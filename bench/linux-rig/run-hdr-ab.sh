#!/bin/bash
# Where does the realistic-GET deficit to fastify live? Bare GET is a dead heat and realistic GET is
# not. The payload sweep already ruled out response size, which leaves the three extra request
# headers the realistic shape sends. This runs the realistic server's GET with those headers and
# without them, for nifra and fastify only, so the deficit can be attributed to per-header work or
# ruled out of it. The authorization header stays on in the success arms because the app rejects the
# request without it, so the variable there is the cookie and origin pair; the `noauth` arm drops it
# deliberately to time the rejection path, which is its own question - a 401 flood is traffic a
# server should shed more cheaply than it serves. Every arm asserts its expected status first,
# because oha counts a 401 as a completed request and a mis-shaped arm would otherwise gate green.
#
#   docker run --rm -v "$PWD":/repo:ro \
#     -v "$PWD/bench/linux-rig/run-hdr-ab.sh":/run.sh nifra-bench bash /run.sh
set -u
cd /repo

PORT=8837
H1='authorization: Bearer abcdefghijklmnopqrstuvwxyz'
H2='cookie: theme=dark'
H3='origin: https://app.example.com'
PASSES=${BENCH_RUNS:-3}
DURATION=${BENCH_DURATION_S:-4}
CONNS=${BENCH_CONNS:-50}

ORDER="fastify nifra"
CONDS="hdr auth-only noauth"

if [ ! -f bench/http-realworld/dist/serve-node-nifra.js ]; then
  echo "missing bench/http-realworld/dist/serve-node-nifra.js - build it on the host first" >&2
  exit 1
fi

bench() {
  local fw=$1 cond=$2 out rate code url
  if [ "$fw" = "nifra" ]; then
    taskset -c 0-3 node bench/http-realworld/dist/serve-node-nifra.js $PORT >/dev/null 2>&1 &
  else
    taskset -c 0-3 node bench/http-realworld/serve-node.ts "$fw" $PORT >/dev/null 2>&1 &
  fi
  local SRV=$!
  for _ in $(seq 1 80); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -H "$H1" -H "$H2" -H "$H3" \
      "http://127.0.0.1:$PORT/api/orders?limit=10" 2>/dev/null)
    [ "$code" = "200" ] && break
    sleep 0.15
  done
  if [ "$code" != "200" ]; then
    kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
    echo "SPAWN-FAIL"
    return
  fi

  url="http://127.0.0.1:$PORT/api/orders?limit=10"
  local hdrs=() want=200
  case "$cond" in
    hdr) hdrs=("-H" "$H1" "-H" "$H2" "-H" "$H3") ;;
    auth-only) hdrs=("-H" "$H1") ;;
    noauth) hdrs=("-H" "$H2" "-H" "$H3"); want=401 ;;
  esac

  local st
  st=$(curl -s -o /dev/null -w '%{http_code}' "${hdrs[@]}" "$url" 2>/dev/null)
  if [ "$st" != "$want" ]; then
    kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
    echo "STATUS-$st"
    return
  fi

  local args=("-c" "$CONNS" "--no-tui" "${hdrs[@]}" "$url")

  taskset -c 4-11 oha -z 1s "${args[@]}" >/dev/null 2>&1
  out=$(taskset -c 4-11 oha -z "${DURATION}s" "${args[@]}" 2>/dev/null)
  kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
  sleep 0.4
  out=$(echo "$out" | sed $'s/\x1b\[[0-9;]*m//g')
  rate=$(echo "$out" | awk '/Success rate:/ {print $3}')
  if [ "$rate" != "100.00%" ]; then echo "GATE-FAIL"; else
    echo "$out" | awk '/Requests\/sec:/ {printf "%.0f", $2}'
  fi
}

RAW=$(mktemp)
for cond in $CONDS; do
  for pass in $(seq 1 "$PASSES"); do
    if [ $((pass % 2)) -eq 0 ]; then arms="nifra fastify"; else arms=$ORDER; fi
    for fw in $arms; do
      echo "$fw $cond $(bench "$fw" "$cond")" >> "$RAW"
    done
  done
  echo "  $cond done" >&2
done

echo
echo "linux rig, realistic GET - server cores 0-3, oha 4-11; c$CONNS, ${DURATION}s x$PASSES (median)"
echo
printf '%-11s %-11s %-11s %s\n' "condition" "nifra" "fastify" "fastify % of nifra"
echo "-------------------------------------------------------"
for cond in $CONDS; do
  awk -v c="$cond" '
    $2 == c { vals[$1] = vals[$1] " " $3 }
    END {
      split("nifra fastify", names, " ")
      for (i = 1; i <= 2; i++) {
        fw = names[i]
        m = split(vals[fw], v, " ")
        bad = 0
        for (j = 1; j <= m; j++) if (v[j] + 0 == 0) bad = 1
        if (bad) { med[fw] = -1; continue }
        for (j = 1; j <= m; j++) for (k = j + 1; k <= m; k++)
          if (v[k] + 0 < v[j] + 0) { t = v[j]; v[j] = v[k]; v[k] = t }
        med[fw] = v[int((m + 1) / 2)] + 0
      }
      if (med["nifra"] < 0 || med["fastify"] < 0) { printf "%-11s %-11s %-11s %s\n", c, "FAIL", "FAIL", "-" }
      else printf "%-11s %-11d %-11d %.1f%%\n", c, med["nifra"], med["fastify"], 100 * med["fastify"] / med["nifra"]
    }
  ' "$RAW"
done
echo
echo "raw samples:"
cat "$RAW"
rm -f "$RAW"

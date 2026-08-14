#!/bin/bash
# Realistic-shape HTTP bench, full field, on a Linux kernel with pinned cores.
#
# Same workload as run-inside.sh (a validated GET with query + headers, a validated POST with a JSON
# body), but against every framework the harness carries rather than just the two nearest. Server
# cores 0-3, oha 4-11. Arms interleaved (order reversed on alternate passes), every row the MEDIAN
# of PASSES, and any row that dropped a single request reads FAIL rather than a number.
#
#   docker run --rm -v "$PWD":/repo:ro \
#     -v "$PWD/bench/linux-rig/run-inside-all.sh":/run.sh nifra-bench bash /run.sh
set -u
cd /repo

PORT=8817
GET_URL="http://127.0.0.1:$PORT/api/orders?limit=10"
POST_URL="http://127.0.0.1:$PORT/api/orders"
H1='authorization: Bearer abcdefghijklmnopqrstuvwxyz'
H2='cookie: theme=dark'
H3='origin: https://app.example.com'
BODY='{"sku":"SKU-1","qty":2,"note":"gift wrap"}'
PASSES=${BENCH_RUNS:-3}
DURATION=${BENCH_DURATION_S:-4}
CONNS=${BENCH_CONNS:-50}

ORDER="node-raw fastify hono express elysia nifra"

if [ ! -f bench/http-realworld/dist/serve-node-nifra.js ]; then
  echo "missing bench/http-realworld/dist/serve-node-nifra.js - build it on the host first" >&2
  exit 1
fi

bench() {
  local fw=$1 wl=$2 out rate code
  if [ "$fw" = "nifra" ]; then
    taskset -c 0-3 node bench/http-realworld/dist/serve-node-nifra.js $PORT >/dev/null 2>&1 &
  else
    taskset -c 0-3 node bench/http-realworld/serve-node.ts "$fw" $PORT >/dev/null 2>&1 &
  fi
  local SRV=$!
  for _ in $(seq 1 80); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -H "$H1" -H "$H2" -H "$H3" "$GET_URL" 2>/dev/null)
    [ "$code" = "200" ] && break
    sleep 0.15
  done
  if [ "$code" != "200" ]; then
    kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
    echo "SPAWN-FAIL"
    return
  fi
  if [ "$wl" = "GET" ]; then
    taskset -c 4-11 oha -c "$CONNS" -z 1s --no-tui -H "$H1" -H "$H2" -H "$H3" "$GET_URL" >/dev/null 2>&1
    out=$(taskset -c 4-11 oha -c "$CONNS" -z "${DURATION}s" --no-tui -H "$H1" -H "$H2" -H "$H3" "$GET_URL" 2>/dev/null)
  else
    taskset -c 4-11 oha -c "$CONNS" -z 1s --no-tui -m POST -d "$BODY" \
      -H 'content-type: application/json' -H "$H1" -H "$H2" -H "$H3" "$POST_URL" >/dev/null 2>&1
    out=$(taskset -c 4-11 oha -c "$CONNS" -z "${DURATION}s" --no-tui -m POST -d "$BODY" \
      -H 'content-type: application/json' -H "$H1" -H "$H2" -H "$H3" "$POST_URL" 2>/dev/null)
  fi
  kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
  sleep 0.4
  out=$(echo "$out" | sed $'s/\x1b\[[0-9;]*m//g')
  rate=$(echo "$out" | awk '/Success rate:/ {print $3}')
  if [ "$rate" != "100.00%" ]; then echo "GATE-FAIL"; else
    echo "$out" | awk '/Requests\/sec:/ {printf "%.0f", $2}'
  fi
}

RAW=$(mktemp)
for wl in GET POST; do
  for pass in $(seq 1 "$PASSES"); do
    if [ $((pass % 2)) -eq 0 ]; then
      arms=$(echo "$ORDER" | tr ' ' '\n' | tac | tr '\n' ' ')
    else
      arms=$ORDER
    fi
    for fw in $arms; do
      echo "$fw $wl $(bench "$fw" "$wl")" >> "$RAW"
    done
    echo "  pass $pass/$PASSES $wl done" >&2
  done
done

echo
echo "linux rig - server cores 0-3, oha 4-11; c$CONNS, ${DURATION}s x$PASSES (median)"
for wl in GET POST; do
  echo
  echo "### $wl"
  printf '%-12s %-11s %s\n' "framework" "req/s" "% of nifra"
  echo "--------------------------------------"
  awk -v wl="$wl" -v order="$ORDER" '
    $2 == wl { vals[$1] = vals[$1] " " $3 }
    END {
      n = split(order, names, " ")
      for (i = 1; i <= n; i++) {
        fw = names[i]
        if (!(fw in vals)) continue
        m = split(vals[fw], v, " ")
        bad = 0
        for (j = 1; j <= m; j++) if (v[j] + 0 == 0) bad = 1
        if (bad) { med[fw] = -1; continue }
        for (j = 1; j <= m; j++) for (k = j + 1; k <= m; k++)
          if (v[k] + 0 < v[j] + 0) { t = v[j]; v[j] = v[k]; v[k] = t }
        med[fw] = v[int((m + 1) / 2)] + 0
      }
      base = med["nifra"]
      for (i = 1; i <= n; i++) {
        fw = names[i]
        if (!(fw in med)) continue
        if (med[fw] < 0) { printf "%-12s %-11s %s\n", fw, "FAIL", "-"; continue }
        printf "%-12s %-11d %.1f%%\n", fw, med[fw], (base > 0 ? 100 * med[fw] / base : 0)
      }
    }
  ' "$RAW"
done
echo
echo "raw samples:"
cat "$RAW"
rm -f "$RAW"

#!/bin/bash
# Reverse-proxy decomposition on a Linux kernel with pinned cores.
#
# The darwin host cannot hold this matrix still - repeated runs disagreed by 10x on the probe rows
# because the load generator, the origin, and the proxy all fight the same scheduler. Here each
# role gets its own cores: origin 0-3, proxy under test 4-7, oha 8-15. Arms are interleaved (order
# reversed on alternate passes) and every row is the MEDIAN of 3 passes, so a slow patch hits all
# rows rather than whichever one happened to run during it.
#
# Rows are the layer ladder, each adding exactly one thing (see serve-node-nifra.ts):
#   node-raw < web-undici < bare-undici < serve-undici < nifra-undici < nifra
# plus fastify and hono for the field. Read % of direct, never the absolutes.
#
#   docker run --rm -v "$PWD":/repo:ro \
#     -v "$PWD/bench/linux-rig/run-inside-proxy.sh":/run.sh nifra-bench bash /run.sh
set -u
cd /repo

ORIGIN_PORT=3600
PROXY_PORT=3610
GET_PATH="/users/123"
POST_PATH="/users"
BODY='{"name":"Ada","age":36}'
PASSES=${BENCH_RUNS:-3}
DURATION=${BENCH_DURATION_S:-4}
CONNS=${BENCH_CONNS:-50}

NIFRA_MODES="nifra:fetch nifra-undici:undici serve-undici:serve-undici bare-undici:bare-undici web-undici:web-undici"
FIELD="node-raw fastify hono"
ORDER="node-raw fastify hono nifra nifra-undici serve-undici bare-undici web-undici"

if [ ! -f bench/proxy/dist/serve-node-nifra.js ]; then
  echo "missing bench/proxy/dist/serve-node-nifra.js - build it on the host first (the repo is read-only here)" >&2
  exit 1
fi

# One origin for the whole run: it is the constant tax every row pays.
taskset -c 0-3 node bench/proxy/origin.ts $ORIGIN_PORT >/dev/null 2>&1 &
ORIGIN=$!
trap 'kill $ORIGIN 2>/dev/null' EXIT
for _ in $(seq 1 80); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$ORIGIN_PORT$GET_PATH" 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 0.15
done
if [ "$code" != "200" ]; then echo "origin never came up" >&2; exit 1; fi

# oha on its own cores; prints rps, or GATE-FAIL when any request missed.
load() {
  local url=$1 wl=$2 out rate
  if [ "$wl" = "GET" ]; then
    taskset -c 8-15 oha -c "$CONNS" -z 1s --no-tui "$url" >/dev/null 2>&1
    out=$(taskset -c 8-15 oha -c "$CONNS" -z "${DURATION}s" --no-tui "$url" 2>/dev/null)
  else
    taskset -c 8-15 oha -c "$CONNS" -z 1s --no-tui -m POST -d "$BODY" \
      -H 'content-type: application/json' "$url" >/dev/null 2>&1
    out=$(taskset -c 8-15 oha -c "$CONNS" -z "${DURATION}s" --no-tui -m POST -d "$BODY" \
      -H 'content-type: application/json' "$url" 2>/dev/null)
  fi
  out=$(echo "$out" | sed $'s/\x1b\[[0-9;]*m//g')
  rate=$(echo "$out" | awk '/Success rate:/ {print $3}')
  if [ "$rate" != "100.00%" ]; then echo "GATE-FAIL"; else
    echo "$out" | awk '/Requests\/sec:/ {printf "%.0f", $2}'
  fi
}

# Spawn one proxy, sample it, kill it. Nothing else under test is alive at the time.
bench() {
  local fw=$1 wl=$2 mode="" path rps code
  for pair in $NIFRA_MODES; do
    [ "${pair%%:*}" = "$fw" ] && mode="${pair##*:}"
  done
  if [ -n "$mode" ]; then
    taskset -c 4-7 node bench/proxy/dist/serve-node-nifra.js $PROXY_PORT $ORIGIN_PORT "$mode" \
      >/dev/null 2>&1 &
  else
    taskset -c 4-7 node bench/proxy/serve-node.ts "$fw" $PROXY_PORT $ORIGIN_PORT >/dev/null 2>&1 &
  fi
  local SRV=$!
  for _ in $(seq 1 80); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PROXY_PORT$GET_PATH" 2>/dev/null)
    [ "$code" = "200" ] && break
    sleep 0.15
  done
  if [ "$code" != "200" ]; then
    kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
    echo "SPAWN-FAIL"
    return
  fi
  [ "$wl" = "GET" ] && path=$GET_PATH || path=$POST_PATH
  rps=$(load "http://127.0.0.1:$PROXY_PORT$path" "$wl")
  kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
  sleep 0.4
  echo "$rps"
}

RAW=$(mktemp)
for wl in GET POST; do
  [ "$wl" = "GET" ] && p=$GET_PATH || p=$POST_PATH
  for pass in $(seq 1 "$PASSES"); do
    echo "direct $wl $(load "http://127.0.0.1:$ORIGIN_PORT$p" "$wl")" >> "$RAW"
    # Reverse the arm order on even passes so position in the sequence cannot favour a framework.
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
echo "linux rig - origin cores 0-3, proxy 4-7, oha 8-15; c$CONNS, ${DURATION}s x$PASSES (median)"
for wl in GET POST; do
  echo
  echo "### $wl"
  printf '%-14s %-11s %s\n' "proxy" "req/s" "% of direct"
  echo "----------------------------------------"
  awk -v wl="$wl" -v order="direct $ORDER" '
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
      base = med["direct"]
      for (i = 1; i <= n; i++) {
        fw = names[i]
        if (!(fw in med)) continue
        if (med[fw] < 0) { printf "%-14s %-11s %s\n", fw, "FAIL", "-"; continue }
        printf "%-14s %-11d %.1f%%\n", fw, med[fw], (base > 0 ? 100 * med[fw] / base : 0)
      }
    }
  ' "$RAW"
done
echo
echo "raw samples:"
cat "$RAW"
rm -f "$RAW"

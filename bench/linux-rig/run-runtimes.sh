#!/bin/bash
# Is the GET deficit a Node-adapter problem or a framework-core problem?
#
# On Node, nifra trails Fastify on the realistic GET while LEADING it on POST. If that asymmetry is
# the Node adapter's, Bun and Deno should not show it; if it reproduces against Elysia on both other
# runtimes, the cost is in the shared core and the Node adapter is exonerated. Nothing else in this
# rig can tell those two apart.
#
# Measures user/system CPU per completed request from /proc for every (runtime, framework, workload)
# cell - the same instrument as run-syscalls.sh, which is what makes the numbers comparable across
# runtimes at all: raw rps is not, because Bun's and Deno's servers, HTTP parsers, and thread pools
# differ from Node's. CPU per request against the SAME runtime's peer framework is the honest
# comparison, and the peer-relative ratio is the only number that should be read across runtimes.
#
#   docker run --rm -v "$PWD":/repo:ro \
#     -v "$PWD/bench/linux-rig/run-runtimes.sh":/run.sh nifra-bench bash /run.sh
#
# /proc only, no extra capabilities. Build the nifra Node bundle on the host first (Bun and Deno run
# the sources directly; only the Node arm is bundled - see run-syscalls.sh's header).
#
# Peers: Fastify on Node, Elysia on Bun and Deno - each runtime's closest realistic-shape peer, the
# same ones bench/http-realworld/run.ts publishes. Arms are interleaved in both orders per cell.
set -u
PORT=8829
GET_URL_PATH="/api/orders?limit=10"
POST_PATH="/api/orders"
H1='authorization: Bearer abcdefghijklmnopqrstuvwxyz'
H2='cookie: theme=dark'
H3='origin: https://app.example.com'
BODY='{"sku":"SKU-1","qty":2,"note":"gift wrap"}'
CLK=$(getconf CLK_TCK)
cd /repo

start_server() {
  local runtime=$1 fw=$2
  case "$runtime" in
    node)
      if [ "$fw" = "nifra" ]; then
        taskset -c 0-3 node bench/http-realworld/dist/serve-node-nifra.js $PORT >/dev/null 2>&1 &
      else
        taskset -c 0-3 node bench/http-realworld/serve-node.ts "$fw" $PORT >/dev/null 2>&1 &
      fi
      ;;
    bun)
      taskset -c 0-3 bun bench/http-realworld/serve.ts "$fw" $PORT >/dev/null 2>&1 &
      ;;
    deno)
      taskset -c 0-3 deno run --allow-net --allow-env --no-check \
        bench/http-realworld/serve-deno.ts "$fw" $PORT >/dev/null 2>&1 &
      ;;
  esac
  SRV=$!
  for _ in $(seq 1 100); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -H "$H1" -H "$H2" -H "$H3" \
      "http://127.0.0.1:$PORT$GET_URL_PATH" 2>/dev/null)
    [ "$code" = "200" ] && return 0
    sleep 0.15
  done
  echo "  $runtime/$fw never became ready" >&2
  return 1
}

drive() {
  local wl=$1 dur=$2
  if [ "$wl" = "GET" ]; then
    taskset -c 4-11 oha -c 50 -z "$dur" --no-tui -H "$H1" -H "$H2" -H "$H3" \
      "http://127.0.0.1:$PORT$GET_URL_PATH" 2>/dev/null
  else
    taskset -c 4-11 oha -c 50 -z "$dur" --no-tui -m POST -d "$BODY" \
      -H 'content-type: application/json' -H "$H1" -H "$H2" -H "$H3" \
      "http://127.0.0.1:$PORT$POST_PATH" 2>/dev/null
  fi
}

strip() { sed $'s/\x1b\[[0-9;]*m//g' <<<"$1"; }
# utime + stime in clock ticks, summed across every thread by the kernel. Bun and Deno are as
# multi-threaded as Node here, so a process-wide counter is the only fair one.
cpu_of() { sed 's/.*) //' "/proc/$1/stat" | awk '{print $12, $13}'; }

measure() {
  local runtime=$1 fw=$2 wl=$3
  start_server "$runtime" "$fw" || return 1
  drive "$wl" 2s >/dev/null
  read -r ut0 st0 <<<"$(cpu_of "$SRV")"
  local out; out=$(drive "$wl" 5s)
  read -r ut1 st1 <<<"$(cpu_of "$SRV")"

  local ok req rps
  ok=$(strip "$out" | awk '/Success rate:/ {print $3}')
  req=$(strip "$out" | awk '/^  \[2[0-9][0-9]\]/ {n += $2} END {print n+0}')
  rps=$(strip "$out" | awk '/Requests\/sec:/ {printf "%.0f", $2}')
  if [ "$ok" != "100.00%" ] || [ "${req:-0}" -lt 1000 ]; then
    echo "$runtime $fw $wl GATE-FAIL rate=$ok responses=$req"
  else
    awk -v rt="$runtime" -v fw="$fw" -v wl="$wl" -v rps="$rps" -v req="$req" -v clk="$CLK" \
        -v ut="$((ut1 - ut0))" -v st="$((st1 - st0))" '
      BEGIN { printf "%-5s %-8s %-4s rps=%-7s user_us/req=%.2f sys_us/req=%.2f total_us/req=%.2f\n",
        rt, fw, wl, rps, (ut/clk)*1e6/req, (st/clk)*1e6/req, ((ut+st)/clk)*1e6/req }'
  fi
  kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null; sleep 0.5
}

cell() {
  local runtime=$1 peer=$2 wl=$3
  measure "$runtime" nifra "$wl"
  measure "$runtime" "$peer" "$wl"
  measure "$runtime" "$peer" "$wl"
  measure "$runtime" nifra "$wl"
  echo
}

for wl in GET POST; do
  echo "=== $wl ==="
  cell node fastify "$wl"
  cell bun elysia "$wl"
  cell deno elysia "$wl"
done

#!/bin/bash
# Proxy CPU per request on the rig: utime+stime of the proxy process (all threads) across a
# count-bounded oha window, divided by the requests completed. Contention moves req/s far more than
# it moves CPU per request, so this resolves what the throughput matrix cannot on a busy host.
# Build bench/proxy/dist/serve-node-nifra.js on the host first, as for run-inside-proxy.sh.
#
#   docker run --rm -v "$PWD":/repo:ro \
#     -v "$PWD/bench/linux-rig/run-proxy-cpu.sh":/run.sh nifra-bench bash /run.sh
set -u
cd /repo
ORIGIN_PORT=3600
PROXY_PORT=3610
BODY='{"name":"Ada","age":36}'
PASSES=${PASSES:-6}
N=${N:-60000}
ARMS="node-raw fastify nifra-undici"
CLK=$(getconf CLK_TCK)

taskset -c 0-3 node bench/proxy/origin.ts $ORIGIN_PORT >/dev/null 2>&1 &
ORIGIN=$!
trap 'kill $ORIGIN 2>/dev/null' EXIT
for _ in $(seq 1 80); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$ORIGIN_PORT/users/123)" = "200" ] && break
  sleep 0.15
done

cpu_ticks() { awk '{s+=$14+$15} END{print s}' /proc/$1/task/*/stat 2>/dev/null; }

run() {
  local fw=$1 wl=$2 n=$3 args
  if [ "$wl" = "GET" ]; then args=(http://127.0.0.1:$PROXY_PORT/users/123); else
    args=(-m POST -d "$BODY" -H 'content-type: application/json' http://127.0.0.1:$PROXY_PORT/users); fi
  taskset -c 8-15 oha -c 50 -n "$n" --no-tui "${args[@]}" 2>/dev/null | sed $'s/\x1b\[[0-9;]*m//g'
}

measure() {
  local fw=$1 wl=$2 pid
  if [ "$fw" = "nifra-undici" ]; then
    taskset -c 4-7 node bench/proxy/dist/serve-node-nifra.js $PROXY_PORT $ORIGIN_PORT undici >/dev/null 2>&1 &
  else
    taskset -c 4-7 node bench/proxy/serve-node.ts "$fw" $PROXY_PORT $ORIGIN_PORT >/dev/null 2>&1 &
  fi
  pid=$!
  for _ in $(seq 1 80); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PROXY_PORT/users/123)" = "200" ] && break
    sleep 0.15
  done
  run "$fw" "$wl" 20000 >/dev/null
  local before out after rate
  before=$(cpu_ticks $pid)
  out=$(run "$fw" "$wl" "$N")
  after=$(cpu_ticks $pid)
  rate=$(echo "$out" | awk '/Success rate:/ {print $3}')
  kill $pid 2>/dev/null; wait $pid 2>/dev/null
  sleep 0.3
  if [ "$rate" != "100.00%" ]; then echo "GATE-FAIL"; return; fi
  awk -v d=$((after - before)) -v clk=$CLK -v n=$N 'BEGIN{printf "%.2f", d / clk * 1e6 / n}'
}

for wl in GET POST; do
  for pass in $(seq 1 "$PASSES"); do
    if [ $((pass % 2)) = 0 ]; then arms=$(echo $ARMS | tr ' ' '\n' | tac | tr '\n' ' '); else arms=$ARMS; fi
    for fw in $arms; do echo "$fw $wl $(measure $fw $wl)"; done
  done
done

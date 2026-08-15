#!/bin/bash
# Throughput of the realistic app's REJECTION path (401) against its own success path, for one
# guard shape. Run it once per shape (thrown `Response` vs returned plain render) and diff the rows;
# the success arm is the control - it must not move.
#
#   docker run --rm -e BENCH_RUNS=3 -e BENCH_DURATION_S=2 -v "$PWD":/repo:ro \
#     -v "$PWD/bench/linux-rig/run-401-shape.sh":/run.sh nifra-bench bash /run.sh
set -u
PORT=8851
H1='authorization: Bearer abcdefghijklmnopqrstuvwxyz'
H2='cookie: theme=dark'
H3='origin: https://app.example.com'
RUNS=${BENCH_RUNS:-3}
DUR=${BENCH_DURATION_S:-2}
PATH_Q='/api/orders?limit=10'
cd /repo

taskset -c 0-3 node bench/http-realworld/dist/ablate-nifra.js full $PORT >/dev/null 2>&1 &
SRV=$!
sleep 1

# Assert each arm's status before timing anything.
ok_code=$(curl -s -o /dev/null -w '%{http_code}' -H "$H1" -H "$H2" -H "$H3" "http://127.0.0.1:$PORT$PATH_Q")
rj_code=$(curl -s -o /dev/null -w '%{http_code}' -H "$H2" -H "$H3" "http://127.0.0.1:$PORT$PATH_Q")
echo "precheck: ok=$ok_code reject=$rj_code"
if [ "$ok_code" != "200" ] || [ "$rj_code" != "401" ]; then
  echo "precheck FAILED - not timing"; kill $SRV; exit 1
fi

for i in $(seq 1 "$RUNS"); do
  for arm in ok reject reject ok; do
    if [ "$arm" = ok ]; then
      out=$(taskset -c 4-11 oha -z "${DUR}s" -c 50 --no-tui \
        -H "$H1" -H "$H2" -H "$H3" "http://127.0.0.1:$PORT$PATH_Q" 2>/dev/null)
    else
      out=$(taskset -c 4-11 oha -z "${DUR}s" -c 50 --no-tui \
        -H "$H2" -H "$H3" "http://127.0.0.1:$PORT$PATH_Q" 2>/dev/null)
    fi
    out=$(echo "$out" | sed $'s/\x1b\[[0-9;]*m//g')
    echo "$arm $(echo "$out" | awk '/Requests\/sec:/ {printf "%.0f", $2}')"
  done
done
kill $SRV

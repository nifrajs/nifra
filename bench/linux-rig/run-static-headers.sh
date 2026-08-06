#!/bin/bash
# Static response-header tier A/B on a Linux kernel: `securityHeaders()` DECLARED (no response hook)
# vs the same five headers written by an `onResponseHeaders` hook. Interleaved, fresh process per
# measurement, medians read off the printed rows, every row gated on a 100% success rate.
#
# Needs the Node bundle built on the HOST first (the repo mounts read-only):
#   bun run bench/http/static-headers.ts node    # its prepare() writes bench/http/dist/
set -u
PORT=8819
BUNDLE=bench/http/dist/serve-node-static-headers.js
cd /repo
if [ ! -f "$BUNDLE" ]; then
  echo "missing $BUNDLE - build it on the host: bun run bench/http/static-headers.ts node"
  exit 1
fi
bench() {
  local variant=$1 path=$2
  taskset -c 0-3 node "$BUNDLE" "$variant" $PORT >/dev/null 2>&1 &
  SRV=$!
  for i in $(seq 1 80); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" 2>/dev/null)
    [ "$code" = "200" ] && break; sleep 0.15
  done
  local url="http://127.0.0.1:$PORT$path"
  taskset -c 4-11 oha -c 50 -z 1s --no-tui "$url" >/dev/null 2>&1
  local out
  out=$(taskset -c 4-11 oha -c 50 -z 3s --no-tui "$url" 2>/dev/null)
  kill $SRV 2>/dev/null; wait $SRV 2>/dev/null; sleep 0.4
  out=$(echo "$out" | sed $'s/\x1b\[[0-9;]*m//g')
  local rps ok
  rps=$(echo "$out" | awk '/Requests\/sec:/ {printf "%.0f", $2}')
  ok=$(echo "$out" | awk '/Success rate:/ {print $3}')
  if [ "$ok" != "100.00%" ]; then echo "$variant $path GATE-FAIL rate=$ok"; else echo "$variant $path $rps"; fi
}
for path in / /users/123; do
  for round in 1 2 3; do
    bench hook "$path"
    bench static "$path"
  done
done

#!/bin/bash
# Price the ways to answer 401 (see bench/http-realworld/reject-shapes.ts) against each other, on
# pinned cores. One server PROCESS per shape, because hooks apply to every route registered after
# them and shapes on one chain would contaminate each other.
#
# The question is why nifra sheds an unauthorized request at ~39k rps while serving an authorized
# one at ~62k, and fastify does the opposite. Subtracting adjacent rows splits that into the cost of
# the Response object, of the throw, and of unwinding a derive - and the `helper` rows price the
# fix, a `status(...)` early exit rendered as plain data.
#
# BENCH_RUNTIME=node|bun|deno. The shapes are runtime-agnostic on purpose: the Response object is a
# node-adapter tax (built, then drained straight back out) but a fact of life on the Web-native
# runtimes, so the same ladder answers different questions per runtime and only the WITHIN-runtime
# deltas are readable. Node runs the bundle; bun and deno run the source, same as run-runtimes.sh.
#
#   docker run --rm -v "$PWD":/repo:ro \
#     -v "$PWD/bench/linux-rig/run-reject-shapes.sh":/run.sh nifra-bench bash /run.sh
set -u
cd /repo

PORT=8858
PASSES=${BENCH_RUNS:-5}
DURATION=${BENCH_DURATION_S:-4}
CONNS=${BENCH_CONNS:-50}
RUNTIME=${BENCH_RUNTIME:-node}
ROUTES=${BENCH_ROUTES:-"status before return throw derive-throw helper helper-throw not-found invalid"}

if [ "$RUNTIME" = "node" ] && [ ! -f bench/http-realworld/dist/reject-shapes.js ]; then
  echo "missing bench/http-realworld/dist/reject-shapes.js - build it on the host first" >&2
  exit 1
fi

start_shape() {
  case "$RUNTIME" in
    node) taskset -c 0-3 node bench/http-realworld/dist/reject-shapes.js "$1" $PORT >/dev/null 2>&1 & ;;
    bun)  taskset -c 0-3 bun bench/http-realworld/reject-shapes.ts "$1" $PORT >/dev/null 2>&1 & ;;
    deno) taskset -c 0-3 deno run --allow-net --allow-env --no-check \
            bench/http-realworld/reject-shapes.ts "$1" $PORT >/dev/null 2>&1 & ;;
    *) echo "unknown BENCH_RUNTIME=$RUNTIME" >&2; exit 1 ;;
  esac
}

# What each shape must answer - mirrors EXPECTED in reject-shapes.ts. The two framework renders are
# not 401s: `not-found` misses the router, `invalid` fails a query schema.
expected_of() {
  case "$1" in
    not-found) echo 404 ;;
    invalid) echo 422 ;;
    *) echo 401 ;;
  esac
}

bench() {
  local route=$1 out rate st url="http://127.0.0.1:$PORT/x"
  local want
  want=$(expected_of "$route")
  start_shape "$route"
  local SRV=$!
  for _ in $(seq 1 80); do
    st=$(curl -s -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)
    [ "$st" = "$want" ] && break
    sleep 0.15
  done
  # Every arm must be on its own rejection path; oha counts any completed request, so a route that
  # quietly answered 200 would gate green and read as a fast rejection.
  if [ "$st" != "$want" ]; then
    kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
    echo "STATUS-$st"
    return
  fi
  taskset -c 4-11 oha -c "$CONNS" -z 1s --no-tui "$url" >/dev/null 2>&1
  out=$(taskset -c 4-11 oha -c "$CONNS" -z "${DURATION}s" --no-tui "$url" 2>/dev/null)
  kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
  sleep 0.4
  out=$(echo "$out" | sed $'s/\x1b\[[0-9;]*m//g')
  rate=$(echo "$out" | awk '/Success rate:/ {print $3}')
  if [ "$rate" != "100.00%" ]; then echo "GATE-FAIL"; else
    echo "$out" | awk '/Requests\/sec:/ {printf "%.0f", $2}'
  fi
}

RAW=$(mktemp)
for pass in $(seq 1 "$PASSES"); do
  if [ $((pass % 2)) -eq 0 ]; then
    arms=$(echo "$ROUTES" | tr ' ' '\n' | tac | tr '\n' ' ')
  else
    arms=$ROUTES
  fi
  for route in $arms; do
    echo "$route $(bench "$route")" >> "$RAW"
  done
  echo "  pass $pass/$PASSES done" >&2
done

echo
echo "linux rig, 401 shapes on $RUNTIME - server cores 0-3, oha 4-11; c$CONNS, ${DURATION}s x$PASSES (median)"
echo
printf '%-14s %s\n' "shape" "req/s"
echo "-----------------------------"
for route in $ROUTES; do
  awk -v r="$route" '
    $1 == r { v = v " " $2 }
    END {
      m = split(v, x, " ")
      for (j = 1; j <= m; j++) if (x[j] + 0 == 0) { printf "%-14s %s\n", r, "FAIL"; exit }
      for (j = 1; j <= m; j++) for (k = j + 1; k <= m; k++)
        if (x[k] + 0 < x[j] + 0) { t = x[j]; x[j] = x[k]; x[k] = t }
      printf "%-14s %d\n", r, x[int((m + 1) / 2)]
    }
  ' "$RAW"
done
echo
echo "raw samples:"
cat "$RAW"
rm -f "$RAW"

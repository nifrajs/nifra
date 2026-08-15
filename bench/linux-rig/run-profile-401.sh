#!/bin/bash
# CPU-profile the realistic server on the REJECTION path and on the success path, so the two can be
# diffed frame by frame.
#
# It was written to chase a gap that has since been closed: the app's guard used to build and throw
# a `Response`, and shed an unauthorized GET at ~38k rps against its own ~62k success path - dearer
# to reject than to serve. The guard now returns the plain render `status(...)` produces and sheds at
# ~63k, so rejecting is cheaper than serving, as it should be. Keep the script for the next such gap;
# read a fresh pair of profiles, not the numbers above.
#
#   docker run --rm -v "$PWD":/repo:ro -v "$PWD/bench/linux-rig/run-profile-401.sh":/run.sh \
#     -v "$PWD/bench/linux-rig/prof":/out nifra-bench bash /run.sh nifra ok reject
#
# nifra runs through the ablation harness rather than serve-node-nifra.js: its `full` rung is
# behaviour-identical to the realistic app AND it installs the SIGINT handler that lets `--cpu-prof`
# flush on exit, which a default SIGINT skips (the plain bench server leaves an empty directory).
#
# Writes /out/<fw>-<arm>.cpuprofile per arm named on the command line; the host diffs them with
# bench/linux-rig/profile-diff.ts. The repo mounts read-only, so /out is a separate writable mount.
set -u
PORT=8847
H1='authorization: Bearer abcdefghijklmnopqrstuvwxyz'
H2='cookie: theme=dark'
H3='origin: https://app.example.com'
OUT=/out
INTERVAL_US="${INTERVAL_US:-100}"
cd /repo
mkdir -p "$OUT"

# Default: the ablation harness's `full` rung, behaviour-identical to the realistic app. Override
# with NIFRA_CMD to profile another nifra server (the 401-shape server, say).
NIFRA_CMD=${NIFRA_CMD:-'bench/http-realworld/dist/ablate-nifra.js full'}
# The arm's request shape: `reject` drops the authorization header and expects 401, anything else
# sends the full header set and expects 200. PROF_PATH overrides the path both arms request.
PROF_PATH=${PROF_PATH:-/api/orders?limit=10}

fw=$1
shift

for arm in "$@"; do
  if [ "$fw" = "nifra" ]; then
    taskset -c 0-3 node --cpu-prof --cpu-prof-interval="$INTERVAL_US" --cpu-prof-dir="$OUT" \
      --cpu-prof-name="$fw-$arm.cpuprofile" \
      $NIFRA_CMD $PORT >/dev/null 2>&1 &
  else
    taskset -c 0-3 node --cpu-prof --cpu-prof-interval="$INTERVAL_US" --cpu-prof-dir="$OUT" \
      --cpu-prof-name="$fw-$arm.cpuprofile" \
      bench/http-realworld/serve-node.ts "$fw" $PORT >/dev/null 2>&1 &
  fi
  SRV=$!
  ready=0
  for _ in $(seq 1 80); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -H "$H1" -H "$H2" -H "$H3" \
      "http://127.0.0.1:$PORT${PROF_PATH}" 2>/dev/null)
    [ "$code" != "000" ] && { ready=1; break; }
    sleep 0.15
  done
  if [ "$ready" != 1 ]; then
    echo "$fw/$arm never became ready" >&2
    kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null
    continue
  fi

  url="http://127.0.0.1:$PORT${PROF_PATH}"
  if [ "$arm" = "reject" ]; then hdrs=("-H" "$H2" "-H" "$H3"); want=401
  else hdrs=("-H" "$H1" "-H" "$H2" "-H" "$H3"); want=${WANT:-200}; fi

  st=$(curl -s -o /dev/null -w '%{http_code}' "${hdrs[@]}" "$url" 2>/dev/null)
  if [ "$st" != "$want" ]; then
    echo "$fw/$arm answered $st, expected $want" >&2
    kill -INT "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null
    continue
  fi

  taskset -c 4-11 oha -c 50 -z 2s --no-tui "${hdrs[@]}" "$url" >/dev/null 2>&1
  out=$(taskset -c 4-11 oha -c 50 -z 12s --no-tui "${hdrs[@]}" "$url" 2>/dev/null)
  req=$(sed $'s/\x1b\[[0-9;]*m//g' <<<"$out" | awk -v w="$want" '$1 == "[" w "]" || $0 ~ "\\[" w "\\]" {n += $2} END {print n+0}')
  # SIGINT so the profiler flushes its file on exit.
  kill -INT "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null
  echo "$fw/$arm profiled over $req responses"
  sleep 0.5
done
ls -la "$OUT"

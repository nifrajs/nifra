#!/bin/bash
# CPU-profile one ablation rung under load and write the .cpuprofile out for host-side analysis.
#
# The ablation ladder localizes a cost to a rung; this says which frames inside it. Profiling two
# ADJACENT rungs and diffing their self-time tables attributes the step between them, which is the
# only way to read a cost that is a few percent of the total and spread across a lane.
#
#   docker run --rm -v "$PWD":/repo:ro -v "$PWD/bench/linux-rig/run-profile.sh":/run.sh \
#     -v "$PWD/bench/linux-rig/prof":/out nifra-bench bash /run.sh nifra cors1 corsnoop
#
# Writes /out/<fw>-<rung>.cpuprofile per rung named on the command line. The host analyses them with
# bench/linux-rig/profile-diff.ts. The repo mounts read-only, so /out must be a separate writable
# mount - bench/linux-rig/prof/ is gitignored (bench/** ignores everything but the scripts).
#
# Profiler overhead compresses the absolute rps, exactly as the earlier cpu-prof runs did; the
# self-time SHARES are what this is for, and the diff between two rungs profiled identically.
set -u
PORT=8827
H1='authorization: Bearer abcdefghijklmnopqrstuvwxyz'
H2='cookie: theme=dark'
H3='origin: https://app.example.com'
OUT=/out
# Default 1ms sampling yields only a few thousand samples over a 12s window - far too coarse to
# resolve a stage worth a few percent. 100us gives ~10x the samples for the same window.
INTERVAL_US="${INTERVAL_US:-100}"
cd /repo
mkdir -p "$OUT"

fw=$1
shift

for rung in "$@"; do
  if [ "$fw" = "nifra" ]; then
    taskset -c 0-3 node --cpu-prof --cpu-prof-interval="$INTERVAL_US" --cpu-prof-dir="$OUT" \
      --cpu-prof-name="$fw-$rung.cpuprofile" \
      bench/http-realworld/dist/ablate-nifra.js "$rung" $PORT >/dev/null 2>&1 &
  else
    taskset -c 0-3 node --cpu-prof --cpu-prof-interval="$INTERVAL_US" --cpu-prof-dir="$OUT" \
      --cpu-prof-name="$fw-$rung.cpuprofile" \
      bench/http-realworld/ablate-fastify.ts "$rung" $PORT >/dev/null 2>&1 &
  fi
  SRV=$!
  ready=0
  for _ in $(seq 1 80); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -H "$H1" -H "$H2" -H "$H3" \
      "http://127.0.0.1:$PORT/api/orders?limit=10" 2>/dev/null)
    [ "$code" = "200" ] && { ready=1; break; }
    sleep 0.15
  done
  if [ "$ready" != 1 ]; then
    echo "$fw/$rung never became ready" >&2
    kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null
    continue
  fi
  taskset -c 4-11 oha -c 50 -z 2s --no-tui -H "$H1" -H "$H2" -H "$H3" \
    "http://127.0.0.1:$PORT/api/orders?limit=10" >/dev/null 2>&1
  out=$(taskset -c 4-11 oha -c 50 -z 12s --no-tui -H "$H1" -H "$H2" -H "$H3" \
    "http://127.0.0.1:$PORT/api/orders?limit=10" 2>/dev/null)
  req=$(sed $'s/\x1b\[[0-9;]*m//g' <<<"$out" | awk '/^  \[2[0-9][0-9]\]/ {n += $2} END {print n+0}')
  # SIGINT so the profiler flushes its file on exit.
  kill -INT "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null
  echo "$fw/$rung profiled over $req responses"
  sleep 0.5
done
ls -la "$OUT"

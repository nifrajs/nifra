#!/bin/bash
# Per-thread CPU attribution.
#
# run-syscalls.sh showed nifra spending ~0.7 us MORE user CPU per realistic GET than fastify with
# byte-identical syscall counts, and run-payload-sweep.sh showed that deficit is FLAT across a 5.8x
# response-size range - so it is fixed per-request work, not serialization. Two earlier `node
# --cpu-prof` runs found no hotspot to explain it.
#
# `user_us/req` from /proc/<pid>/stat sums EVERY thread in the process. A main-thread CPU profile
# does not: V8's concurrent marking and sweeping threads, and libuv's pool, are invisible to it.
# Work that shows up in the total but in no profile frame is exactly the signature of GC pressure
# from higher per-request allocation.
#
# This reads /proc/<pid>/task/*/stat before and after a load window and prints the utime+stime
# delta per THREAD, with each thread's comm. If the deficit sits on the main JS thread, allocation
# is not the story and the next step is a sharper main-thread profile. If it sits on the marker/
# sweeper threads, the fix is allocating less per request, not micro-optimizing the lane.
#
#   docker run --rm -v "$PWD":/repo:ro \
#     -v "$PWD/bench/linux-rig/run-thread-cpu.sh":/run.sh nifra-bench bash /run.sh
#
# Build the nifra Node bundle on the host first (see run-syscalls.sh's header). /proc only, no
# ptrace, no added overhead. Arms interleaved in both orders; sub-2% rows are noise as always here.
set -u
PORT=8823
GET_URL="http://127.0.0.1:$PORT/api/orders?limit=10"
H1='authorization: Bearer abcdefghijklmnopqrstuvwxyz'
H2='cookie: theme=dark'
H3='origin: https://app.example.com'
CLK=$(getconf CLK_TCK)
cd /repo

start_server() {
  if [ "$1" = "nifra" ]; then
    taskset -c 0-3 node bench/http-realworld/dist/serve-node-nifra.js $PORT >/dev/null 2>&1 &
  else
    taskset -c 0-3 node bench/http-realworld/serve-node.ts "$1" $PORT >/dev/null 2>&1 &
  fi
  SRV=$!
  for _ in $(seq 1 80); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -H "$H1" -H "$H2" -H "$H3" "$GET_URL" 2>/dev/null)
    [ "$code" = "200" ] && return 0
    sleep 0.15
  done
  echo "  server $1 never became ready" >&2
  return 1
}

drive() {
  taskset -c 4-11 oha -c 50 -z "$1" --no-tui -H "$H1" -H "$H2" -H "$H3" "$GET_URL" 2>/dev/null
}

strip() { sed $'s/\x1b\[[0-9;]*m//g' <<<"$1"; }

# "<tid> <comm> <utime+stime ticks>" for every thread in the group.
threads_of() {
  for t in /proc/"$1"/task/*/stat; do
    [ -r "$t" ] || continue
    awk '{ tid = $1; sub(/.*\) /, ""); print tid, $12 + $13 }' "$t" 2>/dev/null |
      while read -r tid ticks; do
        comm=$(tr -d '\0' < "$(dirname "$t")/comm" 2>/dev/null)
        echo "$tid ${comm:-?} $ticks"
      done
  done
}

measure() {
  local fw=$1
  start_server "$fw" || return 1
  drive 2s >/dev/null

  threads_of "$SRV" > /tmp/thr0.txt
  local out; out=$(drive 6s)
  threads_of "$SRV" > /tmp/thr1.txt

  local ok req rps
  ok=$(strip "$out" | awk '/Success rate:/ {print $3}')
  req=$(strip "$out" | awk '/^  \[2[0-9][0-9]\]/ {n += $2} END {print n+0}')
  rps=$(strip "$out" | awk '/Requests\/sec:/ {printf "%.0f", $2}')
  if [ "$ok" != "100.00%" ] || [ "${req:-0}" -lt 1000 ]; then
    echo "$fw GATE-FAIL rate=$ok responses=$req"
  else
    echo "--- $fw  rps=$rps  responses=$req ---"
    awk -v req="$req" -v clk="$CLK" '
      NR == FNR { before[$1] = $3; comm[$1] = $2; next }
      { comm[$1] = $2; d = $3 - (($1 in before) ? before[$1] : 0)
        if (d > 0) { rows[++n] = sprintf("  tid %-7s %-16s %8.3f us/req", $1, comm[$1], (d/clk)*1e6/req); tot += d } }
      END {
        for (i = 1; i <= n; i++) print rows[i]
        printf "  %-28s %8.3f us/req  (all threads)\n", "TOTAL", (tot/clk)*1e6/req
      }' /tmp/thr0.txt /tmp/thr1.txt | sort -t= -k2 -nr
  fi
  kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null; sleep 0.4
}

for fw in fastify nifra; do measure "$fw"; done
for fw in nifra fastify; do measure "$fw"; done

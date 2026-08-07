#!/bin/bash
# Kernel-level rig: where run-inside.sh answers "how many requests per second", this answers
# "how many syscalls, context switches, and CPU-microseconds did each of those requests cost".
# It exists because the userland cpu-prof of the realistic GET came back flat (nifra and fastify
# have near-identical CPU distributions) while the throughput gap stayed 4-7% - which points below
# the JS layer.
#
# Two instruments, in order of trust:
#
#   1. /proc counters (ZERO overhead, the primary numbers). /proc/<pid>/io gives syscr/syscw -
#      the exact count of read-family and write-family syscalls the process issued - plus rchar/
#      wchar for the bytes moved through them. /proc/<pid>/task/*/status gives context switches.
#      /proc/<pid>/stat gives utime/stime. All are read before and after a load window and divided
#      by the requests oha actually completed in it, so every number below is PER REQUEST and is
#      measured on a process running at full speed.
#
#   2. strace -c (PERTURBING, the syscall breakdown). Only strace can attribute counts to
#      epoll_wait/epoll_ctl/futex/accept, but ptrace-stopping every syscall collapses throughput
#      by an order of magnitude and changes event batching (epoll_wait returns fewer events per
#      call when the process is slower). Read its SHAPE, never its absolute rate, and never
#      compare a strace number against a /proc number.
#
# Requires ptrace, which Docker's default seccomp profile blocks:
#
#   docker build -t nifra-bench bench/linux-rig
#   docker run --rm --cap-add=SYS_PTRACE --security-opt seccomp=unconfined \
#     -v "$PWD":/repo:ro -v "$PWD/bench/linux-rig/run-syscalls.sh":/run.sh \
#     nifra-bench bash /run.sh
#
# The nifra Node bundle must be built on the host first (the repo mounts read-only). Any run of
# `bun run bench:http:realworld` produces it, or build just the bundle:
#
#   bun run --filter '@nifrajs/core' build && bun run --filter '@nifrajs/middleware' build
#   bun -e 'await Bun.build({entrypoints:["bench/http-realworld/serve-node-nifra.ts"],target:"node",outdir:"bench/http-realworld/dist"})'
#
# Same pinning as run-inside.sh (server on cores 0-3, load generator on 4-11) and the same caveats:
# Docker Desktop's VM shares host silicon and thermals, so arms are interleaved and sub-2% deltas
# on the CPU-time rows are noise. The syscall COUNTS are integers per request and far more stable
# than any timing row here.
set -u
PORT=8819
GET_URL="http://127.0.0.1:$PORT/api/orders?limit=10"
POST_URL="http://127.0.0.1:$PORT/api/orders"
H1='authorization: Bearer abcdefghijklmnopqrstuvwxyz'
H2='cookie: theme=dark'
H3='origin: https://app.example.com'
BODY='{"sku":"SKU-1","qty":2,"note":"gift wrap"}'
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

stop_server() { kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null; sleep 0.4; }

# oha for the given workload; stdout is the raw report.
drive() {
  local wl=$1 dur=$2 conns=$3
  if [ "$wl" = "GET" ]; then
    taskset -c 4-11 oha -c "$conns" -z "$dur" --no-tui -H "$H1" -H "$H2" -H "$H3" "$GET_URL" 2>/dev/null
  else
    taskset -c 4-11 oha -c "$conns" -z "$dur" --no-tui -m POST -d "$BODY" \
      -H 'content-type: application/json' -H "$H1" -H "$H2" -H "$H3" "$POST_URL" 2>/dev/null
  fi
}

# Completed 2xx responses in an oha report - the denominator for every per-request number.
responses_of() { sed $'s/\x1b\[[0-9;]*m//g' <<<"$1" | awk '/^  \[2[0-9][0-9]\]/ {n += $2} END {print n+0}'; }
rps_of() { sed $'s/\x1b\[[0-9;]*m//g' <<<"$1" | awk '/Requests\/sec:/ {printf "%.0f", $2}'; }
okrate_of() { sed $'s/\x1b\[[0-9;]*m//g' <<<"$1" | awk '/Success rate:/ {print $3}'; }

# syscr syscw rchar wchar - read-family count, write-family count, bytes through each.
io_of() { awk '/^syscr:/{r=$2} /^syscw:/{w=$2} /^rchar:/{rc=$2} /^wchar:/{wc=$2} END{print r, w, rc, wc}' "/proc/$1/io"; }
# Voluntary + involuntary context switches summed across every thread in the group.
ctx_of() {
  awk '/^voluntary_ctxt_switches:/{v+=$2} /^nonvoluntary_ctxt_switches:/{n+=$2} END{print v+0, n+0}' \
    /proc/"$1"/task/*/status 2>/dev/null
}
# utime stime in clock ticks, already summed across threads by the kernel.
cpu_of() { sed 's/.*) //' "/proc/$1/stat" | awk '{print $12, $13}'; }

# One measured arm: warm, snapshot /proc, drive load, snapshot again, print per-request numbers.
measure() {
  local fw=$1 wl=$2
  start_server "$fw" || return 1
  drive "$wl" 2s 50 >/dev/null

  read -r r0 w0 rc0 wc0 <<<"$(io_of "$SRV")"
  read -r v0 n0 <<<"$(ctx_of "$SRV")"
  read -r ut0 st0 <<<"$(cpu_of "$SRV")"

  local out; out=$(drive "$wl" 5s 50)

  read -r r1 w1 rc1 wc1 <<<"$(io_of "$SRV")"
  read -r v1 n1 <<<"$(ctx_of "$SRV")"
  read -r ut1 st1 <<<"$(cpu_of "$SRV")"

  local ok; ok=$(okrate_of "$out")
  local req; req=$(responses_of "$out")
  local rps; rps=$(rps_of "$out")
  if [ "$ok" != "100.00%" ] || [ "${req:-0}" -lt 1000 ]; then
    echo "$fw $wl GATE-FAIL rate=$ok responses=$req"
    stop_server; return 0
  fi

  awk -v fw="$fw" -v wl="$wl" -v rps="$rps" -v req="$req" -v clk="$CLK" \
      -v r="$((r1 - r0))" -v w="$((w1 - w0))" -v rc="$((rc1 - rc0))" -v wc="$((wc1 - wc0))" \
      -v v="$((v1 - v0))" -v n="$((n1 - n0))" -v ut="$((ut1 - ut0))" -v st="$((st1 - st0))" '
    BEGIN {
      printf "%-8s %-4s rps=%-7s reads/req=%.3f writes/req=%.3f rbytes/req=%.0f wbytes/req=%.0f",
        fw, wl, rps, r/req, w/req, rc/req, wc/req
      printf " vctx/req=%.3f ictx/req=%.4f user_us/req=%.2f sys_us/req=%.2f total_us/req=%.2f\n",
        v/req, n/req, (ut/clk)*1e6/req, (st/clk)*1e6/req, ((ut+st)/clk)*1e6/req
    }'
  stop_server
}

# strace -c over a short low-concurrency window. Perturbing by construction (see the header):
# read the relative shape of the syscall table, not the rates.
straced() {
  local fw=$1 wl=$2
  start_server "$fw" || return 1
  drive "$wl" 1s 8 >/dev/null
  local f="/tmp/strace-$fw-$wl.txt"
  timeout -s INT 6 strace -c -f -p "$SRV" -o "$f" 2>/dev/null &
  local ST=$!
  sleep 0.5
  local out; out=$(drive "$wl" 4s 8)
  wait $ST 2>/dev/null
  local req; req=$(responses_of "$out")
  echo "--- $fw $wl  (strace, PERTURBED; ${req:-0} responses in window) ---"
  if [ -s "$f" ]; then
    awk -v req="${req:-1}" '
      /^[- ]*$/ {next}
      $NF ~ /^[a-z_0-9]+$/ && NF >= 4 && $(NF-1) ~ /^[0-9]+$/ {
        calls[$NF] = $(NF-1) + 0
      }
      END { for (s in calls) if (calls[s] > 0) printf "  %-16s %10d  %8.3f/req\n", s, calls[s], calls[s]/req }
    ' "$f" | sort -k2 -nr | head -14
  else
    echo "  strace produced nothing - is the container missing --cap-add=SYS_PTRACE?"
  fi
  stop_server
}

echo "== /proc counters (zero overhead, per completed request) =="
for wl in GET POST; do
  for fw in fastify nifra; do measure "$fw" "$wl"; done
  for fw in nifra fastify; do measure "$fw" "$wl"; done
done

echo
echo "== perf stat (hardware counters; expected to be unavailable in Docker Desktop's VM) =="
if perf stat -e task-clock true >/dev/null 2>&1; then
  for fw in fastify nifra; do
    start_server "$fw" || continue
    drive GET 1s 50 >/dev/null
    echo "--- $fw GET ---"
    perf stat -p "$SRV" -e task-clock,context-switches,cpu-migrations,page-faults,instructions,cycles \
      -- sleep 4 2>&1 | sed 's/^/  /'
    stop_server
  done
else
  echo "  perf_event_open unavailable (no virtualized PMU / paranoid level). Skipped."
fi

echo
echo "== strace -c syscall breakdown =="
for wl in GET POST; do
  for fw in fastify nifra; do straced "$fw" "$wl"; done
done

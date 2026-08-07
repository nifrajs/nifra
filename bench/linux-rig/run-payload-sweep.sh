#!/bin/bash
# Payload sweep: same route, same lifecycle, only the response size changes.
#
# run-syscalls.sh established that nifra and fastify issue the IDENTICAL syscalls per request
# (1.002 reads, 1.002 writes, 1.000 writev, 0.126 epoll_pwait) and spend the same system CPU, but
# that nifra spends ~0.8 us MORE user CPU on the realistic GET (+7%) while spending ~0.4 us LESS on
# the realistic POST (-3%). The two workloads differ in almost nothing except how many bytes come
# back: GET writes ~1623 bytes/req, POST ~469.
#
# `?limit=N` on /api/orders returns N of a fixed 25-order array through the same derives, the same
# beforeHandle, the same query schema, and the same JSON.stringify - so sweeping N holds every
# per-request pipeline cost constant and scales ONLY the serialized payload. If nifra's user-CPU
# deficit scales with N, the cost is per response BYTE (serialization or the write path). If it is
# flat across N, the cost is per REQUEST and the payload is a red herring.
#
#   docker build -t nifra-bench bench/linux-rig
#   docker run --rm -v "$PWD":/repo:ro \
#     -v "$PWD/bench/linux-rig/run-payload-sweep.sh":/run.sh nifra-bench bash /run.sh
#
# No ptrace needed here - this rig reads /proc only. Build the nifra Node bundle on the host first
# (see run-syscalls.sh's header). Arms are interleaved in both orders per limit; report medians and
# treat sub-2% rows as noise, as on every arm of this rig.
set -u
PORT=8821
H1='authorization: Bearer abcdefghijklmnopqrstuvwxyz'
H2='cookie: theme=dark'
H3='origin: https://app.example.com'
LIMITS="1 5 10 25"
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
    code=$(curl -s -o /dev/null -w '%{http_code}' -H "$H1" -H "$H2" -H "$H3" \
      "http://127.0.0.1:$PORT/api/orders?limit=1" 2>/dev/null)
    [ "$code" = "200" ] && return 0
    sleep 0.15
  done
  echo "  server $1 never became ready" >&2
  return 1
}

drive() {
  taskset -c 4-11 oha -c 50 -z "$1" --no-tui -H "$H1" -H "$H2" -H "$H3" \
    "http://127.0.0.1:$PORT/api/orders?limit=$2" 2>/dev/null
}

strip() { sed $'s/\x1b\[[0-9;]*m//g' <<<"$1"; }
responses_of() { strip "$1" | awk '/^  \[2[0-9][0-9]\]/ {n += $2} END {print n+0}'; }
rps_of() { strip "$1" | awk '/Requests\/sec:/ {printf "%.0f", $2}'; }
okrate_of() { strip "$1" | awk '/Success rate:/ {print $3}'; }
io_of() { awk '/^syscw:/{w=$2} /^wchar:/{wc=$2} END{print w, wc}' "/proc/$1/io"; }
cpu_of() { sed 's/.*) //' "/proc/$1/stat" | awk '{print $12, $13}'; }

measure() {
  local fw=$1 limit=$2
  start_server "$fw" || return 1
  drive 2s "$limit" >/dev/null

  read -r w0 wc0 <<<"$(io_of "$SRV")"
  read -r ut0 st0 <<<"$(cpu_of "$SRV")"
  local out; out=$(drive 5s "$limit")
  read -r w1 wc1 <<<"$(io_of "$SRV")"
  read -r ut1 st1 <<<"$(cpu_of "$SRV")"

  local ok req rps
  ok=$(okrate_of "$out"); req=$(responses_of "$out"); rps=$(rps_of "$out")
  if [ "$ok" != "100.00%" ] || [ "${req:-0}" -lt 1000 ]; then
    echo "limit=$limit $fw GATE-FAIL rate=$ok responses=$req"
  else
    awk -v fw="$fw" -v lim="$limit" -v rps="$rps" -v req="$req" -v clk="$CLK" \
        -v wc="$((wc1 - wc0))" -v ut="$((ut1 - ut0))" -v st="$((st1 - st0))" '
      BEGIN { printf "limit=%-3s %-8s rps=%-7s wbytes/req=%-6.0f user_us/req=%.2f sys_us/req=%.2f total_us/req=%.2f\n",
        lim, fw, rps, wc/req, (ut/clk)*1e6/req, (st/clk)*1e6/req, ((ut+st)/clk)*1e6/req }'
  fi
  kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null; sleep 0.4
}

for limit in $LIMITS; do
  for fw in fastify nifra; do measure "$fw" "$limit"; done
  for fw in nifra fastify; do measure "$fw" "$limit"; done
  echo
done

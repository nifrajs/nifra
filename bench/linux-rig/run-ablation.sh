#!/bin/bash
# Per-stage bill for the realistic GET.
#
# run-syscalls.sh / run-payload-sweep.sh / run-thread-cpu.sh narrowed nifra's deficit against
# Fastify to ~0.8 us of fixed, payload-independent, main-thread user CPU with no hotspot behind it.
# That shape says the cost is the SUM of the stages nifra runs per request, so the way to act on it
# is to price each stage rather than hunt for one missing trick.
#
# Both frameworks climb the same cumulative ladder (see bench/http-realworld/ablate-{nifra,fastify}.ts):
#
#   full      securityHeaders + cors + request-id + auth derive + cookie + query schema
#   nocors    - cors
#   nosec     - securityHeaders
#   noreqid   - request-id hook
#   noderive  - auth derive + cookie read   (identical work moves into the handler)
#   bare      - query schema                (router -> handler and nothing else)
#
# The difference between two consecutive rungs is that stage's per-request cost IN THAT FRAMEWORK.
# Comparing the two ladders stage by stage says where nifra's 0.8 us actually goes, and the `bare`
# rung says how much of it is present before any middleware runs at all.
#
# Fastify additionally gets a `full-slow` rung: `full` written the way bench/http-realworld/
# serve-node.ts writes it today (async hooks, per-request Object.entries, HSTS instead of vary).
# Fastify's hook runner only allocates a promise when a hook returns a thenable, so `full` vs
# `full-slow` prices OUR bench's authoring choices rather than anything about the framework. The
# `full` rungs of the two ladders emit byte-identical headers and byte-identical bodies.
#
#   docker run --rm -v "$PWD":/repo:ro \
#     -v "$PWD/bench/linux-rig/run-ablation.sh":/run.sh nifra-bench bash /run.sh
#
# /proc only, no extra capabilities. Build the nifra bundles on the host first:
#
#   bun run --filter '@nifrajs/core' build && bun run --filter '@nifrajs/middleware' build
#   bun -e 'await Bun.build({entrypoints:["bench/http-realworld/ablate-nifra.ts"],target:"node",outdir:"bench/http-realworld/dist"})'
#
# Arms interleaved in both orders. Per-stage deltas are differences of noisy numbers, so read a
# stage as real only when it clears ~0.15 us; the ladder is for ranking stages, not for pricing one
# to three digits.
set -u
PORT=8825
H1='authorization: Bearer abcdefghijklmnopqrstuvwxyz'
H2='cookie: theme=dark'
H3='origin: https://app.example.com'
# Overridable so a focused question (say, just full/corslite/nocors) does not pay for the whole
# ladder: NIFRA_RUNGS="full corslite nocors" FASTIFY_RUNGS="" bash run-ablation.sh
NIFRA_RUNGS="${NIFRA_RUNGS-full nocors nosec noreqid noderive bare}"
FASTIFY_RUNGS="${FASTIFY_RUNGS-full-slow full nocors nosec noreqid noderive bare}"
CLK=$(getconf CLK_TCK)
cd /repo

start_server() {
  if [ "$1" = "nifra" ]; then
    taskset -c 0-3 node bench/http-realworld/dist/ablate-nifra.js "$2" $PORT >/dev/null 2>&1 &
  else
    taskset -c 0-3 node bench/http-realworld/ablate-fastify.ts "$2" $PORT >/dev/null 2>&1 &
  fi
  SRV=$!
  for _ in $(seq 1 80); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -H "$H1" -H "$H2" -H "$H3" \
      "http://127.0.0.1:$PORT/api/orders?limit=10" 2>/dev/null)
    [ "$code" = "200" ] && return 0
    sleep 0.15
  done
  echo "  $1/$2 never became ready" >&2
  return 1
}

drive() {
  taskset -c 4-11 oha -c 50 -z "$1" --no-tui -H "$H1" -H "$H2" -H "$H3" \
    "http://127.0.0.1:$PORT/api/orders?limit=10" 2>/dev/null
}

strip() { sed $'s/\x1b\[[0-9;]*m//g' <<<"$1"; }
cpu_of() { sed 's/.*) //' "/proc/$1/stat" | awk '{print $12, $13}'; }

measure() {
  local fw=$1 rung=$2
  start_server "$fw" "$rung" || return 1
  drive 2s >/dev/null
  read -r ut0 st0 <<<"$(cpu_of "$SRV")"
  local out; out=$(drive 5s)
  read -r ut1 st1 <<<"$(cpu_of "$SRV")"

  local ok req rps
  ok=$(strip "$out" | awk '/Success rate:/ {print $3}')
  req=$(strip "$out" | awk '/^  \[2[0-9][0-9]\]/ {n += $2} END {print n+0}')
  rps=$(strip "$out" | awk '/Requests\/sec:/ {printf "%.0f", $2}')
  if [ "$ok" != "100.00%" ] || [ "${req:-0}" -lt 1000 ]; then
    echo "$fw $rung GATE-FAIL rate=$ok responses=$req"
  else
    awk -v fw="$fw" -v rung="$rung" -v rps="$rps" -v req="$req" -v clk="$CLK" \
        -v ut="$((ut1 - ut0))" -v st="$((st1 - st0))" '
      BEGIN { printf "%-8s %-9s rps=%-7s user_us/req=%.2f sys_us/req=%.2f total_us/req=%.2f\n",
        fw, rung, rps, (ut/clk)*1e6/req, (st/clk)*1e6/req, ((ut+st)/clk)*1e6/req }'
  fi
  kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null; sleep 0.4
}

echo "== pass 1 (nifra ladder, then fastify ladder) =="
for r in $NIFRA_RUNGS; do measure nifra "$r"; done
for r in $FASTIFY_RUNGS; do measure fastify "$r"; done
echo
echo "== pass 2 (reversed order) =="
for r in $FASTIFY_RUNGS; do measure fastify "$r"; done
for r in $NIFRA_RUNGS; do measure nifra "$r"; done

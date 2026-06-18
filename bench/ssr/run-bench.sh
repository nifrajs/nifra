#!/usr/bin/env bash
# Full SSR benchmark with port cleanup and logging.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG="$ROOT/bench/ssr/bench-ssr.log"
PIDFILE="$ROOT/bench/ssr/bench-ssr.pid"

"$ROOT/bench/ssr/free-ports.sh"

: >"$LOG"
echo "started $(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$LOG"
echo $$ >"$PIDFILE"

cd "$ROOT"
env -u NO_COLOR bun run bench/ssr/run.ts 2>&1 | tee -a "$LOG"
ec=${PIPESTATUS[0]}
echo "finished $(date -u +%Y-%m-%dT%H:%M:%SZ) exit=$ec" >>"$LOG"
rm -f "$PIDFILE"
exit "$ec"

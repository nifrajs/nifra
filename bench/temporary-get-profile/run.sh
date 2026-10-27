#!/usr/bin/env bash
set -euo pipefail
runtime=$1
out="$PWD/bench/temporary-get-results"
mkdir -p "$out"

if [[ "$runtime" == node ]]; then
  for suite in realworld generic; do
    for mode in metrics cpu heap; do
      rounds=4
      if [[ "$mode" != metrics ]]; then rounds=2; fi
      node bench/profiling/run.mjs --suite="$suite" --mode="$mode" --targets=nifra,fastify \
        --workloads=get --rounds="$rounds" --requests=60000 --warmup=15000 --out="$out/$suite-$mode"
    done
  done
  exit 0
fi

port=19771
pid=""
cleanup() {
  if [[ -n "$pid" ]]; then kill -TERM "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
}
trap cleanup EXIT

for shape in bare realworld generic; do
  case "$shape" in
    bare) path='/users/123'; check='.id == "123"'; headers=() ;;
    generic) path='/orgs/acme/projects/apollo/tasks/42?verbose=1&trace=abc123'; check='.id == "42" and .org == "acme" and .proj == "apollo"'; headers=(-H 'x-req-id: bench-1') ;;
    realworld) path='/api/orders?limit=10'; check='(.orders | length) == 10'; headers=(-H 'authorization: Bearer abcdefghijklmnopqrstuvwxyz' -H 'cookie: theme=dark' -H 'origin: https://app.example.com' -H 'x-request-id: bench-1') ;;
  esac
  url="http://127.0.0.1:$port$path"
  for round in 1 2; do
    prefix="$out/$runtime-$shape-$round"
    if [[ "$runtime" == bun ]]; then
      NODE_ENV=production taskset -c "$SERVER_CPUS" bun --cpu-prof --cpu-prof-interval=100 \
        --cpu-prof-dir="$out" --cpu-prof-name="$runtime-$shape-$round.cpuprofile" \
        bench/temporary-get-profile/bun-server.ts "$shape" "$port" >"$prefix.server.log" 2>&1 &
    elif [[ "$runtime" == deno ]]; then
      NODE_ENV=production taskset -c "$SERVER_CPUS" deno run --no-check --allow-net --allow-env --allow-read --allow-write \
        bench/temporary-get-profile/deno-server.ts "$shape" "$port" "$prefix.cpuprofile" >"$prefix.server.log" 2>&1 &
    else
      echo "Unknown runtime: $runtime" >&2; exit 1
    fi
    pid=$!
    ready=0
    for _ in $(seq 1 100); do
      if curl -fsS "${headers[@]}" "$url" > "$prefix.response.json" 2>/dev/null && jq -e "$check" "$prefix.response.json" >/dev/null; then ready=1; break; fi
      if ! kill -0 "$pid" 2>/dev/null; then break; fi
      sleep 0.1
    done
    if [[ "$ready" != 1 ]]; then cat "$prefix.server.log"; echo "server did not return the expected body" >&2; exit 1; fi
    taskset -c "$LOAD_CPUS" oha --no-tui --output-format json -n 15000 -c 32 "${headers[@]}" "$url" > "$prefix.warm.json"
    jq -e '.statusCodeDistribution["200"] == 15000 and .summary.successRate == 1' "$prefix.warm.json" >/dev/null
    if [[ "$runtime" == deno ]]; then
      kill -USR1 "$pid"
      for _ in $(seq 1 100); do [[ -f "$prefix.cpuprofile.started" ]] && break; sleep 0.1; done
      [[ -f "$prefix.cpuprofile.started" ]] || { cat "$prefix.server.log"; echo 'profiler did not start' >&2; exit 1; }
    fi
    taskset -c "$LOAD_CPUS" oha --no-tui --output-format json -n 120000 -c 32 "${headers[@]}" "$url" > "$prefix.load.json"
    jq -e '.statusCodeDistribution["200"] == 120000 and .summary.successRate == 1' "$prefix.load.json" >/dev/null
    if [[ "$runtime" == deno ]]; then
      kill -USR2 "$pid"
      for _ in $(seq 1 100); do [[ -s "$prefix.cpuprofile" ]] && break; sleep 0.1; done
      [[ -s "$prefix.cpuprofile" ]] || { cat "$prefix.server.log"; echo 'profile did not finish' >&2; exit 1; }
    fi
    kill -TERM "$pid"
    wait "$pid" || true
    pid=""
    [[ -s "$prefix.cpuprofile" ]] || { cat "$prefix.server.log"; echo 'missing profile' >&2; exit 1; }
    echo "$runtime $shape round $round: profile and 120000 successful requests captured"
  done
done

# Worst-case HTTP benchmark

This benchmark compares Nifra's generic HTTP lane with Elysia across Bun, Node, and Deno.
The application is intentionally adversarial for Nifra: it combines lifecycle hooks, a
multi-parameter route, validated query data, JSON body validation, and dynamic response headers.
It is a valid-request generic-lane stress case, not a representative application benchmark or
the untrusted-stream/body-limit path.

Every server is correctness-probed before load: successful GET and POST responses, dynamic
headers, hook rejection, and invalid-body rejection must all behave as expected. The benchmark
uses paired, count-bounded `oha` runs and reports median results.

## Run

Build the workspace artifacts first:

```sh
bun run build
```

Run a bounded smoke pass across all runtimes:

```sh
BENCH_SCALE=1 BENCH_WARMUP=0 BENCH_RUNS=1 bun run bench/http/worst-case/run.ts
```

Run the full matrix:

```sh
bun run bench/http/worst-case/run.ts
```

For an independent-process aggregate that reduces JIT and machine-load drift:

```sh
bun run bench/http/worst-case/aggregate.ts --runs 7
```

The runner alternates which framework is measured first in each round. The aggregate starts fresh
child processes for every matrix and takes a median across those matrices.

Use the existing component matrices to isolate individual costs before interpreting this stress
case:

```sh
BENCH_SCALE=10 BENCH_WARMUP=1 BENCH_RUNS=3 bun run bench/http/run.ts deno --full
BENCH_SCALE=10 BENCH_WARMUP_S=1 BENCH_DURATION_S=3 BENCH_RUNS=3 bun run bench/http-realworld/run.ts deno
```

The first suite isolates bare routing, dynamic routing, query validation, and body validation. The
real-world suite adds auth, lifecycle middleware, security/CORS headers, and body-observing tiers.

Pass `bun`, `node`, or `deno` to run one runtime section. `BENCH_SCALE` is a percentage of
the default request counts; `BENCH_WARMUP`, `BENCH_RUNS`, and `BENCH_CONNS` control warmup,
sampling, and concurrency. The Deno worst-case targets share the same `Deno.serve` ingress and
runtime framing marker. The runner requires `oha`, Bun, Node, and Deno for the full matrix.

Absolute throughput and latency vary with hardware, runtime versions, and machine load. Compare
Nifra with Elysia from the same run; the ratio is the useful signal.

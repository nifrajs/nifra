# Worst-case HTTP benchmark

This benchmark compares Nifra's generic HTTP lane with Elysia across Bun, Node, and Deno.
The application is intentionally adversarial for Nifra: it combines lifecycle hooks, a
multi-parameter route, validated query data, untrusted JSON body validation, and dynamic
response headers. It is a throughput and latency stress case, not a representative application
benchmark.

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

Pass `bun`, `node`, or `deno` to run one runtime section. `BENCH_SCALE` is a percentage of
the default request counts; `BENCH_WARMUP`, `BENCH_RUNS`, and `BENCH_CONNS` control warmup,
sampling, and concurrency. The runner requires `oha`, Bun, Node, and Deno for the full matrix.

Absolute throughput and latency vary with hardware, runtime versions, and machine load. Compare
Nifra with Elysia from the same run; the ratio is the useful signal.

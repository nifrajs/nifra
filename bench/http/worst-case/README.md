# Worst-case HTTP benchmark

This benchmark compares Nifra with Elysia across Bun, Node, and Deno, plus Fastify across all three.
Fastify's Bun and Deno rows use the same `node:http` server through each runtime's Node compatibility.
The application is intentionally adversarial for Nifra: it combines lifecycle hooks, validated
multi-parameter routes, validated query data, JSON body validation, and dynamic response headers.
Path params are schema-validated in every mode. The default workload exercises Nifra's fused param,
query, and body validation with derive/before/after hooks. Multiple hooks and error hooks are fused
too, so a second no-op hook alone no longer selects the general runner.

Set `BENCH_GENERIC=1` to configure a no-op `onValidationError` recovery hook on Nifra's routes, which
selects its general lifecycle plan for otherwise valid traffic. Elysia and Fastify get a matching
extra no-op before hook. The recovery callback is only invoked by the invalid-param correctness probe;
the measured requests are valid. This compares the same valid route inputs while isolating Nifra's
generic lifecycle lane. It is a valid-request stress case, not a representative application benchmark
or the untrusted-stream/body-limit path.

Every server is correctness-probed before load: successful GET and POST responses, dynamic
headers, hook rejection, invalid-body rejection, and invalid-parameter rejection must all behave as
expected. The benchmark uses paired, count-bounded `oha` runs and reports median results.

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

Run the generic runner across all runtimes:

```sh
BENCH_GENERIC=1 bun run bench/http/worst-case/run.ts
```

For a fresh-process median across three full generic matrices:

```sh
BENCH_GENERIC=1 bun run bench/http/worst-case/aggregate.ts --runs 3
```

For CPU per request, sampled allocations including collected objects, and retained heap, see
[`../../profiling/README.md`](../../profiling/README.md). A heap snapshot or before/after heap delta
measures retention; it does not measure allocation churn.

For an independent-process aggregate that reduces JIT and machine-load drift:

```sh
bun run bench/http/worst-case/aggregate.ts --runs 7
```

The runner alternates which framework is measured first in each round. The aggregate starts fresh
child processes for every matrix and takes a median across those matrices.

Use the existing component matrices to isolate individual costs before interpreting this stress
case:

```sh
BENCH_SCALE=10 BENCH_WARMUP=1 BENCH_ROUNDS=4 bun run bench/http/run.ts deno --full
BENCH_SCALE=10 BENCH_WARMUP=1 BENCH_ROUNDS=4 bun run bench/http-realworld/run.ts deno
```

The first suite isolates bare routing, dynamic routing, query validation, and body validation. The
real-world suite adds auth, lifecycle middleware, security/CORS headers, and body-observing tiers.

Pass `bun`, `node`, or `deno` to run one runtime section. `BENCH_SCALE` is a percentage of
the default request counts; `BENCH_WARMUP`, `BENCH_RUNS`, and `BENCH_CONNS` control warmup,
sampling, and concurrency. The Deno worst-case targets share the same `Deno.serve` ingress and
runtime framing marker. The runner requires `oha`, Bun, Node, and Deno for the full matrix.

Absolute throughput and latency vary with hardware, runtime versions, and machine load. Compare
Nifra with Elysia from the same run; the ratio is the useful signal.
## Prototype-policy diagnostic

Default results keep Nifra's prototype-poisoning rejection enabled. For a separately labelled
control, set `BENCH_BUN_UNGUARDED` to a current bundled Nifra factory. The runner adds
`nifra-unguarded` with `protoPoisoning: "ignore"` and verifies that the opt-out actually took effect
before measuring it. This control is not the default Nifra result. See
[`../../profiling/README.md`](../../profiling/README.md) for commands and the behavior probe.

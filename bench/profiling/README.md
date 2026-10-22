# HTTP attribution

Measure server CPU and allocation churn independently of loopback throughput. Peers are Nifra,
Fastify, and Elysia on the same Node runtime, using the existing built-artifact fixtures. Build first:

```sh
bun run --filter '@nifrajs/core' --filter '@nifrajs/middleware' --filter '@nifrajs/node' build
```

Run one measurement process at a time on an idle machine:

```sh
node bench/profiling/run.mjs --suite=realworld --mode=metrics
node bench/profiling/run.mjs --suite=realworld --mode=cpu --rounds=1
node bench/profiling/run.mjs --suite=realworld --mode=heap --rounds=3
node bench/profiling/run.mjs --suite=generic --mode=metrics --requests=20000
bun --preload ./bench/dist-core-preload.ts bench/profiling/fetch-micro.ts
```

`--suite=worst` measures the existing closed hookful shape. `--suite=generic` adds a second no-op
before hook on all peers, which excludes Nifra's one-derive/one-before fusion. The latter has three
path parameters, validated query data, dynamic headers, and nested POST bodies around 10 and 66 KiB.
These are bounded valid-request stress cases, not an absolute worst case for every application.

The Bun microbenchmark measures GET response production with a reused bodyless Request, excluding
networking, Request construction, and response draining. It compares the closed and generic shapes
over eight balanced rounds. Its ns/request numbers cannot be read as end-to-end latency.

To attribute Bun's generic path in its own engine:

```sh
bun --cpu-prof --cpu-prof-dir=./bench/profiling/results --preload ./bench/dist-core-preload.ts bench/profiling/fetch-micro.ts --target=nifra --shape=generic --count=500000
```

Repeat with `--target=elysia`. Each CPU profile should run by itself. These traces include startup
and forced collections; their throughput should not be used as publication numbers.

Options use `--key=value`: `suite`, `mode`, `rounds`, `requests`, `connections`, and `out`.
`--workloads=get` (or a comma-separated selection) narrows a diagnostic run. Memory capture
requires the complete GET/POST workload and rejects this option.
`--warmup=200000` increases the diagnostic warmup from its default 20,000 requests, capped at
the measured request count. Memory capture follows its separate fresh-process protocol.
For paired implementation experiments, `--baseline=<saved-node-bundle>` adds `nifra-before` and
`--targets=nifra,nifra-before` selects only the two implementations. `build-fixtures.ts` saves
immutable Bun and Node fixture bundles before an edit; `core-ab.ts` compares their GET/POST paths.
Default metrics rounds cover each selected target in each order position.
The default output is ignored under `bench/profiling/results/`. Use a multiple of six rounds for
metrics: each peer occupies each position equally in the rotating/reversing order. Every workload
is warmed up on every peer. Load is count-bounded; every measured request must complete with 200.
Successful response fields are checked before measurement. Startup, load, profiler, and partial
response failures exit nonzero. Children are cleaned up on success or failure.

Metrics mode has no CPU or allocation sampler. It records process user/system CPU per completed
request, RSS, external memory, heap usage, GC count/duration, and heap after a forced collection.
Forced collection precedes every sample and follows the CPU measurement window; these are
diagnostic samples, not untouched production throughput. The CPU window includes process-wide
background GC work. The loopback load generator runs in another process.

`promise-audit.mjs <saved-fixture.js>` separately counts Node PROMISE init events, with request
construction excluded and the await driver included. It includes null/JSON response controls;
event counts are not exact allocation bytes or throughput. `core-ab.ts --cases=<names>` selects
producer controls, including policy/async paths and generic/closed nested POST cases.
See [the generic fastlane audit](FASTLANES-2026-10-22.md) for coverage and rejected experiments.

CPU mode writes Chrome-compatible `.cpuprofile` files. Its top frames use weighted self time;
idle/program frames and inspector control calls are excluded. A caller's allocation frame is not
necessarily where all associated work executes. CPU sample percentages are attribution estimates,
not direct timing of individual functions.

Heap mode writes V8 `.heapprofile` files, using 16 KiB allocation sampling with both
`includeObjectsCollectedByMinorGC` and `includeObjectsCollectedByMajorGC` enabled. Reported bytes
per request estimate cumulative sampled JS allocations, including short-lived collected objects.
They are not exact allocation counts, native allocation totals, RSS, or retained memory. Native
buffers and allocator fragmentation require separate investigation. Do not compare profiled RPS
with metrics-mode RPS: profiler overhead changes the workload.

For Bun/Deno throughput, run the existing paired matrix with `BENCH_GENERIC=1`:

```sh
BENCH_GENERIC=1 BENCH_RUNS=6 bun bench/http/worst-case/run.ts
```

The Node allocation numbers do not characterize Bun's JavaScriptCore engine or Deno's adapter.
Keep raw samples and inspect same-round ratios before calling a small difference a win. A local
sub-2% throughput gap is usually inconclusive; independent process runs on quiet Linux hardware
are needed before making a public consistency claim.

The separate `--mode=memory --packaging=native` protocol starts fresh native-module processes for
all five frameworks. See [`../memory/README.md`](../memory/README.md) for publication requirements
and the distinction between RSS, peak RSS, retained heap, and allocation churn.

For Bun POST producer attribution, use fresh requests and explicitly choose runtime framing:

```sh
bun --preload ./bench/dist-core-preload.ts bench/profiling/fetch-micro.ts --workload=post-large --framed
bun --cpu-prof --cpu-prof-interval=250 --cpu-prof-dir=bench/profiling/results --preload ./bench/dist-core-preload.ts bench/profiling/fetch-micro.ts --target=nifra --shape=generic --workload=post-large --framed --count=10000
```

`--framed` marks only the benchmark's correctly sized synthetic JSON requests, matching runtime
framing. Without it POST measures the untrusted-request delivered-byte lane. GET still reuses its
bodyless request. `bun-server.ts <nifra|elysia> <port>` profiles actual HTTP ingress and flushes Bun's
CLI profile on SIGTERM after bounded load. Bun's `--heap-prof` writes a retained heap snapshot;
its interval flag does not provide allocation sampling. Do not label it bytes allocated/request.

For a Bun HTTP A/B, save before/after factories with `build-fixtures.ts`, then use both bundles:

```sh
BENCH_GENERIC=1 BENCH_BUN_BASELINE=bench/profiling/results/before/fixture-entry.js BENCH_BUN_CANDIDATE=bench/profiling/results/candidate/fixture-entry.js BENCH_WARMUP=5 BENCH_RUNS=6 BENCH_SCALE=50 bun bench/http/worst-case/run.ts bun --json
```

Both Nifra variants use the same diagnostic server entry and packaging. `BENCH_WARMUP` counts
untimed batches per peer; each batch uses one fifth of the measured request count. The default
remains one. Omitting both bundle options preserves the normal peer comparison. `guard-ab.mjs`
and `query-ab.mjs` accept `--before`/`--after` helper bundles for phase attribution on Bun or Node;
those timings exclude HTTP, parsing for the guard case, and request construction.

Prototype-policy diagnostics keep the opt-out separate from default results:

```sh
bun bench/profiling/proto-policy-probe.ts
BENCH_GENERIC=1 BENCH_BUN_CANDIDATE=bench/profiling/results/candidate/fixture-entry.js BENCH_BUN_UNGUARDED=bench/profiling/results/candidate/fixture-entry.js BENCH_RUNS=8 bun bench/http/worst-case/run.ts bun --json
bun bench/profiling/guard-ab.mjs --before=before.mjs --after=after.mjs --extended
```

`nifra-unguarded` explicitly uses `protoPoisoning: "ignore"`; it is a diagnostic, not the default
Nifra result. Its factory must accept the second policy argument (current `build-fixtures.ts`
output does). JSON output includes every round's samples and the warmup batch count. The behavior
probe separates a passthrough schema from the benchmark's closed schema: accepting a request is
not evidence that every schema passes the extra keys to the handler. `--extended` adds mixed
arrays, nested records, and 20,000-level nesting; the deep case caps iterations at 1,000 per round.

Measurement contract tests:

```sh
node --test bench/profiling/measurements.test.mjs bench/profiling/generic.test.mjs
```

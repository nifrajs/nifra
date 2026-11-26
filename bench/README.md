# Benchmarks

`bun run bench/performance-improvements.ts --baseline /absolute/path/to/original-checkout --check
--output BENCHMARKS-PERFORMANCE.json` compares the original and modified source checkouts in
41 paired rounds, alternating measurement order. It checks output equality before measuring output
guards, traced cache hits, full SSR responses, and static schema validation; it also compares identical
bundled route shapes. Proof mode requires an idle host throughout and at least five percent improvement
in every row. Omitting `--check` runs diagnostics; a busy-host diagnostic cannot report a proof as passed.
The JSON report is ignored by Git. Static-schema results measure the opt-in generated module against
the eval-free adapter, rather than against Bun's existing dynamic compiled checker.

`NIFRA_PERF_GATE=1 bun run bench:p99` also refuses a busy host before starting and after measuring.

Both HTTP benchmark aggregators refuse `--write` unless Bun, Node, and Deno match `.tool-versions` and the one-minute host load is at or below the logical CPU count (100% per CPU).

The benchmark **code** lives here; the **results** are not committed. Absolute req/s moves with
machine load (thermal state, other processes), so numbers are only meaningful as same-run ratios on
your own idle machine - a committed snapshot would just be misleading. Run them yourself:

```sh
# HTTP throughput (driven by `oha` - install: https://github.com/hatoo/oha)
bun run bench:http              # full matrix: Bun + Node + Deno
bun run bench:http bun          # one runtime section (bun | node | deno)
bun run bench:http:quick        # fast comparative smoke (~30s): nifra vs the field, ranked
bun run bench:http:quick bun    # …on the Bun section (adds Elysia)
bun run bench:http:quick deno post   # …Deno, POST /users workload
bun run bench:http:update       # repeated matrix, medianed, writes BENCHMARKS.md (git-ignored, local)
bun run bench:http:update --full     # all 4 workloads instead of the default GET + POST pair
bun run bench/http/route-count.ts --check  # fresh-process route-count matrix: core + network
bun run bench:http:realworld    # realistic-shape matrix: auth + middleware route, all runtimes
bun run bench:realworld          # compatibility alias for bench:http:realworld
bun run bench:http:realworld:update  # repeated, medianed, writes BENCHMARKS-REALWORLD.md (git-ignored)
bun run bench:memory               # fresh-process Node RSS/heap comparison, all peers native modules
bun run bench:memory:update        # capture and update the local /benchmarks memory table

# Other axes
bun run bench:ssr               # SSR throughput per UI runtime
bun run bench:ppr               # partial prerendering's server cost and TTFB, with its gates
bun run bench:ppr:gzip          # the same with compression() on
bun run bench:ppr:saturation    # every loader reading a backend pushed past its capacity
bun run bench:size              # server bundle size
bun bench/check.ts              # full vs incremental check after one handler edit in a 400-route app
bun run bench:coldboot          # cold-start time
bun run bench/keep-alive/run.ts # keepAlive restore, latency and memory (React + Svelte, Chromium)
```

`bench:p99`, `bench:soak`, and `bench:coldboot` accept `NIFRA_PERF_GATE=1` to fail closed against
fixed release floors (tail latency, memory drift, boot time) instead of only printing numbers:

```sh
NIFRA_PERF_GATE=1 bun run bench:p99
```

`bench:http:update` writes a local `BENCHMARKS.md` at the repo root (git-ignored). Read the
same-run ratios (nifra vs the field, % of the raw server) - not the absolute numbers.

Workloads are identical across every framework (`bench/http/serve*.ts`): `GET /users/:id` (routing +
path param) and `POST /users` (validated body), plus `GET /` and `GET /search` under `--full`. The
schema probes check required fields, strict types, and accepted extra query/body fields. Fastify's
Ajv coercion is disabled so a string age cannot pass its numeric schema. The probes match Nifra's
benchmark Standard Schema fixture and run before measurement. Each
server runs in its own subprocess. A runtime section boots all of them, then measures in interleaved
rounds (`BENCH_ROUNDS`, default 4, odd counts round up): each round takes one count-bounded `oha`
sample of every server, one at a time, so only the sampled server carries load. A row's % of the raw
server is the median of its per-round ratios, which holds on a busy host because both samples of a
round see the same load; the aggregators pool those per-round ratios across runs. Round order is in
`bench/rounds.ts`.
The Deno rows use the shared direct `Deno.serve` ingress in `bench/http/deno-ingress.ts`, including
the same parser-framing marker for Nifra; they do not mix Nifra's production adapter overhead into
the framework comparison.

Fastify also runs on Bun and Deno through each runtime's `node:http` compatibility, reusing the same
`serve-node.ts` implementation as Node. Those rows measure the compatibility path, not native
`Bun.serve` or `Deno.serve` ingress.
`bench:http:realworld` (`bench/http-realworld/`) runs the same GET/POST split on a route with what a
real API route actually has - fixed security and CORS response headers, a request-id hook,
bearer-token auth, and a cookie read - which nifra compiles into its fused derive-and-before lane.
The GET and POST validators require the same fields and types and ignore unknown fields, matching
Nifra's benchmark Standard Schema fixture; the runner probes missing fields, wrong types, and extra
fields before timing. Each
target writes the same headers for the one allowed fixture origin; preflight and rejected-origin
policy behavior are outside the timed workload.
Its Bun runner preloads `dist-core-preload.ts` so workspace middleware shares the app's built core;
otherwise Bun's source export condition loads a second core beside the explicit dist app imports.
The preload is scoped to the local checkout; `BENCH_APP_DIR` keeps its own package resolution.
A third workload adds one body-observing middleware (an `x-body-hash` over the final serialized
body) through each framework's own idiomatic body tier (nifra `onResponseBody`, Fastify `onSend`,
Elysia `mapResponse`, Hono buffer-and-rewrap, Express `res.json` wrap, inline for the raw ceilings) -
the cost a header-only comparison can't show. Both HTTP matrices use count-bounded `oha` samples, and the realistic runner fails closed unless every request returns HTTP 200. Duration cutoffs can cancel in-flight POSTs and trigger Deno.serve slowdowns. Compare a framework's ratio across both suites to see
its fast-path premium directly.

`bench/http/route-count.ts` is the general-pipeline baseline. It runs each 1/10/50/200-route row in
a fresh Bun process across static, dynamic, query, body, and derive/before/after lifecycle shapes.
It correctness-probes status and JSON before load, then reports separate direct `app.fetch` and
real TCP `Bun.serve` measurements with request count, concurrency, median/p50, p99, runtime, and
success rate. `--check` fails closed unless every loaded response succeeds. The route-count matrix
is a diagnostic baseline, not a framework-specific fast lane or a public throughput promise.

The mixed-route worst-case matrix also runs correctness probes before count-bounded `oha` load. Its
Node section includes Nifra, Elysia, and Fastify on the same route graph, body/query workload,
dynamic headers, hook behavior, and direct Node ingress. Comparisons below five percent require
confirmation on the Linux performance rig before being treated as a release claim.

`bench/otel/` measures the tracing seams. `cache-wrap.ts` is the in-process `cache.wrap()` fresh-hit
path with no observer, a no-op observer, and `cacheTracing()` unbound and bound; set
`NIFRA_CACHE_BASELINE` to another checkout's `packages/cache/src/index.ts` to add that copy as a
baseline row. `bridge-fetch.ts` (Bun or Node) is the in-process `app.fetch()` cost of the OTel SDK
bridge's `around()` plugin, and `bridge-http.ts` runs the same comparison over TCP with count-bounded
`oha` on Bun and Node. Node loads the built dist: run `bun run build && bun run
scripts/link-for-node.ts` first.

`bench/ssr/README.md` says what each SSR row runs. Every headline row is a real app built and served
the way its framework ships it, measured in interleaved rounds against the comparator.

## In CI

The `Benchmark accuracy` workflow (`.github/workflows/benchmark-accuracy.yml`) runs nightly and on
demand, as three jobs: HTTP with real-world, SSR, and memory. Hosted runners vary in CPU model, so
what is read together is measured in one job. SSR's Node and Bun are sampled in the same rounds, with
each rival measured once for both reports.

`.github/workflows/benchmarks.yml` is the report-only path: on demand, and the HTTP matrices on a PR
labelled `bench`. It runs one job per HTTP suite and runtime, and one SSR job for Node and Bun.

Both go through `bench/ci/run.ts`. A job splits the runner's physical cores in two
(`BENCH_SERVER_CPUS` for the servers, `BENCH_LOAD_CPUS` for oha, both taskset lists the matrices also
take by hand on Linux) and runs the whole matrix at least 3 times in fresh processes. After that it reruns only the workloads that still hold a row whose 95%
interval is wider than 10% of its median, up to 5 runs; reruns reuse the first run's builds. The
stopping rule reads only interval widths, never which row leads. Every ratio in the job summary is a
median of per-round ratios with a distribution-free interval (`bench/ci/stats.ts`); the req/s beside
it is the median over every round and moves with the runner.

The `nifra-engine` rows serve nifra on the in-repo Rust engine (`@nifrajs/node-engine`, experimental)
on Node. The matrices include them only when `NIFRA_RUST_ENGINE_PATH` names a built addon, as CI
does, and the website's tables leave them out.

Artifacts keep every raw round, CPU topology and steal time, the commit SHA, runtime versions and
sampling settings for 90 days. Rows still noisy after the run budget are marked unsettled, and
benchmark measurements do not gate merges.

```sh
bun run bench/ci/run.ts --suite http --runtime bun --pin   # one job, Linux only with --pin
bun run bench/ci/run.ts --suite ssr --runtime node,bun --out 'bench-ci/ssr-{runtime}.json'   # unpinned
bun run bench/ci/summary.ts bench-ci                       # combine downloaded reports
```

## Route performance in Chromium

`bun bench/route-performance/run.ts` builds a synthetic catalog and its product detail route for
Bun. Pass `--vite` to use the Vite production build. Install Chromium with
`bun bench/node_modules/playwright/cli.js install chromium` or set `NIFRA_TEST_CHROME` to an
installed Chrome executable.

Each sample uses a fresh browser context with 150 ms added latency, 200 kB/s download, 90 kB/s
upload, and 4× CPU slowdown. After one warm-up, the script reports the median of ten samples
(`BENCH_BROWSER_SAMPLES` overrides ten). It measures navigation start to an enabled filter button
with a paint opportunity, verifies the click handler, then measures a real click to the first
client-side detail page with a paint opportunity. It verifies the JSON data request and compares
the initial JavaScript URLs in the build report with the browser's resource timings. Gzip totals
come from the build and transfer bytes come from Chromium.

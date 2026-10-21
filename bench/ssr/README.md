# SSR benchmark

`bun run bench:ssr` renders the same 50-item catalog in every framework and measures throughput with
`oha` (50 connections). Every row proves it rendered the catalog before it is measured.

```sh
bun run build                                # node bundles and client builds read packages/*/dist
bun run bench:ssr                            # every table
bun run bench/ssr/run.ts react vue:A         # React (both tables) + Vue Table A
BENCH_ROUNDS=3 BENCH_SSR_JSON=out.json bun run bench/ssr/run.ts svelte
bun run bench/ssr/run.ts --runtime node vue  # nifra's Vue rows on Node only, with every rival
```

Knobs: `BENCH_ROUNDS` (default 5), `BENCH_DURATION_S` (5), `BENCH_WARMUP_S` (3), `BENCH_CONNS` (50).
`BENCH_SSR_JSON` writes every round's req/s per row.
`BENCH_SSR_RESULTS_JSON` preserves the complete measured rows, including latency and client bytes.
`BENCH_SSR_RAW_DIR` preserves the oha JSON for each warmup and measurement sample.
`BENCH_SERVER_CPUS` and `BENCH_LOAD_CPUS` pin the servers and `oha` to disjoint CPUs on Linux
(`bench/pinning.ts`), and `BENCH_ROUND_OFFSET` starts the round rotation further along.
A table filter that matches no table fails the run instead of measuring nothing.
Every accepted sample must have a 100% success rate and only HTTP 200 responses.
Duration-bounded samples finish outstanding requests instead of cancelling them at the deadline.
A row that fails to build or to measure a round fails the run once every selected table has run:
it exits non-zero and writes no results.

Runtime versions are pinned in `.tool-versions`. Comparator apps have isolated installs;
after changing their dependencies, run `bun install` in each changed app before measuring,
including when its `node_modules` already exists. SolidStart 2 uses Vite and Nitro;
SvelteKit 3 configures its adapter in the Vite plugin.

## How a table is measured

Each table builds its rows, then runs interleaved rounds. A round starts each row's server as a fresh
process, warms it, and takes one `oha` sample. Rounds run in pairs, one order forward and then
reversed, so any two rows swap places within a pair; the rotation advances each pair, so every row
also runs first (`bench/rounds.ts`).

A row's **ratio** is the median of its per-round ratios to the table's baseline, a comparator measured
in the same rounds. On a busy host the absolute req/s moves with the load, but within a round both
rows of a pair see the same host, so the ratio holds. Read ratios, not req/s.

Compare Node rows with Node rows. The meta-frameworks run on Node; nifra runs on Bun and on Node.

## Every row is measured uncompressed

Every request the bench makes, from `oha` and from the harness, sends `accept-encoding: identity`
(`SSR_BENCH_REQUEST_HEADERS` in `harness.ts`). Without it `oha` asks for `gzip, compress, deflate,
br`, and the rows answer that differently by default: the Next.js standalone server gzips every
response (`compress: true`), `react-router-serve` brotli-compresses, and nifra, Nuxt, SvelteKit and
SolidStart send dynamic pages uncompressed. Those rows would pay a per-request compression cost the
others skip, so the table would measure compression settings rather than rendering. A production
deployment usually compresses at a CDN or reverse proxy in front of any of them.

Before each sample, the harness fetches the page with the same headers and fails the row if the
response carries a `content-encoding` other than `identity`. A row that compresses regardless of
what the client asked for drops out of the table instead of being measured compressed.

SvelteKit's static row serves a precompressed `.br` (or `.gz`) copy of its prerendered page when the
request allows it, a real advantage for that row in production. Under `identity` it serves the plain
HTML file like every other static row.

## Row kinds

| Kind | What runs per request | Like for like? |
| --- | --- | --- |
| app | A framework app, built and served the way that framework ships it | Yes, with the other app rows |
| renderer | A UI library's render-to-string in a bare server, no framework (Preact only) | No |
| static host | A prerendered file from a plain file server | No framework code runs |

### App rows (the headline)

Every nifra app row is a real app, written the way the docs teach it:

- `routes/index.*` - the page component (`.tsx`, `.vue` or `.svelte`), typed with
  `LoaderData<typeof loader>`
- `routes/index.backend.ts` - a `loader` with a `loaderOutput` schema
- `nifra.config.ts` and `backend/framework.ts` - the adapter and its build plugins

`nifra build --target bun` or `--target node` builds it, and the `server.js` it generates serves it.
That server is what `nifra start` runs: `createWebApp`, file routes, the loader, the hashed client
bundle and its static files.

| Framework | nifra app | Comparator (Node) |
| --- | --- | --- |
| React | `nifra-app` | Next.js standalone server (`force-dynamic`), React Router `react-router-serve` |
| Solid | `nifra-solid-app` | SolidStart 2 (Vite + Nitro `node_server`) |
| Vue | `nifra-vue-app` | Nuxt (Nitro `node-server`, route cache off) |
| Svelte | `nifra-svelte-app` | SvelteKit `adapter-node` |
| Preact | `nifra-preact-app` | none runs on Node (Fresh is Deno-only); `preact-ssr` is `preact-render-to-string` in a bare Node server, the renderer's ceiling |

No dynamic row caches anything: each request runs the loader and renders the page.

### The renderer row (Preact only)

Preact has no meta-framework that runs on Node, so its Table A compares the app with `preact-ssr`:
`preact-render-to-string` in a bare Node server, with no router, loader or schema. It is the one raw
row the website shows, labelled as the renderer's ceiling and kept out of the headline chart and the
multipliers. The other frameworks' tables compare with their meta-frameworks only.

## Table B: SSG and ISR

- **SSG, app rows**: the same app with `export const prerender = true`, built by `nifra build --target
  bun|node`. The build prerenders the page into `_prerendered/`, and the generated server answers it
  from that file after `use` middleware. Comparators serve their prerendered page through their own
  Node server.
- **SSG files on a static host**: the `nifra build --target static` output served by
  `static-server.ts`, a plain Bun file server that reads the file on each request. No nifra code
  runs, so this row measures that file server. A CDN's number is the CDN's.
- **ISR (React)**: the built `createWebApp` wrapped in `withISR` from a custom server entry, as
  the `/docs/rendering` page shows, on Bun and on Node. The generated `server.js` has no ISR.
  Next.js ISR is the comparator. Both are cache-warmed before measuring.

Cached rows are not SSR rows: compare within Table B only.

## In CI

The Benchmarks workflow (`bench/README.md`) runs one SSR job per runtime, Bun and Node, through
`bench/ci/run.ts --suite ssr`. A job runs `run.ts --runtime <runtime> --json`: every table, with
nifra's app rows on that runtime and every rival app, renderer and static-host row, in 4 interleaved
rounds. `--json` sends the tables to stderr and prints one result line holding every round; it never
touches the website's numbers. The rival apps run on Node in both jobs.

The job's report divides each row by the table's ceiling where the table has one: the raw renderer in
Preact's Table A, the static file server in every Table B. Every rival app's row also shows nifra over
it, against nifra's row that serves the same way, so React's Table B splits into an SSG comparison
(against `next (static)`) and an ISR one (against `next (ISR)`). A row that fails to build or to measure
fails the job, as it fails a local run.

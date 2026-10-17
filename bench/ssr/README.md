# SSR benchmark

`bun run bench:ssr` renders the same 50-item catalog in every framework and measures throughput with
`oha` (50 connections). Every row proves it rendered the catalog before it is measured.

```sh
bun run build                                # node bundles and client builds read packages/*/dist
bun run bench:ssr                            # every table
bun run bench/ssr/run.ts react vue:A         # React (both tables) + Vue Table A
BENCH_ROUNDS=3 BENCH_SSR_JSON=out.json bun run bench/ssr/run.ts svelte
```

Knobs: `BENCH_ROUNDS` (default 5), `BENCH_DURATION_S` (5), `BENCH_WARMUP_S` (3), `BENCH_CONNS` (50).
`BENCH_SSR_JSON` writes every round's req/s per row.

## How a table is measured

Each table builds its rows, then runs interleaved rounds. A round starts each row's server as a fresh
process, warms it, and takes one `oha` sample. Rounds run in pairs, one order forward and then
reversed, so any two rows swap places within a pair; the rotation advances each pair, so every row
also runs first (`bench/rounds.ts`).

A row's **ratio** is the median of its per-round ratios to the table's baseline, a comparator measured
in the same rounds. On a busy host the absolute req/s moves with the load, but within a round both
rows of a pair see the same host, so the ratio holds. Read ratios, not req/s.

Compare Node rows with Node rows. The meta-frameworks run on Node; nifra runs on Bun and on Node.

## Row kinds

| Kind | What runs per request | Like for like? |
| --- | --- | --- |
| app | A framework app, built and served the way that framework ships it | Yes, with the other app rows |
| own server | nifra's `renderPage` called from a server you write yourself | No |
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
| Solid | `nifra-solid-app` | SolidStart (Nitro `node-server`) |
| Vue | `nifra-vue-app` | Nuxt (Nitro `node-server`, route cache off) |
| Svelte | `nifra-svelte-app` | SvelteKit `adapter-node` |
| Preact | `nifra-preact-app` | none exists; `preact-ssr` is `preact-render-to-string` in a bare Node server, the renderer's ceiling |

No dynamic row caches anything: each request runs the loader and renders the page.

### Own-server rows: nifra's render API in a server you write

Each Table A also has one row per runtime that calls `renderPage({ adapter, chain, data })` from a
hand-written server: a raw `Bun.serve` fetch handler, and the same handler on Node through
`@nifrajs/node`'s `serve` (see `nifra*/handler.ts`). No nifra router, `createWebApp`, file routes,
loader or schema check runs.

The row shows that nifra's page renderer is a function any request handler can call, in a server
you own. Other frameworks can run inside a server you own too: SvelteKit's `handler.js`, a Next.js
custom server, Nitro's `node_middleware` preset, React Router's Express adapter. There, though,
the framework's router still owns each request. Here your code does, and nifra only renders.

It is **not** like for like with the comparators, which run full file-routed apps. The website
labels these rows and keeps them out of the headline chart and the multipliers. Each Table A ends
with the paired ratio of the app row to its own-server row, per runtime: the cost of the framework
layer.

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

# nifra site (Svelte)

A nifra + **Svelte 5** SSR site — file-based routes, typed loaders/actions, hydration — that deploys to
**Bun, Node (Docker), Deno Deploy, Cloudflare Pages, and Vercel Edge from one source**. `app.fetch`
is Web-standard, so only the server entry + build target differ per platform.

```sh
bun install
bun run dev        # nifra dev → true-HMR dev server (Vite + nifra SSR) at http://localhost:3000
bun run preview    # wrangler pages dev dist → preview the built Cloudflare bundle (run `bun run build` first)
```

Routes are `.svelte` components under `routes/` — `index.svelte` (landing + a live loader/action
counter), `_layout.svelte` (chrome via the `children` snippet), `_404.svelte`. A route's
`loader`/`action`/`meta` are named exports from its `<script module>` block; the page receives the
loader output as the `data` prop (`let { data } = $props()`). The frontend adapter is one line in
`framework.ts`; data lives behind `backend.ts`. Each `build*` script wires `svelteBunPlugin("dom")` for
the client and `("ssr")` for the server.

## Deploy — pick a target

| target | build | deploy |
| --- | --- | --- |
| **Bun** (flagship) | `bun run build:bun` | `bun run start` — any host |
| **Node** | `bun run build:node` | `docker build -t app . && docker run -p 3000:3000 app` (or `bun run start:node`) |
| **Deno Deploy** | `bun run build:deno` | `deployctl deploy --prod --entrypoint=dist-deno/server-deno.js` |
| **Cloudflare Pages** | `bun run build` | `bun run deploy:cf` |
| **Vercel Edge** | `bun run build:vercel` | `bun run deploy:vercel` |

nifra never enters your cloud credentials — it scaffolds the configs (`Dockerfile`, `deno.json`,
`wrangler.toml`, Vercel Build Output API); you run the vendor CLI.

## Structure

```
routes/        index.svelte (landing), _layout.svelte (chrome), _404.svelte
framework.ts   the adapter (svelteAdapter) — imported by the server entries (edge-bundlable)
nifra.config.ts the nifra CLI's dev/build config (adapter + clientModule + Svelte plugins) — read by `nifra dev`
backend.ts     your contract (loaders/actions call it in-process)
server-bun.ts  Bun entry (Bun.serve)         build-bun.ts    → dist-bun/
_worker.ts     Cloudflare Pages entry        build.ts        → dist/
server-node.ts Node entry (@nifrajs/node)       build-node.ts   → dist-node/   (Dockerfile)
server-deno.ts Deno entry (@nifrajs/deno)       build-deno.ts   → dist-deno/    (deno.json)
server-vercel.ts Vercel Edge function        build-vercel.ts → .vercel/output/
```

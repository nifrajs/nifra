# nifra's website

nifra's own marketing site — **built with nifra** (`@nifrajs/web` + React), **server-rendered on the
edge**, deployed to **Cloudflare Pages**. Dogfood: the landing page's stats come from a typed loader
calling nifra's own backend in-process during SSR.

```
site/
  routes/          file-based routes (index.tsx = the landing page, _layout.tsx = chrome + CSS)
  backend.ts       the contract the loader calls (api.stats.get())
  _worker.ts       the SSR entry → createWebApp + toFetchHandler (built into dist/_worker.js)
  build.ts         buildClient + buildServer → assembles the Cloudflare Pages output
  wrangler.toml    Pages config (output dir + nodejs_compat)
```

## Build

```sh
bun run site:build        # from the repo root  (or: cd site && bun run build)
```

Produces `site/dist/`, a Cloudflare-Pages-ready directory:

- `_worker.js` — the nifra SSR worker (edge build: `workerd`/`edge-light` conditions,
  `react-dom/server.edge`). Handles page routes.
- `_routes.json` — `{ exclude: ["/assets/*"] }`, so Pages serves the client bundle statically from
  its CDN and only page routes hit the worker.
- `assets/*` — the content-hashed client bundle (hydration JS), served at `/assets/*`.

## Develop / verify locally (on workerd, no account needed)

```sh
cd site && bun run dev    # wrangler pages dev → http://localhost:8788
```

This runs the exact Pages setup on workerd (Cloudflare's runtime) locally — SSR + static assets +
hydration — without deploying. Verified: `/` SSRs the landing page, `/assets/*` serves the bundle,
the page hydrates with no console errors.

## Deploy to Cloudflare Pages

> Not run here (no Cloudflare credentials in this environment). One command on your machine:

```sh
bun run site:build
cd site && bunx wrangler pages deploy dist
```

(First run: `wrangler login`, then `wrangler pages project create nifra-site`.) Or connect this repo
in the Cloudflare dashboard with build command `bun run site:build` and output directory `site/dist`.

## Deploy anywhere — one source, many runtimes

`app.fetch` is a Web-standard handler, so the **same site source** builds to every target — only the
server entry + `buildServer` target/conditions differ. The routes, backend, and client bundle are
shared.

| target | build | run / serve | verified |
| --- | --- | --- | --- |
| **Cloudflare Pages** | `bun run site:build` → `dist/` (`_worker.js` + `_routes.json`) | `wrangler pages deploy dist` | workerd (`wrangler pages dev`) ✅ |
| **Node** | `bun run site:build:node` → `dist-node/` | `node dist-node/server-node.js` (`@nifrajs/node`) | real `node` + curl + browser ✅ |
| **Deno** | `bun run site:build:deno` → `dist-deno/` | `deno run -A dist-deno/server-deno.js` (`@nifrajs/deno`) | real `deno` + curl ✅ |
| **Vercel Edge** | `bun run site:build:vercel` → `dist-vercel/` (`function.js` + `static/`) | Vercel Edge Function (Build Output API) | handler SSR-verified ✅ (deploy = your step) |

What differs per target is only the **server**: Cloudflare/Vercel use the edge build
(`workerd`/`edge-light` + `react-dom/server.edge`); Node uses `target: "node"`. The Node/Deno
entries add a tiny `/assets/*` static handler (the adapters serve `app.fetch` only); Cloudflare and
Vercel serve the client bundle from their CDN.

> No cloud credentials in this environment — every target is **built and run/verified locally**
> (Node/Deno: process + curl + browser; Vercel: the Edge handler imported and asserted to SSR).
> The actual cloud deploy is the one command in the table.

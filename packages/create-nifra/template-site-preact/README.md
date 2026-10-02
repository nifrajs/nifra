# nifra site (Preact)

A nifra + **Preact** SSR site - file-based routes, typed loaders/actions, hydration - that deploys to
**Bun, Node (Docker), Deno Deploy, Cloudflare Pages, and Vercel Edge from one source**. `app.fetch`
is Web-standard, so only the server entry + build target differ per platform.

```sh
bun install
bun run dev        # nifra dev → true-HMR dev server (Bun + nifra SSR) at http://localhost:3000
```

The backend starter includes response security headers, explicit-origin CORS, a 30-second request
deadline, bounded concurrency, and a development rate limit. Its in-memory rate-limit store refuses
production unless `NIFRA_ALLOW_MEMORY_RATE_LIMIT=true`; use a shared store for multi-instance deploys.
For cookie sessions, add signed CSRF middleware and require both runtime authentication and CSRF
evidence in `nifra.assurance.ts`.

Routes are Preact function components (JSX, via `jsxImportSource: "preact"`) under `routes/` -
`index.tsx` (landing + a live loader/action counter), `_layout.tsx` (chrome), `_404.tsx`. The
frontend adapter is one line in `backend/framework.ts`; data lives behind `backend/app.ts`.

## Deploy

The app deploys to the `target` in `nifra.config.ts` (chosen with `bun create nifra --target`, switched
with `nifra target <t>`). `bun run build` runs `nifra build`, which generates that target's server
entry from `backend/` and `routes/`, so the app carries no per-runtime entry or build script.

| target | `bun run build` emits | then |
| --- | --- | --- |
| **bun** (default) | `dist/server.js` + assets | `bun dist/server.js` on any host (`--docker` adds a Dockerfile) |
| **node** | `dist/server.js` + assets | `node dist/server.js` (`--docker` adds a Dockerfile) |
| **deno** | `dist/server.js` + assets | `deployctl deploy --prod --entrypoint=dist/server.js` |
| **cloudflare** | `dist/` (`_worker.js`, `_routes.json`) | `wrangler pages deploy dist` |
| **vercel** | `.vercel/output/` (Build Output API) | `vercel deploy --prebuilt` |

nifra never enters your cloud credentials: it writes the target's config (`wrangler.toml`,
`deno.json`, a `Dockerfile`) and you run the vendor CLI.

## Structure

```
routes/        index.tsx (landing), _layout.tsx (chrome), _404.tsx
               index.backend.ts - the landing page's loader/action (server only)
backend/       app.ts - your contract (loaders/actions call it in-process)
               framework.ts - the adapter (preactAdapter) - imported by the server entry `nifra build` generates (edge-bundlable)
frontend/      browser-only code (components, hooks) - created when you need it
shared/        code both sides import (types, formatting, validation) - may import only shared code
nifra.config.ts the nifra CLI's dev/build config (adapter + clientModule) - read by `nifra dev` and `nifra build`,
               including `target`, where `nifra build` deploys
```

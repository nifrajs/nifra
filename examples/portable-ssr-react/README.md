# nifra — portable SSR (one app, five runtimes)

The **same** file-routed React app, server-rendered on **Cloudflare Workers, Node, Deno, Deno Deploy,
and Vercel Edge**. `createWebApp` + the React adapter are identical everywhere; only a ~3-line entry
(the serve/export shape + how static assets are served) and the bundle's `target` differ.

## Layout

- `routes/`, `backend.ts` — the app (shared across all runtimes).
- `app.ts` — `createWebApp(...)` → the nifra `app`. Every entry imports this.
- `cloudflare.ts` / `node.ts` / `deno.ts` / `vercel.ts` — the per-runtime entries.
- `build.ts` — `buildClient` once → `public/assets`; `buildServer` per entry → `dist/<runtime>`.

`buildServer` codegens a **static-import** route manifest (no runtime `node:fs`) and bundles each entry
with the right `target` (edge runtimes share the default `browser`; Node uses `target: "node"`).

```sh
bun run build                          # build the @nifrajs/* packages (monorepo)
bun run examples/portable-ssr-react/build.ts
```

## Run / verify each runtime

| Runtime | Command | Assets |
|---|---|---|
| **Cloudflare Workers** | `cd examples/portable-ssr-react && bunx wrangler dev` | Workers Assets (`./public`) |
| **Node** | `cd examples/portable-ssr-react && node dist/node/node.js` | from disk (`node:fs`) |
| **Deno** | `cd examples/portable-ssr-react && deno run --allow-net --allow-read --allow-env dist/deno/deno.js` | `Deno.readFile` |
| **Deno Deploy** | same `deno.ts` entry — Deno Deploy is the same runtime | deployed files |
| **Vercel Edge** | `cd examples/portable-ssr-react && bunx edge-runtime --listen dist/vercel/vercel.js` | Vercel `/public` |

Each was verified locally on the real runtime (Node, Deno, workerd via wrangler) or its faithful
emulator (`edge-runtime` is Vercel's own Edge Runtime sandbox). Visit `/` (loader + increment action),
`/users/7` (dynamic param + `meta` title), `/about`, and an unknown path (`_404`).

## Deploying (account-gated — commands, not verified here)

`build.ts` produces the artifacts each platform ships; the deploy step is platform CLI + account:

- **Cloudflare** — `bunx wrangler deploy` (uses `wrangler.toml`: `main` = the worker, `assets` = `./public`).
- **Node** — run `dist/node/node.js` under any process manager; reverse-proxy + serve `public/` (or let
  the bundle's `/assets/*` route serve from disk).
- **Deno Deploy** — `deployctl deploy --entrypoint dist/deno/deno.js` (include `public/`).
- **Vercel Edge** — ship `vercel.ts` as an Edge Function with `{ "runtime": "edge" }` (project/`vercel.json`
  config) + `public/` as static assets.

These are documented, not run here (no cloud accounts); the **runtimes** are emulator/local-verified above.

## Notes

- **Vercel entry shape.** `vercel.ts` is a pure fetch-event worker (`addEventListener("fetch", …)`) —
  the form the Edge Runtime (and the `edge-runtime` emulator) execute. The edge-target flag lives in
  `vercel.json` (`{ "functions": { "vercel.ts": { "runtime": "edge" } } }`), not an `export const
  config`, so the bundle stays a worker the emulator accepts.
- **Lazy/code-split routes.** Pass `lazy: true` to any `buildServer` call to emit one chunk per route
  (loaded on first request) instead of a single file. On Cloudflare, ship the chunks with wrangler's
  `no_bundle` + `find_additional_modules` + an ESModule `rule`; Node/Deno import them natively.
- **In-memory `count`** is per-process / per-isolate (a real app uses a shared store via `c.env`).
- Real cloud deploys (CF/Vercel/Deno Deploy accounts) are out of scope — the entries + local-runtime
  verification are the deliverable. Build artifacts (`server-manifest.ts`, `public/`, `dist/`) are
  git-ignored; `build.ts` regenerates them.

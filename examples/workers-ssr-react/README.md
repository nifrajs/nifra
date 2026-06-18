# nifra — frontend SSR on Cloudflare Workers (React)

The full file-routed nifra frontend — SSR, hydration, loaders, actions, dynamic params, `<head>`,
streaming, `defer()`, soft-nav — running on **Cloudflare Workers / workerd**, where there is **no
filesystem at request time**. The same `routes/` tree that serves on Bun/Node/Deno, on the edge.

## How the disk-less edge is handled

`discoverRoutes` (the Bun/Node/Deno path) scans `node:fs` and dynamic-imports each route by a runtime
path — neither exists on workerd. So the build pre-bakes everything:

- **`buildClient`** → `public/assets/` — the content-hashed, code-split client bundle (served by
  Workers Assets).
- **`buildServer`** → `dist-server/worker.js` — a self-contained worker. It codegens a
  **static-import** route manifest (`generateServerManifest`, reusing `buildManifest`, with the
  client entry URL **baked in**) and bundles `worker.ts` with edge conditions (React resolves to
  `react-dom/server`'s edge build). No `node:fs`, no dynamic-path import.

`worker.ts` is just `createWebApp(...)` + `export default toFetchHandler(app)`. **Assets-first**
wrangler config serves `/assets/*` from `./public`; everything else falls through to the worker (SSR).

## Run it

```sh
bun run examples/workers-ssr-react/build.ts
cd examples/workers-ssr-react && bunx wrangler dev   # real workerd
```

Then visit the dev URL:

- **`/`** — SSR'd home with a typed `loader` (count) + an `action` (increment); the form works with
  JS off (progressive enhancement) and revalidates without a reload once hydrated.
- **`/users/7`** — a dynamic `[id]` param + typed loader; the tab title updates from the route `meta`.
- **`/slow`** — `defer()`'d data: the shell + fallback render immediately, then `feed` **streams in**
  mid-response and hydrates with no re-fetch. On a client nav it streams over the soft-nav endpoint.
- **`/about`**, and any unknown path → the `_404` route.

Navigation between routes is client-side (no full reload), with `<head>` updates, scroll restoration,
and view transitions where supported — the whole F7–F10 polish, on the edge.

> Build artifacts (`server-manifest.ts`, `public/`, `dist-server/`) are git-ignored — `build.ts`
> regenerates them. In a standalone project `@nifrajs/*` resolve from `node_modules`; in this monorepo
> they resolve from the workspace (build the packages first: `bun run build`).

# nifra examples

Runnable examples. The single-file `.ts` examples are CI-typechecked, so they can't drift
from the API; the full-stack `web-solid/` example uses Solid JSX + its own toolchain, so it's
excluded from the monorepo typecheck and browser-verified instead.

| File | Shows |
|---|---|
| [`inline-server.ts`](inline-server.ts) | The minimal inline server; `app.fetch()` without a port |
| [`contract-client.ts`](contract-client.ts) | `defineContract` + `implement` + an end-to-end-typed client |
| [`schema-openapi.ts`](schema-openapi.ts) | `t` validation + `toOpenAPI` |
| [`hardened.ts`](hardened.ts) | `securityHeaders` + `cors` + `rateLimit` via `app.use()` |
| [`edge.ts`](edge.ts) | `app.fetch` as the universal handler (Workers / Deno / edge) |
| [`serve-on-node.ts`](serve-on-node.ts) | `@nifrajs/node` — serve a nifra app on Node's `http` server |
| [`web-solid/`](web-solid/) | Full-stack SSR — `@nifrajs/web` + `@nifrajs/web-solid` server-render a Solid page, then hydrate it |
| [`web-react/`](web-react/) | The same loop with React — `@nifrajs/web` + `@nifrajs/web-react` (one agnostic core, a different renderer) |
| [`routing-solid/`](routing-solid/) | File-based routing — a `routes/` dir, nested layout, `[id]` param, `_404` (Solid) |
| [`routing-react/`](routing-react/) | The same file-based routing, on React |
| [`workers/`](workers/) | nifra **backend** on Cloudflare Workers — `toFetchHandler` + `c.env` + `c.waitUntil` |
| [`workers-ssr-react/`](workers-ssr-react/) | Full **frontend SSR on Workers** (React) — disk-less edge via `buildServer` + Workers Assets |
| [`workers-ssr-solid/`](workers-ssr-solid/) | The same frontend SSR on Workers, on Solid |
| [`portable-ssr-react/`](portable-ssr-react/) | **One app, five runtimes** — the same SSR app on Cloudflare, Node, Deno, Deno Deploy, Vercel Edge |
| [`portable-ssr-solid/`](portable-ssr-solid/) | The same five-runtime portability, on Solid (Vercel Edge is account-gated — see its README) |

```sh
bun run examples/inline-server.ts
bun run examples/contract-client.ts
bun run examples/schema-openapi.ts
bun run examples/hardened.ts
bun run examples/edge.ts
bun run examples/serve-on-node.ts
```

The full-stack SSR examples build a client bundle, then serve. Solid needs its SSR Babel
transform preloaded; React's JSX is Bun-native, so it needs no preload (set `PORT` to change
the port):

```sh
# Solid
bun run examples/web-solid/build.ts
bun --preload examples/web-solid/ssr-preload.ts examples/web-solid/server.ts

# React — same renderPage, different adapter; no preload
bun run examples/web-react/build.ts
bun examples/web-react/server.ts
```

The file-based routing examples (`routing-*/`) discover a `routes/` dir, SSR each route's
layout chain, and hydrate the matched route (visit `/`, `/users/7`, and an unknown path):

```sh
bun run examples/routing-solid/build.ts
bun --preload examples/routing-solid/ssr-preload.ts examples/routing-solid/server.ts

bun run examples/routing-react/build.ts
bun examples/routing-react/server.ts
```

Both routing examples also exercise the F7 navigation polish:

- **head/meta** — `routes/index.tsx` exports a static `meta` (`title` + a `description`) and
  `routes/users/[id].tsx` exports a `meta(args)` derived from its loader data. SSR injects them;
  watch the browser tab title update as you navigate between the two (no full reload).
- **prefetch** — hovering (or keyboard-focusing) the `user 7` link warms that route's chunk +
  loader data, so the click transitions instantly. Automatic — no example code; it's `installHistory`.
- **scroll restoration** — scroll a route, navigate away, then go back: the prior scroll position
  is restored; a fresh navigation starts at the top. Also automatic via `installHistory`.
- **view transitions** — client navigations are wrapped in `document.startViewTransition` where the
  browser supports it (Chrome/Edge), so route changes cross-fade. Automatic + progressive (a no-op
  in browsers without the API); pairs with prefetch so the transition starts instantly.

…and F8 streaming SSR + F9 deferred data + F10 streaming soft-nav:

- **`defer()` + `<Await>`** — `routes/slow.tsx`'s loader marks slow data deferred:
  `feed: defer(slowPromise)`. The server **streams**: the shell + `<head>` (with a `modulepreload`
  of the entry) and the `<Await fallback>` flush immediately, then the resolved `feed` is **painted
  mid-stream** (~400ms later) behind `<Suspense>` and hydrates with no client re-fetch. Visit
  `/slow` on a fresh server and watch "loading…" become the content. `<Await errorFallback>` renders
  if the deferred rejects. The streamed `Response` flushes incrementally on Bun (`app.listen()`),
  Node (`@nifrajs/node`), and Deno (`@nifrajs/deno`) alike.
- **streaming soft nav** — the same `/slow` route also streams its deferred data on a **client**
  navigation, not just the full-page load: click the `streaming` nav link (or navigate from `/`) and
  the transition lands immediately on the shell + `<Await fallback>`, then `feed` streams in behind
  it ~400ms later — no blocking, no re-fetch. Under the hood the soft-nav (`X-Nifra-Data`) GET returns
  NDJSON (line 1 = critical data + placeholders, then a settle line per deferred); a route with no
  `defer()` keeps returning a single JSON. Open DevTools → Network → the `/slow` request and watch
  the response stream its lines. A superseded navigation (click `streaming`, then quickly `home`)
  abandons the in-flight stream and lands cleanly on the new route.

…and the F13 depth — matched-route preload + deferred everywhere (`routing-react`):

- **matched-route-chunk modulepreload** — `server.ts` passes `buildClient`'s per-route chunk map
  (`routePreload`), so each page `<link rel="modulepreload">`s its **matched** route's chunks (its
  layout chain + own chunk) alongside the entry — the route code downloads in parallel during HTML
  parse instead of after the entry runs. View source on `/` vs `/users/7`: each preloads a different,
  route-specific set. Automatic; the build maps it (`BuildManifest.routes`).
- **nested `defer()`** — `routes/slow.tsx` also defers a value nested in an **array → object**
  (`panels[0].chart`); it streams + hydrates behind its own `<Await>`, independently of the top-level
  `feed`. `defer()` works at any depth, not just top-level loader keys.
- **`defer()` in actions** — `routes/index.tsx`'s `action` returns a deferred "receipt": click
  **increment** and the count updates immediately (the mutation isn't blocked) while the receipt
  streams into `<Await actionData>` ~300ms later. With JS off, the full-page POST resolves it before
  rendering (progressive enhancement).

…and the F15 depth — optimistic UI + revalidation control (`routing-react`, the `todos` nav link):

- **optimistic UI** — `routes/todos.tsx` renders an **optimistic row** instantly from the in-flight
  submission's `FormData` (the router exposes `submission` + `pending` as props; no per-adapter hook).
  Type an item and click **add (revalidates)**: the row appears immediately (greyed, "saving…", the
  button disabled while `pending`), the action runs (~700ms, artificial), then the active loader
  **revalidates** and the optimistic row reconciles to the real item. Submit `fail` (or empty) and the
  action returns a typed `{ ok: false }` — the optimistic row **reverts** (the revalidated list omits
  it) and an error shows; because it's error *data* (a 200), not a thrown 500, there's no native-form
  fallback. (`pending`/`submission` are client-only — absent on SSR, so no hydration mismatch.)
- **revalidation control** — the second form carries `data-nifra-revalidate="false"`: **add (skips
  revalidation)** posts the action but does **not** re-fetch the loader (open DevTools → Network: one
  `POST`, **no** follow-up `X-Nifra-Data` GET). The new row is shown from the action's returned
  `created` (`actionData`) instead of a full-list re-read — for when the action already returned what
  changed. Scope note: nifra's loader is atomic (one object per route, no keyed query cache), so the
  granularity is *whether* the active loader re-runs, not per-key partial revalidation.

…and the F16 depth — concurrent fetchers + targeted revalidation (`routing-react`, the `todos` route):

- **concurrent fetchers** — each todo row has its own **bump** button backed by `useFetcher(`bump-${id}`)`
  (from `@nifrajs/web-react/fetcher`). Each bump runs in an **independent** fetcher with its own
  `pending` — so several rows can be mutating at once (each button shows "bumping…", disabled) without
  blocking the list, the add form, or each other. The heavy logic is the agnostic `router.fetcher(key)`
  store; `useFetcher` is the same thin subscribe-binding as `mountRouter` (server-safe: idle on SSR).
- **targeted revalidation** — the bump action returns `revalidate(["/todos"], …)`, so when each bump
  settles the server declares `/todos` changed (the `X-Nifra-Revalidate` header) and the client refreshes
  exactly that route — the row's new text appears with no full-page reload. A mutation thus refreshes
  every mounted view of the changed route (the list here; in a larger app, any other fetcher showing it).
- **keyed query-cache** — the "home count (via useQuery)" panel uses `useQuery(["count"], fn)` (from
  `@nifrajs/web-react/query`): an **arbitrary-keyed**, client-interactive cache distinct from the route
  loader. The count is fetched + cached under `["count"]`; the **refresh** button calls
  `useQueryClient().invalidateQueries(["count"])` to refetch it (showing the stale value while
  `isFetching`). Two `useQuery`s with the same key share **one** cache entry + **one** fetch (dedup),
  with `staleTime` freshness and GC. Loaders stay the SSR data source; queries are client-first.

The same file-routed frontend also runs on **Cloudflare Workers / workerd** (no filesystem at request
time) — `workers-ssr-react/` and `workers-ssr-solid/`:

```sh
bun run build                                   # build the @nifrajs/* packages first (monorepo)
bun run examples/workers-ssr-react/build.ts     # buildClient → public/assets, buildServer → worker
cd examples/workers-ssr-react && bunx wrangler dev   # real workerd
# …or examples/workers-ssr-solid for the Solid variant
```

`generateServerManifest` pre-bakes the route manifest as **static imports** (no runtime `node:fs`,
no dynamic-path import); `buildServer` bundles a self-contained worker with the renderer's **edge**
build (it pins `react-dom/server` / `solid-js/web` to their edge/server builds); **Workers Assets**
(`assets = { directory }`) serves the hashed client bundle, and the worker — just `createWebApp(...)`
+ `toFetchHandler(app)` — handles SSR. Loaders, actions, `<head>`, streaming, `defer()`, and soft-nav
all work on the edge; verified hydrating on real workerd for React and Solid alike.

…and that bundle is **portable across runtimes** — `portable-ssr-react/` runs the same app on five:

```sh
bun run examples/portable-ssr-react/build.ts            # buildClient + buildServer per target
cd examples/portable-ssr-react
bunx wrangler dev                                       # Cloudflare Workers (real workerd)
node dist/node/node.js                                  # Node
deno run --allow-net --allow-read --allow-env dist/deno/deno.js   # Deno (= Deno Deploy)
bunx edge-runtime --listen dist/vercel/vercel.js        # Vercel Edge (real Edge Runtime emulator)
```

A shared `app.ts` (`createWebApp`) + a ~3-line per-runtime entry (the serve/export shape + how assets
are served); `buildServer({ target })` picks the bundle shape (edge runtimes share `browser`, Node uses
`node`). Pass `buildServer({ lazy: true })` for **code-split** routes — one chunk per route, loaded on
first request (on Cloudflare, shipped via wrangler's `no_bundle` + `find_additional_modules`). Each
runtime was verified on the real runtime or its faithful local emulator.

[`portable-ssr-solid/`](portable-ssr-solid/) is the same app on **Solid**, proving the agnostic seam
across both renderers. It's verified on Node, Deno (= Deno Deploy), and Cloudflare; Vercel Edge is
account-gated for Solid (its `solid-js/web` server build needs node-compat, which the strict local
emulator lacks but real Vercel Edge provides — see the example's README).

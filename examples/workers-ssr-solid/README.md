# nifra — frontend SSR on Cloudflare Workers (Solid)

The same disk-less-edge story as [`workers-ssr-react`](../workers-ssr-react/), on **Solid** — proving
the agnostic seam: identical `routes/` structure, loaders, actions, `defer()`, soft-nav, only the
renderer differs.

## What's Solid-specific

- **`buildClient`** uses `solidBunPlugin("dom")` + `conditions: ["bun", "solid", "browser"]` (the
  hydratable client transform), as on Bun/Node/Deno.
- **`buildServer`** uses `solidBunPlugin("ssr")` (the SSR transform) + `conditions: ["workerd",
  "worker", "edge-light", "solid", "browser"]`. The **`worker`** condition makes `solid-js/web`
  resolve to its **server** runtime (`renderToStream`) rather than the dom one — and since `worker`
  precedes `browser` in solid's exports map, it wins even with `browser` present. (React needs no
  such plugin — its JSX is Bun-native and `buildServer` pins `react-dom/server` to its edge build.)

Everything else is identical to the React example: `worker.ts` is `createWebApp(...)` +
`toFetchHandler(app)`, assets-first wrangler config, `generateServerManifest`'s static-import manifest.

## Run it

```sh
bun run examples/workers-ssr-solid/build.ts
cd examples/workers-ssr-solid && bunx wrangler dev   # real workerd
```

Visit `/` (loader + increment action), `/users/7` (param + meta title), `/slow` (`defer()` streaming),
`/about`, and any unknown path (`_404`) — SSR'd by Solid on the edge, hydrated, with client-side
navigation. Build artifacts (`server-manifest.ts`, `public/`, `dist-server/`) are git-ignored.

# nifra — portable SSR on Solid (one app, five runtimes)

The Solid twin of [`portable-ssr-react`](../portable-ssr-react/): the **same** file-routed app, SSR'd
on **Cloudflare Workers, Node, Deno, Deno Deploy, and Vercel Edge** — proving the agnostic seam across
both renderers *and* all five runtimes. `createWebApp` + the entries are identical; only the adapter
(`solidAdapter`) + the build's Solid transform differ.

## Solid specifics

- **`buildClient`** uses `solidBunPlugin("dom")` + `conditions: ["bun", "solid", "browser"]`.
- **`buildServer`** uses `solidBunPlugin("ssr")`; its built-in shim pins `solid-js/web` to its **server**
  build on the edge (`browser`) targets (the `worker` condition would too but segfaults Bun.build), and
  the `node`/`solid` conditions resolve it on the Node target.

Everything else mirrors the React example: a shared `app.ts` + `cloudflare`/`node`/`deno`/`vercel`
entries + one `build.ts`; assets served by the platform on edge, from disk on Node/Deno.

## Run / verify each runtime

```sh
bun run build                                   # build the @nifrajs/* packages first (monorepo)
bun run examples/portable-ssr-solid/build.ts
cd examples/portable-ssr-solid
bunx wrangler dev                                       # Cloudflare Workers (real workerd)
node dist/node/node.js                                  # Node
deno run --allow-net --allow-read --allow-env dist/deno/deno.js   # Deno (= Deno Deploy)
bunx edge-runtime --listen dist/vercel/vercel.js        # Vercel Edge (real Edge Runtime emulator)
```

Visit `/` (loader + increment action), `/users/7` (param + `meta` title), `/about`, and any unknown
path (`_404`) — SSR'd by Solid on each runtime, hydrated, with client-side navigation. The Vercel entry
is a pure fetch-event worker (the runtime flag goes in `vercel.json`). Build artifacts
(`server-manifest.ts`, `public/`, `dist/`) are git-ignored.

> **Verified locally:** Node, Deno (= Deno Deploy), and Cloudflare Workers (`wrangler dev`) — SSR +
> hydration. **Vercel Edge note:** Solid's `solid-js/web` *server* build imports `node:*` (`Buffer`,
> streams), so it needs a node-compat layer — Node, Deno, and Cloudflare (`nodejs_compat`) all provide
> one, but the strict local **`edge-runtime` emulator does not**, so it crashes there. Real Vercel Edge
> *does* offer node-compat, so the same bundle is expected to run there (not locally verifiable without
> an account). The fully edge-native Solid build is selected by the `worker` condition, which currently
> **segfaults `Bun.build` 1.3.14** — so nifra uses the node-compat server build
> for now. React (`portable-ssr-react`) ships an edge-native `react-dom/server.edge`, so it runs in the
> emulator too.

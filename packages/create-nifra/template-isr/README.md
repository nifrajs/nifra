# nifra + ISR

A nifra + React app with **Incremental Static Regeneration** — pages are cached and served
stale-while-revalidate, backed by **Workers KV** in production (so the cache and on-demand purges hold
across instances) and an in-memory store for local dev.

## Develop

On real workerd with a local KV (no Cloudflare account needed):

```sh
bun install
bun run build      # buildClient → public/assets, buildServer → dist-server/worker.js
bun run dev        # bunx wrangler dev
```

Or a plain Bun server with an in-memory store:

```sh
bun run build
bun run dev:bun    # http://localhost:3000
```

Watch the `x-nifra-isr` response header as you reload: `miss` (rendered + stored) → `hit` (fresh, from
cache) → `stale` (served instantly while it regenerates). The page shows a server-render counter that
holds across `hit`s and bumps on a `miss`/regeneration.

## How it works

- `withISR(app, { store, revalidate, now })` wraps the app's `fetch`. Only full-document `text/html`
  `GET` `200`s are cached; assets, soft-nav data fetches, redirects, and errors pass through.
- A route sets its freshness with `export const revalidate = <seconds>` (see `routes/index.tsx`).
- `KVCacheStore(env.ISR_CACHE)` is the shared, durable store (production); `MemoryCacheStore` is dev.
- `revalidateEndpoint({ store, secret })` is the on-demand purge handler:

  ```sh
  curl -X POST 'http://localhost:3000/__velo/revalidate?path=/' -H 'x-nifra-revalidate-token: dev-secret'
  ```

## Deploy

```sh
bunx wrangler kv namespace create ISR_CACHE   # paste the id into wrangler.toml
bunx wrangler secret put REVALIDATE_SECRET     # set a real purge secret
bun run build && bunx wrangler deploy
```

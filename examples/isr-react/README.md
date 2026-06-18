# isr-react — Incremental Static Regeneration on nifra

A nifra + React app whose rendered pages are **cached and served stale-while-revalidate** by
`withISR`. Dynamic pages get static-like speed and revalidate in the background — the same wrapper
runs on Bun (dev) and Cloudflare Workers (prod); the only line that changes is the store.

## Run it (Bun, in-memory store)

```sh
bun run examples/isr-react/build.ts     # build the client bundle (→ public/assets) + worker bundle
bun examples/isr-react/server.ts        # serve with ISR on http://localhost:3000
```

Watch the `x-nifra-isr` response header as you reload:

```sh
curl -sD - -o /dev/null http://localhost:3000/ | grep -i x-nifra-isr   # miss → hit → (after 2s) stale
```

The index route declares `export const revalidate = 2` (a 2-second freshness window). The page shows
a **server-render counter**: it holds across cache `hit`s (the loader doesn't run) and bumps when a
`miss` or a background regeneration renders the page.

### On-demand purge

Drop a path's cached entry so the next request re-renders it:

```sh
curl -X POST 'http://localhost:3000/__velo/revalidate?path=/' \
  -H 'x-nifra-revalidate-token: dev-secret'
# → { "revalidated": "/" }   (wrong/missing token → 401; checked in constant time)
```

## Run it on the edge (workerd + Workers KV)

`wrangler dev` runs the worker on real workerd with a **local** KV namespace (miniflare) — no
Cloudflare account needed:

```sh
bun run examples/isr-react/build.ts
cd examples/isr-react && bunx wrangler dev
```

The only difference from `server.ts` is the store: `MemoryCacheStore` → `KVCacheStore(env.ISR_CACHE)`,
so the page cache and on-demand purges hold **across worker instances**. `ctx.waitUntil` keeps the
worker alive while a stale page regenerates behind the response.

To deploy: create a KV namespace (`bunx wrangler kv namespace create ISR_CACHE`), paste its id into
`wrangler.toml`, set the purge secret (`bunx wrangler secret put REVALIDATE_SECRET`), then
`bunx wrangler deploy`.

## How it works

- `withISR(app, { store, revalidate, now })` wraps the app's `fetch`. Only full-document `text/html`
  `GET` `200`s are cached; assets, data-mode soft-nav fetches, redirects, and errors pass through.
- Per-route `export const revalidate` (seconds) → the `x-nifra-isr-revalidate` header → the page's TTL.
- `MemoryCacheStore` (dev) refuses to run under `NODE_ENV=production`; `KVCacheStore` (prod) is the
  shared, durable store. Any backend fitting the `CacheStore` interface works.
- `revalidateEndpoint({ store, secret })` is the on-demand purge handler.

See [the rendering docs](../../site/routes/docs/rendering.tsx) for the full picture (SSG + ISR).

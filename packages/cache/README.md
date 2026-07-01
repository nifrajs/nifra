# @nifrajs/cache

Typed KV cache for nifra — **TTL**, **stale-while-revalidate**, **tag invalidation**, and **single-flight
stampede protection** on a **pluggable store** (in-memory by default; bring CF KV / Redis for a shared
cache). **Dependency-free**; runs on Bun/Node/Deno/Workers.

```ts
import { createCache } from "@nifrajs/cache"

const cache = createCache({ defaultTtlMs: 30_000 })

// Cache-aside in a loader — one DB hit per key per TTL, even under a stampede:
export async function loader({ params }) {
  const user = await cache.wrap(
    `user:${params.id}`,
    () => db.users.find(params.id),
    { ttlMs: 30_000, swrMs: 60_000, tags: [`user:${params.id}`] },
  )
  return { user }
}

// On write, drop everything tagged for that user:
await cache.invalidateTag(`user:${id}`)
```

## Semantics

- **`wrap(key, loader, opts)`** — returns the cached value, or runs `loader`, stores, and returns it.
  - **Fresh** (`now < staleAt`): the cached value, no loader call.
  - **Stale-but-live** (`staleAt ≤ now < expiresAt`, i.e. within `swrMs`): the stale value is returned
    **immediately** while a **background** refresh runs (deduped). Latency stays flat; data self-heals.
  - **Miss/expired**: awaits `loader`. Concurrent misses for the same key share **one** call (no stampede).
  - A throwing `loader` is **not** cached (and in the background path goes to `onError`, never rejects the caller).
- **`set` / `get` / `has` / `delete`**, **`invalidateTag(tag)`**, **`clear()`**.
- TTL: `ttlMs` (→ stale) + optional `swrMs` (→ served-stale window) + optional `tags`.

## Stores

The default `MemoryCache` is in-process with lazy expiry, a tag index, and an optional LRU cap
(`new MemoryCache({ maxEntries: 10_000 })`). For a cache shared across instances, implement `CacheStore`
(`get` / `set` / `delete` / `invalidateTag` / `clear`) over CF KV, Redis, etc.:

```ts
const cache = createCache({ store: new RedisCacheStore(redis) })
```

On **Cloudflare Workers** the in-memory cache is per-isolate and short-lived — back it with **CF KV** (or
the Cache API) via a `CacheStore` for anything that should survive across requests/instances.

## API

- `createCache(options?)` → `Cache` — `{ store?, defaultTtlMs?, now?, onError? }`.
- `cache.wrap(key, loader, { ttlMs?, swrMs?, tags? })` · `get` · `has` · `set` · `delete` · `invalidateTag` · `clear`.
- `MemoryCache({ maxEntries?, now? })` — the default store; implement `CacheStore` for your own.

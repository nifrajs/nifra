/**
 * @nifrajs/cache — a typed KV cache for nifra: TTL, stale-while-revalidate, tag invalidation, and
 * single-flight stampede protection, on a pluggable store (in-memory by default; bring CF KV / Redis for
 * a shared cache). Dependency-free; runs on Bun/Node/Deno/Workers.
 *
 *   import { createCache } from "@nifrajs/cache"
 *   const cache = createCache()
 *   const data = await cache.wrap("key", () => expensive(), { ttlMs: 60_000 })
 */

export { createCache } from "./cache.ts"
export { MemoryCache, type MemoryCacheOptions } from "./memory-cache.ts"
export type {
  Cache,
  CacheOptions,
  CacheStore,
  SetOptions,
  StoredEntry,
  WrapOptions,
} from "./types.ts"

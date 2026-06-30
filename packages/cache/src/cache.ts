/**
 * The cache facade — typed get/set/wrap over a {@link CacheStore}, with TTL, stale-while-revalidate, and
 * single-flight stampede protection. Mirrors the other nifra primitives: a factory, an injectable clock,
 * and error isolation (a background revalidation that throws goes to `onError`, never rejects the caller).
 *
 *   import { createCache } from "@nifrajs/cache"
 *
 *   const cache = createCache({ defaultTtlMs: 30_000 })
 *   // Cache-aside in a loader — one DB hit per 30s per key, stampede-safe:
 *   const user = await cache.wrap(`user:${id}`, () => db.user(id), { ttlMs: 30_000, swrMs: 60_000, tags: [`user:${id}`] })
 *   await cache.invalidateTag(`user:${id}`) // on write
 */
import { MemoryCache } from "./memory-cache.ts"
import type { Cache, CacheOptions, CacheStore, SetOptions, WrapOptions } from "./types.ts"

/** Create a cache over the given (or a fresh in-memory) store. */
export function createCache(options: CacheOptions = {}): Cache {
  const defaultTtlMs = options.defaultTtlMs ?? 60_000
  const now = options.now ?? (() => Date.now())
  // The default store must share the facade's clock, or test-injected timestamps look instantly expired.
  const store: CacheStore = options.store ?? new MemoryCache({ now })
  const onError =
    options.onError ??
    ((error, key) =>
      console.error(`[nifra/cache] revalidate ${JSON.stringify(key)} failed:`, error))

  // Single-flight: concurrent loads for the same key share one promise (miss stampede + SWR dedup).
  const inflight = new Map<string, Promise<unknown>>()

  async function get<T = unknown>(key: string): Promise<T | undefined> {
    const entry = await store.get(key)
    return entry === undefined ? undefined : (entry.value as T)
  }

  async function has(key: string): Promise<boolean> {
    return (await store.get(key)) !== undefined
  }

  async function set<T>(key: string, value: T, opts: SetOptions = {}): Promise<void> {
    const ttlMs = opts.ttlMs ?? defaultTtlMs
    const swrMs = Math.max(0, opts.swrMs ?? 0)
    const t = now()
    await store.set(
      key,
      { value, staleAt: t + ttlMs, expiresAt: t + ttlMs + swrMs },
      opts.tags ?? [],
    )
  }

  function load(key: string, loader: () => unknown, opts: WrapOptions): Promise<unknown> {
    const existing = inflight.get(key)
    if (existing !== undefined) return existing
    const p = (async () => {
      const value = await loader()
      await set(key, value, opts)
      return value
    })().finally(() => {
      if (inflight.get(key) === p) inflight.delete(key)
    })
    inflight.set(key, p)
    return p
  }

  function revalidate(key: string, loader: () => unknown, opts: WrapOptions): void {
    if (inflight.has(key)) return // a refresh is already running
    void load(key, loader, opts).catch((error) => {
      try {
        onError(error, key)
      } catch {
        /* a throwing onError must not surface */
      }
    })
  }

  async function wrap<T>(
    key: string,
    loader: () => T,
    opts: WrapOptions = {},
  ): Promise<Awaited<T>> {
    const entry = await store.get(key)
    if (entry !== undefined) {
      if (now() < entry.staleAt) return entry.value as Awaited<T> // fresh hit
      revalidate(key, loader as () => unknown, opts) // stale-but-live → serve stale, refresh in background
      return entry.value as Awaited<T>
    }
    return (await load(key, loader as () => unknown, opts)) as Awaited<T> // miss → load (single-flight)
  }

  return {
    get,
    has,
    set,
    wrap,
    delete: (key) => Promise.resolve(store.delete(key)),
    invalidateTag: (tag) => Promise.resolve(store.invalidateTag(tag)),
    clear: () => Promise.resolve(store.clear()),
  }
}

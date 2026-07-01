/**
 * @nifrajs/cache — types for the typed KV cache.
 *
 * The facade ({@link Cache}) is typed + owns TTL/SWR/stampede logic; the {@link CacheStore} is a raw
 * key→entry adapter (memory by default; bring CF KV / Redis for shared or durable caching). Dependency-free.
 */

/** A cached entry as the store holds it. */
export interface StoredEntry {
  readonly value: unknown
  /** Epoch-ms after which the entry is gone — a miss. */
  readonly expiresAt: number
  /** Epoch-ms after which the entry is stale: still served during the SWR window while a refresh runs.
   * Equal to `expiresAt` when there's no stale-while-revalidate window. */
  readonly staleAt: number
}

/**
 * Raw key→entry storage. The default {@link MemoryCache} is in-process; implement this over CF KV /
 * Redis / etc. for a cache shared across instances. All methods may be sync or async — the cache awaits them.
 */
export interface CacheStore {
  /** The live entry for `key`, or `undefined` if missing or hard-expired (`now >= expiresAt`). */
  get(key: string): StoredEntry | undefined | Promise<StoredEntry | undefined>
  /** Store `entry` under `key`, indexed by `tags` for {@link CacheStore.invalidateTag}. */
  set(key: string, entry: StoredEntry, tags: readonly string[]): void | Promise<void>
  delete(key: string): void | Promise<void>
  /** Drop every entry carrying `tag`. */
  invalidateTag(tag: string): void | Promise<void>
  clear(): void | Promise<void>
}

export interface SetOptions {
  /** Time-to-live (ms) before the value goes stale. Default: the cache's `defaultTtlMs`. */
  readonly ttlMs?: number
  /** Extra ms past TTL during which the stale value is served while a background refresh runs. Default 0. */
  readonly swrMs?: number
  /** Tags for group invalidation via `invalidateTag`. */
  readonly tags?: readonly string[]
}

export type WrapOptions = SetOptions

export interface CacheOptions {
  /** Storage adapter. Default: a fresh {@link MemoryCache}. */
  readonly store?: CacheStore
  /** Default TTL (ms) for `set`/`wrap` when none is given. Default 60_000. */
  readonly defaultTtlMs?: number
  /** Injectable clock (tests). Default `() => Date.now()`. */
  readonly now?: () => number
  /** Called when a background SWR revalidation throws. Default: `console.error`. */
  readonly onError?: (error: unknown, key: string) => void
}

export interface Cache {
  /** The cached value for `key`, or `undefined` if missing/expired. Pass `T` for the value type. */
  get<T = unknown>(key: string): Promise<T | undefined>
  /** Whether a live (non-expired) entry exists. */
  has(key: string): Promise<boolean>
  /** Store `value` under `key`. */
  set<T>(key: string, value: T, options?: SetOptions): Promise<void>
  delete(key: string): Promise<void>
  /** Drop every entry tagged `tag`. */
  invalidateTag(tag: string): Promise<void>
  clear(): Promise<void>
  /**
   * Cache-aside: return the cached value, or run `loader`, store the result, and return it. Stampede-safe
   * (concurrent misses for one key share a single `loader` call) and SWR-aware (a stale-but-live value is
   * returned immediately while a deduped background refresh runs). A throwing `loader` is NOT cached.
   */
  wrap<T>(key: string, loader: () => T, options?: WrapOptions): Promise<Awaited<T>>
}

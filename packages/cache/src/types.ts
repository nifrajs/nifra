/**
 * @nifrajs/cache - types for the typed KV cache.
 *
 * The facade ({@link Cache}) is typed + owns TTL/SWR/stampede logic; the {@link CacheStore} is a raw
 * key→entry adapter (memory by default; bring CF KV / Redis for shared or durable caching). Dependency-free.
 */

/** A cached entry as the store holds it. */
export interface StoredEntry {
  readonly value: unknown
  /** Epoch-ms after which the entry is gone - a miss. */
  readonly expiresAt: number
  /** Epoch-ms after which the entry is stale: still served during the SWR window while a refresh runs.
   * Equal to `expiresAt` when there's no stale-while-revalidate window. */
  readonly staleAt: number
}

/**
 * Raw key→entry storage. The default {@link MemoryCache} is in-process; implement this over CF KV /
 * Redis / etc. for a cache shared across instances. All methods may be sync or async - the cache awaits them.
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

/**
 * `useCapability` from `@nifrajs/core/capabilities`, taken as a parameter rather than imported so this
 * package keeps its zero dependencies - a cache should not drag the server into a bundle that only
 * wanted a cache. Wiring it is one line where the cache is created.
 */
export type CapabilityBeacon = (context: object, capability: string) => void

/** Capability tokens this cache announces. Defaults: `cache.read` and `cache.write`. */
export interface CacheCapabilities {
  readonly read?: string
  readonly write?: string
}

/** A cache operation reported to a {@link CacheObserver}. `revalidate` is the background SWR refresh. */
export type CacheOperation =
  | "get"
  | "has"
  | "set"
  | "wrap"
  | "delete"
  | "invalidateTag"
  | "clear"
  | "revalidate"

/**
 * How an operation ended. Reads report `hit`, `stale` (served from the SWR window) or `miss`; writes and
 * a completed revalidation report `ok`; `error` means the store or the loader threw.
 */
export type CacheOutcome = "hit" | "stale" | "miss" | "ok" | "error"

/** One settled cache operation, as an observer sees it. */
export interface CacheEvent {
  readonly op: CacheOperation
  readonly outcome: CacheOutcome
  /** Epoch ms the operation started. */
  readonly startedAt: number
  /** Monotonic duration in ms. */
  readonly durationMs: number
  /**
   * The raw key. Keys often hold ids or emails: this value is for in-process use, and an exporter
   * decides what (if anything) of it leaves the process. Absent for `clear` and `invalidateTag`.
   */
  readonly key: string | undefined
  /** The tag passed to `invalidateTag`, with the same caution as `key`. */
  readonly tag: string | undefined
  /** Tags written by `set`, `wrap` and `revalidate`; 1 for `invalidateTag`; otherwise 0. */
  readonly tagCount: number
  /**
   * The context bound with `for(context)`, or `undefined` for the unbound cache. For `revalidate` it is
   * the context whose read found the stale entry.
   */
  readonly context: object | undefined
}

/**
 * Called once per operation after it settles, never before the caller sees the result. A throwing (or
 * rejecting) observer is swallowed: it cannot change a cache result.
 */
export type CacheObserver = (event: CacheEvent) => void

export interface CacheOptions {
  /** Storage adapter. Default: a fresh {@link MemoryCache}. */
  readonly store?: CacheStore
  /**
   * Make cache operations produce capability evidence:
   *
   *   import { useCapability } from "@nifrajs/core/capabilities"
   *   const cache = createCache({ beacon: useCapability })
   *
   * Then `cache.for(context)` announces its capability before each operation. Evidence from the CALL is
   * per-route and exact, where evidence from an import is per-module and therefore as broad as the
   * module - which is why a beacon can say something a provenance rule cannot.
   */
  readonly beacon?: CapabilityBeacon
  /** Override the announced tokens when the app names its capabilities differently. */
  readonly capabilities?: CacheCapabilities
  /** Default TTL (ms) for `set`/`wrap` when none is given. Default 60_000. */
  readonly defaultTtlMs?: number
  /** Injectable clock (tests). Default `() => Date.now()`. */
  readonly now?: () => number
  /** Called when a background SWR revalidation throws. Default: `console.error`. */
  readonly onError?: (error: unknown, key: string) => void
  /**
   * Receives one {@link CacheEvent} per operation - the seam `cacheTracing()` from `@nifrajs/otel/cache`
   * plugs into. Without one the cache reads no extra clock and allocates no event.
   */
  readonly observer?: CacheObserver
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
  /**
   * A view bound to a request (or job) context. With a `beacon`, every operation announces its
   * capability first and fails closed when the route did not declare it. With an `observer`, every
   * event carries `context`, which is how a tracer parents the span to `context.trace`.
   *
   * `wrap` announces BOTH read and write, because a miss writes and which one happens is not known
   * before the call. A declaration describes what a route may do, so the conservative answer is the
   * correct one.
   *
   * Requires `beacon` or `observer`. With neither this throws rather than handing back a view that
   * quietly does nothing - a beacon nobody notices is missing is the exact failure the beacon exists
   * to prevent.
   */
  for(context: object): Cache
}

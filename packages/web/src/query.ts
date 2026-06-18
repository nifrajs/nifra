/**
 * The agnostic keyed query-cache — a `query(key, fn)` primitive with in-flight dedup, `staleTime`
 * freshness, prefix `invalidateQueries`, and bounded GC. Pure logic, no `window`, no framework, no
 * `Date.now`/timers (the clock is injected) — so it unit-tests deterministically and is safe to import
 * from the SSR core's main entry. A per-adapter binding (`useQuery`/`createQuery`) subscribes to a
 * query's `subscribe`/`snapshot` store (the same shape the router + fetchers use).
 *
 * This is a SECOND keyed cache, distinct from the router's path-keyed route cache (F16): route loaders
 * + navigation use the path cache; component-level interactive data (search, infinite scroll, polling)
 * uses this arbitrary-keyed query cache. The two coexist.
 */

/** A query's lifecycle status. `pending` = no data yet; `success`/`error` once it has settled once. */
export type QueryStatus = "pending" | "success" | "error"

/** A query's observable state — what a binding renders. A new (frozen) object per transition, so a
 * `useSyncExternalStore`/signal binding can compare by reference. */
export interface QueryState<T = unknown> {
  readonly status: QueryStatus
  readonly data: T | undefined
  readonly error: unknown
  /** True while a fetch is in flight — the initial load OR a background refetch (data may still show). */
  readonly isFetching: boolean
  /** When `data` was last set (via the injected clock); drives `staleTime`. `-Infinity` until first set. */
  readonly updatedAt: number
}

/** A stable per-key handle: subscribe to its state, read a snapshot, trigger a fetch/refetch. */
export interface QueryHandle<T = unknown> {
  snapshot: () => QueryState<T>
  subscribe: (listener: () => void) => () => void
  /** Fetch when stale or absent (fresh ⇒ no-op); joins an in-flight fetch (dedup). Resolves to the
   * data, or rejects if the fetch threw. */
  fetch: () => Promise<T>
  /** Refetch regardless of staleness (still joins an in-flight fetch). */
  refetch: () => Promise<T>
}

export interface QueryClientOptions {
  /** Monotonic clock in ms — injected so the core stays deterministic + testable; the adapter binding
   * passes `() => Date.now()`. */
  readonly now: () => number
  /** Data stays fresh this long after a fetch; older ⇒ refetch on the next `fetch()` (default `0`). */
  readonly staleTime?: number
  /** Evict an entry this long (ms) after its last subscriber leaves (default 5 min). */
  readonly gcTime?: number
  /** Hard cap on cached entries — LRU-evict the oldest *unsubscribed* entry past it (default 1000). */
  readonly max?: number
}

/** The keyed query cache. One per app (a binding registers it like the router). */
export interface QueryClient {
  /** Get the stable {@link QueryHandle} for `key`, fetched via `fn`. Re-binds the latest `fn` each
   * call (closures change between renders); returns the same handle for the same (hashed) key. */
  query: <T>(key: unknown, fn: () => Promise<T>) => QueryHandle<T>
  /** Mark matching cached queries stale and refetch the **mounted** ones (subscribers > 0). Array
   * keys match by **prefix** (`["todo"]` ⇒ every `["todo", …]`); other keys match exactly. */
  invalidateQueries: (keyOrPrefix: unknown) => void
}

/**
 * Hash a query key to a stable cache string. Object keys are sorted (so `{a,b}` ≡ `{b,a}`); arrays
 * keep order. Keys must be serializable — a function/symbol in the key throws (it can't be a stable
 * identity). Mirrors TanStack Query's structural hashing.
 */
export function hashQueryKey(key: unknown): string {
  return JSON.stringify(key, (_k, value) => {
    if (typeof value === "function" || typeof value === "symbol")
      throw new TypeError("[nifra/web] a query key must be serializable (no functions/symbols)")
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>
      return Object.fromEntries(
        Object.keys(obj)
          .sort()
          .map((k) => [k, obj[k]]),
      )
    }
    return value
  })
}

// Structural array-prefix match on un-hashed keys: invalidate(["todo"]) hits ["todo", id]. Non-array
// keys (or a non-array prefix) match exactly (by hash).
function keyMatchesPrefix(key: unknown, prefix: unknown): boolean {
  if (!Array.isArray(key) || !Array.isArray(prefix))
    return hashQueryKey(key) === hashQueryKey(prefix)
  return (
    prefix.length <= key.length && prefix.every((p, i) => hashQueryKey(key[i]) === hashQueryKey(p))
  )
}

interface Entry {
  readonly key: unknown
  fn: () => Promise<unknown>
  state: QueryState
  promise: Promise<unknown> | undefined
  /** The {@link generation} the in-flight {@link promise} started at — so a fetch begun *before* an
   * `invalidateQueries` (which bumps `generation`) is recognized as superseded, not joined. */
  promiseGen: number
  /** Bumped by `invalidateQueries`/`refetch` to supersede any in-flight fetch begun before it. */
  generation: number
  invalidated: boolean
  subscribers: number
  /** Scheduled eviction time (set when subscribers hit 0; cleared on resubscribe). */
  gcAt: number | undefined
  readonly listeners: Set<() => void>
  // Assigned once just after construction (the handle's closures reference this entry); not readonly.
  handle: QueryHandle
}

const PENDING: QueryState = Object.freeze({
  status: "pending",
  data: undefined,
  error: undefined,
  isFetching: false,
  updatedAt: Number.NEGATIVE_INFINITY,
})

export function createQueryClient(options: QueryClientOptions): QueryClient {
  const { now } = options
  const staleTime = options.staleTime ?? 0
  const gcTime = options.gcTime ?? 5 * 60_000
  const max = options.max ?? 1000
  const cache = new Map<string, Entry>()

  // Lazily evict entries whose GC timer has elapsed (no subscribers), then enforce the hard cap by
  // dropping the oldest-inserted unsubscribed entries. Called on every `query()` — no background timer.
  const sweep = (): void => {
    const t = now()
    for (const [h, e] of cache) {
      if (e.subscribers === 0 && e.gcAt !== undefined && t >= e.gcAt) cache.delete(h)
    }
    if (cache.size <= max) return
    for (const [h, e] of cache) {
      if (cache.size <= max) break
      if (e.subscribers === 0) cache.delete(h) // oldest-inserted unsubscribed first (Map order)
    }
  }

  const query = <T>(key: unknown, fn: () => Promise<T>): QueryHandle<T> => {
    sweep()
    const h = hashQueryKey(key)
    const existing = cache.get(h)
    if (existing !== undefined) {
      existing.fn = fn as () => Promise<unknown> // re-bind the latest closure
      return existing.handle as QueryHandle<T>
    }
    const entry: Entry = {
      key,
      fn: fn as () => Promise<unknown>,
      state: PENDING,
      promise: undefined,
      promiseGen: 0,
      generation: 0,
      invalidated: false,
      subscribers: 0,
      gcAt: undefined,
      listeners: new Set(),
      // `handle` is assigned just below; the cast lets the entry reference itself.
      handle: undefined as unknown as QueryHandle,
    }
    const emit = (): void => {
      // Iterate the live set — no per-emit copy (the common case is 0–1 subscribers; the spread
      // allocated an array on every state transition ∝ subscriber count). Contract: a listener must
      // not synchronously subscribe/unsubscribe during notification — `useSyncExternalStore`/signal/
      // store bindings don't (un/subscribe happens in a later effect/cleanup tick).
      if (entry.listeners.size === 0) return
      for (const l of entry.listeners) l()
    }
    const setState = (next: QueryState): void => {
      entry.state = Object.freeze(next)
      emit()
    }
    const isStale = (): boolean => entry.invalidated || now() - entry.state.updatedAt >= staleTime

    const run = (force: boolean): Promise<unknown> => {
      // Dedup — but join the in-flight fetch ONLY when it belongs to the current generation. An
      // `invalidateQueries` bumps `generation`, so a fetch that started *before* the invalidation is
      // superseded and must NOT satisfy this call (its data is pre-mutation); fall through and kick a
      // fresh fetch instead of returning the stale in-flight one.
      if (entry.promise !== undefined && entry.promiseGen === entry.generation) return entry.promise
      if (!force && entry.state.status === "success" && !isStale())
        return Promise.resolve(entry.state.data) // fresh cache hit — no fn call
      const gen = entry.generation
      setState({ ...entry.state, isFetching: true }) // show the background/initial fetch
      const promise = (async () => {
        try {
          const data = await entry.fn()
          // A newer generation (a later invalidate/refetch) owns the entry now — discard this result
          // rather than publishing pre-mutation data as fresh or clearing `invalidated`. The fetch
          // that superseded this one publishes the post-mutation data.
          if (gen !== entry.generation) return data
          entry.invalidated = false
          setState({
            status: "success",
            data,
            error: undefined,
            isFetching: false,
            updatedAt: now(),
          })
          return data
        } catch (error) {
          if (gen === entry.generation)
            setState({ ...entry.state, status: "error", error, isFetching: false })
          throw error
        } finally {
          // Clear the slot only if no newer fetch took ownership. A later generation's fetch
          // overwrites `entry.promiseGen`, so `promiseGen === gen` means we're still the current
          // in-flight fetch; if it differs, the fetch that superseded us owns `entry.promise` now.
          if (entry.promiseGen === gen) entry.promise = undefined
        }
      })()
      entry.promise = promise
      entry.promiseGen = gen
      return promise
    }

    entry.handle = {
      snapshot: () => entry.state,
      subscribe: (listener: () => void) => {
        entry.subscribers++
        entry.gcAt = undefined // in use again — cancel any pending eviction
        entry.listeners.add(listener)
        return () => {
          entry.listeners.delete(listener)
          entry.subscribers--
          if (entry.subscribers === 0) entry.gcAt = now() + gcTime
        }
      },
      fetch: () => run(false) as Promise<T>,
      refetch: () => run(true) as Promise<T>,
    }
    cache.set(h, entry)
    return entry.handle as QueryHandle<T>
  }

  const invalidateQueries = (keyOrPrefix: unknown): void => {
    for (const entry of cache.values()) {
      if (!keyMatchesPrefix(entry.key, keyOrPrefix)) continue
      entry.invalidated = true // next fetch refetches even within staleTime
      // Supersede any in-flight fetch begun before this point — its result is pre-mutation and must
      // not resolve as "fresh" or clear `invalidated`. The refetch below (or the next `fetch()`)
      // starts a new generation that publishes the post-mutation data.
      entry.generation++
      if (entry.subscribers > 0) void entry.handle.refetch().catch(() => {}) // refresh mounted now (best-effort)
    }
  }

  return { query, invalidateQueries }
}

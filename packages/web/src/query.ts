/**
 * The agnostic keyed query-cache - a `query(key, fn)` primitive with in-flight dedup, `staleTime`
 * freshness, prefix `invalidateQueries`, imperative cache read/write, prefetch, SSR dehydrate/hydrate,
 * infinite (paged) queries, and standalone mutations. Pure logic, no `window`, no framework, no
 * `Date.now`/timers (the clock is injected) - so it unit-tests deterministically and is safe to import
 * from the SSR core's main entry. A per-adapter binding (`useQuery`/`useMutation`/`createQuery`)
 * subscribes to a query/mutation's `subscribe`/`snapshot` store (the same shape the router + fetchers
 * use).
 *
 * This is a SECOND keyed cache, distinct from the router's path-keyed route cache (F16): route loaders
 * + navigation use the path cache; component-level interactive data (search, infinite scroll, polling)
 * uses this arbitrary-keyed query cache. The two coexist.
 */
import { documentEpoch } from "./identity.ts"
import { adoptClient, type LiveQuery, querySeam } from "./internal/query-seam.ts"

/** A query's lifecycle status. `pending` = no data yet; `success`/`error` once it has settled once. */
export type QueryStatus = "pending" | "success" | "error"

/** A query's observable state - what a binding renders. A new (frozen) object per transition, so a
 * `useSyncExternalStore`/signal binding can compare by reference. */
export interface QueryState<T = unknown> {
  readonly status: QueryStatus
  readonly data: T | undefined
  readonly error: unknown
  /** True while a fetch is in flight - the initial load OR a background refetch (data may still show). */
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

/** Per-query overrides passed alongside the fetcher. */
export interface QueryOptions {
  /** Data stays fresh this long (ms) after a fetch; older ⇒ refetch on the next `fetch()`. Overrides
   * the client default for this key. */
  readonly staleTime?: number
  /**
   * Live keys the data depends on, as the page's loaders declare them with `ctx.live()`. While the
   * query is mounted, a change to one refetches it. Needs `live({ queryKeys: true })`.
   */
  readonly live?: readonly string[]
}

export interface QueryClientOptions {
  /** Monotonic clock in ms - injected so the core stays deterministic + testable; the adapter binding
   * passes `() => Date.now()`. */
  readonly now: () => number
  /** Data stays fresh this long after a fetch; older ⇒ refetch on the next `fetch()` (default `0`). */
  readonly staleTime?: number
  /** Evict an entry this long (ms) after its last subscriber leaves (default 5 min). */
  readonly gcTime?: number
  /** Hard cap on cached entries - LRU-evict the oldest *unsubscribed* entry past it (default 1000). */
  readonly max?: number
}

/** An infinite (paged) query's accumulated data: the fetched `pages` in order + the `pageParam` each
 * was fetched with (so the next/previous param can be derived). */
export interface InfiniteData<T, P> {
  readonly pages: readonly T[]
  readonly pageParams: readonly P[]
}

/** Options for an {@link InfiniteQueryHandle}. `getNextPageParam` (required) derives the param for the
 * next page from the last page - return `undefined`/`null` to signal there is no next page. */
export interface InfiniteQueryOptions<T, P> extends QueryOptions {
  /** The param the FIRST page is fetched with. */
  readonly initialPageParam: P
  /** Derive the next page's param from the last fetched page (and all pages/params). `undefined`/`null`
   * ⇒ no next page (`hasNextPage` is false). */
  readonly getNextPageParam: (
    lastPage: T,
    allPages: readonly T[],
    lastPageParam: P,
    allPageParams: readonly P[],
  ) => P | undefined | null
  /** Derive the previous page's param (for bidirectional infinite lists). Omit ⇒ no previous page. */
  readonly getPreviousPageParam?: (
    firstPage: T,
    allPages: readonly T[],
    firstPageParam: P,
    allPageParams: readonly P[],
  ) => P | undefined | null
}

/** A stable per-key handle for an infinite (paged) query. */
export interface InfiniteQueryHandle<T, P> {
  snapshot: () => QueryState<InfiniteData<T, P>>
  subscribe: (listener: () => void) => () => void
  /** Fetch the first page when absent/stale (fresh ⇒ no-op). */
  fetch: () => Promise<InfiniteData<T, P>>
  /** Refetch every currently-loaded page (in order), replacing the data. */
  refetch: () => Promise<InfiniteData<T, P>>
  /** Append the next page (a no-op when `hasNextPage()` is false or a fetch is already in flight). */
  fetchNextPage: () => Promise<InfiniteData<T, P>>
  /** Prepend the previous page (a no-op without `getPreviousPageParam` or when there is none). */
  fetchPreviousPage: () => Promise<InfiniteData<T, P>>
  /** Whether another page can be appended (derived from `getNextPageParam` of the last page). */
  hasNextPage: () => boolean
  /** Whether a page can be prepended (derived from `getPreviousPageParam` of the first page). */
  hasPreviousPage: () => boolean
}

/** A serializable snapshot of the cache's successful queries - the SSR→client bridge payload. */
export interface DehydratedState {
  readonly queries: ReadonlyArray<{
    readonly key: unknown
    readonly data: unknown
    readonly updatedAt: number
  }>
  /** The successful infinite queries, pages and page params. */
  readonly infiniteQueries?: ReadonlyArray<{
    readonly key: unknown
    readonly data: InfiniteData<unknown, unknown>
    readonly updatedAt: number
  }>
}

/** The keyed query cache. One per app (a binding registers it like the router). */
export interface QueryClient {
  /** Get the stable {@link QueryHandle} for `key`, fetched via `fn`. Re-binds the latest `fn` (and
   * `options`) each call (closures change between renders); returns the same handle for the same
   * (hashed) key. */
  query: <T>(key: unknown, fn: () => Promise<T>, options?: QueryOptions) => QueryHandle<T>
  /** Get the stable {@link InfiniteQueryHandle} for `key`, whose pages are fetched via `fn(pageParam)`. */
  infiniteQuery: <T, P>(
    key: unknown,
    fn: (pageParam: P) => Promise<T>,
    options: InfiniteQueryOptions<T, P>,
  ) => InfiniteQueryHandle<T, P>
  /** Mark matching cached queries, infinite ones included, stale and refetch the **mounted** ones
   * (subscribers > 0). Array keys match by **prefix** (`["todo"]` ⇒ every `["todo", …]`); other keys
   * match exactly. */
  invalidateQueries: (keyOrPrefix: unknown) => void
  /** Read a cached query's data (`undefined` if absent or not yet successful). Synchronous, no fetch. */
  getQueryData: <T>(key: unknown) => T | undefined
  /** Write a query's data directly (optimistic updates, or seeding). Creates the entry if absent; marks
   * it fresh (`updatedAt = now`). `updater` may be a value or a function of the previous data. */
  setQueryData: <T>(key: unknown, updater: T | ((prev: T | undefined) => T)) => void
  /** Fetch + cache a query's data WITHOUT subscribing (SSR prefetch, hover warm). Resolves when cached;
   * a fresh entry is a no-op. Rejects if the fetch throws (caller may swallow). */
  prefetchQuery: <T>(key: unknown, fn: () => Promise<T>, options?: QueryOptions) => Promise<void>
  /** Serialize every successful query to a transferable snapshot (server → client SSR bridge). */
  dehydrate: () => DehydratedState
  /** Seed the cache from a {@link dehydrate} snapshot (client boot). Existing fresher entries win. */
  hydrate: (state: DehydratedState) => void
  /** Drop every cached query: mounted ones go back to pending and refetch, the rest are removed. Every
   * client in the page runs it when the visitor changes: `identityChanged()` in this tab, a live
   * account switch, or, on the client's next read, a new identity epoch cookie. */
  clear: () => void
}

/**
 * Hash a query key to a stable cache string. Object keys are sorted (so `{a,b}` ≡ `{b,a}`); arrays
 * keep order. Keys must be serializable - a function/symbol in the key throws (it can't be a stable
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

/** What both kinds of entry carry for a page with live refresh. */
interface LiveFields {
  live: readonly string[]
  subscribers: number
  readonly lq: LiveQuery
}

/** The live tick now; 0 on a page without live refresh. */
const liveTick = (): number => querySeam()?.tick() ?? 0

/** New keys while mounted are tracked again: a change to a new key before now never reached it. */
function relive(entry: LiveFields, live: readonly string[] | undefined): void {
  if (live === undefined) return
  if (live.length === entry.live.length && live.every((key, i) => key === entry.live[i])) return
  entry.live = [...live]
  if (entry.subscribers === 0) return
  querySeam()?.track(entry.lq, false)
  querySeam()?.track(entry.lq, true)
}

interface Entry extends LiveFields {
  readonly key: unknown
  fn: () => Promise<unknown>
  staleTime: number
  /** The {@link liveTick} at the start of the latest fetch, and of the fetch that produced `state`. */
  startTick: number
  dataTick: number
  state: QueryState
  promise: Promise<unknown> | undefined
  /** The {@link generation} the in-flight {@link promise} started at - so a fetch begun *before* an
   * `invalidateQueries` (which bumps `generation`) is recognized as superseded, not joined. */
  promiseGen: number
  /** Bumped by `invalidateQueries`/`refetch` to supersede any in-flight fetch begun before it. */
  generation: number
  /** The visitor count the fetch that settled `state` started at. */
  answeredFor: number
  invalidated: boolean
  /** Scheduled eviction time (set when subscribers hit 0; cleared on resubscribe). */
  gcAt: number | undefined
  readonly listeners: Set<() => void>
  // Entry-level operations (assigned by makeEntry; reused by query/prefetch/setQueryData/invalidate).
  setState: (next: QueryState) => void
  /** `forChange`: a reload for a visitor change, which takes a change while it runs as its own. */
  run: (force: boolean, forChange?: boolean) => Promise<unknown>
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

/** Build a success state for freshly-set data (imperative writes + hydration). */
function successState<T>(data: T, updatedAt: number): QueryState<T> {
  return { status: "success", data, error: undefined, isFetching: false, updatedAt }
}

export function createQueryClient(options: QueryClientOptions): QueryClient {
  const { now } = options
  const defaultStaleTime = options.staleTime ?? 0
  const gcTime = options.gcTime ?? 5 * 60_000
  const max = options.max ?? 1000
  const cache = new Map<string, Entry>()

  // Lazily evict entries whose GC timer has elapsed (no subscribers), then enforce the hard cap by
  // dropping the oldest-inserted unsubscribed entries. Called on every `query()` - no background timer.
  const sweepEntries = (
    entries: Map<string, { readonly subscribers: number; readonly gcAt: number | undefined }>,
    t: number,
  ): void => {
    for (const [h, e] of entries) {
      if (e.subscribers === 0 && e.gcAt !== undefined && t >= e.gcAt) entries.delete(h)
    }
    if (entries.size <= max) return
    for (const [h, e] of entries) {
      if (entries.size <= max) break
      if (e.subscribers === 0) entries.delete(h) // oldest-inserted unsubscribed first (Map order)
    }
  }
  const sweep = (): void => {
    const t = now()
    sweepEntries(cache, t)
    sweepEntries(infinite, t)
  }

  // Build a cache entry + its handle. `fn`/`staleTime` are mutated in place on re-bind (closures change
  // between renders). All the fetch/dedup/generation machinery lives here so query(), prefetchQuery(),
  // setQueryData(), and invalidateQueries() share exactly one implementation.
  const makeEntry = (key: unknown, fn: () => Promise<unknown>, staleTime: number): Entry => {
    const lq: LiveQuery = {
      keys: () => entry.live,
      tick: () =>
        entry.promise !== undefined && entry.promiseGen === entry.generation
          ? entry.startTick
          : entry.dataTick,
      refresh: () => invalidateEntry(entry),
    }
    const entry: Entry = {
      key,
      fn,
      staleTime,
      live: [],
      lq,
      startTick: 0,
      dataTick: 0,
      state: PENDING,
      promise: undefined,
      promiseGen: 0,
      generation: 0,
      answeredFor: -1,
      invalidated: false,
      subscribers: 0,
      gcAt: undefined,
      listeners: new Set(),
      setState: undefined as unknown as Entry["setState"],
      run: undefined as unknown as Entry["run"],
      handle: undefined as unknown as QueryHandle,
    }
    const emit = (): void => {
      // Iterate the live set - no per-emit copy (the common case is 0-1 subscribers). Contract: a
      // listener must not synchronously subscribe/unsubscribe during notification - `useSyncExternalStore`/
      // signal/store bindings don't (un/subscribe happens in a later effect/cleanup tick).
      if (entry.listeners.size === 0) return
      for (const l of entry.listeners) l()
    }
    entry.setState = (next: QueryState): void => {
      entry.state = Object.freeze(next)
      emit()
    }
    const isStale = (): boolean =>
      entry.invalidated || now() - entry.state.updatedAt >= entry.staleTime

    entry.run = (force: boolean, forChange = false): Promise<unknown> => {
      // Dedup - but join the in-flight fetch ONLY when it belongs to the current generation. An
      // `invalidateQueries` bumps `generation`, so a fetch that started *before* the invalidation is
      // superseded and must NOT satisfy this call (its data is pre-mutation); fall through and kick a
      // fresh fetch instead of returning the stale in-flight one.
      if (entry.promise !== undefined && entry.promiseGen === entry.generation) return entry.promise
      if (!force && entry.state.status === "success" && !isStale())
        return Promise.resolve(entry.state.data) // fresh cache hit - no fn call
      const gen = entry.generation
      const seen = visitor
      const started = liveTick()
      entry.startTick = started
      entry.setState({ ...entry.state, isFetching: true }) // show the background/initial fetch
      if (forChange) reloading++
      // A visitor change while it loaded: what came back, or failed, may be the previous visitor's,
      // so the call answers as the reload the change started does, loading once more if none has.
      const again = (): Promise<unknown> => {
        if (gen === entry.generation) entry.generation++
        if (entry.promise === undefined && entry.answeredFor === visitor && !entry.invalidated) {
          if (entry.state.status === "error") return Promise.reject(entry.state.error)
          if (entry.state.status === "success") return Promise.resolve(entry.state.data)
        }
        return entry.run(true, true)
      }
      const promise = (async () => {
        try {
          const data = await entry.fn()
          landed(forChange)
          if (seen !== visitor) return await again()
          // A newer generation (a later invalidate/refetch) owns the entry now - discard this result
          // rather than publishing pre-mutation data as fresh or clearing `invalidated`. The fetch
          // that superseded this one publishes the post-mutation data.
          if (gen !== entry.generation) return data
          entry.invalidated = false
          entry.dataTick = started
          entry.answeredFor = seen
          entry.setState(successState(data, now()))
          return data
        } catch (error) {
          landed(forChange)
          if (seen !== visitor) return await again()
          if (gen === entry.generation) {
            entry.answeredFor = seen
            entry.setState({ ...entry.state, status: "error", error, isFetching: false })
          }
          throw error
        } finally {
          if (forChange) reloading--
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

    // A handle outlives the call that made it, so its reads check the epoch too.
    entry.handle = {
      snapshot: () => {
        checkEpoch()
        return entry.state
      },
      subscribe: (listener: () => void) => {
        entry.subscribers++
        entry.gcAt = undefined // in use again - cancel any pending eviction
        entry.listeners.add(listener)
        if (entry.subscribers === 1) querySeam()?.track(lq, true)
        return () => {
          entry.listeners.delete(listener)
          entry.subscribers--
          if (entry.subscribers === 0) {
            entry.gcAt = now() + gcTime
            querySeam()?.track(lq, false)
          }
        }
      },
      fetch: () => {
        checkEpoch()
        return entry.run(false)
      },
      refetch: () => {
        checkEpoch()
        return entry.run(true)
      },
    }
    return entry
  }

  const invalidateEntry = (entry: Entry): void => {
    entry.invalidated = true // next fetch refetches even within staleTime
    // Supersede any in-flight fetch begun before this point - its result is pre-mutation and must
    // not resolve as "fresh" or clear `invalidated`. The refetch below (or the next `fetch()`)
    // starts a new generation that publishes the post-mutation data.
    entry.generation++
    if (entry.subscribers > 0) void entry.handle.refetch().catch(() => {}) // refresh mounted now (best-effort)
  }

  // Get an entry by key, or create + insert a fresh one. `fn`/`staleTime`/`live` re-bind on an
  // existing entry; `live` stays as it is when the call names none (a write, a hydration).
  const upsert = (
    key: unknown,
    fn: () => Promise<unknown>,
    staleTime: number,
    live?: readonly string[],
  ): Entry => {
    const h = hashQueryKey(key)
    const existing = cache.get(h)
    if (existing !== undefined) {
      existing.fn = fn
      existing.staleTime = staleTime
      relive(existing, live)
      return existing
    }
    const entry = makeEntry(key, fn, staleTime)
    relive(entry, live)
    cache.set(h, entry)
    return entry
  }

  const query = <T>(key: unknown, fn: () => Promise<T>, opts?: QueryOptions): QueryHandle<T> => {
    checkEpoch()
    sweep()
    return upsert(
      key,
      fn as () => Promise<unknown>,
      opts?.staleTime ?? defaultStaleTime,
      opts?.live ?? [],
    ).handle as QueryHandle<T>
  }

  const invalidateQueries = (keyOrPrefix: unknown): void => {
    checkEpoch()
    for (const entry of cache.values()) {
      if (keyMatchesPrefix(entry.key, keyOrPrefix)) invalidateEntry(entry)
    }
    for (const entry of infinite.values()) {
      if (keyMatchesPrefix(entry.key, keyOrPrefix)) entry.invalidate()
    }
  }

  const getQueryData = <T>(key: unknown): T | undefined => {
    checkEpoch()
    const entry = cache.get(hashQueryKey(key))
    return entry !== undefined && entry.state.status === "success"
      ? (entry.state.data as T)
      : undefined
  }

  const setQueryData = <T>(key: unknown, updater: T | ((prev: T | undefined) => T)): void => {
    checkEpoch()
    // Create a placeholder entry if none exists - its `fn` throws until a real `query(key, fn)` re-binds
    // it, so a `setQueryData` for a key nobody queries yet never triggers a fetch on its own.
    const entry = upsert(
      key,
      cache.get(hashQueryKey(key))?.fn ??
        (() =>
          Promise.reject(new Error("[nifra/web] query has no fetcher (setQueryData-only key)"))),
      defaultStaleTime,
    )
    const prev = entry.state.status === "success" ? (entry.state.data as T) : undefined
    const data =
      typeof updater === "function" ? (updater as (p: T | undefined) => T)(prev) : updater
    // A direct write is the new truth - bump the generation so any in-flight fetch can't overwrite it,
    // and clear the invalidated flag (the caller just supplied fresh data).
    entry.generation++
    entry.invalidated = false
    entry.dataTick = liveTick()
    entry.setState(successState(data, now()))
  }

  const prefetchQuery = async <T>(
    key: unknown,
    fn: () => Promise<T>,
    opts?: QueryOptions,
  ): Promise<void> => {
    checkEpoch()
    sweep()
    await upsert(
      key,
      fn as () => Promise<unknown>,
      opts?.staleTime ?? defaultStaleTime,
      opts?.live,
    ).run(false)
  }

  const dehydrate = (): DehydratedState => {
    checkEpoch()
    const queries: Array<{ key: unknown; data: unknown; updatedAt: number }> = []
    for (const entry of cache.values()) {
      if (entry.state.status === "success")
        queries.push({ key: entry.key, data: entry.state.data, updatedAt: entry.state.updatedAt })
    }
    const infiniteQueries: Array<{
      key: unknown
      data: InfiniteData<unknown, unknown>
      updatedAt: number
    }> = []
    for (const entry of infinite.values()) {
      const { status, data, updatedAt } = entry.handle.snapshot()
      if (status === "success" && data !== undefined)
        infiniteQueries.push({ key: entry.key, data, updatedAt })
    }
    return { queries, infiniteQueries }
  }

  const hydrate = (state: DehydratedState): void => {
    checkEpoch()
    for (const q of state.queries) {
      const entry = upsert(
        q.key,
        cache.get(hashQueryKey(q.key))?.fn ??
          (() => Promise.reject(new Error("[nifra/web] hydrated query has no fetcher yet"))),
        defaultStaleTime,
      )
      // Don't clobber a client entry that's already fresher than the server snapshot (the client may
      // have refetched between SSR and hydration). Seed only when we have no successful data or the
      // incoming snapshot is newer.
      if (entry.state.status !== "success" || q.updatedAt > entry.state.updatedAt) {
        // Read before any live load took a watermark: the first grant of its keys refetches it.
        entry.dataTick = 0
        entry.setState(successState(q.data, q.updatedAt))
      }
    }
    // An infinite entry needs its page options before it can exist, so a snapshot for a key not yet
    // queried waits here until `infiniteQuery` creates it.
    for (const q of state.infiniteQueries ?? []) {
      const h = hashQueryKey(q.key)
      const existing = infinite.get(h)
      if (existing === undefined) seeded.set(h, q)
      else existing.seed(q.data, q.updatedAt)
    }
  }

  // --- Infinite (paged) queries -----------------------------------------------------------------
  const infiniteQuery = <T, P>(
    key: unknown,
    fn: (pageParam: P) => Promise<T>,
    opts: InfiniteQueryOptions<T, P>,
  ): InfiniteQueryHandle<T, P> => {
    checkEpoch()
    sweep()
    const h = hashQueryKey(key)
    const existing = infinite.get(h)
    if (existing !== undefined) {
      existing.rebind(
        fn as (p: unknown) => Promise<unknown>,
        opts as InfiniteQueryOptions<unknown, unknown>,
      )
      return existing.handle as InfiniteQueryHandle<T, P>
    }
    const created = makeInfinite<T, P>(key, fn, opts)
    infinite.set(h, created as InfiniteEntry<unknown, unknown>)
    const snapshot = seeded.get(h)
    if (snapshot !== undefined) {
      seeded.delete(h)
      created.seed(snapshot.data, snapshot.updatedAt)
    }
    return created.handle
  }

  // Infinite entries live in their own map (their data shape + fetch model differ from plain queries).
  interface InfiniteEntry<T, P> extends LiveFields {
    readonly key: unknown
    handle: InfiniteQueryHandle<T, P>
    rebind: (fn: (p: P) => Promise<T>, opts: InfiniteQueryOptions<T, P>) => void
    /** Mark stale, drop an in-flight fetch's result, and refetch when mounted. */
    invalidate: () => void
    /** Back to pending, dropping an in-flight fetch's result, without telling subscribers; the call it
     * returns refetches the first page when mounted, and that fetch tells them. */
    reset: (forChange: boolean) => () => void
    /** Take a dehydrated snapshot unless the entry already holds fresher data. */
    seed: (data: InfiniteData<unknown, unknown>, updatedAt: number) => void
    gcAt: number | undefined
  }
  const infinite = new Map<string, InfiniteEntry<unknown, unknown>>()
  const seeded = new Map<string, NonNullable<DehydratedState["infiniteQueries"]>[number]>()

  const makeInfinite = <T, P>(
    key: unknown,
    fetchPage: (pageParam: P) => Promise<T>,
    initialOpts: InfiniteQueryOptions<T, P>,
  ): InfiniteEntry<T, P> => {
    let fn = fetchPage
    let opts = initialOpts
    let state: QueryState<InfiniteData<T, P>> = PENDING as QueryState<InfiniteData<T, P>>
    const pending = state
    let generation = 0
    let answeredFor = -1
    let invalidated = false
    let promise: Promise<InfiniteData<T, P>> | undefined
    let startTick = 0
    let dataTick = 0
    const listeners = new Set<() => void>()
    const emit = (): void => {
      for (const l of listeners) l()
    }
    const setState = (next: QueryState<InfiniteData<T, P>>): void => {
      state = Object.freeze(next)
      emit()
    }
    const nextParam = (data: InfiniteData<T, P>): P | undefined | null => {
      const last = data.pages[data.pages.length - 1]
      if (last === undefined) return undefined
      return opts.getNextPageParam(
        last,
        data.pages,
        data.pageParams[data.pageParams.length - 1] as P,
        data.pageParams,
      )
    }
    const prevParam = (data: InfiniteData<T, P>): P | undefined | null => {
      if (opts.getPreviousPageParam === undefined || data.pages.length === 0) return undefined
      return opts.getPreviousPageParam(
        data.pages[0] as T,
        data.pages,
        data.pageParams[0] as P,
        data.pageParams,
      )
    }
    const isStale = (): boolean =>
      invalidated || now() - state.updatedAt >= (opts.staleTime ?? defaultStaleTime)

    // Run a paged operation under a fresh generation, guarding against a superseding op (like `run`).
    const runPaged = (
      build: () => Promise<InfiniteData<T, P>>,
      forChange = false,
    ): Promise<InfiniteData<T, P>> => {
      if (promise !== undefined) return promise
      const gen = ++generation
      const seen = visitor
      const started = liveTick()
      startTick = started
      setState({ ...state, isFetching: true })
      if (forChange) reloading++
      // The pages may be the previous visitor's: the call answers as the reload the change started
      // does, loading again from what the change left if none has.
      const again = (): Promise<InfiniteData<T, P>> => {
        if (gen === generation) {
          generation++
          promise = undefined
        }
        if (promise === undefined && answeredFor === visitor && !invalidated) {
          if (state.status === "error") return Promise.reject(state.error)
          if (state.data !== undefined) return Promise.resolve(state.data)
        }
        return reload(true)
      }
      const p = (async () => {
        try {
          const data = await build()
          landed(forChange)
          if (seen !== visitor) return await again()
          if (gen !== generation) return data
          invalidated = false
          dataTick = started
          answeredFor = seen
          setState(successState(data, now()))
          return data
        } catch (error) {
          landed(forChange)
          if (seen !== visitor) return await again()
          if (gen === generation) {
            answeredFor = seen
            setState({ ...state, status: "error", error, isFetching: false })
          }
          throw error
        } finally {
          if (forChange) reloading--
          if (gen === generation) promise = undefined
        }
      })()
      promise = p
      return p
    }

    const fetchFirst = (force: boolean): Promise<InfiniteData<T, P>> => {
      if (!force && state.status === "success" && !isStale() && state.data !== undefined)
        return Promise.resolve(state.data)
      return runPaged(async () => {
        const page = await fn(opts.initialPageParam)
        return { pages: [page], pageParams: [opts.initialPageParam] }
      })
    }

    const reload = (forChange: boolean): Promise<InfiniteData<T, P>> =>
      runPaged(async () => {
        const current = state.data
        if (current === undefined || current.pages.length === 0) {
          const page = await fn(opts.initialPageParam)
          return { pages: [page], pageParams: [opts.initialPageParam] }
        }
        // Refetch every loaded page in order with its original param, so the list stays the same size.
        const pages: T[] = []
        for (const param of current.pageParams) pages.push(await fn(param))
        return { pages, pageParams: [...current.pageParams] }
      }, forChange)

    const handle: InfiniteQueryHandle<T, P> = {
      snapshot: () => {
        checkEpoch()
        return state
      },
      subscribe: (listener) => {
        entry.subscribers++
        entry.gcAt = undefined
        listeners.add(listener)
        if (entry.subscribers === 1) querySeam()?.track(lq, true)
        return () => {
          listeners.delete(listener)
          entry.subscribers--
          if (entry.subscribers === 0) {
            entry.gcAt = now() + gcTime
            querySeam()?.track(lq, false)
          }
        }
      },
      fetch: () => {
        checkEpoch()
        return fetchFirst(false)
      },
      refetch: () => {
        checkEpoch()
        return reload(false)
      },
      fetchNextPage: () => {
        checkEpoch()
        const current = state.data
        if (current === undefined) return fetchFirst(false)
        const param = nextParam(current)
        if (param === undefined || param === null) return Promise.resolve(current)
        return runPaged(async () => {
          const page = await fn(param)
          return { pages: [...current.pages, page], pageParams: [...current.pageParams, param] }
        })
      },
      fetchPreviousPage: () => {
        checkEpoch()
        const current = state.data
        if (current === undefined) return fetchFirst(false)
        const param = prevParam(current)
        if (param === undefined || param === null) return Promise.resolve(current)
        return runPaged(async () => {
          const page = await fn(param)
          return { pages: [page, ...current.pages], pageParams: [param, ...current.pageParams] }
        })
      },
      hasNextPage: () => {
        checkEpoch()
        const p = state.data === undefined ? undefined : nextParam(state.data)
        return p !== undefined && p !== null
      },
      hasPreviousPage: () => {
        checkEpoch()
        const p = state.data === undefined ? undefined : prevParam(state.data)
        return p !== undefined && p !== null
      },
    }
    const lq: LiveQuery = {
      keys: () => entry.live,
      tick: () => (promise !== undefined ? startTick : dataTick),
      refresh: () => entry.invalidate(),
    }
    const entry: InfiniteEntry<T, P> = {
      key,
      handle,
      rebind: (nextFn, nextOpts) => {
        fn = nextFn
        opts = nextOpts
        relive(entry, nextOpts.live ?? [])
      },
      invalidate: () => {
        invalidated = true
        // A fetch begun before this point read pre-mutation data: it may not publish, and a new fetch
        // must not join it.
        generation++
        promise = undefined
        if (entry.subscribers > 0) void handle.refetch().catch(() => {})
      },
      reset: (forChange) => {
        invalidated = true
        generation++
        promise = undefined
        dataTick = 0
        state = pending
        return () => {
          if (entry.subscribers > 0) void reload(forChange).catch(() => {})
        }
      },
      seed: (data, updatedAt) => {
        if (state.status === "success" && state.updatedAt >= updatedAt) return
        dataTick = 0
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the snapshot was dehydrated from an entry under this key, whose pages and params are T and P
        setState(successState(data as InfiniteData<T, P>, updatedAt))
      },
      subscribers: 0,
      gcAt: undefined,
      live: [],
      lq,
    }
    relive(entry, initialOpts.live)
    return entry
  }

  // Every query drops its data at once; the call returned refetches the mounted ones, and the fetch
  // that starts tells their subscribers. One a read started since is joined, and told them already.
  // The refetches for a change seen at a read take a change while they run as their own; those for
  // `clear()` hear one as any load does.
  const forget = (forChange: boolean): (() => void) => {
    visitor++
    seeded.clear()
    const mounted: (() => void)[] = []
    // Entries stay, emptied: a handle kept past its last subscriber, or a call loading again into one,
    // is then where the next change reaches it.
    for (const entry of cache.values()) {
      // An in-flight fetch carried the last viewer's credentials: its result may not publish.
      entry.generation++
      entry.invalidated = true
      entry.dataTick = 0
      entry.state = PENDING
      if (entry.subscribers > 0) mounted.push(() => void entry.run(true, forChange).catch(() => {}))
    }
    for (const entry of infinite.values()) mounted.push(entry.reset(forChange))
    return () => {
      for (const tell of mounted) tell()
    }
  }
  const clear = (): void => {
    epoch = documentEpoch()
    forget(false)()
  }
  // A new identity epoch cookie: what the client holds was loaded for the previous visitor. Reads run
  // while a component renders, so the data goes at once and mounted queries hear once it is over.
  // While the reloads a change started run, a new epoch is theirs: a server that rotates it on every
  // response costs one reload, never a loop. Another tab's sign-in inside that window goes unseen
  // here; `identityChanged()` in this tab never does.
  let epoch = documentEpoch()
  // One count per visitor change, and the reloads for one still in flight.
  let visitor = 0
  let reloading = 0
  const checkEpoch = (): void => {
    const current = documentEpoch()
    if (current === epoch) return
    epoch = current
    if (reloading === 0) queueMicrotask(forget(true))
  }
  // A load that lands hears a new epoch as a read would; a reload for a change takes it as its own.
  const landed = (forChange: boolean): void => {
    if (forChange) epoch = documentEpoch()
    else checkEpoch()
  }

  const client: QueryClient = {
    query,
    infiniteQuery,
    invalidateQueries,
    getQueryData,
    setQueryData,
    prefetchQuery,
    dehydrate,
    hydrate,
    clear,
  }
  // A page with live refresh clears every client it made when the viewer changes.
  adoptClient(client)
  return client
}

// --- Standalone mutations -----------------------------------------------------------------------

/** A mutation's lifecycle status. */
export type MutationStatus = "idle" | "pending" | "success" | "error"

/** A mutation's observable state. A new (frozen) object per transition (reference-comparable). */
export interface MutationState<TData, TVariables> {
  readonly status: MutationStatus
  readonly data: TData | undefined
  readonly error: unknown
  /** The variables of the in-flight / last mutation (`undefined` before the first call). */
  readonly variables: TVariables | undefined
}

/** Lifecycle callbacks for a mutation. All optional; `onSettled` runs after success OR error. */
export interface MutationCallbacks<TData, TVariables> {
  readonly onMutate?: (variables: TVariables) => void | Promise<void>
  readonly onSuccess?: (data: TData, variables: TVariables) => void | Promise<void>
  readonly onError?: (error: unknown, variables: TVariables) => void | Promise<void>
  readonly onSettled?: (
    data: TData | undefined,
    error: unknown,
    variables: TVariables,
  ) => void | Promise<void>
}

/** A standalone mutation store: subscribe to its state, fire `mutate`, `reset` back to idle. */
export interface MutationHandle<TData, TVariables> {
  snapshot: () => MutationState<TData, TVariables>
  subscribe: (listener: () => void) => () => void
  /** Run the mutation. Resolves to the data (and runs onSuccess/onSettled) or rejects (onError/onSettled);
   * a throwing `onMutate` fails it the same way. A throwing `onSuccess` or `onSettled` after the write
   * rejects the call but leaves the state `success` and never calls `onError`. The latest concurrent
   * call wins the published state (older results are dropped). */
  mutate: (variables: TVariables) => Promise<TData>
  /** Rebind the latest `fn`/callbacks (closures change between renders) without losing state. */
  rebind: (
    fn: (variables: TVariables) => Promise<TData>,
    callbacks: MutationCallbacks<TData, TVariables>,
  ) => void
  /** Reset to the idle state (clears data/error/variables). */
  reset: () => void
}

const IDLE_MUTATION: MutationState<unknown, unknown> = Object.freeze({
  status: "idle",
  data: undefined,
  error: undefined,
  variables: undefined,
})

/**
 * Create a standalone mutation state machine - framework-agnostic, so a per-adapter `useMutation`
 * binding just subscribes to it. Single-flight by a monotonic token: overlapping `mutate` calls each
 * run their `fn`, but only the latest publishes state (an older, slower response can't clobber a newer
 * one). The callbacks fire in TanStack order: `onMutate` (before), then `onSuccess`/`onError`, then
 * `onSettled`.
 */
export function createMutation<TData, TVariables>(
  fn: (variables: TVariables) => Promise<TData>,
  callbacks: MutationCallbacks<TData, TVariables> = {},
): MutationHandle<TData, TVariables> {
  let mutationFn = fn
  let cbs = callbacks
  let state = IDLE_MUTATION as MutationState<TData, TVariables>
  let latest = 0
  const listeners = new Set<() => void>()
  const emit = (): void => {
    for (const l of listeners) l()
  }
  const setState = (next: MutationState<TData, TVariables>): void => {
    state = Object.freeze(next)
    emit()
  }
  return {
    snapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    rebind: (nextFn, nextCallbacks) => {
      mutationFn = nextFn
      cbs = nextCallbacks
    },
    reset: () => setState(IDLE_MUTATION as MutationState<TData, TVariables>),
    mutate: async (variables) => {
      const mine = ++latest
      setState({ status: "pending", data: undefined, error: undefined, variables })
      let data: TData
      try {
        // Only await a callback when one is actually supplied - an `await undefined` would insert a
        // needless microtask before the mutationFn runs (and complicates single-flight timing).
        if (cbs.onMutate !== undefined) await cbs.onMutate(variables)
        data = await mutationFn(variables)
      } catch (error) {
        if (mine === latest) setState({ status: "error", data: undefined, error, variables })
        if (cbs.onError !== undefined) await cbs.onError(error, variables)
        if (cbs.onSettled !== undefined) await cbs.onSettled(undefined, error, variables)
        throw error
      }
      if (mine === latest) setState({ status: "success", data, error: undefined, variables })
      // The write happened: a success callback that throws rejects the call, but is no failure of the
      // write, so it never reaches onError (which would roll back what the server kept).
      try {
        if (cbs.onSuccess !== undefined) await cbs.onSuccess(data, variables)
      } finally {
        if (cbs.onSettled !== undefined) await cbs.onSettled(data, undefined, variables)
      }
      return data
    },
  }
}

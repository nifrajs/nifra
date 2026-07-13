/**
 * The agnostic keyed query-cache — a `query(key, fn)` primitive with in-flight dedup, `staleTime`
 * freshness, prefix `invalidateQueries`, imperative cache read/write, prefetch, SSR dehydrate/hydrate,
 * infinite (paged) queries, and standalone mutations. Pure logic, no `window`, no framework, no
 * `Date.now`/timers (the clock is injected) — so it unit-tests deterministically and is safe to import
 * from the SSR core's main entry. A per-adapter binding (`useQuery`/`useMutation`/`createQuery`)
 * subscribes to a query/mutation's `subscribe`/`snapshot` store (the same shape the router + fetchers
 * use).
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

/** Per-query overrides passed alongside the fetcher. */
export interface QueryOptions {
  /** Data stays fresh this long (ms) after a fetch; older ⇒ refetch on the next `fetch()`. Overrides
   * the client default for this key. */
  readonly staleTime?: number
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

/** An infinite (paged) query's accumulated data: the fetched `pages` in order + the `pageParam` each
 * was fetched with (so the next/previous param can be derived). */
export interface InfiniteData<T, P> {
  readonly pages: readonly T[]
  readonly pageParams: readonly P[]
}

/** Options for an {@link InfiniteQueryHandle}. `getNextPageParam` (required) derives the param for the
 * next page from the last page — return `undefined`/`null` to signal there is no next page. */
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

/** A serializable snapshot of the cache's successful queries — the SSR→client bridge payload. */
export interface DehydratedState {
  readonly queries: ReadonlyArray<{
    readonly key: unknown
    readonly data: unknown
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
  /** Mark matching cached queries stale and refetch the **mounted** ones (subscribers > 0). Array
   * keys match by **prefix** (`["todo"]` ⇒ every `["todo", …]`); other keys match exactly. */
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
  staleTime: number
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
  // Entry-level operations (assigned by makeEntry; reused by query/prefetch/setQueryData/invalidate).
  setState: (next: QueryState) => void
  run: (force: boolean) => Promise<unknown>
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

  // Build a cache entry + its handle. `fn`/`staleTime` are mutated in place on re-bind (closures change
  // between renders). All the fetch/dedup/generation machinery lives here so query(), prefetchQuery(),
  // setQueryData(), and invalidateQueries() share exactly one implementation.
  const makeEntry = (key: unknown, fn: () => Promise<unknown>, staleTime: number): Entry => {
    const entry: Entry = {
      key,
      fn,
      staleTime,
      state: PENDING,
      promise: undefined,
      promiseGen: 0,
      generation: 0,
      invalidated: false,
      subscribers: 0,
      gcAt: undefined,
      listeners: new Set(),
      setState: undefined as unknown as Entry["setState"],
      run: undefined as unknown as Entry["run"],
      handle: undefined as unknown as QueryHandle,
    }
    const emit = (): void => {
      // Iterate the live set — no per-emit copy (the common case is 0–1 subscribers). Contract: a
      // listener must not synchronously subscribe/unsubscribe during notification — `useSyncExternalStore`/
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

    entry.run = (force: boolean): Promise<unknown> => {
      // Dedup — but join the in-flight fetch ONLY when it belongs to the current generation. An
      // `invalidateQueries` bumps `generation`, so a fetch that started *before* the invalidation is
      // superseded and must NOT satisfy this call (its data is pre-mutation); fall through and kick a
      // fresh fetch instead of returning the stale in-flight one.
      if (entry.promise !== undefined && entry.promiseGen === entry.generation) return entry.promise
      if (!force && entry.state.status === "success" && !isStale())
        return Promise.resolve(entry.state.data) // fresh cache hit — no fn call
      const gen = entry.generation
      entry.setState({ ...entry.state, isFetching: true }) // show the background/initial fetch
      const promise = (async () => {
        try {
          const data = await entry.fn()
          // A newer generation (a later invalidate/refetch) owns the entry now — discard this result
          // rather than publishing pre-mutation data as fresh or clearing `invalidated`. The fetch
          // that superseded this one publishes the post-mutation data.
          if (gen !== entry.generation) return data
          entry.invalidated = false
          entry.setState(successState(data, now()))
          return data
        } catch (error) {
          if (gen === entry.generation)
            entry.setState({ ...entry.state, status: "error", error, isFetching: false })
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
      fetch: () => entry.run(false),
      refetch: () => entry.run(true),
    }
    return entry
  }

  // Get an entry by key, or create + insert a fresh one. `fn`/`staleTime` re-bind on an existing entry.
  const upsert = (key: unknown, fn: () => Promise<unknown>, staleTime: number): Entry => {
    const h = hashQueryKey(key)
    const existing = cache.get(h)
    if (existing !== undefined) {
      existing.fn = fn
      existing.staleTime = staleTime
      return existing
    }
    const entry = makeEntry(key, fn, staleTime)
    cache.set(h, entry)
    return entry
  }

  const query = <T>(key: unknown, fn: () => Promise<T>, opts?: QueryOptions): QueryHandle<T> => {
    sweep()
    return upsert(key, fn as () => Promise<unknown>, opts?.staleTime ?? defaultStaleTime)
      .handle as QueryHandle<T>
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

  const getQueryData = <T>(key: unknown): T | undefined => {
    const entry = cache.get(hashQueryKey(key))
    return entry !== undefined && entry.state.status === "success"
      ? (entry.state.data as T)
      : undefined
  }

  const setQueryData = <T>(key: unknown, updater: T | ((prev: T | undefined) => T)): void => {
    // Create a placeholder entry if none exists — its `fn` throws until a real `query(key, fn)` re-binds
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
    // A direct write is the new truth — bump the generation so any in-flight fetch can't overwrite it,
    // and clear the invalidated flag (the caller just supplied fresh data).
    entry.generation++
    entry.invalidated = false
    entry.setState(successState(data, now()))
  }

  const prefetchQuery = async <T>(
    key: unknown,
    fn: () => Promise<T>,
    opts?: QueryOptions,
  ): Promise<void> => {
    sweep()
    await upsert(key, fn as () => Promise<unknown>, opts?.staleTime ?? defaultStaleTime).run(false)
  }

  const dehydrate = (): DehydratedState => {
    const queries: Array<{ key: unknown; data: unknown; updatedAt: number }> = []
    for (const entry of cache.values()) {
      if (entry.state.status === "success")
        queries.push({ key: entry.key, data: entry.state.data, updatedAt: entry.state.updatedAt })
    }
    return { queries }
  }

  const hydrate = (state: DehydratedState): void => {
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
      if (entry.state.status !== "success" || q.updatedAt > entry.state.updatedAt)
        entry.setState(successState(q.data, q.updatedAt))
    }
  }

  // --- Infinite (paged) queries -----------------------------------------------------------------
  const infiniteQuery = <T, P>(
    key: unknown,
    fn: (pageParam: P) => Promise<T>,
    opts: InfiniteQueryOptions<T, P>,
  ): InfiniteQueryHandle<T, P> => {
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
    const created = makeInfinite<T, P>(fn, opts)
    infinite.set(h, created as InfiniteEntry<unknown, unknown>)
    return created.handle
  }

  // Infinite entries live in their own map (their data shape + fetch model differ from plain queries).
  interface InfiniteEntry<T, P> {
    handle: InfiniteQueryHandle<T, P>
    rebind: (fn: (p: P) => Promise<T>, opts: InfiniteQueryOptions<T, P>) => void
  }
  const infinite = new Map<string, InfiniteEntry<unknown, unknown>>()

  const makeInfinite = <T, P>(
    fetchPage: (pageParam: P) => Promise<T>,
    initialOpts: InfiniteQueryOptions<T, P>,
  ): InfiniteEntry<T, P> => {
    let fn = fetchPage
    let opts = initialOpts
    let state: QueryState<InfiniteData<T, P>> = PENDING as QueryState<InfiniteData<T, P>>
    let generation = 0
    let promise: Promise<InfiniteData<T, P>> | undefined
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
    const isStale = (): boolean => now() - state.updatedAt >= (opts.staleTime ?? defaultStaleTime)

    // Run a paged operation under a fresh generation, guarding against a superseding op (like `run`).
    const runPaged = (build: () => Promise<InfiniteData<T, P>>): Promise<InfiniteData<T, P>> => {
      if (promise !== undefined) return promise
      const gen = ++generation
      setState({ ...state, isFetching: true })
      const p = (async () => {
        try {
          const data = await build()
          if (gen !== generation) return data
          setState(successState(data, now()))
          return data
        } catch (error) {
          if (gen === generation) setState({ ...state, status: "error", error, isFetching: false })
          throw error
        } finally {
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

    const handle: InfiniteQueryHandle<T, P> = {
      snapshot: () => state,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      fetch: () => fetchFirst(false),
      refetch: () =>
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
        }),
      fetchNextPage: () => {
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
        const p = state.data === undefined ? undefined : nextParam(state.data)
        return p !== undefined && p !== null
      },
      hasPreviousPage: () => {
        const p = state.data === undefined ? undefined : prevParam(state.data)
        return p !== undefined && p !== null
      },
    }
    return {
      handle: handle as InfiniteQueryHandle<unknown, unknown>,
      rebind: (nextFn, nextOpts) => {
        fn = nextFn
        opts = nextOpts
      },
    } as InfiniteEntry<T, P>
  }

  return {
    query,
    infiniteQuery,
    invalidateQueries,
    getQueryData,
    setQueryData,
    prefetchQuery,
    dehydrate,
    hydrate,
  }
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
  /** Run the mutation. Resolves to the data (and runs onSuccess/onSettled) or rejects (onError/onSettled).
   * The latest concurrent call wins the published state (older results are dropped). */
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
 * Create a standalone mutation state machine — framework-agnostic, so a per-adapter `useMutation`
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
  let token = 0
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
      const mine = ++token
      setState({ status: "pending", data: undefined, error: undefined, variables })
      // Only await a callback when one is actually supplied — an `await undefined` would insert a
      // needless microtask before the mutationFn runs (and complicates single-flight timing).
      if (cbs.onMutate !== undefined) await cbs.onMutate(variables)
      try {
        const data = await mutationFn(variables)
        if (mine === token) setState({ status: "success", data, error: undefined, variables })
        if (cbs.onSuccess !== undefined) await cbs.onSuccess(data, variables)
        if (cbs.onSettled !== undefined) await cbs.onSettled(data, undefined, variables)
        return data
      } catch (error) {
        if (mine === token) setState({ status: "error", data: undefined, error, variables })
        if (cbs.onError !== undefined) await cbs.onError(error, variables)
        if (cbs.onSettled !== undefined) await cbs.onSettled(undefined, error, variables)
        throw error
      }
    },
  }
}

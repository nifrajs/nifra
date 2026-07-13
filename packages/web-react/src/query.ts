/**
 * `@nifrajs/web-react/query` — React bindings for the keyed query-cache + mutations: `useQuery`,
 * `useInfiniteQuery`, `useMutation`, `useQueryClient`, `QueryClientProvider`, and the SSR
 * `HydrationBoundary` (+ `dehydrate` re-exported). A drop-in for the TanStack Query surface realty uses,
 * backed by `@nifrajs/web`'s agnostic engine. Imports only `react` + `@nifrajs/web` (never `react-dom/*`),
 * so route components use it on the server *and* client. No JSX (the package builds with plain `tsc`).
 *
 * Resolution order for the client a hook uses: a `QueryClientProvider` in the tree (required for SSR
 * dehydrate/hydrate and for tests), else a lazily-created **client-side** module singleton (the simple
 * client-only app — the `typeof window` guard means the server has none, so hooks render idle/pending
 * and the first client render matches for a clean hydration).
 */
import {
  createMutation,
  createQueryClient,
  type DehydratedState,
  type InfiniteData,
  type InfiniteQueryOptions,
  type MutationCallbacks,
  type MutationHandle,
  type MutationState,
  type QueryClient,
  type QueryHandle,
  type QueryOptions,
  type QueryState,
} from "@nifrajs/web"
import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react"

export type { DehydratedState } from "@nifrajs/web"

// The lazily-created client-side singleton (used when no QueryClientProvider is present). SSR-guarded:
// the server has no singleton, so provider-less hooks render idle there.
let singleton: QueryClient | undefined
function getSingleton(): QueryClient | undefined {
  if (typeof window === "undefined") return undefined
  if (singleton === undefined) singleton = createQueryClient({ now: () => Date.now() })
  return singleton
}

// A no-op client for the server / pre-hydration (all reads empty, all writes ignored). Stable ref so a
// hook's `useSyncExternalStore` server snapshot is consistent.
const NOOP_CLIENT: QueryClient = {
  query: () => IDLE_HANDLE as QueryHandle<never>,
  infiniteQuery: () => IDLE_INFINITE_HANDLE as never,
  invalidateQueries: () => {},
  getQueryData: () => undefined,
  setQueryData: () => {},
  prefetchQuery: async () => {},
  dehydrate: () => ({ queries: [] }),
  hydrate: () => {},
}

const QueryClientContext = createContext<QueryClient | undefined>(undefined)

/** Provide a {@link QueryClient} to the tree — required for SSR dehydrate/hydrate and for tests; a
 * client-only app can omit it and rely on the built-in client-side singleton. */
export function QueryClientProvider(props: {
  readonly client: QueryClient
  readonly children?: ReactNode
}): ReactNode {
  return createElement(QueryClientContext.Provider, { value: props.client }, props.children)
}

/** The active {@link QueryClient}: a `QueryClientProvider`'s client, else the client-side singleton,
 * else a no-op (server / pre-hydration). Use it to `invalidateQueries`/`setQueryData`/`prefetchQuery`. */
export function useQueryClient(): QueryClient {
  const provided = useContext(QueryClientContext)
  return provided ?? getSingleton() ?? NOOP_CLIENT
}

// Stable idle snapshots + handles for the server / pre-fetch render (stable refs → no loop, no mismatch).
const IDLE: QueryState<never> = Object.freeze({
  status: "pending",
  data: undefined,
  error: undefined,
  isFetching: false,
  updatedAt: Number.NEGATIVE_INFINITY,
})
const idleSnapshot = (): QueryState<never> => IDLE
const IDLE_INFINITE: QueryState<InfiniteData<never, never>> = IDLE as QueryState<
  InfiniteData<never, never>
>
const idleInfiniteSnapshot = (): QueryState<InfiniteData<never, never>> => IDLE_INFINITE
const noopSubscribe = (): (() => void) => () => {}
const noopAsync = async (): Promise<never> => {
  throw new Error("[nifra/web-react] query action called with no query client (server?)")
}
const IDLE_HANDLE: QueryHandle<never> = {
  snapshot: idleSnapshot,
  subscribe: noopSubscribe,
  fetch: noopAsync,
  refetch: noopAsync,
}
const IDLE_INFINITE_HANDLE = {
  snapshot: idleInfiniteSnapshot,
  subscribe: noopSubscribe,
  fetch: noopAsync,
  refetch: noopAsync,
  fetchNextPage: noopAsync,
  fetchPreviousPage: noopAsync,
  hasNextPage: () => false,
  hasPreviousPage: () => false,
}

/** Options for {@link useQuery}. */
export interface UseQueryOptions extends QueryOptions {
  /** When `false`, don't fetch (the query stays idle) — for dependent queries. Default `true`. */
  readonly enabled?: boolean
}

/** A query's reactive {@link QueryState} plus `isPending` + `refetch`. */
export interface UseQueryResult<T> extends QueryState<T> {
  /** `status === "pending"` — no data yet (initial load). */
  readonly isPending: boolean
  /** `status === "error"`. */
  readonly isError: boolean
  /** `status === "success"`. */
  readonly isSuccess: boolean
  /** Force a refetch (ignores `staleTime`). */
  readonly refetch: () => Promise<T>
}

/**
 * Subscribe to the keyed query for `key`, fetched via `fn`. Returns `{ status, data, error, isFetching,
 * updatedAt, isPending, isError, isSuccess, refetch }`. Concurrent `useQuery`s with the same key share
 * one cache entry + one in-flight fetch (dedup). Fetches on mount and when the key changes; `enabled:
 * false` keeps it idle (dependent queries). SSR-idle unless a `QueryClientProvider` supplies a hydrated
 * client.
 */
export function useQuery<T>(
  key: unknown,
  fn: () => Promise<T>,
  options?: UseQueryOptions,
): UseQueryResult<T> {
  const client = useQueryClient()
  const enabled = options?.enabled !== false
  const queryOpts: QueryOptions | undefined =
    options?.staleTime !== undefined ? { staleTime: options.staleTime } : undefined
  // A disabled query still binds a handle (so it re-renders when re-enabled), but never fetches.
  const handle: QueryHandle<T> = client.query<T>(key, fn, queryOpts)
  // Server snapshot = the handle's own snapshot: without a provider the client is the NOOP one (idle),
  // but WITH a hydrated provider client it returns the server-seeded data — so a HydrationBoundary-fed
  // query renders its data during SSR and the first client render matches (no loading flash, no drift).
  const state = useSyncExternalStore<QueryState<T>>(
    handle.subscribe,
    handle.snapshot,
    handle.snapshot,
  )
  useEffect(() => {
    if (enabled) handle.fetch().catch(() => {})
  }, [handle, enabled])
  return {
    ...state,
    isPending: state.status === "pending",
    isError: state.status === "error",
    isSuccess: state.status === "success",
    refetch: handle.refetch,
  }
}

/** A mutation's reactive state + imperative controls (the TanStack `useMutation` shape). */
export interface UseMutationResult<TData, TVariables> extends MutationState<TData, TVariables> {
  readonly isIdle: boolean
  readonly isPending: boolean
  readonly isError: boolean
  readonly isSuccess: boolean
  /** Fire-and-forget: runs the mutation and swallows rejection (read `error`/`isError` for failures). */
  readonly mutate: (variables: TVariables) => void
  /** Run the mutation and return the promise (rejects on failure) — for `await`. */
  readonly mutateAsync: (variables: TVariables) => Promise<TData>
  /** Reset back to idle. */
  readonly reset: () => void
}

/**
 * A mutation hook (create/update/delete). Returns `{ mutate, mutateAsync, data, error, variables, isIdle,
 * isPending, isError, isSuccess, reset }`. Invalidate affected queries from `onSuccess` via
 * `useQueryClient().invalidateQueries(...)`. The handle is stable across renders; the latest `fn`/
 * callbacks re-bind each render.
 */
export function useMutation<TData, TVariables = void>(
  fn: (variables: TVariables) => Promise<TData>,
  callbacks: MutationCallbacks<TData, TVariables> = {},
): UseMutationResult<TData, TVariables> {
  const ref = useRef<MutationHandle<TData, TVariables> | undefined>(undefined)
  if (ref.current === undefined) ref.current = createMutation(fn, callbacks)
  const handle = ref.current
  handle.rebind(fn, callbacks) // pick up the latest closures each render
  const state = useSyncExternalStore(handle.subscribe, handle.snapshot, handle.snapshot)
  return {
    ...state,
    isIdle: state.status === "idle",
    isPending: state.status === "pending",
    isError: state.status === "error",
    isSuccess: state.status === "success",
    mutate: (variables) => {
      handle.mutate(variables).catch(() => {}) // fire-and-forget: don't surface an unhandled rejection
    },
    mutateAsync: handle.mutate,
    reset: handle.reset,
  }
}

/** Options for {@link useInfiniteQuery} — the engine's {@link InfiniteQueryOptions} plus `enabled`. */
export interface UseInfiniteQueryOptions<T, P> extends InfiniteQueryOptions<T, P> {
  readonly enabled?: boolean
}

/** An infinite query's reactive state + paging controls. */
export interface UseInfiniteQueryResult<T, P> extends QueryState<InfiniteData<T, P>> {
  readonly isPending: boolean
  readonly isError: boolean
  readonly isSuccess: boolean
  readonly fetchNextPage: () => Promise<InfiniteData<T, P>>
  readonly fetchPreviousPage: () => Promise<InfiniteData<T, P>>
  readonly hasNextPage: boolean
  readonly hasPreviousPage: boolean
  readonly refetch: () => Promise<InfiniteData<T, P>>
}

/**
 * Subscribe to a paged (infinite-scroll) query. Returns the accumulated `data.pages` plus
 * `fetchNextPage`/`fetchPreviousPage`/`hasNextPage`/`hasPreviousPage`. Fetches the first page on mount.
 * SSR-idle unless a `QueryClientProvider` supplies a hydrated client.
 */
export function useInfiniteQuery<T, P>(
  key: unknown,
  fn: (pageParam: P) => Promise<T>,
  options: UseInfiniteQueryOptions<T, P>,
): UseInfiniteQueryResult<T, P> {
  const client = useQueryClient()
  const enabled = options.enabled !== false
  const handle = client.infiniteQuery<T, P>(key, fn, options)
  const state = useSyncExternalStore(handle.subscribe, handle.snapshot, handle.snapshot)
  useEffect(() => {
    if (enabled) handle.fetch().catch(() => {})
  }, [handle, enabled])
  return {
    ...state,
    isPending: state.status === "pending",
    isError: state.status === "error",
    isSuccess: state.status === "success",
    fetchNextPage: handle.fetchNextPage,
    fetchPreviousPage: handle.fetchPreviousPage,
    hasNextPage: handle.hasNextPage(),
    hasPreviousPage: handle.hasPreviousPage(),
    refetch: handle.refetch,
  }
}

/**
 * Seed the context's {@link QueryClient} from a server {@link dehydrate} snapshot — the SSR data bridge.
 * Wrap the app (inside `QueryClientProvider`) so server-prefetched queries are in the cache before the
 * first client render, avoiding a loading flash. Hydration runs during render (idempotent, fresher-wins),
 * so the data is available synchronously to child `useQuery`s.
 */
export function HydrationBoundary(props: {
  readonly state: DehydratedState | undefined
  readonly children?: ReactNode
}): ReactNode {
  const client = useQueryClient()
  const { state } = props
  useMemo(() => {
    if (state !== undefined) client.hydrate(state)
  }, [client, state])
  return props.children ?? null
}

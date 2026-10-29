import type {
  DehydratedState,
  InfiniteData,
  InfiniteQueryOptions,
  MutationCallbacks,
  MutationContext,
  MutationHandle,
  MutationState,
  QueryClient,
  QueryHandle,
  QueryOptions,
  QueryState,
} from "@nifrajs/web"
import { createMutation } from "@nifrajs/web/client"
import {
  createNoClientRefetch,
  fetchOnMount,
  getQueryClientSingleton,
  IDLE_QUERY_STATE,
  noop,
  noopSubscribe,
} from "@nifrajs/web/internal/query-runtime"
import { type ComponentChildren, createContext, createElement } from "preact"
/**
 * `@nifrajs/web-preact/query` - Preact bindings for the keyed query-cache. `useQuery(key, fn)` subscribes a
 * component to a query (via `useSyncExternalStore` from preact/compat) and fetches on mount / key change;
 * `useQueryClient` exposes `invalidateQueries` for after a mutation. Imports only `preact/compat` +
 * `preact/hooks` + `@nifrajs/web`, so route components use it on the server *and* client. No JSX.
 *
 * Without a provider, the query client is created lazily **client-side only**; SSR uses an idle
 * snapshot and route loaders remain the data source. `QueryClientProvider` supplies a request-scoped
 * client so prefetched query state can render on the server and match the first client render.
 */
import { useSyncExternalStore } from "preact/compat"
import { useContext, useEffect, useMemo, useRef } from "preact/hooks"

const QueryClientContext = createContext<QueryClient | undefined>(undefined)

function useQueryClientForCurrentTree(): QueryClient | undefined {
  let provided: QueryClient | undefined
  try {
    provided = useContext(QueryClientContext)
  } catch {
    // Preserve the adapter's server-safe no-op when useQueryClient is called outside render.
  }
  return provided ?? getQueryClientSingleton()
}

/** Provide an SSR/request-scoped query client or an application-specific client. */
export function QueryClientProvider(props: {
  readonly client: QueryClient
  readonly children?: ComponentChildren
}): ComponentChildren {
  return createElement(QueryClientContext.Provider, { value: props.client }, props.children)
}

/** Seed the provider's cache before its child queries read their first snapshot. */
export function HydrationBoundary(props: {
  readonly state: DehydratedState | undefined
  readonly children?: ComponentChildren
}): ComponentChildren {
  const client = useQueryClientForCurrentTree()
  useMemo(() => {
    if (props.state !== undefined) client?.hydrate(props.state)
  }, [client, props.state])
  return props.children ?? null
}

/** Access the query client to imperatively `invalidateQueries(keyOrPrefix)` (e.g. after a mutation). */
export function useQueryClient(): Pick<QueryClient, "invalidateQueries"> {
  return useQueryClientForCurrentTree() ?? { invalidateQueries: noop }
}

// Stable idle snapshot for the server / pre-fetch render (stable ref → no loop, no hydration mismatch).
const idleSnapshot = (): QueryState<never> => IDLE_QUERY_STATE
const noopAsync = createNoClientRefetch<never>("[nifra/web-preact]", "useQuery.refetch")

/** A query's reactive {@link QueryState} plus `isPending` + `refetch`. */
export interface UseQueryResult<T> extends QueryState<T> {
  /** `status === "pending"` - no data yet (initial load). */
  readonly isPending: boolean
  /** Force a refetch (ignores `staleTime`). */
  readonly refetch: () => Promise<T>
}

/**
 * Subscribe to the keyed query for `key`, fetched via `fn`. Returns `{ status, data, error, isFetching,
 * updatedAt, isPending, refetch }`. Concurrent `useQuery`s with the same key share one cache entry +
 * one in-flight fetch (dedup). Refetches on mount and when the key changes; SSR-idle. `options.live`
 * names the live keys that refetch it.
 */
export function useQuery<T>(
  key: unknown,
  fn: () => Promise<T>,
  options?: QueryOptions,
): UseQueryResult<T> {
  const handle: QueryHandle<T> | undefined = useQueryClientForCurrentTree()?.query<T>(
    key,
    fn,
    options,
  )
  const state = useSyncExternalStore<QueryState<T>>(
    handle?.subscribe ?? noopSubscribe,
    handle ? handle.snapshot : idleSnapshot,
  )
  // Fetch on mount + whenever the key changes (the handle is stable per key, so it changes with the key).
  useEffect(fetchOnMount(handle), [handle])
  return {
    ...state,
    isPending: state.status === "pending",
    refetch: handle ? handle.refetch : (noopAsync as () => Promise<T>),
  }
}

/** Observable mutation state and imperative controls. */
export interface UseMutationResult<TData, TVariables> extends MutationState<TData, TVariables> {
  readonly isIdle: boolean
  readonly isPending: boolean
  readonly isError: boolean
  readonly isSuccess: boolean
  readonly mutate: (variables: TVariables) => void
  readonly mutateAsync: (variables: TVariables) => Promise<TData>
  readonly reset: () => void
  readonly cancel: () => void
}

/** A mutation binding with Preact state subscriptions and identity-boundary cancellation. */
export function useMutation<TData, TVariables = void>(
  fn: (variables: TVariables, context: MutationContext) => Promise<TData>,
  callbacks: MutationCallbacks<TData, TVariables> = {},
): UseMutationResult<TData, TVariables> {
  const ref = useRef<MutationHandle<TData, TVariables> | undefined>(undefined)
  if (ref.current === undefined) ref.current = createMutation(fn, callbacks)
  const handle = ref.current
  handle.rebind(fn, callbacks)
  const state = useSyncExternalStore(handle.subscribe, handle.snapshot, handle.snapshot)
  return {
    ...state,
    isIdle: state.status === "idle",
    isPending: state.status === "pending",
    isError: state.status === "error",
    isSuccess: state.status === "success",
    mutate: (variables) => {
      handle.mutate(variables).catch(noop)
    },
    mutateAsync: handle.mutate,
    reset: handle.reset,
    cancel: handle.cancel,
  }
}

/** Options for an infinite query. */
export interface UseInfiniteQueryOptions<T, P> extends InfiniteQueryOptions<T, P> {
  readonly enabled?: boolean
}

/** Infinite-query state and page controls. */
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

// biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The idle state has no query data, so its generic payload is unused.
const IDLE_INFINITE_STATE = IDLE_QUERY_STATE as QueryState<InfiniteData<never, never>>
const idleInfiniteSnapshot = (): QueryState<InfiniteData<never, never>> => IDLE_INFINITE_STATE

/** A paged query binding that follows Preact's mount and subscription lifecycle. */
export function useInfiniteQuery<T, P>(
  key: unknown,
  fn: (pageParam: P) => Promise<T>,
  options: UseInfiniteQueryOptions<T, P>,
): UseInfiniteQueryResult<T, P> {
  const client = useQueryClientForCurrentTree()
  const enabled = options.enabled !== false
  const handle = client?.infiniteQuery<T, P>(key, fn, options)
  const state = useSyncExternalStore(
    handle?.subscribe ?? noopSubscribe,
    handle ? handle.snapshot : idleInfiniteSnapshot,
    handle ? handle.snapshot : idleInfiniteSnapshot,
  )
  useEffect(fetchOnMount(enabled ? handle : undefined), [handle, enabled])
  const noClientAction = createNoClientRefetch<InfiniteData<T, P>>(
    "[nifra/web-preact]",
    "infinite query action",
  )
  return {
    ...state,
    isPending: state.status === "pending",
    isError: state.status === "error",
    isSuccess: state.status === "success",
    fetchNextPage: handle?.fetchNextPage ?? noClientAction,
    fetchPreviousPage: handle?.fetchPreviousPage ?? noClientAction,
    hasNextPage: handle?.hasNextPage() ?? false,
    hasPreviousPage: handle?.hasPreviousPage() ?? false,
    refetch: handle?.refetch ?? noClientAction,
  }
}

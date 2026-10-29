import type {
  DehydratedState,
  InfiniteData,
  InfiniteQueryOptions,
  MutationCallbacks,
  MutationContext,
  MutationHandle,
  MutationState,
  QueryClient,
  QueryOptions,
  QueryState,
} from "@nifrajs/web"
import { createMutation as createMutationHandle } from "@nifrajs/web/client"
import {
  createNoClientRefetch,
  fetchOnMount,
  getQueryClientSingleton,
  IDLE_QUERY_STATE,
  noop,
} from "@nifrajs/web/internal/query-runtime"
/**
 * `@nifrajs/web-solid/query` - Solid bindings for the keyed query-cache. `createQuery(key, fn)` bridges a
 * query's `subscribe`/`snapshot` store into a Solid signal and fetches on mount; `useQueryClient`
 * exposes `invalidateQueries` for after a mutation. Imports only `solid-js` + `@nifrajs/web` (never
 * `solid-js/web`), so route components use it on the server *and* client. No JSX.
 *
 * Without a provider, the query client is created lazily **client-side only** (`typeof window`) - on
 * the server the accessor returns idle state and route loaders remain the data source. A
 * `QueryClientProvider` can supply a request-scoped hydrated client.
 * The `key` is captured once (Solid setup runs once); a reactive key is a documented future enhancement.
 */
import {
  type Accessor,
  createComponent,
  createContext,
  createSignal,
  type JSX,
  onCleanup,
  onMount,
  useContext,
} from "solid-js"

const QueryClientContext = createContext<QueryClient>()

function queryClientForCurrentTree(): QueryClient | undefined {
  return useContext(QueryClientContext) ?? getQueryClientSingleton()
}

/** Provide a request-scoped client and optionally seed it before descendants run. */
export function QueryClientProvider(props: {
  readonly client: QueryClient
  readonly state?: DehydratedState
  readonly children?: JSX.Element
}): JSX.Element {
  if (props.state !== undefined) props.client.hydrate(props.state)
  return createComponent(QueryClientContext.Provider, {
    value: props.client,
    get children() {
      return props.children
    },
  })
}

/** Access the query client to imperatively `invalidateQueries(keyOrPrefix)` (e.g. after a mutation). */
export function useQueryClient(): Pick<QueryClient, "invalidateQueries"> {
  return queryClientForCurrentTree() ?? { invalidateQueries: noop }
}

/** A query's reactive state accessor plus `refetch`. */
export interface CreateQueryResult<T> {
  /** Reactive accessor for the {@link QueryState} (`status`/`data`/`error`/`isFetching`/`updatedAt`). */
  readonly state: Accessor<QueryState<T>>
  /** Force a refetch (ignores `staleTime`). */
  readonly refetch: () => Promise<T>
}

/**
 * Bind the keyed query for `key`, fetched via `fn`. Returns a reactive `state()` accessor + `refetch`.
 * Concurrent `createQuery`s with the same key share one cache entry + one in-flight fetch (dedup).
 * Fetches on mount; SSR-idle. Call inside a component (owns the subscription). `options.live` names
 * the live keys that refetch it.
 */
export function createQuery<T>(
  key: unknown,
  fn: () => Promise<T>,
  options?: QueryOptions,
): CreateQueryResult<T> {
  const handle = queryClientForCurrentTree()?.query<T>(key, fn, options)
  const [state, setState] = createSignal<QueryState<T>>(
    handle ? handle.snapshot() : IDLE_QUERY_STATE,
  )
  if (handle !== undefined) {
    onCleanup(handle.subscribe(() => setState(() => handle.snapshot())))
    onMount(fetchOnMount(handle))
    return { state, refetch: handle.refetch }
  }
  return {
    state,
    refetch: createNoClientRefetch<T>("[nifra/web-solid]", "createQuery.refetch"),
  }
}

/** A mutation result expressed as Solid accessors and imperative controls. */
export interface CreateMutationResult<TData, TVariables> {
  readonly state: Accessor<MutationState<TData, TVariables>>
  readonly isIdle: Accessor<boolean>
  readonly isPending: Accessor<boolean>
  readonly isError: Accessor<boolean>
  readonly isSuccess: Accessor<boolean>
  readonly mutate: (variables: TVariables) => void
  readonly mutateAsync: (variables: TVariables) => Promise<TData>
  readonly reset: () => void
  readonly cancel: () => void
}

/** Bind a mutation to a Solid owner. Identity changes discard late results and callbacks. */
export function createMutation<TData, TVariables = void>(
  fn: (variables: TVariables, context: MutationContext) => Promise<TData>,
  callbacks: MutationCallbacks<TData, TVariables> = {},
): CreateMutationResult<TData, TVariables> {
  const handle: MutationHandle<TData, TVariables> = createMutationHandle(fn, callbacks)
  const [state, setState] = createSignal(handle.snapshot())
  onCleanup(handle.subscribe(() => setState(() => handle.snapshot())))
  return {
    state,
    isIdle: () => state().status === "idle",
    isPending: () => state().status === "pending",
    isError: () => state().status === "error",
    isSuccess: () => state().status === "success",
    mutate: (variables) => {
      handle.mutate(variables).catch(noop)
    },
    mutateAsync: handle.mutate,
    reset: handle.reset,
    cancel: handle.cancel,
  }
}

/** Options for a Solid infinite query. */
export interface CreateInfiniteQueryOptions<T, P> extends InfiniteQueryOptions<T, P> {
  readonly enabled?: boolean
}

/** Infinite-query state and page controls expressed as Solid accessors. */
export interface CreateInfiniteQueryResult<T, P> {
  readonly state: Accessor<QueryState<InfiniteData<T, P>>>
  readonly isPending: Accessor<boolean>
  readonly isError: Accessor<boolean>
  readonly isSuccess: Accessor<boolean>
  readonly hasNextPage: Accessor<boolean>
  readonly hasPreviousPage: Accessor<boolean>
  readonly fetchNextPage: () => Promise<InfiniteData<T, P>>
  readonly fetchPreviousPage: () => Promise<InfiniteData<T, P>>
  readonly refetch: () => Promise<InfiniteData<T, P>>
}

/** Bind a paged query to a Solid owner and fetch its first page on mount. */
export function createInfiniteQuery<T, P>(
  key: unknown,
  fn: (pageParam: P) => Promise<T>,
  options: CreateInfiniteQueryOptions<T, P>,
): CreateInfiniteQueryResult<T, P> {
  const client = queryClientForCurrentTree()
  const enabled = options.enabled !== false
  const handle = client?.infiniteQuery<T, P>(key, fn, options)
  const [state, setState] = createSignal<QueryState<InfiniteData<T, P>>>(
    handle ? handle.snapshot() : (IDLE_QUERY_STATE as QueryState<InfiniteData<T, P>>),
  )
  if (handle) {
    onCleanup(handle.subscribe(() => setState(() => handle.snapshot())))
    onMount(() => {
      if (enabled) handle.fetch().catch(noop)
    })
  }
  const noClientAction = createNoClientRefetch<InfiniteData<T, P>>(
    "[nifra/web-solid]",
    "infinite query action",
  )
  return {
    state,
    isPending: () => state().status === "pending",
    isError: () => state().status === "error",
    isSuccess: () => state().status === "success",
    hasNextPage: () => {
      state()
      return handle?.hasNextPage() ?? false
    },
    hasPreviousPage: () => {
      state()
      return handle?.hasPreviousPage() ?? false
    },
    fetchNextPage: handle?.fetchNextPage ?? noClientAction,
    fetchPreviousPage: handle?.fetchPreviousPage ?? noClientAction,
    refetch: handle?.refetch ?? noClientAction,
  }
}

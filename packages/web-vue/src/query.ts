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
} from "@nifrajs/web/internal/query-runtime"
/**
 * `@nifrajs/web-vue/query` - Vue bindings for the keyed query-cache. `useQuery(key, fn)` subscribes a
 * component to a query (a `shallowRef` fed by `handle.subscribe`) and fetches on mount; `useQueryClient`
 * exposes `invalidateQueries` for after a mutation. Imports only `vue` + `@nifrajs/web`.
 *
 * Without a provider, the query client is created lazily **client-side only**; SSR uses an idle
 * snapshot and route loaders remain the data source. `provideQueryClient(client, state)` supplies a
 * request-scoped cache before child setup. The key is read once at setup; key the component when it
 * changes.
 */
import {
  type ComputedRef,
  computed,
  getCurrentInstance,
  type InjectionKey,
  inject,
  onMounted,
  onScopeDispose,
  provide,
  type ShallowRef,
  shallowRef,
} from "vue"

const QUERY_CLIENT_KEY: InjectionKey<QueryClient> = Symbol.for("@nifrajs/web-vue/query-client")

function queryClientForCurrentTree(): QueryClient | undefined {
  const provided = getCurrentInstance() ? inject(QUERY_CLIENT_KEY, undefined) : undefined
  return provided ?? getQueryClientSingleton()
}

/** Provide a request-scoped client and optionally hydrate it before child setup runs. */
export function provideQueryClient(client: QueryClient, state?: DehydratedState): void {
  if (!getCurrentInstance()) {
    throw new Error("[nifra/web-vue] provideQueryClient must run during component setup")
  }
  if (state !== undefined) client.hydrate(state)
  provide(QUERY_CLIENT_KEY, client)
}

/** Access the query client to imperatively `invalidateQueries(keyOrPrefix)` (e.g. after a mutation). */
export function useQueryClient(): Pick<QueryClient, "invalidateQueries"> {
  return queryClientForCurrentTree() ?? { invalidateQueries: noop }
}

/** A query's reactive {@link QueryState} (read `.value`) plus `refetch`. */
export interface UseQueryResult<T> {
  readonly state: Readonly<ShallowRef<QueryState<T>>>
  /** Force a refetch (ignores `staleTime`). */
  readonly refetch: () => Promise<T>
}

/**
 * Subscribe to the keyed query for `key`, fetched via `fn`. Returns a reactive `state` ref (`status`,
 * `data`, `error`, `isFetching`, `updatedAt`) + `refetch`. Concurrent `useQuery`s with the same key
 * share one cache entry + one in-flight fetch (dedup). Fetches on mount; SSR-idle. `options.live`
 * names the live keys that refetch it.
 */
export function useQuery<T>(
  key: unknown,
  fn: () => Promise<T>,
  options?: QueryOptions,
): UseQueryResult<T> {
  const handle: QueryHandle<T> | undefined = queryClientForCurrentTree()?.query<T>(key, fn, options)
  const state = shallowRef<QueryState<T>>(handle ? handle.snapshot() : IDLE_QUERY_STATE)
  if (handle) {
    const unsubscribe = handle.subscribe(() => {
      state.value = handle.snapshot()
    })
    onScopeDispose(unsubscribe)
    onMounted(fetchOnMount(handle))
  }
  return {
    state,
    refetch: handle
      ? handle.refetch
      : createNoClientRefetch<T>("[nifra/web-vue]", "useQuery.refetch"),
  }
}

/** A Vue mutation result with reactive state and promise/fire-and-forget controls. */
export interface UseMutationResult<TData, TVariables> {
  readonly state: Readonly<ShallowRef<MutationState<TData, TVariables>>>
  readonly isIdle: ComputedRef<boolean>
  readonly isPending: ComputedRef<boolean>
  readonly isError: ComputedRef<boolean>
  readonly isSuccess: ComputedRef<boolean>
  readonly mutate: (variables: TVariables) => void
  readonly mutateAsync: (variables: TVariables) => Promise<TData>
  readonly reset: () => void
  readonly cancel: () => void
}

/** Bind a mutation to Vue's effect scope. Identity changes discard late results and callbacks. */
export function useMutation<TData, TVariables = void>(
  fn: (variables: TVariables, context: MutationContext) => Promise<TData>,
  callbacks: MutationCallbacks<TData, TVariables> = {},
): UseMutationResult<TData, TVariables> {
  const handle: MutationHandle<TData, TVariables> = createMutation(fn, callbacks)
  const state = shallowRef(handle.snapshot())
  const unsubscribe = handle.subscribe(() => {
    state.value = handle.snapshot()
  })
  onScopeDispose(unsubscribe)
  return {
    state,
    isIdle: computed(() => state.value.status === "idle"),
    isPending: computed(() => state.value.status === "pending"),
    isError: computed(() => state.value.status === "error"),
    isSuccess: computed(() => state.value.status === "success"),
    mutate: (variables) => {
      handle.mutate(variables).catch(noop)
    },
    mutateAsync: handle.mutate,
    reset: handle.reset,
    cancel: handle.cancel,
  }
}

/** Options for a Vue infinite query. */
export interface UseInfiniteQueryOptions<T, P> extends InfiniteQueryOptions<T, P> {
  readonly enabled?: boolean
}

/** Infinite-query state and page controls as Vue refs/computed values. */
export interface UseInfiniteQueryResult<T, P> {
  readonly state: Readonly<ShallowRef<QueryState<InfiniteData<T, P>>>>
  readonly isPending: ComputedRef<boolean>
  readonly isError: ComputedRef<boolean>
  readonly isSuccess: ComputedRef<boolean>
  readonly hasNextPage: ComputedRef<boolean>
  readonly hasPreviousPage: ComputedRef<boolean>
  readonly fetchNextPage: () => Promise<InfiniteData<T, P>>
  readonly fetchPreviousPage: () => Promise<InfiniteData<T, P>>
  readonly refetch: () => Promise<InfiniteData<T, P>>
}

/** Bind a paged query to Vue's mount and effect-scope lifecycles. */
export function useInfiniteQuery<T, P>(
  key: unknown,
  fn: (pageParam: P) => Promise<T>,
  options: UseInfiniteQueryOptions<T, P>,
): UseInfiniteQueryResult<T, P> {
  const client = queryClientForCurrentTree()
  const enabled = options.enabled !== false
  const handle = client?.infiniteQuery<T, P>(key, fn, options)
  const state = shallowRef<QueryState<InfiniteData<T, P>>>(
    handle ? handle.snapshot() : (IDLE_QUERY_STATE as QueryState<InfiniteData<T, P>>),
  )
  if (handle) {
    const unsubscribe = handle.subscribe(() => {
      state.value = handle.snapshot()
    })
    onScopeDispose(unsubscribe)
    onMounted(() => {
      if (enabled) handle.fetch().catch(noop)
    })
  }
  const noClientAction = createNoClientRefetch<InfiniteData<T, P>>(
    "[nifra/web-vue]",
    "infinite query action",
  )
  return {
    state,
    isPending: computed(() => state.value.status === "pending"),
    isError: computed(() => state.value.status === "error"),
    isSuccess: computed(() => state.value.status === "success"),
    hasNextPage: computed(() => {
      void state.value
      return handle?.hasNextPage() ?? false
    }),
    hasPreviousPage: computed(() => {
      void state.value
      return handle?.hasPreviousPage() ?? false
    }),
    fetchNextPage: handle?.fetchNextPage ?? noClientAction,
    fetchPreviousPage: handle?.fetchPreviousPage ?? noClientAction,
    refetch: handle?.refetch ?? noClientAction,
  }
}

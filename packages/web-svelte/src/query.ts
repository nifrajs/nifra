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
  getQueryClientSingleton,
  IDLE_QUERY_STATE,
  noop,
} from "@nifrajs/web/internal/query-runtime"
/**
 * `@nifrajs/web-svelte/query` - Svelte bindings for the keyed query-cache, as **Svelte stores** (plain
 * `.ts`). `useQuery(key, fn)` returns a `Readable<QueryState<T>>` augmented with `refetch` - read it
 * reactively with `$query`. The store fetches on mount (the start notifier fires on the first
 * `$`-subscription) and subscribes to the cache entry; concurrent `useQuery`s with the same key share
 * one entry + one in-flight fetch (dedup). `useQueryClient` exposes `invalidateQueries`.
 *
 * Without a provider, the query client is created lazily **client-side only**; SSR uses an idle
 * snapshot and route loaders remain the data source. `provideQueryClient(client, state)` supplies a
 * request-scoped cache before descendant stores initialize.
 */
import { getContext, setContext } from "svelte"
import { type Readable, readable } from "svelte/store"

const QUERY_CLIENT_CONTEXT = Symbol.for("@nifrajs/web-svelte/query-client")

function queryClientForCurrentTree(): QueryClient | undefined {
  let provided: QueryClient | undefined
  try {
    provided = getContext<QueryClient>(QUERY_CLIENT_CONTEXT)
  } catch {
    // Svelte's context API is only available while a component is initializing.
  }
  return provided ?? getQueryClientSingleton()
}

/** Set the component-tree client and hydrate it before descendants subscribe to queries. */
export function provideQueryClient(client: QueryClient, state?: DehydratedState): void {
  if (state !== undefined) client.hydrate(state)
  setContext(QUERY_CLIENT_CONTEXT, client)
}

/** Access the query client to imperatively `invalidateQueries(keyOrPrefix)` (e.g. after a mutation). */
export function useQueryClient(): Pick<QueryClient, "invalidateQueries"> {
  return queryClientForCurrentTree() ?? { invalidateQueries: noop }
}

/** A query store: a `Readable<QueryState<T>>` (read via `$`) plus `refetch`. */
export type QueryStore<T> = Readable<QueryState<T>> & {
  /** Force a refetch (ignores `staleTime`). */
  readonly refetch: () => Promise<T>
}

/**
 * Subscribe to the keyed query for `key`, fetched via `fn`. Returns a store of `{ status, data, error,
 * isFetching, updatedAt }` augmented with `refetch`. Fetches on mount (first `$`-subscription); SSR-idle.
 * `options.live` names the live keys that refetch it.
 */
export function useQuery<T>(
  key: unknown,
  fn: () => Promise<T>,
  options?: QueryOptions,
): QueryStore<T> {
  const handle: QueryHandle<T> | undefined = queryClientForCurrentTree()?.query<T>(key, fn, options)
  const store = readable<QueryState<T>>(handle ? handle.snapshot() : IDLE_QUERY_STATE, (set) => {
    if (handle === undefined) return
    set(handle.snapshot())
    const unsubscribe = handle.subscribe(() => set(handle.snapshot()))
    if (typeof window !== "undefined") handle.fetch().catch(noop) // fetch only in the browser
    return unsubscribe
  })
  const refetch = handle
    ? handle.refetch
    : createNoClientRefetch<T>("[nifra/web-svelte]", "useQuery.refetch")
  return Object.assign(store, { refetch })
}

/** A Svelte readable mutation state, augmented with imperative controls. */
export type MutationStore<TData, TVariables> = Readable<MutationState<TData, TVariables>> & {
  readonly mutate: (variables: TVariables) => void
  readonly mutateAsync: (variables: TVariables) => Promise<TData>
  readonly reset: () => void
  readonly cancel: () => void
}

/** Bind a mutation as a Svelte store. Identity changes discard late results and callbacks. */
export function useMutation<TData, TVariables = void>(
  fn: (variables: TVariables, context: MutationContext) => Promise<TData>,
  callbacks: MutationCallbacks<TData, TVariables> = {},
): MutationStore<TData, TVariables> {
  const handle: MutationHandle<TData, TVariables> = createMutation(fn, callbacks)
  const store = readable<MutationState<TData, TVariables>>(handle.snapshot(), (set) => {
    set(handle.snapshot())
    return handle.subscribe(() => set(handle.snapshot()))
  })
  const mutateAsync = handle.mutate
  return Object.assign(store, {
    mutate: (variables: TVariables) => {
      mutateAsync(variables).catch(noop)
    },
    mutateAsync,
    reset: handle.reset,
    cancel: handle.cancel,
  })
}

/** Svelte's infinite-query snapshot includes page availability alongside the shared query state. */
export interface InfiniteQuerySnapshot<T, P> extends QueryState<InfiniteData<T, P>> {
  readonly hasNextPage: boolean
  readonly hasPreviousPage: boolean
}

/** A Svelte readable infinite-query snapshot with page controls. */
export type InfiniteQueryStore<T, P> = Readable<InfiniteQuerySnapshot<T, P>> & {
  readonly fetchNextPage: () => Promise<InfiniteData<T, P>>
  readonly fetchPreviousPage: () => Promise<InfiniteData<T, P>>
  readonly refetch: () => Promise<InfiniteData<T, P>>
}

/** Options for a Svelte infinite query. */
export interface UseInfiniteQueryOptions<T, P> extends InfiniteQueryOptions<T, P> {
  readonly enabled?: boolean
}

/** Bind a paged query as a Svelte readable store. Fetching starts on the first browser subscription. */
export function useInfiniteQuery<T, P>(
  key: unknown,
  fn: (pageParam: P) => Promise<T>,
  options: UseInfiniteQueryOptions<T, P>,
): InfiniteQueryStore<T, P> {
  const client = queryClientForCurrentTree()
  const enabled = options.enabled !== false
  const handle = client?.infiniteQuery<T, P>(key, fn, options)
  const snapshot = (): InfiniteQuerySnapshot<T, P> => {
    const state = handle ? handle.snapshot() : (IDLE_QUERY_STATE as QueryState<InfiniteData<T, P>>)
    return {
      ...state,
      hasNextPage: handle?.hasNextPage() ?? false,
      hasPreviousPage: handle?.hasPreviousPage() ?? false,
    }
  }
  const store = readable<InfiniteQuerySnapshot<T, P>>(snapshot(), (set) => {
    if (!handle) return
    set(snapshot())
    const unsubscribe = handle.subscribe(() => set(snapshot()))
    if (typeof window !== "undefined" && enabled) handle.fetch().catch(noop)
    return unsubscribe
  })
  const noClientAction = createNoClientRefetch<InfiniteData<T, P>>(
    "[nifra/web-svelte]",
    "infinite query action",
  )
  return Object.assign(store, {
    fetchNextPage: handle?.fetchNextPage ?? noClientAction,
    fetchPreviousPage: handle?.fetchPreviousPage ?? noClientAction,
    refetch: handle?.refetch ?? noClientAction,
  })
}

import type { QueryClient, QueryHandle, QueryState } from "@nifrajs/web"
import {
  createNoClientRefetch,
  getQueryClientSingleton,
  IDLE_QUERY_STATE,
} from "@nifrajs/web/internal/query-runtime"
/**
 * `@nifrajs/web-vue/query` - Vue bindings for the keyed query-cache. `useQuery(key, fn)` subscribes a
 * component to a query (a `shallowRef` fed by `handle.subscribe`) and fetches on mount; `useQueryClient`
 * exposes `invalidateQueries` for after a mutation. Imports only `vue` + `@nifrajs/web`.
 *
 * The query client is created lazily **client-side only** (the `typeof window` guard) - on the server
 * there is none, so `useQuery` renders the idle/pending state (queries are client-first; loaders are the
 * SSR data source). The first client render uses the same idle snapshot, so no mismatch. The key is read
 * once at setup (Vue composables don't re-run with new args); for a changing key, key the component.
 */
import { onMounted, onScopeDispose, type ShallowRef, shallowRef } from "vue"

/** Access the query client to imperatively `invalidateQueries(keyOrPrefix)` (e.g. after a mutation). */
export function useQueryClient(): Pick<QueryClient, "invalidateQueries"> {
  return getQueryClientSingleton() ?? { invalidateQueries: () => {} }
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
 * share one cache entry + one in-flight fetch (dedup). Fetches on mount; SSR-idle.
 */
export function useQuery<T>(key: unknown, fn: () => Promise<T>): UseQueryResult<T> {
  const handle: QueryHandle<T> | undefined = getQueryClientSingleton()?.query<T>(key, fn)
  const state = shallowRef<QueryState<T>>(handle ? handle.snapshot() : IDLE_QUERY_STATE)
  if (handle) {
    const unsubscribe = handle.subscribe(() => {
      state.value = handle.snapshot()
    })
    onScopeDispose(unsubscribe)
    onMounted(() => {
      handle.fetch().catch(() => {})
    })
  }
  return {
    state,
    refetch: handle
      ? handle.refetch
      : createNoClientRefetch<T>("[nifra/web-vue]", "useQuery.refetch"),
  }
}

import {
  createQueryClient,
  type QueryClient,
  type QueryHandle,
  type QueryState,
} from "@nifrajs/web"
/**
 * `@nifrajs/web-vue/query` — Vue bindings for the keyed query-cache. `useQuery(key, fn)` subscribes a
 * component to a query (a `shallowRef` fed by `handle.subscribe`) and fetches on mount; `useQueryClient`
 * exposes `invalidateQueries` for after a mutation. Imports only `vue` + `@nifrajs/web`.
 *
 * The query client is created lazily **client-side only** (the `typeof window` guard) — on the server
 * there is none, so `useQuery` renders the idle/pending state (queries are client-first; loaders are the
 * SSR data source). The first client render uses the same idle snapshot, so no mismatch. The key is read
 * once at setup (Vue composables don't re-run with new args); for a changing key, key the component.
 */
import { onMounted, onScopeDispose, type ShallowRef, shallowRef } from "vue"

let client: QueryClient | undefined
function getClient(): QueryClient | undefined {
  if (typeof window === "undefined") return undefined // SSR → no client (queries render idle)
  if (client === undefined) client = createQueryClient({ now: () => Date.now() })
  return client
}

/** Access the query client to imperatively `invalidateQueries(keyOrPrefix)` (e.g. after a mutation). */
export function useQueryClient(): Pick<QueryClient, "invalidateQueries"> {
  return getClient() ?? { invalidateQueries: () => {} }
}

// Stable idle snapshot for the server / pre-fetch render.
const IDLE: QueryState<never> = Object.freeze({
  status: "pending",
  data: undefined,
  error: undefined,
  isFetching: false,
  updatedAt: Number.NEGATIVE_INFINITY,
})
const noopAsync = async (): Promise<never> => {
  throw new Error("[nifra/web-vue] useQuery.refetch called with no query client (server?)")
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
  const handle: QueryHandle<T> | undefined = getClient()?.query<T>(key, fn)
  const state = shallowRef<QueryState<T>>(handle ? handle.snapshot() : IDLE)
  if (handle) {
    const unsubscribe = handle.subscribe(() => {
      state.value = handle.snapshot()
    })
    onScopeDispose(unsubscribe)
    onMounted(() => {
      handle.fetch().catch(() => {})
    })
  }
  return { state, refetch: handle ? handle.refetch : (noopAsync as () => Promise<T>) }
}

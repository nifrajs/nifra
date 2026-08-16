import type { QueryClient, QueryHandle, QueryState } from "@nifrajs/web"
import {
  createNoClientRefetch,
  getQueryClientSingleton,
  IDLE_QUERY_STATE,
} from "@nifrajs/web/internal/query-runtime"
/**
 * `@nifrajs/web-svelte/query` - Svelte bindings for the keyed query-cache, as **Svelte stores** (plain
 * `.ts`). `useQuery(key, fn)` returns a `Readable<QueryState<T>>` augmented with `refetch` - read it
 * reactively with `$query`. The store fetches on mount (the start notifier fires on the first
 * `$`-subscription) and subscribes to the cache entry; concurrent `useQuery`s with the same key share
 * one entry + one in-flight fetch (dedup). `useQueryClient` exposes `invalidateQueries`.
 *
 * The query client is created lazily **client-side only** (the `typeof window` guard) - on the server
 * there is none, so `useQuery` holds the idle/pending state (queries are client-first; loaders are the
 * SSR data source). The first client render uses the same idle snapshot, so no mismatch.
 */
import { type Readable, readable } from "svelte/store"

/** Access the query client to imperatively `invalidateQueries(keyOrPrefix)` (e.g. after a mutation). */
export function useQueryClient(): Pick<QueryClient, "invalidateQueries"> {
  return getQueryClientSingleton() ?? { invalidateQueries: () => {} }
}

/** A query store: a `Readable<QueryState<T>>` (read via `$`) plus `refetch`. */
export type QueryStore<T> = Readable<QueryState<T>> & {
  /** Force a refetch (ignores `staleTime`). */
  readonly refetch: () => Promise<T>
}

/**
 * Subscribe to the keyed query for `key`, fetched via `fn`. Returns a store of `{ status, data, error,
 * isFetching, updatedAt }` augmented with `refetch`. Fetches on mount (first `$`-subscription); SSR-idle.
 */
export function useQuery<T>(key: unknown, fn: () => Promise<T>): QueryStore<T> {
  const handle: QueryHandle<T> | undefined = getQueryClientSingleton()?.query<T>(key, fn)
  const store = readable<QueryState<T>>(handle ? handle.snapshot() : IDLE_QUERY_STATE, (set) => {
    if (handle === undefined) return
    set(handle.snapshot())
    const unsubscribe = handle.subscribe(() => set(handle.snapshot()))
    handle.fetch().catch(() => {}) // fetch on mount (the first subscriber attached)
    return unsubscribe
  })
  const refetch = handle
    ? handle.refetch
    : createNoClientRefetch<T>("[nifra/web-svelte]", "useQuery.refetch")
  return Object.assign(store, { refetch })
}

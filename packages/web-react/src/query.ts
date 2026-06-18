import {
  createQueryClient,
  type QueryClient,
  type QueryHandle,
  type QueryState,
} from "@nifrajs/web"
/**
 * `@nifrajs/web-react/query` — React bindings for the keyed query-cache. `useQuery(key, fn)` subscribes a
 * component to a query (via `useSyncExternalStore`) and fetches on mount / key change; `useQueryClient`
 * exposes `invalidateQueries` for after a mutation. Imports only `react` + `@nifrajs/web` (never
 * `react-dom/*`), so route components use it on the server *and* client. No JSX (the package builds
 * with plain `tsc`).
 *
 * The query client is created lazily **client-side only** (the `typeof window` guard) — on the server
 * there is none, so `useQuery` renders the idle/pending state (queries are client-first; loaders are
 * the SSR data source). The first client render uses the same idle server-snapshot, so no mismatch.
 */
import { useEffect, useSyncExternalStore } from "react"

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

// Stable idle snapshot for the server / pre-fetch render (stable ref → no loop, no hydration mismatch).
const IDLE: QueryState<never> = Object.freeze({
  status: "pending",
  data: undefined,
  error: undefined,
  isFetching: false,
  updatedAt: Number.NEGATIVE_INFINITY,
})
const idleSnapshot = (): QueryState<never> => IDLE
const noopSubscribe = (): (() => void) => () => {}
const noopAsync = async (): Promise<never> => {
  throw new Error("[nifra/web-react] useQuery.refetch called with no query client (server?)")
}

/** A query's reactive {@link QueryState} plus `isPending` + `refetch`. */
export interface UseQueryResult<T> extends QueryState<T> {
  /** `status === "pending"` — no data yet (initial load). */
  readonly isPending: boolean
  /** Force a refetch (ignores `staleTime`). */
  readonly refetch: () => Promise<T>
}

/**
 * Subscribe to the keyed query for `key`, fetched via `fn`. Returns `{ status, data, error, isFetching,
 * updatedAt, isPending, refetch }`. Concurrent `useQuery`s with the same key share one cache entry +
 * one in-flight fetch (dedup). Refetches on mount and when the key changes; SSR-idle.
 */
export function useQuery<T>(key: unknown, fn: () => Promise<T>): UseQueryResult<T> {
  const handle: QueryHandle<T> | undefined = getClient()?.query<T>(key, fn)
  const state = useSyncExternalStore<QueryState<T>>(
    handle?.subscribe ?? noopSubscribe,
    handle ? handle.snapshot : idleSnapshot,
    idleSnapshot,
  )
  // Fetch on mount + whenever the key changes (the handle is stable per key, so it changes with the key).
  useEffect(() => {
    if (handle !== undefined) handle.fetch().catch(() => {})
  }, [handle])
  return {
    ...state,
    isPending: state.status === "pending",
    refetch: handle ? handle.refetch : (noopAsync as () => Promise<T>),
  }
}

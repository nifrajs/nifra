import { createQueryClient, type QueryClient, type QueryState } from "@nifrajs/web"
/**
 * `@nifrajs/web-solid/query` — Solid bindings for the keyed query-cache. `createQuery(key, fn)` bridges a
 * query's `subscribe`/`snapshot` store into a Solid signal and fetches on mount; `useQueryClient`
 * exposes `invalidateQueries` for after a mutation. Imports only `solid-js` + `@nifrajs/web` (never
 * `solid-js/web`), so route components use it on the server *and* client. No JSX.
 *
 * The query client is created lazily **client-side only** (`typeof window`) — on the server the
 * accessor returns the idle/pending state (queries are client-first; loaders are the SSR data source).
 * The `key` is captured once (Solid setup runs once); a reactive key is a documented future enhancement.
 */
import { type Accessor, createSignal, onCleanup, onMount } from "solid-js"

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

const IDLE: QueryState<never> = Object.freeze({
  status: "pending",
  data: undefined,
  error: undefined,
  isFetching: false,
  updatedAt: Number.NEGATIVE_INFINITY,
})

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
 * Fetches on mount; SSR-idle. Call inside a component (owns the subscription).
 */
export function createQuery<T>(key: unknown, fn: () => Promise<T>): CreateQueryResult<T> {
  const handle = getClient()?.query<T>(key, fn)
  const [state, setState] = createSignal<QueryState<T>>(handle ? handle.snapshot() : IDLE)
  if (handle !== undefined) {
    onCleanup(handle.subscribe(() => setState(() => handle.snapshot())))
    onMount(() => {
      handle.fetch().catch(() => {})
    })
    return { state, refetch: handle.refetch }
  }
  return {
    state,
    refetch: async () => {
      throw new Error("[nifra/web-solid] createQuery.refetch called with no query client (server?)")
    },
  }
}

import type { QueryClient, QueryState } from "../query.ts"
import { createQueryClient } from "../query.ts"

/** Stable idle state shared by every framework query binding. */
export const IDLE_QUERY_STATE: QueryState<never> = Object.freeze({
  status: "pending",
  data: undefined,
  error: undefined,
  isFetching: false,
  updatedAt: Number.NEGATIVE_INFINITY,
})

let singleton: QueryClient | undefined

/** Return the client-side query singleton, or undefined during SSR. */
export function getQueryClientSingleton(): QueryClient | undefined {
  if (!("window" in globalThis)) return undefined
  if (singleton === undefined) singleton = createQueryClient({ now: () => Date.now() })
  return singleton
}

/** Create the refetch fallback used when a binding has no client-side query cache. */
export function createNoClientRefetch<T>(tag: string, operation: string): () => Promise<T> {
  return async () => {
    throw new Error(`${tag} ${operation} called with no query client (server?)`)
  }
}

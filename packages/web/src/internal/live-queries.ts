/**
 * The live client's side of the query seam. A mounted query with live keys registers here, and the
 * live client matches its keys to the tags each live load grants. Every query client the page uses is
 * adopted too, so a viewer switch can clear them all. Importing this module installs the seam.
 */
import type { QueryClient } from "../query.ts"
import { installQuerySeam, type LiveQuery } from "./query-seam.ts"

export type { LiveQuery }

let tick = 0

/** Read by a query as each fetch starts. */
export const liveTick = (): number => tick

/**
 * Advanced as each live load's response arrives, and as each query registers. A query whose fetch
 * started after a load arrived read the server after that load took its watermark.
 */
export const advanceLiveTick = (): number => ++tick

// Query to the live tick it registered at: a change before that never reached it.
const queries = new Map<LiveQuery, number>()
const watchers = new Set<() => void>()

function changed(): void {
  for (const watcher of watchers) watcher()
}

export function liveQueries(): Iterable<LiveQuery> {
  return queries.keys()
}

/** The live tick `query` registered at, or `undefined` once it left. */
export function registeredAt(query: LiveQuery): number | undefined {
  return queries.get(query)
}

/** Returns the function that stops watching. */
export function watchLiveQueries(watcher: () => void): () => void {
  watchers.add(watcher)
  return () => {
    watchers.delete(watcher)
  }
}

// Weak: a client the page dropped is not kept alive by the registry.
const clients = new Set<WeakRef<QueryClient>>()
const adopted = new WeakSet<QueryClient>()
const PRUNE_AT = 32

/** Another viewer: no query client keeps data loaded for the last one. */
export function clearQueryClients(): void {
  for (const ref of clients) {
    const client = ref.deref()
    if (client === undefined) clients.delete(ref)
    else client.clear()
  }
}

installQuerySeam({
  tick: liveTick,
  track(query, mounted) {
    if (mounted && query.keys().length > 0) {
      if (queries.has(query)) return
      queries.set(query, advanceLiveTick())
      changed()
    } else if (queries.delete(query)) changed()
  },
  adopt(client) {
    // A server builds a client per request; none of them outlives it or sees a viewer switch.
    if (typeof Reflect.get(globalThis, "window") === "undefined" || adopted.has(client)) return
    adopted.add(client)
    if (clients.size >= PRUNE_AT) {
      for (const ref of clients) if (ref.deref() === undefined) clients.delete(ref)
    }
    clients.add(new WeakRef(client))
  },
})

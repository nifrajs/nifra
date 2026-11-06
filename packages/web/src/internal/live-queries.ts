/**
 * The live client's side of the query seam. A mounted query with live keys registers here, and the
 * live client matches its keys to the tags each live load grants. Importing this module installs the
 * seam.
 */
import { installQuerySeam, type LiveQuery } from "./query-seam.ts"

export { clearQueryClients } from "./query-seam.ts"
export type { LiveQuery }

// A linked workspace can load more than one physical copy of this module in one test process. Keep
// the registry global for the same reason query-seam.ts keeps its seam global: every copy must see
// the same mounted queries and watermark.
const LIVE_QUERY_REGISTRY = Symbol.for("nifra.web.liveQueryRegistry")

interface LiveQueryRegistry {
  tick: number
  queries: Map<LiveQuery, number>
  watchers: Set<() => void>
}

const registry = (() => {
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Symbol.for is written only by this module with this registry shape, so duplicate loads can safely reuse it.
  const existing = Reflect.get(globalThis, LIVE_QUERY_REGISTRY) as LiveQueryRegistry | undefined
  if (existing !== undefined) return existing
  const created: LiveQueryRegistry = {
    tick: 0,
    queries: new Map(),
    watchers: new Set(),
  }
  Reflect.set(globalThis, LIVE_QUERY_REGISTRY, created)
  return created
})()

/** Read by a query as each fetch starts. */
export const liveTick = (): number => registry.tick

/**
 * Advanced as each live load's response arrives, and as each query registers. A query whose fetch
 * started after a load arrived read the server after that load took its watermark.
 */
export const advanceLiveTick = (): number => ++registry.tick

// Query to the live tick it registered at: a change before that never reached it.
function changed(): void {
  for (const watcher of registry.watchers) watcher()
}

export function liveQueries(): Iterable<LiveQuery> {
  return registry.queries.keys()
}

/** The live tick `query` registered at, or `undefined` once it left. */
export function registeredAt(query: LiveQuery): number | undefined {
  return registry.queries.get(query)
}

/** Returns the function that stops watching. */
export function watchLiveQueries(watcher: () => void): () => void {
  registry.watchers.add(watcher)
  return () => {
    registry.watchers.delete(watcher)
  }
}

installQuerySeam({
  tick: liveTick,
  track(query, mounted) {
    if (mounted && query.keys().length > 0) {
      if (registry.queries.has(query)) return
      registry.queries.set(query, advanceLiveTick())
      changed()
    } else if (registry.queries.delete(query)) changed()
  },
})

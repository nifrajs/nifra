/**
 * What a query client tells the live client. `@nifrajs/web/live-client` installs the seam; a page
 * without live refresh never does, so its queries keep no live state and ship none of it.
 */
import { onIdentityChange } from "../identity.ts"
import type { QueryClient } from "../query.ts"

export interface LiveQuery {
  /** The live keys its data depends on, as the page's loaders declare them. */
  keys(): readonly string[]
  /** The {@link QuerySeam.tick} its data was asked for at: the start of the fetch in flight, else of
   * the fetch that produced it. */
  tick(): number
  /** Drop its data's freshness and refetch, superseding a fetch in flight. */
  refresh(): void
}

export interface QuerySeam {
  /** The live tick now, read as each fetch starts. */
  tick(): number
  /** A query was mounted or unmounted; only a mounted one with live keys is watched. */
  track(query: LiveQuery, mounted: boolean): void
}

// On the global, so a query engine and a live client from two copies of the package still meet.
const SEAM = Symbol.for("nifra.web.querySeam")
const CLIENTS = Symbol.for("nifra.web.queryClients")

export const querySeam = (): QuerySeam | undefined => Reflect.get(globalThis, SEAM)

export function installQuerySeam(seam: QuerySeam): void {
  if (querySeam() === undefined) Reflect.set(globalThis, SEAM, seam)
}

/**
 * The browser query clients the page made, held weakly: a viewer switch clears each one still alive,
 * whether it was made before or after the live client loaded.
 */
export const queryClients = (): readonly WeakRef<QueryClient>[] =>
  Reflect.get(globalThis, CLIENTS) ?? []

/** Another viewer: no query client keeps data loaded for the last one. */
export function clearQueryClients(): void {
  for (const ref of queryClients()) ref.deref()?.clear()
}

export function adoptClient(client: QueryClient): void {
  // A server builds a client per request; none of them outlives it or sees a viewer switch.
  if (typeof Reflect.get(globalThis, "window") === "undefined") return
  // One watch per page, whichever copy of the package makes the list. Not another tab's message: this
  // tab hears its own `identityChanged()` there a task later, and would drop what loaded since.
  if (Reflect.get(globalThis, CLIENTS) === undefined) onIdentityChange(clearQueryClients)
  // Each new client sheds the ones the page let go, so the list never outgrows the live clients.
  const clients = queryClients().filter((ref) => ref.deref() !== undefined)
  clients.push(new WeakRef(client))
  Reflect.set(globalThis, CLIENTS, clients)
}

/**
 * What a query client tells the live client. `@nifrajs/web/live-client` installs the seam; a page
 * without live refresh never does, so its query clients keep no live state and ship none of it.
 */
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
  /** A query client the page uses: a viewer switch clears it. */
  adopt(client: QueryClient): void
}

// On the global, so a query engine and a live client from two copies of the package still meet.
const SEAM = Symbol.for("nifra.web.querySeam")

export const querySeam = (): QuerySeam | undefined => Reflect.get(globalThis, SEAM)

export function installQuerySeam(seam: QuerySeam): void {
  if (querySeam() === undefined) Reflect.set(globalThis, SEAM, seam)
}

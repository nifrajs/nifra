/**
 * Where the slot wrappers of kept pages go, decided once from the route table so that the server's
 * markup and every client render agree: a wrapper that appeared or vanished with what is kept would
 * remount the page inside it, and one the server did not render fails hydration.
 */
import type { Manifest } from "../manifest.ts"

/** What the server and the browser both read to place the slot wrappers. */
export interface KeepAliveTable {
  /** Routes whose page renders inside the slot wrappers: the build found a `keepAlive` export. */
  readonly routes: readonly string[]
  /** Layouts rendered inside the slot wrappers, because another chain the browser can render shares
   * the layouts above one of them and not that one: a kept page then sits there beside the page on
   * screen. A layout every chain shares is never wrapped. */
  readonly layouts: readonly string[]
}

const sharesAbove = (a: readonly string[], b: readonly string[], depth: number): boolean => {
  for (let i = 0; i < depth; i++) if (a[i] !== b[i]) return false
  return true
}

/** The table for `manifest`, or `undefined` when no route keeps its page alive. */
export function keepAliveTable(manifest: Manifest): KeepAliveTable | undefined {
  const kept = manifest.routes.filter((route) => route.keepAlive === true)
  if (kept.length === 0) return undefined
  // Every layout chain the browser renders: each route's, a root status page's (inside the root
  // layout unless the page opts out, which only its module says), and a `_loading` page's, which takes
  // the layouts the two pages of a navigation share, so any prefix of a route under it.
  const chains: (readonly string[])[] = manifest.routes.map((route) => route.layoutIds)
  if (manifest.notFound !== undefined || Object.keys(manifest.statusPages ?? {}).length > 0) {
    chains.push(manifest.layouts._layout === undefined ? [] : ["_layout"])
  }
  for (const [id, loading] of Object.entries(manifest.loadings ?? {})) {
    for (const route of manifest.routes) {
      if (!route.loadingIds?.includes(id)) continue
      for (let n = loading.layoutIds.length; n <= route.layoutIds.length; n++) {
        chains.push(route.layoutIds.slice(0, n))
      }
    }
  }
  const layouts = new Set<string>()
  for (const route of kept) {
    route.layoutIds.forEach((layout, depth) => {
      if (layouts.has(layout)) return
      if (
        chains.some(
          (chain) => chain[depth] !== layout && sharesAbove(chain, route.layoutIds, depth),
        )
      )
        layouts.add(layout)
    })
  }
  return { routes: [...new Set(kept.map((route) => route.id))], layouts: [...layouts] }
}

/**
 * The chain indices to render inside slot wrappers for a chain of `layoutIds` and then the page of
 * `routeId`: each wrapped layout, and the page when its route keeps alive.
 */
export function slotDepths(
  table: KeepAliveTable,
  layoutIds: readonly string[],
  routeId: string | undefined,
): readonly number[] {
  const depths: number[] = []
  layoutIds.forEach((layout, depth) => {
    if (table.layouts.includes(layout)) depths.push(depth)
  })
  if (routeId !== undefined && table.routes.includes(routeId)) depths.push(layoutIds.length)
  return depths
}

import type { MountRouterOptions, RenderProps, RouterState } from "@nifrajs/web"
// `/client`, not the root: the root's graph carries the server, and Vite's dev server evaluates it
// instead of tree-shaking it - which broke hydration before the browser ran a line of app code.
import { searchOfChain } from "@nifrajs/web/client"

/**
 * The props a mounted Router hands `compose` for one store snapshot - the client half of the
 * `RenderProps` the server assembled for the same route, so the first render reconciles against the
 * SSR markup and every navigation after it carries the same fields.
 */
export function routeProps(
  state: RouterState,
  searchSchemas: MountRouterOptions["searchSchemas"],
): RenderProps {
  // This route's typed `search` from the URL + schema chain (the SAME `searchOfChain` the server
  // ran), recomputed each render so `useSearch` stays reactive and hydrates with no drift.
  const q = state.path.indexOf("?")
  const rawSearch = q === -1 ? "" : state.path.slice(q)
  return {
    data: state.data,
    // Each layout's own loader data. Without it a layout renders `data: null` on the client while the
    // server rendered it with its data - a hydration mismatch on the first paint.
    ...(state.layoutData !== undefined ? { layoutData: state.layoutData } : {}),
    actionData: state.actionData,
    pending: state.pending,
    search: searchOfChain(searchSchemas?.[state.routeId] ?? [], rawSearch),
    ...(state.submission ? { submission: state.submission } : {}),
    ...(state.boundaries !== undefined ? { boundaries: state.boundaries } : {}),
  }
}

import type { MountRouterOptions, RenderProps, RouterState } from "@nifrajs/web"
// `/client`, not the root: the root's graph carries the server, and Vite's dev server evaluates it
// instead of tree-shaking it - which broke hydration before the browser ran a line of app code.
import { searchOfChain } from "@nifrajs/web/client"

/** The client half of the server's `RenderProps`, so the first render matches the SSR markup. */
export function routeProps(
  state: RouterState,
  searchSchemas: MountRouterOptions["searchSchemas"],
  matchChains?: MountRouterOptions["matchChains"],
): RenderProps {
  const matchChain = matchChains?.[state.routeId]
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
    // The same `params`/`path` the server render received, so `useMatches` reports the same chain.
    params: state.params,
    path: state.path,
    search: searchOfChain(searchSchemas?.[state.routeId] ?? [], rawSearch),
    ...(state.submission ? { submission: state.submission } : {}),
    ...(state.boundaries !== undefined ? { boundaries: state.boundaries } : {}),
    // The chain `useMatches` reports - the server passed the same one to the SSR render.
    ...(matchChain !== undefined ? { matchChain } : {}),
  }
}

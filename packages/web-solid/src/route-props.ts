import type { MountRouterOptions, RenderProps, RouterState } from "@nifrajs/web"
// `/client`, not the root: the root's graph carries the server, and Vite's dev server evaluates it
// instead of tree-shaking it - which broke hydration before the browser ran a line of app code.
import { searchOfChain } from "@nifrajs/web/client"

/**
 * The client half of the server's `RenderProps`, as getters so a settle re-renders only what reads the
 * changed field. Cast: a getter always exists where `exactOptionalPropertyTypes` expects absence.
 */
export function routeProps(
  snapshot: () => RouterState,
  searchSchemas: MountRouterOptions["searchSchemas"],
  matchChains?: MountRouterOptions["matchChains"],
): RenderProps {
  return {
    get data() {
      return snapshot().data
    },
    // Each layout's own loader data. Without it a layout renders `data: null` on the client while the
    // server rendered it with its data.
    get serverComponents() {
      return snapshot().serverComponents
    },
    get layoutData() {
      return snapshot().layoutData
    },
    get actionData() {
      return snapshot().actionData
    },
    get pending() {
      return snapshot().pending
    },
    // The same `params`/`path` the server render received, so `useMatches` reports the same chain.
    get params() {
      return snapshot().params
    },
    // While an intercept boundary holds a target the URL is the target's; the route's props describe
    // the page underneath, so they read the page's own path.
    get path() {
      const s = snapshot()
      return s.intercepted?.pagePath ?? s.path
    },
    get search() {
      // The SAME searchOfChain the server ran, over this snapshot's URL - a same-route search change
      // updates in place (fine-grained), matching the SSR value on hydration.
      const s = snapshot()
      const path = s.intercepted?.pagePath ?? s.path
      const idx = path.indexOf("?")
      return searchOfChain(searchSchemas?.[s.routeId] ?? [], idx === -1 ? "" : path.slice(idx))
    },
    get submission() {
      return snapshot().submission
    },
    get boundaries() {
      return snapshot().boundaries
    },
    // The chain `useMatches` reports - the server passed the same one to the SSR render.
    get matchChain() {
      return matchChains?.[snapshot().routeId]
    },
  } as RenderProps
}

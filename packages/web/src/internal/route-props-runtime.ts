/**
 * The client half of the server's `RenderProps`, for every adapter that renders a route from a router
 * snapshot, so the first render matches the SSR markup.
 */
import type { RenderProps } from "../render-seam.ts"
import type { MountRouterOptions, RouterState } from "../router.ts"
import { searchOfChain } from "../search.ts"

type Schemas = NonNullable<MountRouterOptions["searchSchemas"]>[string]
const NO_SCHEMAS: Schemas = []
let lastSearch:
  | {
      readonly schemas: Schemas
      readonly raw: string
      readonly search: Record<string, unknown>
    }
  | undefined
// The last render's search while the schemas and the query are the same: an equal new object would
// count as a changed prop and re-render a memoized page.
const searchFor = (schemas: Schemas = NO_SCHEMAS, raw: string): Record<string, unknown> => {
  if (lastSearch?.schemas !== schemas || lastSearch.raw !== raw)
    lastSearch = { schemas, raw, search: searchOfChain(schemas, raw) }
  return lastSearch.search
}

/** The props a route renders with for one router snapshot. */
export function routeProps(
  state: RouterState,
  searchSchemas: MountRouterOptions["searchSchemas"],
  matchChains?: MountRouterOptions["matchChains"],
): RenderProps {
  const matchChain = matchChains?.[state.routeId]
  // While an intercept boundary holds a target the URL is the target's; the route's props describe the
  // page underneath, so they read the page's own path.
  const path = state.intercepted?.pagePath ?? state.path
  const q = path.indexOf("?")
  const rawSearch = q === -1 ? "" : path.slice(q)
  return {
    data: state.data,
    ...(state.serverComponents === undefined ? {} : { serverComponents: state.serverComponents }),
    // Each layout's own loader data. Without it a layout renders `data: null` on the client while the
    // server rendered it with its data - a hydration mismatch on the first paint.
    ...(state.layoutData !== undefined ? { layoutData: state.layoutData } : {}),
    actionData: state.actionData,
    pending: state.pending,
    // The same `params`/`path` the server render received, so the routing hooks and `useMatches` read
    // the same values on hydration.
    params: state.params,
    path,
    // The route's typed search from the URL query and its schema chain (layout schemas, then the
    // page's), the same `searchOfChain` the server ran, so `useSearch` hydrates with no drift.
    search: searchFor(searchSchemas?.[state.routeId], rawSearch),
    ...(state.submission ? { submission: state.submission } : {}),
    ...(state.boundaries !== undefined ? { boundaries: state.boundaries } : {}),
    ...(matchChain !== undefined ? { matchChain } : {}),
  }
}

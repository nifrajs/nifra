/**
 * The client half of the server's `RenderProps`, for every adapter that renders a route from a router
 * snapshot, so the first render matches the SSR markup.
 */
import type { RenderProps } from "../render-seam.ts"
import type { MountRouterOptions, RouterState } from "../router.ts"
import { searchOfChain } from "../search.ts"

type Schemas = NonNullable<MountRouterOptions["searchSchemas"]>[string]
type BuiltProps = { -readonly [K in keyof RenderProps]: RenderProps[K] }
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

/**
 * The props a route renders with for one router snapshot: a new object on every call, so the caller may
 * add a field of its own before rendering with it.
 */
export function routeProps(
  state: RouterState,
  searchSchemas: MountRouterOptions["searchSchemas"],
  matchChains?: MountRouterOptions["matchChains"],
): BuiltProps {
  // While an intercept boundary holds a target the URL is the target's; the route's props describe the
  // page underneath, so they read the page's own path.
  const path = state.intercepted?.pagePath ?? state.path
  const q = path.indexOf("?")
  // Optional fields are written after the literal: a conditional `...{}` spread allocates and copies
  // through the generic path, 5x the instructions per call on JSC and 11x on V8.
  const props: BuiltProps = {
    data: state.data,
    actionData: state.actionData,
    pending: state.pending,
    // The same `params`/`path` the server render received, so the routing hooks and `useMatches` read
    // the same values on hydration.
    params: state.params,
    path,
    // The route's typed search from the URL query and its schema chain (layout schemas, then the
    // page's), the same `searchOfChain` the server ran, so `useSearch` hydrates with no drift.
    search: searchFor(searchSchemas?.[state.routeId], q === -1 ? "" : path.slice(q)),
  }
  if (state.serverComponents !== undefined) props.serverComponents = state.serverComponents
  // Each layout's own loader data. Without it a layout renders `data: null` on the client while the
  // server rendered it with its data - a hydration mismatch on the first paint.
  if (state.layoutData !== undefined) props.layoutData = state.layoutData
  if (state.submission) props.submission = state.submission
  if (state.boundaries !== undefined) props.boundaries = state.boundaries
  const matchChain = matchChains?.[state.routeId]
  if (matchChain !== undefined) props.matchChain = matchChain
  return props
}

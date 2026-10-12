/**
 * The pure half of the plugin: resolve a concrete route path (a string literal the user typed, e.g.
 * `"/users/42"`) to the `routes/` file that serves it. It matches the path against each route's compiled
 * pattern using nifra's OWN router matcher (`@nifrajs/core/pattern`), so a path resolves here exactly as
 * it would at runtime - the plugin never re-derives the file-based routing rules.
 */
import {
  compileRoutePattern,
  matchRoutePattern,
  sortRoutesBySpecificity,
} from "@nifrajs/core/pattern"

/** A route as the plugin needs it: its URL pattern and the source file that serves it. */
export interface RouteLocation {
  readonly pattern: string
  readonly file: string
}

type CompiledRouteLocation = {
  readonly route: RouteLocation
  readonly pattern: ReturnType<typeof compileRoutePattern>
}

// The language service asks for definitions repeatedly while the cursor moves, and route discovery
// hands over a new array each time. So the compilation/specificity sort is cached by what the routes
// are, not by the array: each query then only matches, and a changed route set compiles afresh.
const compiledRouteCache = new Map<string, readonly CompiledRouteLocation[]>()
/** Route sets kept compiled at once: a workspace's apps, plus the sets an edit just replaced. */
const MAX_CACHED_ROUTE_SETS = 8

function compiledRoutes(routes: readonly RouteLocation[]): readonly CompiledRouteLocation[] {
  const key = JSON.stringify(routes.map((route) => [route.pattern, route.file]))
  const cached = compiledRouteCache.get(key)
  if (cached !== undefined) return cached
  const compiled = sortRoutesBySpecificity(
    routes.map((route) => ({ route, pattern: compileRoutePattern(route.pattern) })),
  )
  if (compiledRouteCache.size >= MAX_CACHED_ROUTE_SETS) {
    const oldest = compiledRouteCache.keys().next()
    if (oldest.done !== true) compiledRouteCache.delete(oldest.value)
  }
  compiledRouteCache.set(key, compiled)
  return compiled
}

/**
 * Resolve a route path literal to the first route whose pattern matches it. Query/hash are ignored
 * (a link's `?tab=x` does not change which route file serves it). Returns the route's `file`, or
 * undefined when the value is not a path or matches no route.
 */
export function resolveRouteFile(
  path: string,
  routes: readonly RouteLocation[],
): string | undefined {
  if (!path.startsWith("/")) return undefined
  const pathname = path.split(/[?#]/, 1)[0] ?? path
  // Runtime/client routing sorts by specificity before matching, so a static route wins over a
  // dynamic one regardless of manifest discovery order.
  for (const { route, pattern } of compiledRoutes(routes)) {
    if (matchRoutePattern(pattern, pathname).matched) return route.file
  }
  return undefined
}

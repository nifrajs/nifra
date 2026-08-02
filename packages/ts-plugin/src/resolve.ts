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

// The language service asks for definitions repeatedly while the cursor moves. Cache the immutable
// compilation/specificity sort by manifest identity so each query only performs route matching; a new
// manifest array naturally gets a fresh entry when routes are added or removed.
const compiledRouteCache = new WeakMap<readonly RouteLocation[], readonly CompiledRouteLocation[]>()

function compiledRoutes(routes: readonly RouteLocation[]): readonly CompiledRouteLocation[] {
  const cached = compiledRouteCache.get(routes)
  if (cached !== undefined) return cached
  const compiled = sortRoutesBySpecificity(
    routes.map((route) => ({ route, pattern: compileRoutePattern(route.pattern) })),
  )
  compiledRouteCache.set(routes, compiled)
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

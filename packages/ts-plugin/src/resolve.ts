/**
 * The pure half of the plugin: resolve a concrete route path (a string literal the user typed, e.g.
 * `"/users/42"`) to the `routes/` file that serves it. It matches the path against each route's compiled
 * pattern using nifra's OWN router matcher (`@nifrajs/core/pattern`), so a path resolves here exactly as
 * it would at runtime - the plugin never re-derives the file-based routing rules.
 */
import { compileRoutePattern, matchRoutePattern } from "@nifrajs/core/pattern"

/** A route as the plugin needs it: its URL pattern and the source file that serves it. */
export interface RouteLocation {
  readonly pattern: string
  readonly file: string
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
  for (const route of routes) {
    if (matchRoutePattern(compileRoutePattern(route.pattern), pathname).matched) return route.file
  }
  return undefined
}

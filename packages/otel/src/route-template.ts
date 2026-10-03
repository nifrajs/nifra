import { type Method, Router } from "@nifrajs/core/router"
import type { RouteDescriptor } from "@nifrajs/core/server"

const KNOWN_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "OPTIONS",
  "CONNECT",
  "TRACE",
])

/** A method as a label or span name may carry it. Any other method a runtime accepts (Deno takes
 * extension tokens) is `_OTHER`, as OpenTelemetry's HTTP conventions name it, so a client cannot
 * mint a new series or span name per request. */
export function methodLabel(method: string): string {
  return KNOWN_METHODS.has(method) ? method : "_OTHER"
}

/**
 * A request's matched route template (`/users/:id`, never `/users/42`), or `undefined` when no route
 * serves it. The matcher is built on first use: by serving time every route is registered, so
 * `app.routes()` is complete, where building it when the plugin is applied would miss later routes.
 */
export function routeTemplateOf(app: {
  routes(): ReadonlyArray<RouteDescriptor>
}): (method: string, path: string) => string | undefined {
  let matcher: Router<string> | undefined
  return (method, path) => {
    if (matcher === undefined) {
      matcher = new Router<string>()
      for (const route of app.routes()) {
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: every registered route's method is one this router already accepted when the app registered it.
        matcher.add(route.method as Method, route.path, route.path)
      }
    }
    const found = matcher.find(method, path)
    return found.found ? found.payload : undefined
  }
}

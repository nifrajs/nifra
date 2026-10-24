import { type Method, Router } from "../router/router.ts"
import type { RouteDescriptor } from "./server-types.ts"

/**
 * A request's matched route template (`/users/:id`, never `/users/42`), or `undefined` when no route
 * serves it. The matcher is built on first use: by serving time every route is registered, so
 * `app.routes()` is complete, where building it when a plugin is applied would miss later routes.
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

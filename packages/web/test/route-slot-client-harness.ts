import { type RouteSlotRuntime, setRouteSlotRuntime } from "../src/internal/route-slot-runtime.ts"
import type { RouteMatch } from "../src/router.ts"

const ORIGIN = "https://route-slot.test"

export function installRouteSlotClientHarness(
  chain: readonly unknown[],
  data: unknown = { label: "authorized target" },
): { readonly requests: string[]; restore(): void } {
  const originalFetch = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL): Promise<Response> => {
      requests.push(String(input))
      return new Response(JSON.stringify({ v: 1, data }), {
        headers: { "content-type": "application/json" },
      })
    },
    { preconnect: originalFetch.preconnect },
  )

  const matches: Record<string, RouteMatch> = {
    "/dashboard": { routeId: "dashboard", params: {} },
    "/users/7": { routeId: "user", params: { id: "7" } },
  }
  const router: RouteSlotRuntime["router"] = {
    match(path) {
      return matches[new URL(path, ORIGIN).pathname] ?? null
    },
    loadModule: async () => {},
    routeSlotsFor(routeId) {
      return routeId === "dashboard" ? { inspector: ["/users/:id"] } : {}
    },
    routePattern(routeId) {
      return routeId === "user" ? "/users/:id" : routeId === "dashboard" ? "/dashboard" : undefined
    },
  }
  setRouteSlotRuntime({
    router,
    routes: { user: chain },
    searchSchemas: undefined,
    matchChains: undefined,
  })

  return {
    requests,
    restore() {
      globalThis.fetch = originalFetch
      Reflect.deleteProperty(globalThis, Symbol.for("nifra.web.route-slot-runtime"))
    },
  }
}

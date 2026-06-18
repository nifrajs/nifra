import { betterAuth } from "@nifrajs/better-auth"
import type { Treaty } from "@nifrajs/client"
import { type Server, server } from "@nifrajs/core"
import type { Equal, Expect } from "@nifrajs/test-utils"

/**
 * Type-level gate (verified by `tsc`) for the #1 user-reported anti-drift bug: `app.use(betterAuth(...))`
 * must THREAD the accumulated route registry, not collapse it. Before the fix the plugin's `app` inferred
 * as `Server<any, any>`, so `.use` returned `Server<any, any>` — every route's type (and the whole typed
 * client derived from it) silently degraded to `any`. These assert the registry stays concrete and keeps
 * the routes declared both before AND after the `.use`.
 */
const stubAuth = {
  handler: async (req: Request): Promise<Response> => Response.json({ ok: true, url: req.url }),
  api: { getSession: async (_: { headers: Headers }) => null },
  options: { basePath: "/api/auth" },
}

const app = server()
  .get("/v1/me", () => ({ id: "1" }))
  .use(betterAuth(stubAuth))
  .get("/v1/destinations", () => [{ id: "1" }])

type Reg = typeof app extends Server<infer R, infer _C> ? R : never
type IsAny<T> = 0 extends 1 & T ? true : false

// The registry must NOT collapse to `any` after `.use(betterAuth(...))` (the core of the bug).
export type _RegistryNotAny = Expect<Equal<IsAny<Reg>, false>>
// Routes declared BEFORE the plugin survive...
export type _KeepsPriorRoute = Expect<
  Equal<Reg extends { "/v1/me": { GET: unknown } } ? true : false, true>
>
// ...and routes declared AFTER it still accumulate.
export type _ThreadsLaterRoute = Expect<
  Equal<Reg extends { "/v1/destinations": { GET: unknown } } ? true : false, true>
>

// End-to-end (the user's exact report): the typed CLIENT derived from an app with `.use(betterAuth(...))`
// must still infer a post-plugin route's response — not collapse to `any`.
declare const api: Treaty<typeof app>
type DataOf<P> = Extract<Awaited<P>, { ok: true }> extends { data: infer D } ? D : never
export type _ClientStillTyped = Expect<
  Equal<DataOf<ReturnType<typeof api.v1.destinations.get>>, { id: string }[]>
>

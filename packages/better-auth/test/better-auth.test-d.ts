import { type BetterAuthLike, betterAuth, getSession, type SessionOf } from "@nifrajs/better-auth"
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

/**
 * Regression for the reported `auth as unknown as BetterAuthLike` cast. A real better-auth `options` is a
 * large concrete object with no top-level `basePath`, so against the old weak `{ basePath? }` type it
 * tripped TS2559 ("no properties in common with the weak type") — forcing a cast that collapsed `A` to
 * `BetterAuthLike` and degraded `SessionOf<A>` to `{}`, which in turn forced per-call session casts.
 * Intersecting `options` with `Record<string, unknown>` drops the weak-type check, so a real instance
 * threads through WITHOUT a cast and the concrete session type is recovered.
 */
type RealSession = { user: { id: string; email: string }; session: { id: string } }
const realAuth = {
  handler: async (req: Request): Promise<Response> => Response.json({ url: req.url }),
  api: { getSession: async (_: { headers: Headers }) => null as RealSession | null },
  // disjoint from `{ basePath? }` (no basePath) — exactly the shape that used to need the cast
  options: { secret: "s", database: {} as object, emailAndPassword: { enabled: true } },
}

// (1) assignable to BetterAuthLike + mounts with NO cast (the bug was this needing `as unknown as`)
export const _assignable: BetterAuthLike = realAuth
export const _mounts = server().use(betterAuth(realAuth))
// (2) SessionOf recovers the real session type instead of collapsing to `{}`
export type _SessionRecovered = Expect<Equal<SessionOf<typeof realAuth>, RealSession>>
// (3) getSession's result is the concrete session | null — no per-call `as { user?… }` cast needed
declare const req: Request
export const _session = getSession(realAuth, req)
export type _GetSessionTyped = Expect<Equal<Awaited<typeof _session>, RealSession | null>>

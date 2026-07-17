import { type AnyServer, defineIdentityPlugin, type Server } from "@nifrajs/core/server"

/**
 * The structural slice of a [better-auth](https://better-auth.com) instance this package needs.
 * Declared structurally rather than imported, so `@nifrajs/better-auth` has **no runtime dependency** on
 * better-auth: you pass your own `auth` object and its concrete types flow through
 * {@link getSession} / {@link requireSession} via inference.
 */
export interface BetterAuthLike {
  /** better-auth's catch-all handler — serves every request under `basePath`. */
  readonly handler: (request: Request) => Response | Promise<Response>
  readonly api: {
    /** Resolve the session from request headers (cookie or bearer). Returns a nullable payload. */
    readonly getSession: (context: { readonly headers: Headers }) => Promise<unknown>
  }
  /**
   * better-auth's resolved options; `basePath` (when set) defaults the mount path. Intersected with
   * `Record<string, unknown>` so a real better-auth instance (whose `options` is a large concrete object
   * with no structural overlap to a bare `{ basePath? }`) stays assignable to `BetterAuthLike` WITHOUT a
   * cast — keeping `A` concrete so `SessionOf<A>` recovers the real session type instead of collapsing
   * to `{}` and forcing per-call session casts downstream.
   */
  readonly options?: { readonly basePath?: string } & Record<string, unknown>
}

/**
 * The non-null session payload of a concrete better-auth instance `A`, inferred from its
 * `api.getSession` return type (typically `{ user: User; session: Session }`).
 */
export type SessionOf<A extends BetterAuthLike> = NonNullable<
  Awaited<ReturnType<A["api"]["getSession"]>>
>

export interface BetterAuthOptions {
  /** Mount path for better-auth's routes. Defaults to `auth.options.basePath`, then `"/api/auth"`. */
  readonly basePath?: string
}

// better-auth dispatches only GET (session, OAuth/email callbacks) and POST (sign-in/up/out, etc.).
const HANDLED_METHODS = ["GET", "POST"] as const

/**
 * Mount a better-auth instance into a nifra app: registers its handler at `${basePath}/*`
 * (default `/api/auth/*`) for `GET` + `POST`, so every better-auth endpoint — sign-in/up/out, OAuth
 * callbacks, session, 2FA, magic links, … — is served by your nifra server.
 *
 * ```ts
 * import { betterAuth, requireSession } from "@nifrajs/better-auth"
 * import { auth } from "./auth"           // your configured better-auth instance
 *
 * const app = server().use(betterAuth(auth))            // wires /api/auth/*
 *   .get("/me", async (c) => (await requireSession(auth, c.req)).user)
 * ```
 *
 * Idempotent (named `"better-auth"` — applying twice mounts once). Read the session with
 * {@link getSession} / {@link requireSession}, which infer your better-auth types.
 */
export function betterAuth(auth: BetterAuthLike, options: BetterAuthOptions = {}) {
  const base = options.basePath ?? auth.options?.basePath ?? "/api/auth"
  const pattern = `${base.replace(/\/+$/, "")}/*` // strip trailing slash(es), then wildcard the subtree
  // A type-IDENTITY plugin (see defineIdentityPlugin): mounting the auth handler must NOT change the
  // route registry's type. A plain `definePlugin((app) => app)` would infer `app: Server<any, any>`, so
  // `use`'s result — and the entire typed client derived from it — collapsed to `any`. This was the #1
  // reported anti-drift bug: routes declared after `.use(betterAuth(...))` silently lost their types.
  return defineIdentityPlugin("better-auth", <S extends AnyServer>(app: S): S => {
    for (const method of HANDLED_METHODS) {
      // `register`'s handler is typed `(context: never) => unknown`; the framework invokes it with the
      // real Context, so reading `c.req` is sound. Returning better-auth's Response passes through as-is.
      app.register(method, pattern, undefined, (c: { readonly req: Request }) =>
        auth.handler(c.req),
      )
    }
    return app
  })
}

/**
 * Resolve the better-auth session for a request — a thin, typed wrapper over `auth.api.getSession`.
 * Returns `null` when unauthenticated. Takes the raw `Request` so it works in both server handlers
 * (`c.req`) and web loaders/actions (`request`).
 *
 * ```ts
 * const session = await getSession(auth, c.req) // typed: { user, session } | null
 * if (session) c.set.headers["x-user"] = session.user.id
 * ```
 */
export function getSession<A extends BetterAuthLike>(
  auth: A,
  request: Request,
): Promise<SessionOf<A> | null> {
  // `auth` is the concrete `A`, so `getSession`'s real return type is recovered by `SessionOf<A>`;
  // the cast bridges the erased `Promise<unknown>` view inside this generic body.
  return auth.api.getSession({ headers: request.headers }) as Promise<SessionOf<A> | null>
}

/**
 * What {@link requireSession} does on a missing session: `302` to `redirectTo` (a same-origin path),
 * or — when omitted — a `401` JSON (`{ ok: false, error: "unauthorized" }`). Mirrors `@nifrajs/auth` guards.
 */
export interface RequireSessionOptions {
  readonly redirectTo?: string
}

const rejection = (options: RequireSessionOptions): Response => {
  const to = options.redirectTo
  if (to === undefined) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 })
  // Same-origin guard (mirrors @nifrajs/web `redirect` + @nifrajs/auth guards): a single leading "/", never
  // "//host" or an absolute URL. `redirectTo` is dev-authored, so a bad value is a config bug — fail loud.
  if (!to.startsWith("/") || to.startsWith("//")) {
    throw new Error(
      `[nifra/better-auth] requireSession redirectTo must be a same-origin path beginning with "/" (got ${JSON.stringify(to)})`,
    )
  }
  return new Response(null, { status: 302, headers: { location: to } })
}

/**
 * Require an authenticated better-auth session at the top of a protected handler/loader/action.
 * Returns the (non-null) session when present; otherwise **throws a `Response`** (302/401) — nifra
 * returns a thrown `Response` as-is, short-circuiting the rest of the handler.
 *
 * ```ts
 * const { user } = await requireSession(auth, c.req, { redirectTo: "/login" })
 * ```
 */
export async function requireSession<A extends BetterAuthLike>(
  auth: A,
  request: Request,
  options: RequireSessionOptions = {},
): Promise<SessionOf<A>> {
  const session = await getSession(auth, request)
  if (session !== null) return session
  throw rejection(options)
}

/**
 * The authenticated caller of a request, mapped from a better-auth session. Built by
 * {@link requirePrincipal} / {@link authed} and threaded onto the handler context as `c.principal`.
 *
 * `tenantId` is optional here (`string | undefined`); with `{ requireTenant: true }` it is narrowed to a
 * non-optional `string` (see {@link authed}), so a tenant-scoped handler never has to null-check it.
 * nifra owns the session -> principal wiring ONLY; binding the principal to a DB/RLS scope stays in
 * userland (nifra is storage-agnostic and adds no DB code).
 */
export interface Principal<User> {
  /** The full better-auth user record, typed from the concrete auth instance. */
  readonly user: User
  /** The user's id (`user.id`). */
  readonly userId: string
  /** The session's id (`session.id`). */
  readonly sessionId: string
  /** The resolved tenant/org id, if any. Non-optional `string` under `{ requireTenant: true }`. */
  readonly tenantId?: string
}

/**
 * The non-null user type of a concrete better-auth instance `A` (`SessionOf<A>["user"]`). Collapses to
 * `unknown` only for the erased structural `BetterAuthLike`; a real instance recovers the concrete user.
 */
export type SessionUserOf<A extends BetterAuthLike> =
  SessionOf<A> extends { user: infer U } ? U : unknown

/**
 * Options for {@link requirePrincipal} / {@link authed}.
 */
export interface AuthedOptions<User> {
  /** Require a resolvable tenant. When set and no tenant resolves, fail closed with `403`. */
  readonly requireTenant?: boolean
  /** Browser redirect target (`302`) for a missing session, instead of the default `401` JSON. Same-origin. */
  readonly redirectTo?: string
  /** Resolve the tenant id from the user. Default: `user.tenantId ?? user.orgId` (string-valued only). */
  readonly tenantOf?: (user: User) => string | undefined
}

/**
 * The principal type for a given `requireTenant` flag: `tenantId` narrows to a required `string` when
 * `requireTenant` is `true`, otherwise stays optional (`string | undefined`). The flag is captured as a
 * literal `const` type parameter at the call sites so `{ requireTenant: true }` selects the narrowed branch.
 */
export type PrincipalFor<User, RequireTenant extends boolean> = RequireTenant extends true
  ? Principal<User> & { readonly tenantId: string }
  : Principal<User>

/** Add `{ principal: P }` to a server's context while preserving its route registry `R` (no collapse to
 * `any`). This is the type that makes `.use(authed(auth))` thread a NON-NULL `c.principal`. */
export type WithPrincipal<S extends AnyServer, P> =
  S extends Server<infer R, infer C> ? Server<R, C & { principal: P }> : never

const forbidden = (): Response => Response.json({ ok: false, error: "forbidden" }, { status: 403 })

/**
 * Resolve the better-auth session and map it to a {@link Principal}, or **throw a `Response`** so the
 * handler never runs unauthenticated:
 *
 * - No/invalid session -> `302` to `options.redirectTo` when set, else `401` JSON (`requireSession`).
 * - `requireTenant: true` and no tenant resolves -> `403` JSON (`{ ok: false, error: "forbidden" }`).
 *
 * nifra returns a thrown `Response` as-is (short-circuit), so this is the fail-closed guard used inline
 * or by {@link authed}. `tenantId` is a non-optional `string` in the return type when `requireTenant`.
 *
 * ```ts
 * const principal = await requirePrincipal(auth, c.req, { requireTenant: true })
 * // principal.userId / principal.tenantId are typed `string`, no null-check
 * ```
 */
export async function requirePrincipal<
  A extends BetterAuthLike,
  const RequireTenant extends boolean = false,
>(
  auth: A,
  request: Request,
  options?: AuthedOptions<SessionUserOf<A>> & { readonly requireTenant?: RequireTenant },
): Promise<PrincipalFor<SessionUserOf<A>, RequireTenant>> {
  // Reuse requireSession's throw path (302/redirect or 401) verbatim - one owner for the no-session gate.
  const session = await requireSession(
    auth,
    request,
    options?.redirectTo !== undefined ? { redirectTo: options.redirectTo } : {},
  )
  // better-auth sessions are `{ user: { id: string, ... }, session: { id: string, ... } }`; view the
  // fields we map. The concrete user type flows through `SessionUserOf<A>` for `principal.user`.
  const view = session as unknown as {
    readonly user: SessionUserOf<A>
    readonly session: { readonly id: string }
  }
  const user = view.user
  const userId = (user as { readonly id: string }).id
  const sessionId = view.session.id

  const resolveTenant =
    options?.tenantOf ??
    ((u: SessionUserOf<A>): string | undefined => {
      const record = u as { readonly tenantId?: unknown; readonly orgId?: unknown }
      const value = record.tenantId ?? record.orgId
      return typeof value === "string" ? value : undefined
    })
  // A blank tenant is NOT a resolved tenant: a NOT-NULL column defaulted to "" (or a custom `tenantOf`
  // returning "") must fail closed under `requireTenant`, never bind the principal to an empty tenant.
  const resolved = resolveTenant(user)
  const tenantId = resolved === undefined || resolved === "" ? undefined : resolved

  if (options?.requireTenant === true && tenantId === undefined) throw forbidden()

  // Build the principal without ever assigning `tenantId: undefined` (exactOptionalPropertyTypes). The
  // single cast maps our own constructed object onto the conditional `PrincipalFor` return - the runtime
  // shape is exactly the mapped session, no untrusted data crosses here.
  const principal: Principal<SessionUserOf<A>> =
    tenantId === undefined ? { user, userId, sessionId } : { user, userId, sessionId, tenantId }
  return principal as PrincipalFor<SessionUserOf<A>, RequireTenant>
}

/**
 * A nifra plugin that derives a fail-closed {@link Principal} onto every downstream handler as
 * `c.principal`. After `server().use(authed(auth))`, `c.principal.user` / `c.principal.userId` are typed
 * and **non-null** - a handler CANNOT run without an authenticated caller, so the guard can't be
 * forgotten. Works in both modes:
 *
 * ```ts
 * // inline
 * const app = server().use(authed(auth)).get("/me", (c) => ({ id: c.principal.userId }))
 * // contract-first (the pre-applied derive threads `principal` into the contract's handlers)
 * const api = implement(contract, handlers, server().use(authed(auth, { requireTenant: true })))
 * ```
 *
 * With `{ requireTenant: true }`, `c.principal.tenantId` is typed `string` (a missing tenant is a `403`).
 *
 * DESIGN NOTE: this is an **unnamed** plugin by necessity. A named plugin (for idempotent dedupe) carries
 * a `& { pluginName }` intersection that defeats the generic inference of `use`'s context-threading
 * overload and collapses the server - and its typed client - to `any` (see `@nifrajs/core` plugin docs).
 * Threading a NON-NULL principal is the whole point, so `authed` stays unnamed and generic. Applying it
 * twice simply derives twice (the second resolve overwrites with the same value); scope it once per app.
 */
export function authed<A extends BetterAuthLike, const RequireTenant extends boolean = false>(
  auth: A,
  options?: AuthedOptions<SessionUserOf<A>> & { readonly requireTenant?: RequireTenant },
): <S extends AnyServer>(
  app: S,
) => WithPrincipal<S, PrincipalFor<SessionUserOf<A>, RequireTenant>> {
  return <S extends AnyServer>(app: S) =>
    app.derive(async (c: { readonly req: Request }) => ({
      principal: await requirePrincipal(auth, c.req, options),
    })) as unknown as WithPrincipal<S, PrincipalFor<SessionUserOf<A>, RequireTenant>>
}

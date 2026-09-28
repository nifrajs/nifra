import { NIFRA_ASSURANCE, withRouteAssurance } from "@nifrajs/core/assurance"
import {
  type AnyServer,
  type AuthenticationInput,
  type AuthHeaders,
  authenticated,
  defineIdentityPlugin,
  isSameOriginPath,
  type ResponseResult,
  rejected,
  type Server,
  status,
} from "@nifrajs/core/server"

/**
 * The structural slice of a [better-auth](https://better-auth.com) instance this package needs.
 * Declared structurally rather than imported, so `@nifrajs/better-auth` has **no runtime dependency** on
 * better-auth: you pass your own `auth` object and its concrete types flow through
 * {@link getSession} / {@link requireSession} via inference.
 */
export interface BetterAuthLike {
  /** better-auth's catch-all handler - serves every request under `basePath`. */
  readonly handler: (request: Request) => Response | Promise<Response>
  readonly api: {
    /** Resolve the session from request headers (cookie or bearer). Returns a nullable payload. */
    readonly getSession: (context: { readonly headers: Headers }) => Promise<unknown>
  }
  /**
   * better-auth's resolved options; `basePath` (when set) defaults the mount path. Intersected with
   * `Record<string, unknown>` so a real better-auth instance (whose `options` is a large concrete object
   * with no structural overlap to a bare `{ basePath? }`) stays assignable to `BetterAuthLike` WITHOUT a
   * cast - keeping `A` concrete so `SessionOf<A>` recovers the real session type instead of collapsing
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
 * (default `/api/auth/*`) for `GET` + `POST`, so every better-auth endpoint - sign-in/up/out, OAuth
 * callbacks, session, 2FA, magic links, … - is served by your nifra server.
 *
 * ```ts
 * import { betterAuth, requireSession } from "@nifrajs/better-auth"
 * import { auth } from "./auth"           // your configured better-auth instance
 *
 * const app = server().use(betterAuth(auth))            // wires /api/auth/*
 *   .get("/me", async (c) => (await requireSession(auth, c.req)).user)
 * ```
 *
 * Idempotent (named `"better-auth"` - applying twice mounts once). Read the session with
 * {@link getSession} / {@link requireSession}, which infer your better-auth types.
 */
export function betterAuth(auth: BetterAuthLike, options: BetterAuthOptions = {}) {
  let base = options.basePath ?? auth.options?.basePath ?? "/api/auth"
  while (base.endsWith("/")) base = base.slice(0, -1) // strip trailing slash(es) - endsWith loop, not a backtracking `/\/+$/`
  const pattern = `${base}/*` // then wildcard the subtree
  // A type-IDENTITY plugin (see defineIdentityPlugin): mounting the auth handler must NOT change the
  // route registry's type. A plain `definePlugin((app) => app)` would infer `app: Server<any, any>`, so
  // `use`'s result - and the entire typed client derived from it - collapsed to `any`. This was the #1
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
 * Resolve the better-auth session for a request - a thin, typed wrapper over `auth.api.getSession`.
 * Returns `null` when unauthenticated. Accepts a raw `Request` for handlers/loaders, native
 * `Headers`, or the body-blind `AuthHeaders` capsule supplied by `authenticate()`.
 *
 * ```ts
 * const session = await getSession(auth, c.req) // typed: { user, session } | null
 * if (session) c.set.headers["x-user"] = session.user.id
 * ```
 */
export function getSession<A extends BetterAuthLike>(
  auth: A,
  input: Request | Headers | AuthHeaders,
): Promise<SessionOf<A> | null> {
  // Always give the provider a detached Headers object. That keeps the authentication boundary
  // body-blind and prevents a provider from mutating the request's live header view. The
  // AuthenticationInput capsule intentionally is not a Headers instance, so this copy is also the
  // adapter between the narrow core auth API and better-auth's native `{ headers: Headers }` shape.
  const source = "headers" in input ? input.headers : input
  const headers = new Headers()
  source.forEach((value, name) => {
    headers.append(name, value)
  })
  const result = auth.api.getSession({ headers }) as Promise<SessionOf<A> | null | undefined>
  // Some adapters use `undefined` for an absent session even though better-auth documents `null`.
  // Normalize both forms so every caller has one fail-closed branch.
  return result.then((session) => (session == null ? null : session))
}

/**
 * What {@link requireSession} does on a missing session: `302` to `redirectTo` (a same-origin path),
 * or - when omitted - a `401` JSON (`{ ok: false, error: "unauthorized" }`). Mirrors `@nifrajs/auth` guards.
 */
export interface RequireSessionOptions {
  readonly redirectTo?: string
}

const rejection = (options: RequireSessionOptions): ResponseResult => {
  const to = options.redirectTo
  if (to === undefined) return status(401, { ok: false, error: "unauthorized" })
  return status(302, undefined, { headers: { location: to } })
}

function assertSafeRedirectTo(to: string | undefined, owner: "requireSession" | "authed"): void {
  if (to === undefined || isSameOriginPath(to)) return
  // The kernel's same-origin predicate, shared with `@nifrajs/web`'s `redirect` and the
  // `@nifrajs/auth` guards: a single leading "/", never "//host", an absolute URL, or a form a URL
  // parser resolves off-origin. `redirectTo` is dev-authored, so a bad value is a config bug - fail loud.
  throw new Error(
    `[nifra/better-auth] ${owner} redirectTo must be a same-origin path beginning with "/" - never "//", a backslash, or a control character (got ${JSON.stringify(to)})`,
  )
}

/**
 * Require an authenticated better-auth session at the top of a protected handler/loader/action.
 * Returns the (non-null) session when present; otherwise **throws a Nifra `ResponseResult`** (302/401).
 * Nifra handles the thrown control-flow value on the same rendering lane as `@nifrajs/auth`.
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
  assertSafeRedirectTo(options.redirectTo, "requireSession")
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

const forbidden = (): ResponseResult => status(403, { ok: false, error: "forbidden" })

type PrincipalMapping<A extends BetterAuthLike, RequireTenant extends boolean> =
  | {
      readonly kind: "authenticated"
      readonly principal: PrincipalFor<SessionUserOf<A>, RequireTenant>
    }
  | { readonly kind: "forbidden" }

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * Validate and map a provider session before it becomes trusted handler context. A concrete
 * better-auth type is useful to application code, but it cannot replace these runtime checks: a
 * broken database adapter or a forged test double must never produce a principal with an empty id.
 */
function principalFromSession<
  A extends BetterAuthLike,
  const RequireTenant extends boolean = false,
>(
  session: SessionOf<A>,
  options?: AuthedOptions<SessionUserOf<A>> & { readonly requireTenant?: RequireTenant },
): PrincipalMapping<A, RequireTenant> {
  const sessionRecord = recordOf(session)
  const userRecord = recordOf(sessionRecord?.user)
  const sessionFields = recordOf(sessionRecord?.session)
  const userId = userRecord?.id
  const sessionId = sessionFields?.id
  if (
    userRecord === undefined ||
    typeof userId !== "string" ||
    userId.trim().length === 0 ||
    sessionFields === undefined ||
    typeof sessionId !== "string" ||
    sessionId.trim().length === 0
  ) {
    throw new Error("better-auth returned an invalid session")
  }

  const user = sessionRecord?.user as SessionUserOf<A>
  const resolveTenant =
    options?.tenantOf ??
    ((value: SessionUserOf<A>): string | undefined => {
      const record = value as { readonly tenantId?: unknown; readonly orgId?: unknown }
      const candidate = record.tenantId ?? record.orgId
      return typeof candidate === "string" ? candidate : undefined
    })
  const resolved = resolveTenant(user) as unknown
  if (resolved !== undefined && typeof resolved !== "string") {
    throw new Error("better-auth returned an invalid tenant")
  }
  const tenantId =
    resolved === undefined || resolved.trim().length === 0 ? undefined : (resolved as string)

  if (options?.requireTenant === true && tenantId === undefined) return { kind: "forbidden" }

  const principal: Principal<SessionUserOf<A>> =
    tenantId === undefined ? { user, userId, sessionId } : { user, userId, sessionId, tenantId }
  return {
    kind: "authenticated",
    principal: principal as PrincipalFor<SessionUserOf<A>, RequireTenant>,
  }
}

/**
 * Resolve the better-auth session and map it to a {@link Principal}, or **throw a Nifra `ResponseResult`** so the
 * handler never runs unauthenticated:
 *
 * - No/invalid session -> `302` to `options.redirectTo` when set, else `401` JSON (`requireSession`).
 * - `requireTenant: true` and no tenant resolves -> `403` JSON (`{ ok: false, error: "forbidden" }`).
 *
 * nifra handles the thrown control-flow value as a short-circuit, so this is the fail-closed guard used
 * inline or by {@link authed}. `tenantId` is a non-optional `string` in the return type when `requireTenant`.
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
  const mapped = principalFromSession(session, options)
  if (mapped.kind === "forbidden") throw forbidden()
  return mapped.principal
}

/**
 * A nifra plugin that authenticates the request before untrusted input validation and threads a
 * fail-closed {@link Principal} onto every downstream handler as
 * `c.principal`. After `server().use(authed(auth))`, `c.principal.user` / `c.principal.userId` are typed
 * and **non-null** - a handler CANNOT run without an authenticated caller, so the guard can't be
 * forgotten. Works in both modes:
 *
 * ```ts
 * // inline
 * const app = server().use(authed(auth)).get("/me", (c) => ({ id: c.principal.userId }))
 * // contract-first (the pre-applied auth stage threads `principal` into the contract's handlers)
 * const api = implement(contract, handlers, server().use(authed(auth, { requireTenant: true })))
 * ```
 *
 * With `{ requireTenant: true }`, `c.principal.tenantId` is typed `string` (a missing tenant is a `403`).
 *
 * DESIGN NOTE: this is an **unnamed** plugin by necessity. A named plugin (for idempotent dedupe) carries
 * a `& { pluginName }` intersection that defeats the generic inference of `use`'s context-threading
 * overload and collapses the server - and its typed client - to `any` (see `@nifrajs/core` plugin docs).
 * Threading a NON-NULL principal is the whole point, so `authed` stays unnamed and generic. Applying it
 * twice simply installs two auth stages; scope it once per app so the policy is unambiguous.
 */
export function authed<A extends BetterAuthLike, const RequireTenant extends boolean = false>(
  auth: A,
  options?: AuthedOptions<SessionUserOf<A>> & { readonly requireTenant?: RequireTenant },
): <S extends AnyServer>(
  app: S,
) => WithPrincipal<S, PrincipalFor<SessionUserOf<A>, RequireTenant>> {
  assertSafeRedirectTo(options?.redirectTo, "authed")
  const plugin = <S extends AnyServer>(app: S) =>
    app.authenticate({
      id: "better-auth",
      mode: "async",
      run: async (input: AuthenticationInput<unknown>) => {
        try {
          const session = await getSession(auth, input.headers)
          if (session === null) {
            return rejected(
              "unauthenticated",
              rejection(
                options?.redirectTo === undefined ? {} : { redirectTo: options.redirectTo },
              ),
            )
          }
          const mapped = principalFromSession(session, options)
          if (mapped.kind === "forbidden") return rejected("forbidden")
          return authenticated(mapped.principal)
        } catch {
          // Provider failures, malformed rows, and malformed custom tenant resolvers all fail closed
          // without leaking database/auth detail to the client. The core stage turns this into a
          // stable 503, while 401/403 remain reserved for the two intentional policy decisions.
          return rejected("unavailable")
        }
      },
    }) as unknown as WithPrincipal<S, PrincipalFor<SessionUserOf<A>, RequireTenant>>
  return withRouteAssurance(plugin, {
    id: NIFRA_ASSURANCE.AUTHENTICATED,
    source: "better-auth",
    scope: "subsequent",
  })
}

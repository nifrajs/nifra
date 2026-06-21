import { type AnyServer, defineIdentityPlugin } from "@nifrajs/core"

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

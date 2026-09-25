/**
 * Official Auth.js integration for nifra - backend half. Mount the full Auth.js surface
 * (OAuth/OIDC sign-in, callbacks, session, sign-out, CSRF) into a nifra app, read the session in
 * handlers and loaders, and guard routes - with Auth.js, not a reimplementation, doing the
 * security-critical work (PKCE, state, token verification, session cookies).
 *
 * ```ts
 * import { authjs, requireAuthUser } from "@nifrajs/authjs"
 * import GitHub from "@auth/core/providers/github"
 *
 * const auth = {
 *   providers: [GitHub({ clientId: process.env.GITHUB_ID! })],
 *   secret: process.env.AUTH_SECRET,
 *   trustHost: true, // or AUTH_URL behind a proxy - see AuthJSOptions.authUrl
 * }
 *
 * export const app = server()
 *   .use(authjs(auth))
 *   .get("/me", async (c) => ({ user: await requireAuthUser(c.req, auth) }))
 * ```
 *
 * Frontend half: `createAuthClient` in `@nifrajs/authjs/client`, plus `<AuthSessionProvider>` /
 * `useAuthSession()` in `@nifrajs/web-react/auth` (other adapters wrap the agnostic client the
 * same way `@nifrajs/web-react/i18n` wraps `@nifrajs/i18n`).
 */

import type { AuthConfig } from "@auth/core"
import type { Session } from "@auth/core/types"
import type { AnyServer, Platform, ResponseResult } from "@nifrajs/core/server"
import { defineIdentityPlugin, isSameOriginPath, status } from "@nifrajs/core/server"

export type { Session } from "@auth/core/types"

/** The Auth.js config this integration drives - everything `@auth/core` accepts except `raw`. */
export type AuthJSConfig = Omit<AuthConfig, "raw">

export interface AuthJSOptions {
  /** Mount path for Auth.js routes. Defaults to `config.basePath`, then `"/api/auth"`. */
  readonly basePath?: string
  /** Public origin for deployments behind a proxy (e.g. `"https://app.example.com"`).
   * When set, Auth.js URLs are rewritten onto it. Forwarded headers are ignored for this
   * canonical origin. */
  readonly authUrl?: string
  /** Trust proxy-provided `x-forwarded-*` headers when `authUrl` is absent. Default `false`.
   * Enable only when the deployment strips and replaces those headers at a trusted proxy. */
  readonly trustProxy?: boolean
  /** Session secret. Falls back to the `secretEnv` platform binding, then `process.env`. Missing
   * everywhere fails loud (500) on first use - Auth.js cannot sign cookies without it. */
  readonly secret?: string
  /** Platform-binding name carrying the secret on edge runtimes (no `process.env` there).
   * Default `"AUTH_SECRET"`. */
  readonly secretEnv?: string
}

const HANDLED_METHODS = ["GET", "POST"] as const

/** Read a secret from the process environment where one exists (never on edge workers). */
function readEnvSecret(name: string): string | undefined {
  if (typeof process === "undefined") return undefined
  const value = process.env?.[name]
  return typeof value === "string" && value !== "" ? value : undefined
}

/** Resolve the Auth.js secret: explicit config (a rotation list passes through untouched -
 * Auth.js itself tries each entry), platform binding, then the process environment. */
function resolveSecret(
  env: unknown,
  secretEnv: string | undefined,
  configured: string | readonly string[] | undefined,
): string | string[] | undefined {
  if (configured !== undefined) return typeof configured === "string" ? configured : [...configured]
  const name = secretEnv ?? "AUTH_SECRET"
  const fromEnv =
    typeof env === "object" && env !== null ? (env as Record<string, unknown>)[name] : undefined
  if (typeof fromEnv === "string" && fromEnv !== "") return fromEnv
  return readEnvSecret(name)
}

/** Validate the configured public origin once; request headers must never redefine it. */
function canonicalPublicOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("[nifra/authjs] authUrl must be an absolute http(s) origin")
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("[nifra/authjs] authUrl must be an absolute http(s) origin")
  }
  return url.origin
}

/** Remove proxy routing metadata so Auth.js cannot derive a URL from attacker-controlled headers. */
function sanitizePublicRequest(req: Request, url: string, host: string): Request {
  const rewritten = new Request(url, req)
  rewritten.headers.delete("forwarded")
  rewritten.headers.delete("x-forwarded-host")
  rewritten.headers.delete("x-forwarded-proto")
  rewritten.headers.delete("host")
  rewritten.headers.set("host", host)
  return rewritten
}

/** Rewrite a request onto the public origin, preserving method/headers/body. */
function rewriteUrl(req: Request, authUrl: string): Request {
  const source = new URL(req.url)
  const target = new URL(authUrl)
  source.protocol = target.protocol
  source.host = target.host
  return sanitizePublicRequest(req, source.href, target.host)
}

/** Derive the public request URL, trusting forwarded headers only with an explicit opt-in. */
function publicRequest(req: Request, authUrl: string | undefined, trustProxy: boolean): Request {
  if (authUrl !== undefined) return rewriteUrl(req, authUrl)
  if (!trustProxy) {
    const url = new URL(req.url)
    return sanitizePublicRequest(req, url.href, url.host)
  }
  const proto = req.headers.get("x-forwarded-proto")
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host")
  if (proto === null && host === null) {
    const url = new URL(req.url)
    return sanitizePublicRequest(req, url.href, url.host)
  }
  const url = new URL(req.url)
  try {
    if (proto !== null) {
      const protocol = proto.endsWith(":") ? proto : `${proto}:`
      if (protocol !== "http:" && protocol !== "https:") throw new Error("invalid proxy protocol")
      url.protocol = protocol
    }
    if (host !== null) url.host = host
  } catch {
    const fallback = new URL(req.url)
    return sanitizePublicRequest(req, fallback.href, fallback.host)
  }
  return sanitizePublicRequest(req, url.href, url.host)
}

/**
 * Mount an Auth.js instance into a nifra app: serves `${basePath}/*` (default `/api/auth/*`) for
 * `GET` + `POST`, so sign-in, OAuth callbacks, session, sign-out, and CSRF all run on your server
 * through `@auth/core` itself. A type-IDENTITY plugin (see `defineIdentityPlugin`): mounting never
 * changes the route registry's type, so the typed client keeps working below the mount.
 *
 * Idempotent (named `"authjs"` - applying twice mounts once).
 */
export function authjs(config: AuthJSConfig, options: AuthJSOptions = {}) {
  let base = options.basePath ?? config.basePath ?? "/api/auth"
  while (base.endsWith("/")) base = base.slice(0, -1)
  if (base === "") base = "/api/auth"
  const pattern = `${base}/*`
  const publicOrigin =
    options.authUrl === undefined ? undefined : canonicalPublicOrigin(options.authUrl)
  return defineIdentityPlugin("authjs", <S extends AnyServer>(app: S): S => {
    for (const method of HANDLED_METHODS) {
      // `register`'s handler is typed `(context: never) => unknown`; the framework invokes it with
      // the real Context, so reading `c.req`/`c.env` is sound. Auth.js's Response passes through.
      app.register(
        method,
        pattern,
        undefined,
        async (c: {
          readonly req: Request
          readonly env: unknown
          readonly platform?: Platform
        }) => {
          const secret = resolveSecret(c.env, options.secretEnv, options.secret ?? config.secret)
          if (secret === undefined) {
            return status(500, { ok: false, error: "auth_misconfigured" })
          }
          // Never mutate the caller's config - `setEnvDefaults` fills Auth.js-computed defaults.
          // `basePath` is always set explicitly: core does not apply its own default here, and an
          // unset basePath answers every action (even `/csrf`) with a flat 400.
          const { Auth, setEnvDefaults } = await import("@auth/core")
          const active = {
            ...config,
            basePath: base,
            secret: typeof secret === "string" ? secret : [...secret],
          }
          setEnvDefaults({ AUTH_SECRET: secret }, active)
          return Auth(publicRequest(c.req, publicOrigin, options.trustProxy === true), active)
        },
      )
    }
    return app
  })
}

/** What a guard does when the check fails: 302 to `redirectTo` (same-origin path), else 401 JSON. */
export interface AuthGuardOptions {
  readonly redirectTo?: string
  /** Secret override for this call. */
  readonly secret?: string | string[]
  /** Platform binding object used when `config.secret` is not present. */
  readonly env?: unknown
  /** Secret key in `env`; defaults to `AUTH_SECRET`. */
  readonly secretEnv?: string
}

const guardRejection = (options: AuthGuardOptions): ResponseResult => {
  const to = options.redirectTo
  if (to === undefined) return status(401, { ok: false, error: "unauthorized" })
  if (!isSameOriginPath(to)) {
    throw new Error(
      `[nifra/authjs] guard redirectTo must be a same-origin path beginning with "/" (got ${JSON.stringify(to)})`,
    )
  }
  return status(302, undefined, { headers: { location: to } })
}

/**
 * Resolve the Auth.js session for a request - `null` when unauthenticated. Takes the raw `Request`
 * so it works in handlers (`c.req`), loaders/actions (`request`), and middleware. Mirrors the
 * session-callback interception `@hono/auth-js` uses: the full `{ session, user }` flows through
 * your configured `callbacks.session` first.
 */
export async function getSession(
  req: Request,
  config: AuthJSConfig,
  options: AuthGuardOptions = {},
): Promise<Session | null> {
  const secret = resolveSecret(options.env, options.secretEnv, options.secret ?? config.secret)
  if (secret === undefined) {
    throw new Error("[nifra/authjs] getSession needs config.secret, options.secret, or AUTH_SECRET")
  }
  const { Auth } = await import("@auth/core")
  // Like the mount: core applies no basePath default itself, so set it explicitly.
  const active = { basePath: "/api/auth", ...config, secret }
  const cookie = req.headers.get("cookie") ?? ""
  const url = new URL(req.url)
  const sessionReq = new Request(`${url.origin}${active.basePath ?? "/api/auth"}/session`, {
    headers: { cookie },
  })
  const response = await Auth(sessionReq, active)
  if (!response.ok) return null
  const session = (await response.json()) as Session | null
  return session?.user ? session : null
}

/**
 * Require an authenticated user. Returns `session.user`; otherwise throws a `status(...)` render
 * (302/401) - control flow, caught by nifra's plain-data lane like `@nifrajs/auth` guards. Call at
 * the top of a protected handler/loader/action.
 */
export async function requireAuthUser(
  req: Request,
  config: AuthJSConfig,
  options: AuthGuardOptions = {},
): Promise<NonNullable<Session["user"]>> {
  const session = await getSession(req, config, options)
  if (session?.user) return session.user
  throw guardRejection(options)
}

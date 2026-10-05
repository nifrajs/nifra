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
 *   trustHost: true, // or a canonical origin: AuthJSOptions.authUrl / AUTH_URL
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

import type { AuthConfig, setEnvDefaults } from "@auth/core"
import type { Session } from "@auth/core/types"
import type { AnyServer, Platform, ResponseResult } from "@nifrajs/core/server"
import { defineIdentityPlugin, isSameOriginPath, status } from "@nifrajs/core/server"

export type { Session } from "@auth/core/types"

/** The Auth.js config this integration drives - everything `@auth/core` accepts except `raw`. */
export type AuthJSConfig = Omit<AuthConfig, "raw">

export interface AuthJSOptions {
  /** Mount path for Auth.js routes. Defaults to `config.basePath`, then `"/api/auth"`. */
  readonly basePath?: string
  /** Public origin (e.g. `"https://app.example.com"`); falls back to the `AUTH_URL` variable.
   * Every request is rewritten onto it, so Auth.js trusts it and neither the Host header nor
   * forwarded headers can replace it. Without one, Auth.js trusts the Host header only when
   * `trustHost` (or `AUTH_TRUST_HOST`) says so, or outside production. */
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

/** What Auth.js reads its documented variables from (`AUTH_URL`, `AUTH_TRUST_HOST`, `NODE_ENV`,
 * `AUTH_<PROVIDER>_ID`, ...): the platform bindings, then the process environment. */
function authEnv(bindings: unknown): Record<string, unknown> {
  const bound = typeof bindings === "object" && bindings !== null ? bindings : undefined
  const processEnv = typeof process === "undefined" ? undefined : process.env
  return new Proxy(
    {},
    {
      get: (_target, key) => {
        if (typeof key !== "string") return undefined
        if (bound !== undefined && Object.hasOwn(bound, key)) return Reflect.get(bound, key)
        return processEnv?.[key]
      },
    },
  )
}

/** The origin of the documented `AUTH_URL` (or `NEXTAUTH_URL`), which may carry a path. */
function envOrigin(env: Record<string, unknown>): string | undefined {
  const value = env.AUTH_URL ?? env.NEXTAUTH_URL
  if (value === undefined || value === "") return undefined
  let url: URL
  try {
    url = new URL(String(value))
  } catch {
    throw new Error("[nifra/authjs] AUTH_URL must be an absolute http(s) URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("[nifra/authjs] AUTH_URL must be an absolute http(s) URL")
  }
  return url.origin
}

function normalizeBasePath(value: string | undefined): string {
  let base = value ?? "/api/auth"
  while (base.endsWith("/")) base = base.slice(0, -1)
  return base === "" ? "/api/auth" : base
}

/**
 * The config Auth.js runs with - never the caller's object, which `setEnvDefaults` would mutate.
 * `basePath` is always explicit: core applies no default of its own here, and an unset basePath
 * answers every action (even `/csrf`) with a flat 400.
 */
function activeConfig(
  config: AuthJSConfig,
  basePath: string,
  secret: string | string[],
  origin: string | undefined,
  env: Record<string, unknown>,
  applyEnvDefaults: typeof setEnvDefaults,
): AuthConfig {
  const active: AuthConfig = {
    ...config,
    basePath,
    secret: typeof secret === "string" ? secret : [...secret],
  }
  // A request is rewritten onto a configured origin, so its Host header names nothing. Without
  // one, trusting the Host header is Auth.js's own rule: `trustHost`, `AUTH_TRUST_HOST`, or a
  // `NODE_ENV` other than production.
  if (origin !== undefined) active.trustHost ??= true
  applyEnvDefaults(env, active, true)
  return active
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

/** Derive the public request URL: the configured origin, else the request's own, with forwarded
 * headers trusted only on an explicit opt-in. */
function publicUrl(req: Request, origin: string | undefined, trustProxy: boolean): URL {
  const url = new URL(req.url)
  if (origin !== undefined) {
    const target = new URL(origin)
    url.protocol = target.protocol
    url.host = target.host
    return url
  }
  if (!trustProxy) return url
  const proto = req.headers.get("x-forwarded-proto")
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host")
  if (proto === null && host === null) return url
  const forwarded = new URL(req.url)
  try {
    if (proto !== null) {
      const protocol = proto.endsWith(":") ? proto : `${proto}:`
      if (protocol !== "http:" && protocol !== "https:") throw new Error("invalid proxy protocol")
      forwarded.protocol = protocol
    }
    if (host !== null) forwarded.host = host
  } catch {
    return url
  }
  return forwarded
}

/** Rewrite a request onto its public URL, preserving method/headers/body. */
function publicRequest(req: Request, origin: string | undefined, trustProxy: boolean): Request {
  const url = publicUrl(req, origin, trustProxy)
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
  const base = normalizeBasePath(options.basePath ?? config.basePath)
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
          const env = authEnv(c.env)
          let origin: string | undefined
          try {
            origin = publicOrigin ?? envOrigin(env)
          } catch {
            return status(500, { ok: false, error: "auth_misconfigured" })
          }
          const { Auth, setEnvDefaults } = await import("@auth/core")
          const active = activeConfig(config, base, secret, origin, env, setEnvDefaults)
          return Auth(publicRequest(c.req, origin, options.trustProxy === true), active)
        },
      )
    }
    return app
  })
}

/** What a guard does when the check fails: 302 to `redirectTo` (same-origin path), else 401 JSON.
 * Pass the `basePath`, `authUrl` and `trustProxy` the mount was given, so the session is read on
 * the origin and path the mount serves it from. */
export interface AuthGuardOptions
  extends Pick<AuthJSOptions, "basePath" | "authUrl" | "trustProxy"> {
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
  const env = authEnv(options.env)
  const origin =
    options.authUrl === undefined ? envOrigin(env) : canonicalPublicOrigin(options.authUrl)
  const base = normalizeBasePath(options.basePath ?? config.basePath)
  const { Auth, setEnvDefaults } = await import("@auth/core")
  const active = activeConfig(config, base, secret, origin, env, setEnvDefaults)
  // Read where the mount serves it: the public origin's scheme picks the `__Secure-` cookie names.
  const url = publicUrl(req, origin, options.trustProxy === true)
  const sessionReq = new Request(`${url.origin}${base}/session`, {
    headers: { cookie: req.headers.get("cookie") ?? "" },
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

/**
 * Route guards - run at the top of a protected loader/action/handler. On a missing session they
 * **throw** a `status(...)` render (a 302 to your login path, or a 401); nifra treats a thrown
 * `status(...)` as control flow and renders it on the ordinary plain-data lane, so the guard
 * short-circuits the rest of the handler at the cost of a normal return, without a `Response` being
 * built or drained.
 *
 * The throw is the point of a guard: `requireSession(...)` is called for effect from inside the
 * handler, so its caller cannot return the rejection on its behalf - only unwinding gets out of a
 * half-finished handler. Everywhere the caller CAN return - a `beforeHandle`, a `derive`, the handler
 * itself - return `status(...)` instead; see its docs.
 *
 * Pairs with `@nifrajs/auth` sessions but only needs the `Session` shape, so it's framework-agnostic.
 */
import { isSameOriginPath, type ResponseResult, status } from "@nifrajs/core/server"
import type { Session } from "./session.ts"

/** The response a guard denies a missing session with, in place of the default `401` JSON. */
export interface UnauthenticatedResponse {
  /** An error status, 400-599. Default `401`. */
  readonly status?: number
  /** The body; present but `undefined` sends none. Default `{ ok: false, error: "unauthorized" }`. */
  readonly body?: unknown
  /** Response headers, such as a `www-authenticate` challenge. */
  readonly headers?: Readonly<Record<string, string>>
}

/** What a guard does when the check fails: 302 to `redirectTo` (a same-origin path), or - omitted - the
 * `unauthenticated` response, by default a 401 JSON (`{ ok: false, error: "unauthorized" }`). */
export interface GuardOptions {
  readonly redirectTo?: string
  readonly unauthenticated?: UnauthenticatedResponse
}

const UNAUTHORIZED = { ok: false, error: "unauthorized" } as const

/** A dev-authored denial that is not an error status, or that competes with a redirect, fails loud. */
function assertUnauthenticated(options: {
  readonly redirectTo?: string
  readonly unauthenticated?: UnauthenticatedResponse
}): void {
  const custom = options.unauthenticated
  if (custom === undefined) return
  if (options.redirectTo !== undefined) {
    throw new Error("[nifra/auth] a guard takes redirectTo or unauthenticated, not both")
  }
  const code = custom.status
  if (code !== undefined && (!Number.isInteger(code) || code < 400 || code > 599)) {
    throw new RangeError(
      `[nifra/auth] guard unauthenticated.status must be an integer 400-599 (got ${String(code)})`,
    )
  }
}

const unauthenticatedResult = (custom: UnauthenticatedResponse | undefined): ResponseResult => {
  if (custom === undefined) return status(401, UNAUTHORIZED)
  const body = "body" in custom ? custom.body : UNAUTHORIZED
  return custom.headers === undefined
    ? status(custom.status ?? 401, body)
    : status(custom.status ?? 401, body, { headers: custom.headers })
}

const rejection = (options: GuardOptions): ResponseResult => {
  const to = options.redirectTo
  if (to === undefined) return unauthenticatedResult(options.unauthenticated)
  // The kernel's same-origin predicate, the one `@nifrajs/web`'s `redirect` uses: a single leading
  // "/", never "//host", an absolute URL, or a form a URL parser resolves off-origin. `redirectTo`
  // is dev-authored, so a bad value is a config bug - fail loud here.
  if (!isSameOriginPath(to)) {
    throw new Error(
      `[nifra/auth] guard redirectTo must be a same-origin path beginning with "/" - never "//", a backslash, or a control character (got ${JSON.stringify(to)})`,
    )
  }
  return status(302, undefined, { headers: { location: to } })
}

/**
 * Require a non-empty session. Returns it when present; otherwise throws a `status(...)` render
 * (302/401) - control flow, not a `Response`; see the module docs above. Use at
 * the top of a protected loader:
 * `const session = requireSession(await sessions.get(c), { redirectTo: "/login" })`.
 *
 * Non-empty is not signed in: a session that holds anything (a cart, a return path, CSRF state)
 * passes. Guard a page for signed-in visitors with {@link requireUser} and the key a login sets.
 */
export function requireSession<Data extends Record<string, unknown>>(
  session: Session<Data>,
  options: GuardOptions = {},
): Session<Data> {
  assertUnauthenticated(options)
  if (!session.isEmpty) return session
  throw rejection(options)
}

/**
 * Require a specific session key (e.g. the `userId` a login set) to be present. Returns its value
 * (narrowed non-nullish); otherwise throws like {@link requireSession}. The common "who is the user"
 * guard: `const userId = requireUser(await sessions.get(c), "userId", { redirectTo: "/login" })`.
 */
export function requireUser<Data extends Record<string, unknown>, K extends keyof Data>(
  session: Session<Data>,
  key: K,
  options: GuardOptions = {},
): NonNullable<Data[K]> {
  assertUnauthenticated(options)
  const value = session.get(key)
  // Narrowed by the runtime check; the generic `Data[K] | undefined` doesn't auto-narrow to NonNullable.
  if (value !== undefined && value !== null) return value as NonNullable<Data[K]>
  throw rejection(options)
}

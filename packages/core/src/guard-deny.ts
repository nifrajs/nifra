/**
 * The denial grammar the three auth packages' route guards share: what a guard rejects a missing
 * session with. `@nifrajs/auth`, `@nifrajs/authjs` and `@nifrajs/better-auth` each keep their own
 * options shape and their own redirect rejection; this subpath owns the `unauthenticated` response
 * type, its construction, and the two fail-loud dev-config checks, so the three cannot drift: a
 * fix made here holds for every guard family at once.
 *
 * The module imports only the status lane, so an app whose guards use it pays nothing besides the
 * grammar itself.
 */
import { type ResponseResult, status } from "./server/runtime-core.ts"

/** The body a guard sends when the app did not declare its own. */
const UNAUTHORIZED = { ok: false, error: "unauthorized" } as const

/**
 * The response a guard denies a missing session with, in place of the default `401` JSON. Every
 * nifra auth package's guard options named `unauthenticated` takes this shape.
 */
export interface UnauthenticatedResponse {
  /** An error status, 400-599. Default `401`. */
  readonly status?: number
  /** The body; present but `undefined` sends none. Default `{ ok: false, error: "unauthorized" }`. */
  readonly body?: unknown
  /** Response headers, such as a `www-authenticate` challenge. */
  readonly headers?: Readonly<Record<string, string>>
}

/**
 * A dev-authored denial that is not an error status, or that competes with a redirect, fails loud.
 * A mutation-taking guard must say one thing, and `unauthenticated.status` must stay an HTTP error
 * status. `owner` names the package in the message: `[nifra/<owner>]`.
 */
export function assertUnauthenticated(
  options: { readonly redirectTo?: string; readonly unauthenticated?: UnauthenticatedResponse },
  owner: string,
): void {
  const custom = options.unauthenticated
  if (custom === undefined) return
  if (options.redirectTo !== undefined) {
    throw new Error(`[nifra/${owner}] a guard takes redirectTo or unauthenticated, not both`)
  }
  const code = custom.status
  if (code !== undefined && (!Number.isInteger(code) || code < 400 || code > 599)) {
    throw new RangeError(
      `[nifra/${owner}] guard unauthenticated.status must be an integer 400-599 (got ${String(code)})`,
    )
  }
}

/**
 * The response one guard rejection carries: what the options declared, or the default `401` JSON
 * (`{ ok: false, error: "unauthorized" }`). An explicit `body` of `undefined` sends no body.
 */
export function unauthenticatedResult(custom: UnauthenticatedResponse | undefined): ResponseResult {
  if (custom === undefined) return status(401, UNAUTHORIZED)
  const body = "body" in custom ? custom.body : UNAUTHORIZED
  return custom.headers === undefined
    ? status(custom.status ?? 401, body)
    : status(custom.status ?? 401, body, { headers: custom.headers })
}

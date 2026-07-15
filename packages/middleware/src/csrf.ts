import { NIFRA_ASSURANCE, withRouteAssurance } from "@nifrajs/core/assurance"
import { METHODS, type Middleware } from "@nifrajs/core/server"
import {
  base64UrlEncode,
  hmacSha256,
  jsonError,
  parseCookies,
  SAFE_METHODS,
  secretBytes,
  timingSafeEqualString,
  verifyHmacSha256,
} from "./_utils.ts"

export interface CsrfOptions {
  /** HMAC secret. Must be at least 32 bytes. */
  readonly secret: string | Uint8Array
  /** Cookie carrying the signed token. Default `"csrf-token"`. */
  readonly cookie?: string
  /** Header carrying the same signed token. Default `"x-csrf-token"`. */
  readonly header?: string
  /** Unsafe methods to protect. Default: every method except GET/HEAD/OPTIONS/TRACE. */
  readonly methods?: readonly string[]
  /** Allowed request origins. Default: same-origin derived from the request URL. */
  readonly origins?: readonly string[]
  /** Check Origin/Referer on protected requests. Default true. */
  readonly checkOrigin?: boolean
}

const TOKEN_PREFIX = "v1"

function protectedMethod(method: string, configured: Set<string> | undefined): boolean {
  return configured !== undefined ? configured.has(method) : !SAFE_METHODS.has(method)
}

function originAllowed(req: Request, origins: Set<string> | undefined): boolean {
  const allowed = origins ?? new Set([new URL(req.url).origin])
  const origin = req.headers.get("origin")
  if (origin !== null) return allowed.has(origin)

  const referer = req.headers.get("referer")
  if (referer === null) return false
  try {
    return allowed.has(new URL(referer).origin)
  } catch {
    return false
  }
}

export async function createCsrfToken(
  secret: string | Uint8Array,
  nonce?: string,
): Promise<string> {
  const key = secretBytes(secret, "csrf")
  const tokenNonce = nonce ?? base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))
  if (!/^[A-Za-z0-9_-]{22,}$/.test(tokenNonce)) {
    throw new Error("csrf: nonce must be base64url-like and at least 22 characters")
  }
  const payload = `${TOKEN_PREFIX}.${tokenNonce}`
  return `${payload}.${await hmacSha256(payload, key)}`
}

export async function verifyCsrfToken(
  token: string,
  secret: string | Uint8Array,
): Promise<boolean> {
  const key = secretBytes(secret, "csrf")
  const parts = token.split(".")
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || parts[1] === "" || parts[2] === "") {
    return false
  }
  const [prefix, nonce, signature] = parts as [string, string, string]
  return verifyHmacSha256(`${prefix}.${nonce}`, signature, key)
}

/**
 * Signed double-submit CSRF protection. A protected request must carry the same signed token in a
 * cookie and a header, and must come from an allowed Origin/Referer unless `checkOrigin:false` is set.
 */
export function csrf(options: CsrfOptions): Middleware {
  const key = secretBytes(options.secret, "csrf")
  const cookie = options.cookie ?? "csrf-token"
  const header = (options.header ?? "x-csrf-token").toLowerCase()
  const methods =
    options.methods !== undefined ? new Set(options.methods.map((m) => m.toUpperCase())) : undefined
  const origins = options.origins !== undefined ? new Set(options.origins) : undefined
  const checkOrigin = options.checkOrigin !== false

  const middleware: Middleware = {
    name: "csrf",
    async onRequest(req) {
      if (!protectedMethod(req.method, methods)) return undefined
      if (checkOrigin && !originAllowed(req, origins)) return jsonError(403, "csrf_failed")

      const cookieToken = parseCookies(req.headers.get("cookie"))[cookie]
      const headerToken = req.headers.get(header)
      if (cookieToken === undefined || headerToken === null) return jsonError(403, "csrf_failed")
      if (!(await timingSafeEqualString(cookieToken, headerToken))) {
        return jsonError(403, "csrf_failed")
      }
      return (await verifyCsrfToken(cookieToken, key)) ? undefined : jsonError(403, "csrf_failed")
    },
  }
  return withRouteAssurance(middleware, {
    id: NIFRA_ASSURANCE.CSRF,
    source: "csrf",
    scope: "global",
    // Middleware may intentionally mention methods the Nifra router does not expose (for example
    // TRACE). Keep runtime behavior unchanged, but publish evidence only for registerable routes.
    methods:
      options.methods === undefined
        ? ["POST", "PUT", "PATCH", "DELETE"]
        : METHODS.filter((method) => methods?.has(method)),
  })
}

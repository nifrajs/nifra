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

/**
 * An HMAC secret, or a rotation list of them. With a list, the **first** secret signs new tokens
 * and any listed secret verifies - rotate by prepending the new secret and dropping the old one
 * once outstanding tokens have expired. Every entry must meet the 32-byte floor; an empty list
 * throws.
 */
export type CsrfSecret = string | Uint8Array | ReadonlyArray<string | Uint8Array>

/** Normalize to derived keys, validating every entry's 32-byte floor up front (fail loud at
 * construction, not on the first request that happens to reach an old secret). */
function csrfKeys(secret: CsrfSecret): ReadonlyArray<Uint8Array> {
  const list: ReadonlyArray<string | Uint8Array> =
    typeof secret === "string" || secret instanceof Uint8Array ? [secret] : secret
  if (list.length === 0) throw new Error("csrf: secret list cannot be empty")
  return list.map((s) => secretBytes(s, "csrf"))
}

export interface CsrfOptions {
  /** HMAC secret (≥ 32 bytes), or a rotation list - see {@link CsrfSecret}. */
  readonly secret: CsrfSecret
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

export async function createCsrfToken(secret: CsrfSecret, nonce?: string): Promise<string> {
  const key = csrfKeys(secret)[0] as Uint8Array
  const tokenNonce = nonce ?? base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))
  if (!/^[A-Za-z0-9_-]{22,}$/.test(tokenNonce)) {
    throw new Error("csrf: nonce must be base64url-like and at least 22 characters")
  }
  const payload = `${TOKEN_PREFIX}.${tokenNonce}`
  return `${payload}.${await hmacSha256(payload, key)}`
}

export async function verifyCsrfToken(token: string, secret: CsrfSecret): Promise<boolean> {
  const keys = csrfKeys(secret)
  const parts = token.split(".")
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || parts[1] === "" || parts[2] === "") {
    return false
  }
  const [prefix, nonce, signature] = parts as [string, string, string]
  // Rotation: accept a token signed by any listed secret. Each comparison is constant-time; which
  // generation matched is not attacker-meaningful, so the early exit between keys leaks nothing.
  for (const key of keys) {
    if (await verifyHmacSha256(`${prefix}.${nonce}`, signature, key)) return true
  }
  return false
}

/**
 * Signed double-submit CSRF protection. A protected request must carry the same signed token in a
 * cookie and a header, and must come from an allowed Origin/Referer unless `checkOrigin:false` is set.
 */
export function csrf(options: CsrfOptions): Middleware {
  const keys = csrfKeys(options.secret)
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
      return (await verifyCsrfToken(cookieToken, keys)) ? undefined : jsonError(403, "csrf_failed")
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

import { NIFRA_ASSURANCE, withRouteAssurance } from "@nifrajs/core/assurance"
import { isSameOriginRequest, METHODS, type Middleware } from "@nifrajs/core/server"
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
  /**
   * Form field that may carry the token when the header is absent, so a plain HTML `<form>` (no
   * script to set a header) can submit - e.g. `field: "_csrf"` with
   * `<input type="hidden" name="_csrf" value="...">`. Read from `application/x-www-form-urlencoded`
   * and `multipart/form-data` bodies only, through a clone, so the handler still reads the body.
   * Unset (default), only the header is accepted.
   *
   * A cross-site form can set any field but never a custom header, so keep `checkOrigin` on with a
   * field: the Origin check is what stops a site that can plant a cookie on your domain (a sibling
   * subdomain) from pairing it with a matching field.
   */
  readonly field?: string
  /**
   * Largest body scanned for {@link field}, in bytes. Default 64 KiB. A bigger form (a file upload)
   * fails closed - send the header, or raise this for that app.
   */
  readonly fieldMaxBytes?: number
  /** Unsafe methods to protect. Default: every method except GET/HEAD/OPTIONS/TRACE. */
  readonly methods?: readonly string[]
  /** Allowed request origins. Default: same host as the request URL, where an `https:` Origin may
   * reach an `http:` URL (what a TLS-terminating proxy looks like from the server). */
  readonly origins?: readonly string[]
  /** Check Origin/Referer on protected requests. Default true. */
  readonly checkOrigin?: boolean
}

const TOKEN_PREFIX = "v1"

function protectedMethod(method: string, configured: Set<string> | undefined): boolean {
  return configured !== undefined ? configured.has(method) : !SAFE_METHODS.has(method)
}

/**
 * An explicit allowlist compares exact origins. The same-origin default goes through core's
 * {@link isSameOriginRequest} instead of comparing against `new URL(req.url).origin`: behind a
 * TLS-terminating proxy the request URL says `http:` while the browser reports `https:`, and an exact
 * compare rejected every protected request there.
 */
function originAllowed(req: Request, origins: Set<string> | undefined): boolean {
  const allows = (candidate: string): boolean =>
    origins !== undefined ? origins.has(candidate) : isSameOriginRequest(candidate, req)
  const origin = req.headers.get("origin")
  if (origin !== null) return allows(origin)

  const referer = req.headers.get("referer")
  if (referer === null) return false
  try {
    return allows(new URL(referer).origin)
  } catch {
    return false
  }
}

function mediaEssence(contentType: string): string {
  const semi = contentType.indexOf(";")
  return (semi === -1 ? contentType : contentType.slice(0, semi)).trim().toLowerCase()
}

/** Up to `maxBytes` of a body stream, or `null` when it is longer (or fails mid-read). */
async function readAtMost(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } catch {
    return null
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * The token a form body carries in `field`, read from a clone so the handler keeps the original body.
 * Anything unexpected - another media type, an oversized or unreadable body, a file part under the
 * field's name - yields `null`, which the caller treats as a missing token.
 */
async function formFieldToken(
  req: Request,
  field: string,
  maxBytes: number,
): Promise<string | null> {
  if (req.body === null) return null
  const contentType = req.headers.get("content-type") ?? ""
  const essence = mediaEssence(contentType)
  const urlencoded = essence === "application/x-www-form-urlencoded"
  if (!urlencoded && essence !== "multipart/form-data") return null
  const declared = req.headers.get("content-length")
  if (declared !== null && !(Number(declared) <= maxBytes)) return null
  const clone = req.clone().body
  if (clone === null) return null
  const bytes = await readAtMost(clone, maxBytes)
  if (bytes === null) return null
  try {
    if (urlencoded) return new URLSearchParams(new TextDecoder().decode(bytes)).get(field)
    const form = await new Response(bytes, { headers: { "content-type": contentType } }).formData()
    const value = form.get(field)
    return typeof value === "string" ? value : null
  } catch {
    return null
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
  // @nifra-gate-reviewed: TOKEN_PREFIX is a public, non-secret format tag; this equality is a shape
  // check that short-circuits malformed input. The secret comparison is the constant-time
  // verifyHmacSha256 over the signature below.
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
 * cookie and in a header (or, for a plain HTML form, the {@link CsrfOptions.field} form field), and
 * must come from an allowed Origin/Referer unless `checkOrigin:false` is set.
 */
export function csrf(options: CsrfOptions): Middleware {
  const keys = csrfKeys(options.secret)
  const cookie = options.cookie ?? "csrf-token"
  const header = (options.header ?? "x-csrf-token").toLowerCase()
  const field = options.field
  if (field !== undefined && field.trim() === "") throw new Error("csrf: field must not be empty")
  const fieldMaxBytes = options.fieldMaxBytes ?? 64 * 1024
  if (!Number.isInteger(fieldMaxBytes) || fieldMaxBytes < 1) {
    throw new Error("csrf: fieldMaxBytes must be a positive integer")
  }
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
      if (cookieToken === undefined) return jsonError(403, "csrf_failed")
      // The header wins; the body is only read (from a clone) when a form had no way to set one.
      const requestToken =
        req.headers.get(header) ??
        (field === undefined ? null : await formFieldToken(req, field, fieldMaxBytes))
      if (requestToken === null) return jsonError(403, "csrf_failed")
      if (!(await timingSafeEqualString(cookieToken, requestToken))) {
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

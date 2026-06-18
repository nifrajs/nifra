/**
 * Cookie primitives — parse a request `Cookie` header, serialize a `Set-Cookie`, and sign/verify a
 * value with HMAC-SHA256 via **WebCrypto** (`crypto.subtle`), so they're portable across Bun, Node,
 * Deno, and workerd with no `node:crypto` dependency. Pure + runtime-agnostic: `c.cookies` (read) and
 * `c.set.cookie` (write) build on these, and `@nifrajs/auth` builds sessions on top.
 */

import { requireSecretBytes } from "../internal/secret.ts"

/** Attributes for a `Set-Cookie`. `expires` is a `Date`; `maxAge` is in **seconds**. */
export interface CookieOptions {
  /** Lifetime in seconds. `0` (with a past `expires`) deletes the cookie. */
  readonly maxAge?: number
  readonly expires?: Date
  readonly path?: string
  readonly domain?: string
  readonly secure?: boolean
  readonly httpOnly?: boolean
  readonly sameSite?: "strict" | "lax" | "none"
  readonly partitioned?: boolean
}

// RFC 6265 cookie-name token: visible ASCII minus separators/whitespace/controls.
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const MAX_COOKIE_BYTES = 4096 // browsers cap a cookie near 4 KB — reject oversized before the wire

/** True if `v` contains a character illegal in a cookie attribute (control char or `;` separator) —
 * the header-injection guard for dev-supplied `Path`/`Domain`. */
const hasIllegalChar = (v: string): boolean => {
  for (let i = 0; i < v.length; i++) {
    const code = v.charCodeAt(i)
    if (code < 0x20 || code === 0x7f || code === 0x3b /* ; */) return true
  }
  return false
}

const safeDecode = (v: string): string => {
  // No `%` ⇒ nothing to decode — skip the call AND its try frame (profiled: cookie values are
  // overwhelmingly plain; this was ~3% of a realistic request).
  if (!v.includes("%")) return v
  try {
    return decodeURIComponent(v)
  } catch {
    return v // a malformed %-escape from a hostile/garbage cookie must not throw (it'd 500 the request)
  }
}

/** Parse a request `Cookie` header into a name→value map (values URL-decoded). Unparseable pairs are
 * skipped rather than throwing — a junk `Cookie` header shouldn't fail the request.
 *
 * Hand-rolled index walk instead of `split(";")` + `trim()` chains: those allocated an array + up
 * to three substrings per pair and showed up at ~6% of a realistic (auth + cookie) request. Same
 * semantics, two slices per pair, no intermediate array. */
export function parseCookies(header: string | null | undefined): Record<string, string> {
  // Null-prototype: cookie NAMES come straight from the untrusted header, so a cookie named
  // `constructor`/`__proto__`/`toString` must be an inert own key, not a shadow of a prototype
  // member. Matches the query/form/params parsers (all `Object.create(null)`); values are always
  // strings so global pollution was never possible, but this keeps the whole request-parse layer
  // consistent and safe to treat as a plain dictionary.
  const out: Record<string, string> = Object.create(null)
  if (!header) return out
  const len = header.length
  let pos = 0
  while (pos < len) {
    let end = header.indexOf(";", pos)
    if (end === -1) end = len
    // trim() equivalent on the segment, without allocating the untrimmed slice
    let start = pos
    while (start < end && header.charCodeAt(start) === 32) start++
    let stop = end
    while (stop > start && header.charCodeAt(stop - 1) === 32) stop--
    const eq = header.indexOf("=", start)
    if (eq > start && eq < stop) {
      // name: trim trailing spaces before '='; value: trim leading spaces after it
      let nameEnd = eq
      while (nameEnd > start && header.charCodeAt(nameEnd - 1) === 32) nameEnd--
      let valueStart = eq + 1
      while (valueStart < stop && header.charCodeAt(valueStart) === 32) valueStart++
      if (nameEnd > start) {
        const name = header.slice(start, nameEnd)
        let value: string
        if (
          stop - valueStart >= 2 &&
          header.charCodeAt(valueStart) === 34 /* " */ &&
          header.charCodeAt(stop - 1) === 34
        ) {
          value = header.slice(valueStart + 1, stop - 1)
        } else {
          value = header.slice(valueStart, stop)
        }
        out[name] = safeDecode(value)
      }
    }
    pos = end + 1
  }
  return out
}

/**
 * Serialize a `Set-Cookie` header value. Pure — applies **no** security defaults (the caller, e.g.
 * `c.set.cookie`, layers `HttpOnly`/`Secure`/`SameSite` on). Throws on an invalid cookie name, a
 * header-injecting `Path`/`Domain`, a non-integer `maxAge`, or an oversized result — a serialization
 * bug should fail loudly, not silently emit a cookie the browser drops.
 */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  if (!COOKIE_NAME.test(name)) {
    throw new Error(
      `[nifra] invalid cookie name ${JSON.stringify(name)}: must be an RFC 6265 token`,
    )
  }
  let str = `${name}=${encodeURIComponent(value)}`
  if (options.maxAge !== undefined) {
    if (!Number.isInteger(options.maxAge)) {
      throw new Error("[nifra] cookie maxAge must be an integer number of seconds")
    }
    str += `; Max-Age=${options.maxAge}`
  }
  if (options.domain !== undefined) {
    if (hasIllegalChar(options.domain))
      throw new Error("[nifra] cookie Domain contains an illegal character")
    str += `; Domain=${options.domain}`
  }
  if (options.path !== undefined) {
    if (hasIllegalChar(options.path))
      throw new Error("[nifra] cookie Path contains an illegal character")
    str += `; Path=${options.path}`
  }
  if (options.expires !== undefined) str += `; Expires=${options.expires.toUTCString()}`
  if (options.httpOnly === true) str += "; HttpOnly"
  if (options.secure === true) str += "; Secure"
  if (options.partitioned === true) str += "; Partitioned"
  if (options.sameSite !== undefined) {
    str += `; SameSite=${options.sameSite === "strict" ? "Strict" : options.sameSite === "none" ? "None" : "Lax"}`
  }
  if (str.length > MAX_COOKIE_BYTES) {
    throw new Error(
      `[nifra] cookie ${JSON.stringify(name)} is ${str.length}B, over the ${MAX_COOKIE_BYTES}B limit`,
    )
  }
  return str
}

const TEXT = new TextEncoder()

const importHmacKey = (secret: string): Promise<CryptoKey> => {
  // Reject a weak secret at the choke point both signing and verification flow through (so signed
  // cookies AND @nifrajs/auth sessions, which delegate here via signValue/unsignValue, are covered).
  requireSecretBytes(secret, "signed-cookie")
  return crypto.subtle.importKey(
    "raw",
    TEXT.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  )
}

const toBase64Url = (buf: ArrayBuffer): string => {
  let bin = ""
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

// Returns `Uint8Array<ArrayBuffer>` (not the generic `Uint8Array<ArrayBufferLike>`) so it satisfies
// WebCrypto's `BufferSource` parameter under TS 5.7+'s typed-array generics.
const fromBase64Url = (s: string): Uint8Array<ArrayBuffer> | null => {
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytes
  } catch {
    return null // not valid base64 — treat as a bad signature
  }
}

/** Append an HMAC-SHA256 signature to a value → `value.signature` (base64url). For signed cookies. */
export async function signValue(value: string, secret: string): Promise<string> {
  const key = await importHmacKey(secret)
  const sig = await crypto.subtle.sign("HMAC", key, TEXT.encode(value))
  return `${value}.${toBase64Url(sig)}`
}

/**
 * Verify a `value.signature` produced by {@link signValue} and return the value, or `null` if the
 * signature is missing, malformed, or doesn't match. Verification is **constant-time**
 * (`crypto.subtle.verify`), so a wrong signature can't be discovered byte-by-byte via timing.
 */
export async function unsignValue(signed: string, secret: string): Promise<string | null> {
  const dot = signed.lastIndexOf(".")
  if (dot < 1) return null // no signature segment (or empty value)
  const value = signed.slice(0, dot)
  const sig = fromBase64Url(signed.slice(dot + 1))
  if (sig === null) return null
  const key = await importHmacKey(secret)
  const ok = await crypto.subtle.verify("HMAC", key, sig, TEXT.encode(value))
  return ok ? value : null
}

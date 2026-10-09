export type MaybePromise<T> = T | Promise<T>

import type { AnyServer, NodeResponseContext } from "@nifrajs/core/server"
import {
  authenticated,
  parseCookies as parseCoreCookies,
  rejected,
  writableResponse,
} from "@nifrajs/core/server"

export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"])

const TEXT = new TextEncoder()

export function jsonError(
  status: number,
  error: string,
  headers?: Record<string, string>,
): Response {
  return Response.json(
    { ok: false, error },
    headers === undefined ? { status } : { status, headers },
  )
}

let guardInstances = 0

/**
 * A guard's plugin name, unique to each instance. `use()` skips a name it already applied, so one
 * shared name would silently drop a second, stricter guard (another `bearer()` before admin routes,
 * a tighter `rateLimit()` inside a `group()`). The same instance applied twice still dedupes.
 */
export function guardName(base: string): string {
  guardInstances += 1
  return `${base}#${guardInstances}`
}

/** One request header by name, or `null`: what a credential extractor reads. */
export type HeaderGet = (name: string) => string | null

/**
 * Install a credential guard. Required, it is an `authenticate()` stage, so a request without a
 * principal is refused before its body or query is read or validated, and before any `derive` or
 * `beforeHandle`. Optional never refuses, so it stays a `beforeHandle` that records a principal when
 * the request carries one.
 */
export function installAuthGuard<P>(
  app: AnyServer,
  id: string,
  optional: boolean,
  store: WeakMap<Request, P>,
  verify: (header: HeaderGet) => MaybePromise<P | null | undefined>,
  refuse: () => Response,
): AnyServer {
  if (optional) {
    return app.beforeHandle(async (c: { readonly req: Request }) => {
      const principal = await verify((name) => c.req.headers.get(name))
      if (principal !== null && principal !== undefined) store.set(c.req, principal)
      return undefined
    })
  }
  return app.authenticate({
    id,
    mode: "async",
    run: async (input) => {
      const principal = await verify((name) => input.headers.get(name))
      if (principal === null || principal === undefined) {
        return rejected("unauthenticated", refuse())
      }
      store.set(input.request, principal)
      return authenticated(principal)
    },
  })
}

/** Shared with core so auth/CSRF middleware gets the allocation-light cookie scanner too. */
export const parseCookies = parseCoreCookies

/**
 * The credential of an `Authorization: Bearer <token>` header, or `null`. The auth-scheme is
 * case-insensitive (RFC 9110 section 11.1), so `bearer x` and `BEARER x` carry a token too.
 */
export function bearerToken(header: string | null | undefined): string | null {
  if (header == null || header.length < 7 || header.slice(0, 7).toLowerCase() !== "bearer ") {
    return null
  }
  return header.slice(7).trim() || null
}

export function quotedHeaderValue(value: string): string {
  let out = ""
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) continue
    const ch = value[i] ?? ""
    out += ch === "\\" || ch === '"' ? `\\${ch}` : ch
  }
  return out
}

export function utf8Bytes(value: string): Uint8Array<ArrayBuffer> {
  return TEXT.encode(value)
}

export function secretBytes(secret: string | Uint8Array, label: string): Uint8Array<ArrayBuffer> {
  const bytes = typeof secret === "string" ? utf8Bytes(secret) : new Uint8Array(secret)
  if (bytes.byteLength < 32) {
    throw new Error(`${label}: secret must be at least 32 bytes`)
  }
  return bytes as Uint8Array<ArrayBuffer>
}

export async function sha256(input: string | Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = typeof input === "string" ? utf8Bytes(input) : new Uint8Array(input)
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)) as Uint8Array<ArrayBuffer>
}

export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  let diff = 0
  for (let i = 0; i < a.byteLength; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

export async function timingSafeEqualString(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([sha256(a), sha256(b)])
  return timingSafeEqualBytes(left, right)
}

export function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let bin = ""
  for (const b of view) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

/**
 * Decode unpadded base64url, rejecting non-canonical spellings. `atob` ignores the unused low bits of
 * a final 2- or 3-character group, so without this check a JWT or CSRF signature has several textual
 * forms that verify identically - the same rule core applies to signed cookies.
 */
export function base64UrlDecode(input: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(input) || input.length % 4 === 1) return null
  const remainder = input.length % 4
  if (remainder !== 0) {
    const last = BASE64URL_ALPHABET.indexOf(input[input.length - 1]!)
    if ((remainder === 2 && (last & 0x0f) !== 0) || (remainder === 3 && (last & 0x03) !== 0)) {
      return null
    }
  }
  const padded = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(input.length / 4) * 4, "=")
  try {
    const bin = atob(padded)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytes as Uint8Array<ArrayBuffer>
  } catch {
    return null
  }
}

export function decodeBase64(input: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(input)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytes as Uint8Array<ArrayBuffer>
  } catch {
    return null
  }
}

export async function importHmacKey(
  secret: string | Uint8Array,
  hash = "SHA-256",
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    secretBytes(secret, "hmac"),
    { name: "HMAC", hash },
    false,
    ["sign", "verify"],
  )
}

export async function hmacSha256(input: string, secret: string | Uint8Array): Promise<string> {
  const key = await importHmacKey(secret, "SHA-256")
  const sig = await crypto.subtle.sign("HMAC", key, utf8Bytes(input))
  return base64UrlEncode(sig)
}

export async function verifyHmacSha256(
  input: string,
  signature: string,
  secret: string | Uint8Array,
): Promise<boolean> {
  const sig = base64UrlDecode(signature)
  if (sig === null) return false
  const key = await importHmacKey(secret, "SHA-256")
  return crypto.subtle.verify("HMAC", key, sig, utf8Bytes(input))
}

/**
 * Apply header mutations to the copy of `res` this request owns (`writableResponse`): a body-bearing
 * response with mutable headers is written in place, a body-less one (sendable any number of times,
 * so possibly shared) or one with guarded headers is copied first. Pass the `request` being answered
 * so a copy already made for it is reused.
 */
export function withHeaders(
  res: Response,
  apply: (headers: Headers) => void,
  request?: Request,
): Response {
  const target = writableResponse(res, request)
  apply(target.headers)
  return target
}

/**
 * Set one Node-direct response header without constructing a Web Response. `name` must already be
 * the lowercase wire spelling - the record documents that contract, and it is what `Headers` emits
 * on every other runtime.
 *
 * The outcome's own record is used AS-IS. Re-homing it into a null-prototype object - the obvious
 * way to make `__proto__` inert - demotes it to V8's dictionary mode for the rest of the request,
 * and everything downstream then pays dictionary lookups on the response hot path: the direct
 * writer's key walk, and Node's own `_storeHeader` walk over every name. Values here are strings and
 * string arrays, so assigning one through the inherited `__proto__` setter is a spec-level no-op
 * rather than pollution; the single name that setter would swallow is defined as an own data
 * property instead. Same trade core's portable header view makes over the same record.
 */
export function setNodeHeader(
  res: NodeResponseContext,
  name: string,
  value: string | readonly string[],
): void {
  res.headers ??= {}
  const headers = res.headers
  if (name === "__proto__") {
    Object.defineProperty(headers, name, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    })
    return
  }
  headers[name] = value
}

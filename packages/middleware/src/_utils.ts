export type MaybePromise<T> = T | Promise<T>

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

export function parseCookies(header: string | null | undefined): Record<string, string> {
  // Null-prototype: an untrusted cookie name (`constructor`/`__proto__`/…) is an inert own key,
  // never a prototype-member shadow. Mirrors core's parseCookies + the query/form parsers.
  const out: Record<string, string> = Object.create(null)
  if (!header) return out
  for (const part of header.split(";")) {
    const eq = part.indexOf("=")
    if (eq < 1) continue
    const name = part.slice(0, eq).trim()
    if (name === "") continue
    let value = part.slice(eq + 1).trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1)
    }
    try {
      out[name] = decodeURIComponent(value)
    } catch {
      out[name] = value
    }
  }
  return out
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

export function base64UrlDecode(input: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(input) || input.length % 4 === 1) return null
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
 * Apply header mutations to a response, in place when possible. Framework-built responses
 * (`new Response`, `Response.json`) have mutable headers across every runtime — so the common path
 * mutates `res` directly and returns it, allocating nothing. Only an *immutable*-headers response
 * (`Response.redirect()`/`Response.error()`, or a proxied `fetch()` response on Node/Deno/workerd —
 * never on Bun) makes `.set`/`.append` throw; that path clones into a fresh `Headers` + `Response`,
 * exactly the old always-clone behavior. `apply` runs once either way (immutability is all-or-nothing
 * — the first mutation throws before any partial change), so a mutation chain is safe to pass.
 */
export function withHeaders(res: Response, apply: (headers: Headers) => void): Response {
  try {
    apply(res.headers)
    return res
  } catch {
    const headers = new Headers(res.headers)
    apply(headers)
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  }
}

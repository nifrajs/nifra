/**
 * Short-TTL **signed download URLs** — serve an uploaded file back via a tamper-evident, expiring URL
 * (HMAC-SHA256 over the path + query + expiry). WebCrypto only (portable across Bun/Node/Deno/workerd,
 * no `node:crypto`). Verification is constant-time (`crypto.subtle.verify`). Sign a *relative*
 * URL/path; the returned string is relative so it works behind any host. `vexp` / `vsig` are reserved
 * signature fields and are excluded from the payload.
 */

const ENC = new TextEncoder()
const DUMMY_BASE = "http://localhost" // lets us parse a relative path/URL with the WHATWG URL parser

// 256-bit secret floor — mirrors @nifrajs/core's HMAC guard. This package is deliberately
// dependency-free (ships its own crypto), so the constant is inlined rather than imported.
const MIN_SECRET_BYTES = 32

const importKey = (secret: string): Promise<CryptoKey> => {
  if (ENC.encode(secret).length < MIN_SECRET_BYTES) {
    throw new Error(
      `[nifra/uploads] signing secret must be at least ${MIN_SECRET_BYTES} bytes (256-bit). Generate one with: openssl rand -base64 32`,
    )
  }
  return crypto.subtle.importKey(
    "raw",
    ENC.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  )
}

const toBase64Url = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf)
  let s = ""
  for (const byte of bytes) s += String.fromCharCode(byte)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

const fromBase64Url = (value: string): Uint8Array<ArrayBuffer> | null => {
  try {
    const b = atob(value.replace(/-/g, "+").replace(/_/g, "/"))
    const out = new Uint8Array(b.length)
    for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

const SIGNATURE_PARAMS = new Set(["vexp", "vsig"])

function signedQueryPairs(u: URL): ReadonlyArray<readonly [string, string]> {
  const pairs: Array<readonly [string, string]> = []
  for (const [key, value] of u.searchParams) {
    if (!SIGNATURE_PARAMS.has(key)) pairs.push([key, value])
  }
  return pairs
}

function getSingleParam(u: URL, name: string): string | null {
  const values = u.searchParams.getAll(name)
  return values.length === 1 ? (values[0] ?? null) : null
}

// Sign the path + non-signature query pairs + expiry. Query pair order is intentional: a consumer may
// give repeated params first-value semantics, so reordering must not preserve the signature.
const canonical = (u: URL, exp: number): string =>
  `${u.pathname}\n${JSON.stringify(signedQueryPairs(u))}\n${exp}`

export interface SignDownloadUrlOptions {
  /** Seconds until the URL expires. */
  readonly expiresInSeconds: number
  /** Current unix time (seconds); defaults to `Date.now()/1000`. Injectable for tests. */
  readonly now?: number
}

/** Sign a relative URL/path → a relative URL with `?vexp=&vsig=` appended. */
export async function signDownloadUrl(
  url: string,
  secret: string,
  options: SignDownloadUrlOptions,
): Promise<string> {
  const u = new URL(url, DUMMY_BASE)
  u.searchParams.delete("vexp")
  u.searchParams.delete("vsig")
  const now = options.now ?? Math.floor(Date.now() / 1000)
  const exp = now + options.expiresInSeconds
  const sig = await crypto.subtle.sign(
    "HMAC",
    await importKey(secret),
    ENC.encode(canonical(u, exp)),
  )
  u.searchParams.set("vexp", String(exp))
  u.searchParams.set("vsig", toBase64Url(sig))
  return u.pathname + u.search
}

/** Verify a URL produced by {@link signDownloadUrl}: signature (constant-time) + not expired. */
export async function verifyDownloadUrl(
  url: string,
  secret: string,
  options?: { readonly now?: number },
): Promise<boolean> {
  const u = new URL(url, DUMMY_BASE)
  const exp = getSingleParam(u, "vexp")
  const sig = getSingleParam(u, "vsig")
  if (exp === null || sig === null || !/^\d+$/.test(exp)) return false
  const now = options?.now ?? Math.floor(Date.now() / 1000)
  if (Number(exp) < now) return false
  const sigBytes = fromBase64Url(sig)
  if (sigBytes === null) return false
  return crypto.subtle.verify(
    "HMAC",
    await importKey(secret),
    sigBytes,
    ENC.encode(canonical(u, Number(exp))),
  )
}

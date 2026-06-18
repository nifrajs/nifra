/**
 * Signed image URLs — a portable, **synchronous** HMAC-SHA256 so the (sync) `selfHostedLoader` can sign
 * URLs inline, on any runtime including the edge (WebCrypto's HMAC is async-only; `node:crypto` isn't on
 * Workers). A signed URL lets `createImageHandler` reject any `(src, w, q)` it didn't authorize —
 * shutting down resize-bombing (width/quality enumeration) and locking the endpoint to your own images.
 *
 * Pure JS, dependency-free, KAT-tested against the SHA-256 / RFC 4231 HMAC vectors. The secret never
 * leaves the bytes you pass in.
 */

// FIPS 180-4 SHA-256 round constants.
// biome-ignore format: the 64 constants read best as an 8×8 grid.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const rotr = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0

/** SHA-256 of a byte array → 32-byte digest. */
function sha256(data: Uint8Array): Uint8Array {
  const len = data.length
  const bitLen = len * 8
  // Pad: 0x80, then zeros, so the total is ≡ 56 (mod 64), then the 64-bit big-endian bit length.
  const padded = (56 - ((len + 1) % 64) + 64) % 64
  const total = len + 1 + padded + 8
  const msg = new Uint8Array(total)
  msg.set(data)
  msg[len] = 0x80
  const dv = new DataView(msg.buffer)
  dv.setUint32(total - 8, Math.floor(bitLen / 0x1_0000_0000)) // high word (0 for our sizes)
  dv.setUint32(total - 4, bitLen >>> 0)

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const w = new Uint32Array(64)
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] as number
      const b = w[i - 2] as number
      const s0 = (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) >>> 0
      const s1 = (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10)) >>> 0
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0
    }
    let a = h[0] as number
    let b = h[1] as number
    let c = h[2] as number
    let d = h[3] as number
    let e = h[4] as number
    let f = h[5] as number
    let g = h[6] as number
    let hh = h[7] as number
    for (let i = 0; i < 64; i++) {
      const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0
      const ch = ((e & f) ^ (~e & g)) >>> 0
      const t1 = (hh + s1 + ch + (K[i] as number) + (w[i] as number)) >>> 0
      const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0
      const t2 = (s0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h[0] = ((h[0] as number) + a) >>> 0
    h[1] = ((h[1] as number) + b) >>> 0
    h[2] = ((h[2] as number) + c) >>> 0
    h[3] = ((h[3] as number) + d) >>> 0
    h[4] = ((h[4] as number) + e) >>> 0
    h[5] = ((h[5] as number) + f) >>> 0
    h[6] = ((h[6] as number) + g) >>> 0
    h[7] = ((h[7] as number) + hh) >>> 0
  }
  const out = new Uint8Array(32)
  const odv = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, h[i] as number)
  return out
}

const BLOCK = 64

/** HMAC-SHA256 (RFC 2104) of `message` under `key` → 32-byte tag. */
function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  let k = key.length > BLOCK ? sha256(key) : key
  if (k.length < BLOCK) {
    const padded = new Uint8Array(BLOCK)
    padded.set(k)
    k = padded
  }
  const inner = new Uint8Array(BLOCK + message.length)
  const outer = new Uint8Array(BLOCK + 32)
  for (let i = 0; i < BLOCK; i++) {
    inner[i] = (k[i] as number) ^ 0x36
    outer[i] = (k[i] as number) ^ 0x5c
  }
  inner.set(message, BLOCK)
  outer.set(sha256(inner), BLOCK)
  return sha256(outer)
}

const encoder = new TextEncoder()

const hex = (bytes: Uint8Array): string => {
  let s = ""
  for (const b of bytes) s += b.toString(16).padStart(2, "0")
  return s
}

/** HMAC-SHA256 of `message` under `key` (both UTF-8 strings) → lowercase hex. The primitive behind URL
 * signing; exported for tests (RFC 4231 vectors) and advanced use. */
export function hmacSha256Hex(key: string, message: string): string {
  return hex(hmacSha256(encoder.encode(key), encoder.encode(message)))
}

/** base64url (RFC 4648 §5, unpadded) of a byte array — URL-safe, compact (43 chars for a 32-byte tag). */
function base64url(bytes: Uint8Array): string {
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Constant-time string compare — length-independent of where the first difference is. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** The fields a signature covers. Newline-delimited into a canonical string (newlines can't appear in
 * a URL query value, so the join is unambiguous). `q`/`exp` are normalized to `""` when absent so the
 * signer and verifier agree. */
export interface ImageSignatureParts {
  readonly src: string
  readonly w: string
  // `| undefined` (not just `?`) so callers can pass a computed `string | undefined` under
  // `exactOptionalPropertyTypes` (the value is normalized to `""` in the canonical string).
  readonly q?: string | undefined
  readonly exp?: string | undefined
}

const canonical = (p: ImageSignatureParts): string =>
  `${p.src}\n${p.w}\n${p.q ?? ""}\n${p.exp ?? ""}`

// 256-bit secret floor — mirrors @nifrajs/core's HMAC guard. This package is dependency-free (ships
// its own SHA-256), so the constant is inlined rather than imported.
const MIN_SECRET_BYTES = 32

/** Compute the URL signature (base64url HMAC-SHA256) for a set of image params. Guards (and so does
 * the verify path, which calls through here) against a sub-256-bit secret. */
export function signImageParams(secret: string, parts: ImageSignatureParts): string {
  if (encoder.encode(secret).length < MIN_SECRET_BYTES) {
    throw new Error(
      `[nifra/image] signing secret must be at least ${MIN_SECRET_BYTES} bytes (256-bit). Generate one with: openssl rand -base64 32`,
    )
  }
  return base64url(hmacSha256(encoder.encode(secret), encoder.encode(canonical(parts))))
}

/**
 * Verify a request's signature against `secret` (constant-time) and, when an `exp` is present, that it
 * hasn't passed `nowSeconds`. Returns `false` for a missing/forged/expired signature.
 */
export function verifyImageParams(
  secret: string,
  parts: ImageSignatureParts,
  signature: string,
  nowSeconds: number,
): boolean {
  if (parts.exp !== undefined) {
    if (!/^\d+$/.test(parts.exp)) return false
    if (Number(parts.exp) < nowSeconds) return false // expired
  }
  return safeEqual(signImageParams(secret, parts), signature)
}

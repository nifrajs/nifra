export type Fingerprint = (body: string | Uint8Array) => string

/** 32-bit FNV-1a over UTF-8 bytes, as hex; strings are encoded inline without a buffer copy. */
export function fnv1a(body: string | Uint8Array): string {
  let h = 0x811c9dc5
  if (typeof body === "string") {
    for (let i = 0; i < body.length; i++) {
      let code = body.charCodeAt(i)
      if (code < 0x80) {
        h = Math.imul(h ^ code, 0x01000193)
        continue
      }
      if (code < 0x800) {
        h = Math.imul(h ^ (0xc0 | (code >>> 6)), 0x01000193)
        h = Math.imul(h ^ (0x80 | (code & 0x3f)), 0x01000193)
        continue
      }
      if (code >= 0xd800 && code <= 0xdfff) {
        const low = body.charCodeAt(i + 1)
        if (code <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + low - 0xdc00
          i++
        } else {
          // Match TextEncoder/Response: an unpaired surrogate becomes U+FFFD.
          code = 0xfffd
        }
      }
      if (code < 0x10000) {
        h = Math.imul(h ^ (0xe0 | (code >>> 12)), 0x01000193)
      } else {
        h = Math.imul(h ^ (0xf0 | (code >>> 18)), 0x01000193)
        h = Math.imul(h ^ (0x80 | ((code >>> 12) & 0x3f)), 0x01000193)
      }
      h = Math.imul(h ^ (0x80 | ((code >>> 6) & 0x3f)), 0x01000193)
      h = Math.imul(h ^ (0x80 | (code & 0x3f)), 0x01000193)
    }
  } else {
    for (let i = 0; i < body.length; i++) {
      h ^= body[i]!
      h = Math.imul(h, 0x01000193)
    }
  }
  return (h >>> 0).toString(16)
}

/** The globals {@link fingerprintFor} chooses from. */
export interface FingerprintRuntime {
  readonly Bun?: unknown
  readonly Deno?: unknown
  readonly process?: unknown
}

const member = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined

/**
 * The cheapest content fingerprint `runtime` has, for a weak validator - not crypto. Bun.hash and
 * node:crypto's one-shot SHA-1 take a string without a copy: on a 64 KB body they run 35x and 10x
 * faster than encoding it for FNV-1a. Deno's SHA-1 is slower than FNV-1a, the fallback everywhere.
 */
export function fingerprintFor(runtime: FingerprintRuntime): Fingerprint {
  try {
    const bun = runtime.Bun
    const bunHash = member(bun, "hash")
    if (typeof bunHash === "function") return (body) => String(bunHash.call(bun, body))
    if (runtime.Deno !== undefined) return fnv1a
    const load = member(runtime.process, "getBuiltinModule")
    const crypto: unknown =
      typeof load === "function" ? load.call(runtime.process, "node:crypto") : undefined
    const hash = member(crypto, "hash")
    if (typeof hash === "function") {
      return (body) => String(hash.call(crypto, "sha1", body, "base64url"))
    }
  } catch {
    // A runtime that refuses the lookup keeps the portable fingerprint.
  }
  return fnv1a
}

let current: Fingerprint | undefined

/** {@link fingerprintFor} this runtime, chosen once. */
export function weakFingerprint(): Fingerprint {
  current ??= fingerprintFor(globalThis)
  return current
}

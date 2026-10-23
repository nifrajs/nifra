/**
 * Signatures on entries kept in a store other processes share (Workers KV, Redis). Whoever can write
 * such a store could hand every visitor a page this app never built, so each entry carries an
 * HMAC-SHA-256 under the app's secret, and an entry that fails the check reads as a miss.
 */
import type * as NodeCrypto from "node:crypto"
import { timingSafeEqual } from "./timing-safe-equal.ts"

const TEXT = new TextEncoder()
const MAC_HEX = /^[0-9a-f]{64}$/
// Code units of signed text a signer remembers as proven. A hot page then costs a comparison per
// hit, not a hash: about 1.5 ns a byte to hash against a fraction of that to compare.
const MAX_PROVEN_CHARS = 2 * 1024 * 1024
const MAX_SIGNERS = 4

/** Below this, a secret is too short to sign with. */
export const MIN_STORE_SECRET_LENGTH = 32

export const isStoreSecret = (value: unknown): value is string =>
  typeof value === "string" && value.length >= MIN_STORE_SECRET_LENGTH

/**
 * Signs a list of strings. Each part is hashed behind its length, so no two lists hash the same
 * bytes, whatever the parts hold.
 */
export interface StoreSigner {
  /** The parts' MAC, as lowercase hex. */
  sign(parts: readonly string[]): Promise<string>
  /** Whether `mac` is the parts' MAC under this secret. Anything but 64 lowercase hex digits is not. */
  verify(parts: readonly string[], mac: unknown): Promise<boolean>
}

type CreateHmac = typeof NodeCrypto.createHmac

interface Hasher {
  sign(parts: readonly string[]): Promise<string>
  /** `mac` is already 64 lowercase hex digits. */
  matches(parts: readonly string[], mac: string): Promise<boolean>
}

// Looked up, never imported: a Worker without nodejs_compat cannot load node:crypto. Where it exists
// it is the cheaper path: Web Crypto answers on another thread, about 20 us a call on Bun, Node and
// Deno, more than hashing a 16 KB page.
function nodeCreateHmac(): CreateHmac | undefined {
  const createHmac = globalThis.process?.getBuiltinModule?.("node:crypto")?.createHmac
  return typeof createHmac === "function" ? createHmac : undefined
}

const sameParts = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((part, at) => part === b[at])

const lengthOf = (parts: readonly string[]): number =>
  parts.reduce((sum, part) => sum + part.length, 0)

// One signer per secret for the process, so a handler built per request (a Worker reads its bindings
// in `fetch`) still finds the pages earlier requests proved.
const signers = new Map<string, StoreSigner>()

export function storeSigner(secret: string): StoreSigner {
  const existing = signers.get(secret)
  if (existing !== undefined) return existing
  const signer = provingSigner(hasher(secret))
  for (const oldest of signers.keys()) {
    if (signers.size < MAX_SIGNERS) break
    signers.delete(oldest)
  }
  signers.set(secret, signer)
  return signer
}

function provingSigner(hashing: Hasher): StoreSigner {
  // MAC to the parts this signer signed or verified, oldest first.
  const proven = new Map<string, readonly string[]>()
  let provenChars = 0
  const remember = (mac: string, parts: readonly string[]): void => {
    const length = lengthOf(parts)
    if (length > MAX_PROVEN_CHARS / 8) return
    const had = proven.get(mac)
    if (had !== undefined) {
      proven.delete(mac)
      provenChars -= lengthOf(had)
    }
    proven.set(mac, parts)
    provenChars += length
    for (const [oldest, kept] of proven) {
      if (provenChars <= MAX_PROVEN_CHARS) break
      proven.delete(oldest)
      provenChars -= lengthOf(kept)
    }
  }
  return {
    async sign(parts) {
      const mac = await hashing.sign(parts)
      remember(mac, parts)
      return mac
    },
    async verify(parts, mac) {
      if (typeof mac !== "string" || !MAC_HEX.test(mac)) return false
      const known = proven.get(mac)
      if (known !== undefined && sameParts(known, parts)) return true
      if (!(await hashing.matches(parts, mac))) return false
      remember(mac, parts)
      return true
    },
  }
}

function hasher(secret: string): Hasher {
  const createHmac = nodeCreateHmac()
  if (createHmac !== undefined) {
    const hex = (parts: readonly string[]): string => {
      const hmac = createHmac("sha256", secret)
      for (const part of parts) hmac.update(`${part.length}:`).update(part)
      return hmac.digest("hex")
    }
    return {
      sign: async (parts) => hex(parts),
      matches: async (parts, mac) => timingSafeEqual(hex(parts), mac),
    }
  }
  let signingKey: Promise<CryptoKey> | undefined
  const key = (): Promise<CryptoKey> => {
    signingKey ??= crypto.subtle.importKey(
      "raw",
      TEXT.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    )
    return signingKey
  }
  const bytes = (parts: readonly string[]): Uint8Array<ArrayBuffer> =>
    TEXT.encode(parts.map((part) => `${part.length}:${part}`).join(""))
  return {
    async sign(parts) {
      const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await key(), bytes(parts)))
      let hex = ""
      for (const byte of mac) hex += byte.toString(16).padStart(2, "0")
      return hex
    },
    async matches(parts, mac) {
      const expected = new Uint8Array(mac.length / 2)
      for (let at = 0; at < expected.length; at++) {
        expected[at] = Number.parseInt(mac.slice(at * 2, at * 2 + 2), 16)
      }
      return crypto.subtle.verify("HMAC", await key(), expected, bytes(parts))
    },
  }
}

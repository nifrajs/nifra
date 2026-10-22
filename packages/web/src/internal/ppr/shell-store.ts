/**
 * Shells in a store shared by processes (Workers KV, Redis): a second level behind the in-process
 * map. Whoever can write the store could put script into every visitor's shell, so each entry is
 * signed with the app's secret over its key, deployment and contents; anything that fails the check
 * is a miss.
 */
import type { CachedResponse, CacheStore } from "../../isr.ts"

/** A shell as the shared store holds it: everything a process needs to serve it. */
export interface StoredShell {
  readonly routeId: string
  /** The document up to the request script's end, with room for the token at `tokenAt` (bytes). */
  readonly document: string
  readonly tokenAt: number
  readonly data: unknown
  readonly builtAt: number
  readonly tags: readonly string[]
  /** The shell loader's `notFound()`. */
  readonly notFound: boolean
}

export interface SharedShellStore {
  get(key: string): Promise<StoredShell | undefined>
  /** Skipped by the store when the key or one of its tags was purged after `fence`. */
  set(
    key: string,
    shell: StoredShell,
    keepSeconds: number,
    fence: number | undefined,
  ): Promise<void>
  fence(): Promise<number | undefined>
  /** Absent when the store cannot drop entries by tag. */
  readonly invalidateTag: ((tag: string) => Promise<void>) | undefined
}

const MAC_HEADER = "x-nifra-ppr-mac"
/** Below this, a secret is too short to sign with. */
export const MIN_STORE_SECRET_LENGTH = 32

const hex = (bytes: ArrayBuffer): string => {
  let text = ""
  for (const byte of new Uint8Array(bytes)) text += byte.toString(16).padStart(2, "0")
  return text
}

const fromHex = (text: string): Uint8Array | undefined => {
  if (text.length % 2 !== 0 || !/^[0-9a-f]*$/.test(text)) return undefined
  const bytes = new Uint8Array(text.length / 2)
  for (let at = 0; at < bytes.length; at++)
    bytes[at] = Number.parseInt(text.slice(at * 2, at * 2 + 2), 16)
  return bytes
}

const isStrings = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

const field = (value: object, name: string): unknown => Reflect.get(value, name)

const isStoredShell = (value: unknown): value is StoredShell => {
  if (typeof value !== "object" || value === null) return false
  const tokenAt = field(value, "tokenAt")
  return (
    typeof field(value, "routeId") === "string" &&
    typeof field(value, "document") === "string" &&
    typeof tokenAt === "number" &&
    Number.isSafeInteger(tokenAt) &&
    typeof field(value, "builtAt") === "number" &&
    isStrings(field(value, "tags")) &&
    typeof field(value, "notFound") === "boolean"
  )
}

export function sharedShellStore(
  store: CacheStore,
  secret: string,
  deployment: string,
): SharedShellStore {
  const encoder = new TextEncoder()
  let signingKey: Promise<CryptoKey> | undefined
  const key = (): Promise<CryptoKey> => {
    signingKey ??= crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    )
    return signingKey
  }
  const invalidateTag = store.invalidateTag
  return {
    async get(entryKey) {
      const cached = await store.get(entryKey)
      if (cached === undefined) return undefined
      const mac = fromHex(cached.headers[MAC_HEADER] ?? "")
      if (mac === undefined) return undefined
      const verified = await crypto.subtle.verify(
        "HMAC",
        await key(),
        mac,
        encoder.encode(cached.body),
      )
      if (!verified) {
        console.error("[nifra/web] ppr: a shared shell entry failed its signature check", {
          key: entryKey,
        })
        return undefined
      }
      let payload: unknown
      try {
        payload = JSON.parse(cached.body)
      } catch {
        return undefined
      }
      if (typeof payload !== "object" || payload === null) return undefined
      // The key and deployment are signed too, so an entry copied to another key or kept from
      // another deployment never verifies as this one.
      if (
        field(payload, "v") !== 1 ||
        field(payload, "key") !== entryKey ||
        field(payload, "deployment") !== deployment
      ) {
        return undefined
      }
      const shell = field(payload, "shell")
      return isStoredShell(shell) ? shell : undefined
    },
    async set(entryKey, shell, keepSeconds, fence) {
      const body = JSON.stringify({ v: 1, key: entryKey, deployment, shell })
      const mac = hex(await crypto.subtle.sign("HMAC", await key(), encoder.encode(body)))
      const value: CachedResponse = {
        body,
        status: shell.notFound ? 404 : 200,
        headers: { [MAC_HEADER]: mac },
        storedAt: shell.builtAt,
        revalidate: keepSeconds * 1000,
        tags: shell.tags,
        fence,
      }
      await store.set(entryKey, value)
    },
    async fence() {
      return store.fence === undefined ? undefined : await store.fence()
    },
    invalidateTag:
      invalidateTag === undefined ? undefined : (tag) => invalidateTag.call(store, tag),
  }
}

/**
 * A short, stable digest of `text` (FNV-1a, 64 bits as hex). It names a deployment inside cache keys;
 * nothing an attacker controls goes into it, so it needs no collision resistance.
 */
export function digest(text: string): string {
  let high = 0xcbf29ce4
  let low = 0x84222325
  for (let at = 0; at < text.length; at++) {
    low = (low ^ text.charCodeAt(at)) >>> 0
    // Multiply the 64-bit value by the FNV prime 0x100000001b3 in two 32-bit halves.
    const lowProduct = low * 0x1b3
    const carry = Math.floor(lowProduct / 0x100000000)
    high = (high * 0x1b3 + low * 0x100 + carry) >>> 0
    low = lowProduct >>> 0
  }
  return high.toString(16).padStart(8, "0") + low.toString(16).padStart(8, "0")
}

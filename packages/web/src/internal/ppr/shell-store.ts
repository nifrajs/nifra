/**
 * Shells and shared hole frames in a store shared by processes (Workers KV, Redis): a second level
 * behind the in-process map. Whoever can write the store could put script into every visitor's page,
 * so each entry is signed with the app's secret over its key, deployment and contents; anything that
 * fails the check is a miss.
 */
import type { CachedResponse, CacheStore } from "../../isr.ts"
import { DATE_TAG } from "../revive-dates.ts"
import { storeSigner } from "../store-signature.ts"
import { wireDate } from "../wire-date.ts"

/** A shell or a shared hole's frame as the shared store holds it: everything a process needs to
 * serve it. */
export interface StoredEntry {
  readonly routeId: string
  /** A shell's document up to the request script's end, with room for the token at `tokenAt`
   * (bytes); or a hole's frame. */
  readonly html: string
  readonly tokenAt: number
  readonly data: unknown
  readonly builtAt: number
  readonly tags: readonly string[]
  /** A shared hole's live keys. */
  readonly keys?: readonly string[]
  /** The shell loader's `notFound()`. */
  readonly notFound: boolean
}

export interface SharedShellStore {
  get(key: string): Promise<StoredEntry | undefined>
  /** Skipped by the store when the key or one of its tags was purged after `fence`. */
  set(
    key: string,
    entry: StoredEntry,
    keepSeconds: number,
    fence: number | undefined,
  ): Promise<void>
  fence(): Promise<number | undefined>
  /** Absent when the store cannot drop entries by tag. */
  readonly invalidateTag: ((tag: string) => Promise<void>) | undefined
}

const MAC_HEADER = "x-nifra-ppr-mac"

const isStrings = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

const field = (value: object, name: string): unknown => Reflect.get(value, name)

const isStoredEntry = (value: unknown): value is StoredEntry => {
  if (typeof value !== "object" || value === null) return false
  const tokenAt = field(value, "tokenAt")
  const keys = field(value, "keys")
  return (
    typeof field(value, "routeId") === "string" &&
    typeof field(value, "html") === "string" &&
    typeof tokenAt === "number" &&
    Number.isSafeInteger(tokenAt) &&
    typeof field(value, "builtAt") === "number" &&
    isStrings(field(value, "tags")) &&
    (keys === undefined || isStrings(keys)) &&
    typeof field(value, "notFound") === "boolean"
  )
}

/** Read and write signed deployment-scoped PPR entries, treating malformed data as cache misses. */
export function sharedShellStore(
  store: CacheStore,
  secret: string,
  deployment: string,
): SharedShellStore {
  const signer = storeSigner(secret)
  const invalidateTag = store.invalidateTag
  return {
    async get(entryKey) {
      const cached = await store.get(entryKey)
      if (cached === undefined) return undefined
      // One part, where ISR signs two: under a shared secret neither entry verifies as the other.
      if (!(await signer.verify([cached.body], cached.headers[MAC_HEADER]))) {
        console.error("[nifra/web] ppr: a shared store entry failed its signature check", {
          key: entryKey,
        })
        return undefined
      }
      let payload: unknown
      try {
        // Match page-data revival, but keep the server's tagged toJSON for subsequent responses.
        // JSON.parse defines own properties (including __proto__) without invoking setters.
        payload = JSON.parse(cached.body, (_key, value: unknown) => {
          if (typeof value !== "object" || value === null) return value
          const tagged: unknown = Reflect.get(value, DATE_TAG)
          if (typeof tagged !== "string" || Object.keys(value).length !== 1) return value
          const time = Date.parse(tagged)
          // An invalid wireDate would throw later from toJSON, outside this cache-miss boundary.
          if (!Number.isFinite(time)) throw new RangeError("invalid cached date tag")
          return wireDate(time)
        })
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
      const entry = field(payload, "entry")
      return isStoredEntry(entry) ? entry : undefined
    },
    async set(entryKey, entry, keepSeconds, fence) {
      const body = JSON.stringify({ v: 1, key: entryKey, deployment, entry })
      const mac = await signer.sign([body])
      const value: CachedResponse = {
        body,
        status: entry.notFound ? 404 : 200,
        headers: { [MAC_HEADER]: mac },
        storedAt: entry.builtAt,
        revalidate: keepSeconds * 1000,
        tags: entry.tags,
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

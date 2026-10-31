/**
 * ISR (Incremental Static Regeneration). A caching layer that sits ABOVE the agnostic SSR
 * handler: it stores a rendered `Response` keyed by URL and serves it with stale-while-revalidate
 * freshness, so dynamic pages get static-like speed and revalidate in the background. Agnostic to the
 * UI framework (it caches bytes), coupled to the runtime only through this pluggable {@link CacheStore}.
 *
 * This module is the store primitive; the SWR wrapper (`withISR`) builds on it next.
 */
import { isAuthenticatedRequest, writableResponse } from "@nifrajs/core/server"
import { readBoundedBytes, TransportCodecError } from "@nifrajs/core/transport-codec"
import { isDraftEnabled } from "./draft.ts"
import {
  type InvalidationReport,
  type InvalidationTargets,
  runInvalidation,
  settleInvalidation,
} from "./internal/invalidation.ts"
import { INVALIDATION, type InvalidationHandoff } from "./internal/invalidation-contract.ts"
import {
  isStoreSecret,
  MIN_STORE_SECRET_LENGTH,
  type StoreSigner,
  storeSigner,
} from "./internal/store-signature.ts"
import { assertTokenSecret, timingSafeEqual } from "./internal/timing-safe-equal.ts"
import { SWAP_HEADER } from "./render-seam.ts"

/** A cached SSR response - the bytes + metadata a {@link CacheStore} persists. */
export interface CachedResponse {
  /** The rendered document (UTF-8 HTML, fully buffered). */
  readonly body: string
  readonly status: number
  /** Response headers to replay (e.g. `content-type`). */
  readonly headers: Readonly<Record<string, string>>
  /** When this entry was stored, via the injected clock (ms epoch). */
  readonly storedAt: number
  /** Freshness window (ms): `now - storedAt >= revalidate` ⇒ stale (serve it, regenerate behind it). */
  readonly revalidate: number
  /** Public, bounded invalidation labels. A tag purge makes matching entries miss immediately. */
  readonly tags?: readonly string[]
  /** The store's {@link CacheStore.fence} as the render behind this entry began. A store that keeps
   * purge order skips the write when this key or one of its tags was purged after it. */
  readonly fence?: number | undefined
}

/**
 * Pluggable ISR cache backend. **Production deploys MUST use a shared/durable store** (Workers KV,
 * Redis, the platform Cache API) so cached pages *and* revalidation hold across instances;
 * {@link MemoryCacheStore} is dev / single-instance only. Implementations are async so a network store
 * (KV/Redis) fits the same interface.
 */
export interface CacheStore {
  /** The cached entry for `key`, or `undefined` on a miss. */
  get(key: string): Promise<CachedResponse | undefined>
  /** Store (or overwrite) the entry for `key`. */
  set(key: string, value: CachedResponse): Promise<void>
  /** Drop `key` (on-demand revalidation / purge). A no-op if absent. */
  delete(key: string): Promise<void>
  /** Drop every cached response carrying `tag`, when the backend supports tag invalidation. */
  readonly invalidateTag?: (tag: string) => Promise<void>
  /**
   * The current point in this store's purge order. `withISR` takes one before each render and hands it
   * back as {@link CachedResponse.fence}, and `set` skips that entry when its key or one of its tags
   * was purged after the point. Without it, a purge that lands while a page renders is undone when the
   * render stores the page it built from data read before the purge. A store whose purges reach other
   * instances late must also check on read, as {@link KVCacheStore} does: `set` there cannot see a
   * purge that has not arrived yet.
   */
  readonly fence?: () => number | Promise<number>
}

const ISR_TAG_PATTERN = /^[A-Za-z][A-Za-z0-9._:/-]{0,127}$/
const MAX_ISR_TAGS = 32
const NO_TAGS: readonly string[] = Object.freeze([])

function normalizeTag(tag: string): string {
  if (typeof tag !== "string" || !ISR_TAG_PATTERN.test(tag)) {
    throw new TypeError("[nifra/web] ISR tag must be a bounded token")
  }
  return tag
}

export function normalizeTags(tags: readonly string[] | undefined): readonly string[] {
  if (tags === undefined) return []
  // Every untagged document passes here; it needs no Set or frozen copy.
  if (Array.isArray(tags) && tags.length === 0) return NO_TAGS
  if (!Array.isArray(tags) || tags.length > MAX_ISR_TAGS) {
    throw new TypeError("[nifra/web] ISR tags must contain at most 32 bounded tokens")
  }
  const unique = new Set<string>()
  for (const tag of tags) unique.add(normalizeTag(tag))
  return Object.freeze([...unique])
}

/** The route tags a response carries on {@link ISR_REVALIDATE_TAGS_HEADER}; malformed means none. */
export function tagsFromHeader(value: string | null): readonly string[] {
  if (value === null || value.trim() === "") return []
  try {
    return normalizeTags(value.split(",").map((tag) => tag.trim()))
  } catch {
    // A malformed response-controlled header must never accidentally create an unpurgeable cache
    // entry. Treat it as untagged; route declarations are validated before they reach this path.
    return []
  }
}

/** Validate and serialize route-declared ISR tags for the internal response header. */
export function serializeISRTags(tags: readonly string[]): string | undefined {
  const normalized = normalizeTags(tags)
  return normalized.length === 0 ? undefined : normalized.join(",")
}

/** What a `revalidateTags` function is given: the URL and route params only, both already public. */
export interface RevalidateTagsInput {
  readonly params: Readonly<Record<string, string>>
  /**
   * The request's URL. On a partially prerendered route and its shared holes, the shell's: the
   * configured origin, the path and the declared variations, never the visitor's Host or other query.
   */
  readonly url: URL
}

/**
 * A route's `revalidateTags`: a fixed list, or one computed per request from its params and URL. The
 * function is declared as a method so a route may annotate its own params (`{ params: { id: string } }`).
 */
export type RevalidateTags =
  | readonly string[]
  | { tags(input: RevalidateTagsInput): readonly string[] }["tags"]

const warnedTagRoutes = new Set<string>()

/**
 * The tags `declared` gives this request. A fixed list is returned as declared (it is validated when
 * the header is written). A function's result keeps its valid, distinct tags, at most 32; anything
 * else is dropped with one warning per route, naming the route but never the tag.
 */
export function routeTags(
  declared: RevalidateTags,
  input: RevalidateTagsInput,
  routeId: string,
): readonly string[] {
  if (typeof declared !== "function") return declared
  const result: unknown = declared(input)
  const listed: readonly unknown[] = Array.isArray(result) ? result : []
  const kept = new Set<string>()
  let dropped = 0
  for (const tag of listed) {
    if (typeof tag === "string" && ISR_TAG_PATTERN.test(tag) && kept.size < MAX_ISR_TAGS) {
      kept.add(tag)
    } else dropped++
  }
  if ((dropped > 0 || !Array.isArray(result)) && !warnedTagRoutes.has(routeId)) {
    warnedTagRoutes.add(routeId)
    console.warn(
      `[nifra/web] NIFRA_CDN_TAG_INVALID: revalidateTags of route "${routeId}" returned ${Array.isArray(result) ? `${dropped} tag(s) that are not a letter followed by up to 127 of A-Z a-z 0-9 . _ : / -, or past the first 32` : "something other than an array"}; those were dropped.`,
    )
  }
  return [...kept]
}

export interface MemoryCacheStoreOptions {
  /** Allow the in-memory store in production. Off by default - per-instance caching means revalidation
   * won't propagate across instances and each instance caches separately. */
  readonly allowInProduction?: boolean
  /** Hard cap on entries; the least-recently-used is evicted past it (default 500). */
  readonly max?: number
}

// Nothing outside this process can write these, so `withISR` keeps their pages unsigned.
const inProcessStores = new WeakSet<CacheStore>()

/**
 * In-process ISR cache. Refuses to run in production unless explicitly allowed (mirrors the
 * rate-limit `MemoryStore` - a per-instance cache is unsafe across instances). Bounded **LRU**: a
 * read or write bumps the entry, so the least-recently-used evicts past `max` (a hot, frequently-read
 * page survives a burst of new pages).
 */
export class MemoryCacheStore implements CacheStore {
  private readonly cache = new Map<
    string,
    { readonly value: CachedResponse; readonly tagEpochs: Readonly<Record<string, string>> }
  >()
  private readonly max: number
  private readonly tagEpoch = new Map<string, string>()
  // Purge order: `fence` reads it; each purge advances it and records where, per key and per tag.
  private order = 0
  private readonly purgedKeys = new Map<string, number>()
  private readonly purgedTags = new Map<string, number>()
  // The newest purge order whose mark was evicted. A render fenced before it may predate that purge.
  private purgeFloor = 0

  constructor(options: MemoryCacheStoreOptions = {}) {
    const isProd = typeof process !== "undefined" && process.env?.NODE_ENV === "production"
    if (options.allowInProduction !== true && isProd) {
      throw new Error(
        "[nifra/web] MemoryCacheStore is per-instance and unsafe in production (each instance caches " +
          "separately, and on-demand revalidation won't propagate). Use a shared store (Workers KV, " +
          "Redis, the Cache API), or pass { allowInProduction: true } for a single-instance deploy.",
      )
    }
    this.max = options.max ?? 500
    if (!Number.isSafeInteger(this.max) || this.max <= 0) {
      throw new RangeError("[nifra/web] MemoryCacheStore max must be a positive safe integer")
    }
    inProcessStores.add(this)
  }

  get(key: string): Promise<CachedResponse | undefined> {
    const row = this.cache.get(key)
    if (row !== undefined) {
      for (const [tag, epoch] of Object.entries(row.tagEpochs)) {
        if ((this.tagEpoch.get(tag) ?? "0") !== epoch) {
          this.cache.delete(key)
          this.pruneTagEpochs()
          return Promise.resolve(undefined)
        }
      }
    }
    const value = row?.value
    // LRU: a read bumps the entry to the tail so the bounded evict drops the LEAST-RECENTLY-USED,
    // not the oldest-written - otherwise a burst of new pages would evict a hot, frequently-read one.
    if (value !== undefined) {
      this.cache.delete(key)
      this.cache.set(
        key,
        row as {
          readonly value: CachedResponse
          readonly tagEpochs: Readonly<Record<string, string>>
        },
      )
    }
    return Promise.resolve(value)
  }

  fence(): number {
    return this.order
  }

  set(key: string, value: CachedResponse): Promise<void> {
    const tags = normalizeTags(value.tags)
    if (value.fence !== undefined && this.purgedAfter(key, tags, value.fence))
      return Promise.resolve()
    const tagEpochs: Record<string, string> = {}
    for (const tag of tags) tagEpochs[tag] = this.tagEpoch.get(tag) ?? "0"
    this.cache.delete(key) // re-insert at the tail so Map order tracks recency (with get) for the LRU evict
    this.cache.set(key, { value: tags.length === 0 ? value : { ...value, tags }, tagEpochs })
    while (this.cache.size > this.max) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
    this.pruneTagEpochs()
    return Promise.resolve()
  }

  delete(key: string): Promise<void> {
    this.cache.delete(key)
    this.markPurged(this.purgedKeys, key)
    this.pruneTagEpochs()
    return Promise.resolve()
  }

  invalidateTag(tag: string): Promise<void> {
    normalizeTag(tag)
    this.tagEpoch.set(tag, crypto.randomUUID())
    this.markPurged(this.purgedTags, tag)
    // This store is bounded and local, so eagerly remove matching rows. It keeps invalidation
    // immediate and lets us discard epoch keys that no retained entry references anymore.
    for (const [key, row] of this.cache) {
      if (Object.hasOwn(row.tagEpochs, tag)) this.cache.delete(key)
    }
    this.pruneTagEpochs()
    return Promise.resolve()
  }

  private purgedAfter(key: string, tags: readonly string[], fence: number): boolean {
    if ((this.purgedKeys.get(key) ?? this.purgeFloor) > fence) return true
    return tags.some((tag) => (this.purgedTags.get(tag) ?? this.purgeFloor) > fence)
  }

  private markPurged(marks: Map<string, number>, name: string): void {
    marks.delete(name)
    marks.set(name, ++this.order)
    // Bounded like the entries: a mark matters only to a render still in flight.
    while (marks.size > this.max) {
      const oldest = marks.entries().next().value
      if (oldest === undefined) break
      marks.delete(oldest[0])
      this.purgeFloor = Math.max(this.purgeFloor, oldest[1])
    }
  }

  private pruneTagEpochs(): void {
    if (this.tagEpoch.size === 0) return
    const used = new Set<string>()
    for (const row of this.cache.values()) {
      for (const tag of Object.keys(row.tagEpochs)) used.add(tag)
    }
    for (const tag of this.tagEpoch.keys()) {
      if (!used.has(tag)) this.tagEpoch.delete(tag)
    }
  }
}

/**
 * Minimal structural shape of a Cloudflare Workers **KV namespace** binding - just the three methods
 * {@link KVCacheStore} uses. Structural (not a dependency on `@cloudflare/workers-types`) so any
 * KV-like binding satisfies it and tests can pass an in-memory double.
 */
export interface KVNamespaceLike {
  /** Read a stored string value, or `null` on a miss (Cloudflare's `KVNamespace.get(key)` default). */
  get(key: string): Promise<string | null>
  /** Write a string value, optionally with a TTL (**seconds**). */
  put(key: string, value: string, options?: { readonly expirationTtl?: number }): Promise<void>
  /** Delete a key (a no-op if absent). */
  delete(key: string): Promise<void>
}

export interface KVCacheStoreOptions {
  /**
   * GC backstop (**seconds**) written as the KV entry's `expirationTtl`, so abandoned entries
   * eventually evict. MUST exceed your longest `revalidate` window - otherwise KV expiry turns a
   * stale-while-revalidate into a *blocking* miss (the entry vanishes instead of being served stale
   * while it regenerates) - and be ≥ 60 (Cloudflare KV's minimum). Omit ⇒ entries persist until
   * overwritten on regeneration or purged via `revalidateEndpoint`.
   */
  readonly expirationTtl?: number
  /**
   * Smallest `expirationTtl` this binding accepts (**seconds**). Defaults to 60, which is Cloudflare
   * KV's floor - the common case, and worth rejecting at construction because Cloudflare fails the
   * `put` at runtime instead, one deploy later.
   *
   * The floor belongs to the *binding*, not to this class. {@link KVNamespaceLike} is structural, so
   * a Redis, Deno KV, Upstash, or in-memory binding satisfies it too, and those accept far shorter
   * TTLs. Pass their real minimum, or `0` for a backend with none.
   */
  readonly minExpirationTtl?: number
}

/**
 * Structural validation of a KV-read value before it's trusted as a {@link CachedResponse}. The store
 * is a trust boundary (version skew across a deploy, corruption, tampering), so a malformed entry is
 * treated as a miss (the page re-renders + overwrites it) rather than served as a broken response.
 */
const isCachedResponse = (value: unknown): value is CachedResponse => {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  // Everything a replay hands to `new Response` must be legal there, or a corrupt record would throw
  // on every hit instead of reading as a miss.
  if (
    typeof v.body !== "string" ||
    typeof v.status !== "number" ||
    !Number.isInteger(v.status) ||
    v.status < 200 ||
    v.status > 599 ||
    typeof v.storedAt !== "number" ||
    !Number.isFinite(v.storedAt) ||
    typeof v.revalidate !== "number" ||
    !Number.isFinite(v.revalidate) ||
    v.revalidate < 0 ||
    typeof v.headers !== "object" ||
    v.headers === null ||
    Array.isArray(v.headers)
  ) {
    return false
  }
  if (v.tags !== undefined) {
    if (!Array.isArray(v.tags)) return false
    try {
      normalizeTags(v.tags as string[])
    } catch {
      return false
    }
  }
  const headers: Record<string, string> = {}
  for (const [name, headerValue] of Object.entries(v.headers)) {
    if (typeof headerValue !== "string") return false
    headers[name] = headerValue
  }
  try {
    new Headers(headers)
  } catch {
    return false
  }
  return true
}

const KV_TAG_EPOCH_PREFIX = "__nifra_isr_tag_v1:"
const KV_PATH_EPOCH_PREFIX = "__nifra_isr_path_v1:"
const KV_PATH_DIGEST_PREFIX = "__nifra_isr_path_v1#"
/** Cloudflare KV's key limit, in UTF-8 bytes. */
const KV_KEY_LIMIT = 512
/** How long (seconds) a path epoch outlives the store's `expirationTtl`. */
const PATH_EPOCH_SLACK = 86_400

/** When a tag or path epoch was written (`<time>:<uuid>`); an epoch from before epochs carried a time
 * is older than any render. */
function kvEpochTime(epoch: string): number {
  const at = epoch.indexOf(":")
  const time = at === -1 ? Number.NaN : Number(epoch.slice(0, at))
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY
}

let lastKvTime = 0
/** Wall-clock ms, strictly increasing per process so a purge orders after a render it follows. Not
 * `timeOrigin + performance.now()`: that clock stops while the host sleeps, so a purge from a process
 * that slept would order before renders other instances began earlier. */
const kvClock = (): number => {
  const now = Date.now()
  lastKvTime = now > lastKvTime ? now : lastKvTime + 0.001
  return lastKvTime
}

type StoredResponse = CachedResponse & {
  readonly __nifraTagEpochs?: Readonly<Record<string, string>>
  /** Absent while the path was never purged. */
  readonly __nifraPathEpoch?: string
}

/**
 * A {@link CacheStore} backed by a **Cloudflare Workers KV** namespace (or any {@link KVNamespaceLike}
 * binding) - the production-grade shared/durable store ISR wants: cached pages and on-demand purges
 * hold *across* worker instances (unlike the per-instance {@link MemoryCacheStore}). Entries serialize
 * to JSON; every read is validated before it's trusted (a malformed/version-skewed entry is treated as
 * a miss). Construct it in your Workers `fetch` from the binding: `new KVCacheStore(env.ISR_CACHE)`,
 * and give `withISR` the `storeSecret` it signs these pages with.
 *
 * Cloudflare is the default, not a requirement: {@link KVNamespaceLike} is three structural methods,
 * so a Redis, Deno KV, or Upstash binding satisfies it (pass `minExpirationTtl` for their TTL floor).
 * A backend that *can* enumerate keys deserves its own {@link CacheStore} rather than this one - the
 * epoch indirection in {@link KVCacheStore.invalidateTag} exists only because KV cannot list by tag.
 */
export class KVCacheStore implements CacheStore {
  private readonly kv: KVNamespaceLike
  private readonly putOptions: { readonly expirationTtl?: number } | undefined
  private readonly pathEpochOptions: { readonly expirationTtl?: number } | undefined

  constructor(kv: KVNamespaceLike, options: KVCacheStoreOptions = {}) {
    const floor = options.minExpirationTtl ?? 60
    if (!Number.isSafeInteger(floor) || floor < 0) {
      throw new RangeError(
        "[nifra/web] KVCacheStore minExpirationTtl must be a non-negative integer",
      )
    }
    if (options.expirationTtl !== undefined) {
      if (!Number.isSafeInteger(options.expirationTtl) || options.expirationTtl < 0) {
        throw new RangeError(
          "[nifra/web] KVCacheStore expirationTtl must be a non-negative integer (seconds)",
        )
      }
      if (options.expirationTtl < floor) {
        throw new Error(
          `[nifra/web] KVCacheStore expirationTtl must be >= ${floor}, this binding's minimum. 60 is ` +
            "Cloudflare KV's floor and the default; pass `minExpirationTtl` for a backend with a " +
            "lower one. Whatever the floor, the TTL should exceed your longest `revalidate` window, " +
            "or expiry turns a stale-while-revalidate into a blocking miss.",
        )
      }
    }
    this.kv = kv
    // Precompute the put options object once: omit it entirely when no TTL (KV then never expires).
    this.putOptions =
      options.expirationTtl !== undefined ? { expirationTtl: options.expirationTtl } : undefined
    // An expired path epoch would make pages stored under the one it replaced read as current again.
    // Those were stored before the purge reached their location, so they expire within the TTL plus
    // that delay; without a TTL they never expire, and neither may the epoch.
    this.pathEpochOptions =
      options.expirationTtl !== undefined
        ? { expirationTtl: options.expirationTtl + PATH_EPOCH_SLACK }
        : undefined
  }

  async get(key: string): Promise<CachedResponse | undefined> {
    const [raw, pathEpoch] = await Promise.all([this.kv.get(key), this.pathEpoch(key)])
    if (raw === null) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // A corrupt (non-JSON) entry: treat as a miss so the page re-renders; the next set overwrites it.
      return undefined
    }
    if (!isCachedResponse(parsed)) return undefined
    const {
      __nifraTagEpochs: epochs,
      __nifraPathEpoch: storedPathEpoch,
      ...value
    } = parsed as StoredResponse
    // A page another location stored before this path's purge reached it keeps the older epoch.
    if ((storedPathEpoch ?? "0") !== pathEpoch) return undefined
    const tags = normalizeTags(value.tags)
    if (tags.length === 0) return value
    if (epochs === undefined) return undefined
    const current = await Promise.all(
      tags.map(async (tag) => [tag, (await this.kv.get(this.tagKey(tag))) ?? "0"] as const),
    )
    if (current.some(([tag, epoch]) => epochs[tag] !== epoch)) return undefined
    return value
  }

  /** Wall-clock time, so purges on any instance order against it. KV is eventually consistent, so
   * `set` refuses only purges this location has already seen; a page stored before a purge reached
   * its location keeps the older epoch and reads as a miss once the purge arrives. */
  fence(): number {
    return kvClock()
  }

  async set(key: string, value: CachedResponse): Promise<void> {
    const { fence, ...entry } = value
    const tags = normalizeTags(entry.tags)
    const [pathEpoch, ...tagEpochs] = await Promise.all([
      this.pathEpoch(key),
      ...tags.map(async (tag) => (await this.kv.get(this.tagKey(tag))) ?? "0"),
    ])
    if (
      fence !== undefined &&
      [pathEpoch, ...tagEpochs].some((epoch) => kvEpochTime(epoch) > fence)
    ) {
      return
    }
    const stored: StoredResponse = {
      ...entry,
      ...(tags.length === 0
        ? {}
        : {
            tags,
            __nifraTagEpochs: Object.fromEntries(tags.map((tag, at) => [tag, tagEpochs[at]!])),
          }),
      ...(pathEpoch === "0" ? {} : { __nifraPathEpoch: pathEpoch }),
    }
    await this.kv.put(key, JSON.stringify(stored), this.putOptions)
  }

  /** Moves the path's epoch and leaves the page: a page stored under the old epoch reads as a miss,
   * even one another location stored before this purge reached it, and `set` refuses a render begun
   * before the purge. */
  async delete(key: string): Promise<void> {
    await this.kv.put(
      await this.pathKey(key),
      `${kvClock()}:${crypto.randomUUID()}`,
      this.pathEpochOptions,
    )
  }

  async invalidateTag(tag: string): Promise<void> {
    normalizeTag(tag)
    // Epoch invalidation avoids KV key enumeration and remains bounded for a tag with millions of
    // pages. Epoch keys intentionally have no expiration: an expired epoch would resurrect entries
    // written before the invalidation when their page key still exists. The time orders it for `set`.
    await this.kv.put(this.tagKey(tag), `${kvClock()}:${crypto.randomUUID()}`)
  }

  private tagKey(tag: string): string {
    return `${KV_TAG_EPOCH_PREFIX}${encodeURIComponent(tag)}`
  }

  /** The page key under a prefix, or its digest when that would pass KV's key limit. */
  private async pathKey(key: string): Promise<string> {
    const named = `${KV_PATH_EPOCH_PREFIX}${key}`
    // A UTF-16 unit is at most three UTF-8 bytes, so most keys skip the encode.
    if (named.length * 3 <= KV_KEY_LIMIT) return named
    const encoder = new TextEncoder()
    if (encoder.encode(named).byteLength <= KV_KEY_LIMIT) return named
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(key)))
    return `${KV_PATH_DIGEST_PREFIX}${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
  }

  private async pathEpoch(key: string): Promise<string> {
    return (await this.kv.get(await this.pathKey(key))) ?? "0"
  }
}

/** Minimal platform shape `withISR` needs - just `waitUntil` (edge runtimes extend the response
 * lifetime so background regeneration finishes). Off-edge it's absent and regen runs fire-and-forget. */
export interface ISRPlatform {
  readonly waitUntil?: (promise: Promise<unknown>) => void
}

/** The app `withISR` wraps - anything with a `fetch(req, platform?)` (a `createWebApp` result). */
export interface ISRApp {
  fetch(req: Request, platform?: ISRPlatform): Response | Promise<Response>
}

/** Response header marking how an ISR response was served: a cache `hit` (fresh), `stale` (served +
 * regenerating behind it), or `miss` (rendered now + stored). Useful for debugging + tests. */
export const ISR_STATUS_HEADER = "x-nifra-isr"

/** Response header carrying bounded route tags into {@link withISR}. */
export const ISR_REVALIDATE_TAGS_HEADER = "x-nifra-isr-tags"

/**
 * Response header a route uses to advertise its ISR freshness (**seconds**) to a {@link withISR}
 * wrapper - `createWebApp` emits it from a route's `export const revalidate`. Deliberately distinct
 * from the action-revalidation `x-nifra-revalidate` header (a CSV path list the *client* parses to
 * refetch): this one is an integer TTL the *wrapper* reads, so the two channels never alias.
 */
export const ISR_REVALIDATE_HEADER = "x-nifra-isr-revalidate"

/** A `createWebApp` app answers this with a function that turns its ISR headers on. A wrapper that
 * reads them calls it, so an app nothing caches never sends a route's freshness or tags. */
export const CACHE_CHANNEL: unique symbol = Symbol.for("nifra.web.cacheChannel")

/** Internal route identity seam for explicitly public server-component owner pages. */
export const SERVER_COMPONENT_CACHE_PARTITION: unique symbol = Symbol.for(
  "nifra.web.serverComponentCachePartition",
)
/** Internal proof that a public owner document passed createWebApp's response checks. */
export const OWNER_CACHEABLE_HEADER = "x-nifra-owner-cacheable"

/** Ask `app` to emit its ISR headers; an app without the channel emits whatever it emits. */
export function openCacheChannel(app: object): void {
  const open: unknown = Reflect.get(app, CACHE_CHANNEL)
  if (typeof open === "function") open()
}

/** Drop the ISR headers from a response that leaves the cache layer. */
export function withoutCacheChannel(res: Response): Response {
  if (
    !res.headers.has(ISR_REVALIDATE_HEADER) &&
    !res.headers.has(ISR_REVALIDATE_TAGS_HEADER) &&
    !res.headers.has(OWNER_CACHEABLE_HEADER)
  ) {
    return res
  }
  const target = writableResponse(res)
  target.headers.delete(ISR_REVALIDATE_HEADER)
  target.headers.delete(ISR_REVALIDATE_TAGS_HEADER)
  target.headers.delete(OWNER_CACHEABLE_HEADER)
  return target
}

export interface ISROptions {
  readonly store: CacheStore
  /**
   * Signs every page written to `store` and checks the signature on every read, so whoever else can
   * write the store (another service on the same KV namespace, a leaked token) cannot hand visitors a
   * page this app did not render. Required for every store but a {@link MemoryCacheStore}, whose
   * pages never leave the process and stay unsigned. The same in every process, at least 32
   * characters, and random: generate it, such as 32 random bytes as hex, since a guessable secret
   * can be found from any signed page and then signs pages of its own. A page whose signature is
   * missing or wrong reads as a miss and renders again, so a new secret only empties the cache. It
   * cannot stop a store writer from deleting pages, or from putting back an older page this app
   * stored for the same key. That page keeps its age: still within its freshness window, it is a hit
   * until the window ends; past it, it serves stale and regenerates.
   */
  readonly storeSecret?: string
  /** Default freshness window (**seconds**) for a cached page; older ⇒ stale (served, regenerated
   * behind). A route overrides it per-page via `export const revalidate` (surfaced as the
   * `x-nifra-isr-revalidate` response header). */
  readonly revalidate: number
  /** Monotonic clock (ms) - injected for testability; production passes `() => Date.now()`. */
  readonly now: () => number
  /** Cache key for a request. Default: `origin + pathname`, plus the query parameters `query` admits,
   * so host-routed apps do not share entries across tenants. Return `null` to bypass the cache for
   * this request (it goes straight to the app, uncached). Replaces `query` entirely. Under the default
   * key a request carrying `Authorization` or a cookie outside `anonymousCookies` never reads the
   * store; a custom key takes that decision over, so include whatever identifies the visitor in it.
   * An action's `revalidate(paths)` keys each path with the action request's own headers, so it purges
   * the variant that client reads; a variant keyed on another header value (another language) is not
   * reached - tag those pages and revalidate the tag. */
  readonly key?: (req: Request) => string | null
  /**
   * Cookie names that never change the page, such as a consent or analytics cookie. Under the default
   * key a request carrying `Authorization` or any other cookie skips the stored page and renders fresh,
   * because a signed-in visitor's page can differ from the anonymous one; a request whose cookies are
   * all listed here is served from the cache like one with none. Default none.
   */
  readonly anonymousCookies?: readonly string[]
  /**
   * How the query string reaches the default key. Default `"bypass"`: a request carrying any query
   * parameter skips the cache - rendered fresh, never stored - so `?a=1`, `?a=2`, ... cannot each
   * store a full page. A list caches by those parameters only, in any order (`?b=2&a=1` and
   * `?a=1&b=2` share an entry); a request carrying any other parameter still bypasses, because a
   * loader that reads it would otherwise be served another request's page. `"all"` keys on the whole
   * query string, so every distinct query is a new entry.
   */
  readonly query?: ISRQuery
  /** Draft/preview secret (the same one given to `createWebApp({ draftSecret })` + `enableDraft`). When
   * set, a request carrying a valid signed draft cookie **bypasses the cache** - editors always render
   * fresh, and a draft render is never written to the store (it can't poison the public cache). */
  readonly draftSecret?: string
  /**
   * Called when a store call fails: it throws, rejects, or outlives {@link storeTimeoutMs}, or (op
   * `"verify"`) a page it returns fails its {@link storeSecret} signature check. The request is served
   * without the cache either way - a failed read is a miss, a failed write still returns the rendered
   * page, a failed regeneration keeps the stale entry - so a store outage never changes a status.
   * Default: one `console.error` line per operation per minute, never naming the cache key.
   */
  readonly onStoreError?: (error: unknown, info: { readonly op: ISRStoreOp }) => void
  /**
   * Longest a store call may take (ms) before it counts as failed. Default none, so a hung store holds
   * the request; set it when the store is a network service.
   */
  readonly storeTimeoutMs?: number
  /**
   * Caches below the pages whose entries carry the same tags, such as a `@nifrajs/cache` holding loader
   * data. An action's `revalidate(paths, data, { tags })` invalidates them first, then this store, then
   * publishes to live pages, then purges `cdn`; a cache that fails stops the rest, so no client reloads
   * stale data.
   */
  readonly dataCaches?: readonly { invalidateTag(tag: string): unknown }[]
  /** A CDN an action's invalidation purges last (a `@nifrajs/web/cdn` provider). */
  readonly cdn?: CdnPurgeTarget
  /**
   * An action's invalidation that still failed after its retries; the action's own answer never
   * changes. Default: one `console.error` line naming the operation id and stage.
   */
  readonly onInvalidationError?: (report: InvalidationReport) => void
}

/** The store operation an {@link ISROptions.onStoreError} report is about. */
export type ISRStoreOp = "get" | "set" | "delete" | "fence" | "verify"

const STORE_FAILED = Symbol("nifra.isr.store-failed")
const MAC_HEADER = "x-nifra-isr-mac"
const STORE_REPORT_INTERVAL_MS = 60_000
const STORE_REPORT_DETAIL_CHARS = 200

/** The error's own words with the cache key cut out, since a store may name the key it failed on. */
function storeErrorDetail(error: unknown, key: string): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  let path: string | undefined
  try {
    path = new URL(key).pathname
  } catch {
    path = undefined
  }
  let redacted = text.split(key).join("<key>")
  if (path !== undefined && path.length > 1) redacted = redacted.split(path).join("<key>")
  return redacted.length > STORE_REPORT_DETAIL_CHARS
    ? `${redacted.slice(0, STORE_REPORT_DETAIL_CHARS)}...`
    : redacted
}

/**
 * What a page's MAC covers: everything a replay serves, plus the key, so a page copied to another key
 * never verifies there. Header names and tags are sorted, since a store need not keep their order.
 */
function signedParts(key: string, entry: CachedResponse): readonly string[] {
  const names = Object.keys(entry.headers)
    .filter((name) => name !== MAC_HEADER)
    .sort()
  const headers = names.map((name) => [name, entry.headers[name]])
  const tags = entry.tags === undefined ? [] : [...entry.tags].sort()
  const meta = JSON.stringify([
    1,
    key,
    entry.status,
    entry.storedAt,
    entry.revalidate,
    headers,
    tags,
  ])
  return [meta, entry.body]
}

async function signed(
  signer: StoreSigner,
  key: string,
  entry: CachedResponse,
): Promise<CachedResponse> {
  const mac = await signer.sign(signedParts(key, entry))
  return { ...entry, headers: { ...entry.headers, [MAC_HEADER]: mac } }
}

async function verified(signer: StoreSigner, key: string, entry: CachedResponse): Promise<boolean> {
  try {
    return await signer.verify(signedParts(key, entry), entry.headers[MAC_HEADER])
  } catch {
    // A store's own malformed record.
    return false
  }
}

function signerFor(store: CacheStore, secret: unknown): StoreSigner | undefined {
  if (secret !== undefined && !isStoreSecret(secret)) {
    throw new TypeError(
      `[nifra/web] ISR storeSecret must be a string of at least ${MIN_STORE_SECRET_LENGTH} characters`,
    )
  }
  if (inProcessStores.has(store)) return undefined
  if (secret === undefined) {
    throw new TypeError(
      `[nifra/web] withISR needs storeSecret, at least ${MIN_STORE_SECRET_LENGTH} characters, to sign the pages it keeps in a store other processes can write. Only a MemoryCacheStore runs without one.`,
    )
  }
  return storeSigner(secret)
}

// Headers only an action or a data request carries; a stored page is always a plain document GET.
const ACTION_ONLY_HEADERS = [
  "content-type",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "x-nifra-data",
  "x-nifra-component",
  SWAP_HEADER,
]

/** The document GET for `path` from the client that sent `req`: what a custom key sees on a read. */
function documentGet(path: string, req: Request): Request {
  const headers = new Headers(req.headers)
  for (const name of ACTION_ONLY_HEADERS) headers.delete(name)
  return new Request(originOf(req) + path, { headers })
}

/** `createWebApp`'s marker for how its documents meet a CSP (see `DOCUMENT_POLICY` in ./csp.ts). Read
 * through the global symbol registry so a cache wrapper never imports the CSP module. */
const DOCUMENT_POLICY = Symbol.for("nifra.web.documentPolicy")

/** Remembered `no-store` keys per `withISR` wrapper. */
const MAX_UNCACHEABLE_KEYS = 1024

/** Which query parameters an ISR key carries - see {@link ISROptions.query}. */
export type ISRQuery = "bypass" | "all" | readonly string[]

/** The default key for a URL under a `query` policy, or `null` when the URL must bypass the cache. */
export const urlKeyOf = (query: ISRQuery = "bypass"): ((url: URL) => string | null) => {
  if (query === "all") return (url) => url.origin + url.pathname + url.search
  if (query !== "bypass" && !Array.isArray(query)) {
    throw new TypeError(
      '[nifra/web] ISR query must be "bypass", "all", or a list of parameter names',
    )
  }
  const allowed = new Set<string>(query === "bypass" ? [] : query)
  for (const name of allowed) {
    if (typeof name !== "string" || name === "") {
      throw new TypeError("[nifra/web] ISR query parameter names must be non-empty strings")
    }
  }
  return (url) => {
    if (url.search === "") return url.origin + url.pathname
    if (allowed.size === 0) return null
    const entries: [string, string][] = []
    for (const entry of url.searchParams) {
      if (!allowed.has(entry[0])) return null
      entries.push(entry)
    }
    // Stable by name, so a repeated name keeps its value order (`getAll` can tell them apart).
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    return `${url.origin}${url.pathname}?${new URLSearchParams(entries)}`
  }
}

/**
 * The key of a request, and of a path on the request's origin. Under the default URL key a path needs
 * no `Request`; a custom `key` is handed one.
 */
type CachePartition = (req: Request) => string | null | undefined

const partitionedCacheKey = (key: string, partition: string): string =>
  JSON.stringify(["nifra-owner-v1", partition, key])

function cacheKeysOf(
  options: ISROptions,
  partitionOf: CachePartition | undefined,
): {
  readonly request: (req: Request) => string | null
  readonly path: (path: string, req: Request) => string | null
} {
  const inPartition = (key: string | null, req: Request): string | null => {
    if (key === null || partitionOf === undefined) return key
    const partition = partitionOf(req)
    if (partition === undefined) return key
    return partition === null ? null : partitionedCacheKey(key, partition)
  }
  const custom = options.key
  if (custom !== undefined) {
    return {
      request: (req) => inPartition(custom(req), req),
      path: (path, req) => {
        const document = documentGet(path, req)
        return inPartition(custom(document), document)
      },
    }
  }
  const urlKey = urlKeyOf(options.query)
  return {
    request: (req) => inPartition(urlKey(new URL(req.url)), req),
    path: (path, req) => {
      const document = documentGet(path, req)
      return inPartition(urlKey(new URL(originOf(req) + path)), document)
    },
  }
}

function cachePartitionOf(app: object): CachePartition | undefined {
  const candidate: unknown = Reflect.get(app, SERVER_COMPONENT_CACHE_PARTITION)
  if (typeof candidate !== "function") return undefined
  return (req) => {
    try {
      const value: unknown = candidate(req)
      if (value === undefined) return undefined
      return typeof value === "string" && value.length > 0 && value.length <= 2048 ? value : null
    } catch {
      // A broken internal identity seam disables caching for that request.
      return null
    }
  }
}

/** `req.url` up to its path, without a parse: the path joined to it is parsed as one URL anyway. */
const originOf = (req: Request): string => {
  const url = req.url
  const end = url.indexOf("/", url.indexOf("//") + 2)
  return end === -1 ? url : url.slice(0, end)
}

function assertRevalidate(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`[nifra/web] ${name} must be a finite non-negative number`)
  }
}

/** ISR caches a full-document SSR response: a `GET` (not a data-mode soft-nav fetch), `200`, `text/html`.
 * Assets, data-mode GETs, redirects, and errors pass through uncached. */
const cacheControlHas = (headers: Headers, names: readonly string[]): boolean => {
  const value = headers.get("cache-control")
  if (value === null) return false
  const directives = value
    .toLowerCase()
    .split(",")
    .map((part) => part.trim().split("=", 1)[0])
  return names.some((name) => directives.includes(name))
}

const hasSetCookie = (headers: Headers): boolean =>
  headers.has("set-cookie") || (headers.getSetCookie?.().length ?? 0) > 0

/** Whether every cookie in a `Cookie` header is named in `names`. */
const cookieNamesWithin = (header: string, names: ReadonlySet<string>): boolean => {
  for (const pair of header.split(";")) {
    const name = pair.split("=", 1)[0]?.trim() ?? ""
    if (name !== "" && !names.has(name)) return false
  }
  return true
}

// An authentication stage may read any header, so a request it accepted is private whatever carried
// the credential. The mark is set on the request the app was handed, which is why this runs after it.
const requestCarriesPrivateState = (req: Request): boolean =>
  req.headers.has("authorization") || req.headers.has("cookie") || isAuthenticatedRequest(req)

const responseIsExplicitlyPublic = (res: Response): boolean =>
  cacheControlHas(res.headers, ["public"])

// Data and swap requests bypass both cache reads and writes, so these headers cannot vary stored HTML.
const responseDeclaresVary = (res: Response): boolean => {
  const value = res.headers.get("vary")
  if (value === null) return false
  for (const part of value.split(",")) {
    const name = part.trim().toLowerCase()
    if (name !== "" && name !== "x-nifra-data" && name !== SWAP_HEADER) return true
  }
  return false
}

/**
 * Whether `res` may be stored by a shared cache and served to anyone requesting `req`'s URL: a
 * full-document `GET` 200 `text/html` with no Set-Cookie, no `private`/`no-store`, no `Vary` beyond
 * the data/swap headers, and, for a request carrying a cookie or Authorization or accepted by an
 * authentication stage, an explicit `public`.
 * The one rule both `withISR` and `@nifrajs/web/cdn` cache by.
 */
export const isCacheablePage = (req: Request, res: Response): boolean => {
  if (req.method !== "GET") return false
  if (req.headers.get("x-nifra-data") !== null || req.headers.has(SWAP_HEADER)) return false
  if (res.status !== 200) return false
  if (!(res.headers.get("content-type") ?? "").includes("text/html")) return false
  if (hasSetCookie(res.headers)) return false
  // The default ISR key is URL-only. A response that varies on request headers must either use a
  // caller-supplied key that includes those headers or bypass ISR; otherwise one language/tenant
  // representation can be served to every request for the URL.
  if (responseDeclaresVary(res)) return false
  if (cacheControlHas(res.headers, ["private", "no-store"])) return false
  // Cookie/Authorization requests often personalize HTML without setting a new cookie. Cache them only
  // when the route explicitly declares the response public.
  if (requestCarriesPrivateState(req) && !responseIsExplicitlyPublic(res)) return false
  return true
}

const isCacheableOwnerPage = (req: Request, res: Response): boolean => {
  if (req.method !== "GET") return false
  if (req.headers.get("x-nifra-data") !== null || req.headers.has("x-nifra-component")) return false
  if (req.headers.has(SWAP_HEADER) || requestCarriesPrivateState(req)) return false
  if (res.headers.get(OWNER_CACHEABLE_HEADER) !== "1") return false
  if (res.status !== 200 || !(res.headers.get("content-type") ?? "").includes("text/html"))
    return false
  if (!cacheControlHas(res.headers, ["private"]) || !cacheControlHas(res.headers, ["no-store"]))
    return false
  if (hasSetCookie(res.headers)) return false
  const vary = res.headers.get("vary")
  if (vary !== null) {
    const allowed = new Set(["x-nifra-component", "x-nifra-data"])
    if (vary.split(",").some((part) => !allowed.has(part.trim().toLowerCase()))) return false
  }
  return true
}

// Keep representation and security policy headers, plus `Vary` for legacy entries. Transport,
// request-specific, framework-control, and unknown internal headers stay out of the shared cache.
const CACHEABLE_RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-language",
  "content-security-policy",
  "content-type",
  "cross-origin-embedder-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "etag",
  "last-modified",
  "link",
  "origin-agent-cluster",
  "permissions-policy",
  "referrer-policy",
  "strict-transport-security",
  "vary",
  "x-content-type-options",
  "x-frame-options",
  "x-robots-tag",
])

const isCacheableResponseHeader = (key: string): boolean => {
  const normalized = key.toLowerCase()
  return (
    CACHEABLE_RESPONSE_HEADERS.has(normalized) ||
    normalized.startsWith("content-security-policy-") ||
    normalized.startsWith("cross-origin-") ||
    normalized.startsWith("permissions-policy-")
  )
}

const tagsOf = (res: Response): readonly string[] =>
  tagsFromHeader(res.headers.get(ISR_REVALIDATE_TAGS_HEADER))

const headersOf = (res: Response): Record<string, string> => {
  const out: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    if (key !== OWNER_CACHEABLE_HEADER && isCacheableResponseHeader(key)) out[key] = value
  })
  return out
}

const responseFrom = (entry: CachedResponse, status: "hit" | "stale"): Response =>
  new Response(entry.body, {
    status: entry.status,
    headers: { ...sanitizeCachedHeaders(entry.headers), [ISR_STATUS_HEADER]: status },
  })

function sanitizeCachedHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (isCacheableResponseHeader(key)) out[key.toLowerCase()] = value
  }
  return out
}

/**
 * Whether a regeneration's answer withdraws the stored page: it is gone or moved, or, rendered for a
 * request with no cookie or Authorization, refused (401, 403) or declared `private`/`no-store`. A
 * signed-in visitor's own 403 or private copy says nothing about the shared page. A 5xx or 429 keeps
 * serving the stale copy.
 */
const isInvalidationResponse = (req: Request, res: Response): boolean => {
  if (res.status === 404 || res.status === 410 || (res.status >= 300 && res.status < 400))
    return true
  if (requestCarriesPrivateState(req)) return false
  return (
    res.status === 401 ||
    res.status === 403 ||
    (res.status >= 200 && res.status < 300 && cacheControlHas(res.headers, ["private", "no-store"]))
  )
}

/**
 * Wrap a nifra app with **Incremental Static Regeneration**: a cacheable page is served from
 * {@link CacheStore} when fresh, served **stale while a fresh copy regenerates in the background**
 * (`platform.waitUntil` on edge), or rendered + stored on a miss. Framework-agnostic (it caches the
 * rendered bytes). Returns a `fetch(req, platform?)` handler - hand it to `Bun.serve`/the Workers
 * `export default`, etc. Regeneration is single-flight per key (no stampede on a hot stale page).
 *
 * Each route's freshness comes from the `revalidate` header the app sets (per-route
 * `export const revalidate`), falling back to `options.revalidate`. Only full-document `text/html`
 * GET 200s are cached; everything else (assets, data-mode GETs, redirects, errors) passes through.
 */
export function withISR(
  app: ISRApp,
  options: ISROptions,
): (req: Request, platform?: ISRPlatform) => Promise<Response> {
  const { store, now } = options
  assertRevalidate(options.revalidate, "revalidate")
  const signer = signerFor(store, options.storeSecret)
  const write = (key: string, entry: CachedResponse): Promise<void> =>
    signer === undefined
      ? store.set(key, entry)
      : signed(signer, key, entry).then((value) => store.set(key, value))
  const storeTimeoutMs = options.storeTimeoutMs
  if (storeTimeoutMs !== undefined && !(Number.isFinite(storeTimeoutMs) && storeTimeoutMs > 0)) {
    throw new RangeError("[nifra/web] ISR storeTimeoutMs must be a positive finite number")
  }
  const lastReport = new Map<ISRStoreOp, number>()
  const reportStoreError = (op: ISRStoreOp, key: string, error: unknown): void => {
    try {
      if (options.onStoreError !== undefined) {
        options.onStoreError(error, { op })
        return
      }
      const last = lastReport.get(op)
      const at = now()
      if (last !== undefined && at - last < STORE_REPORT_INTERVAL_MS) return
      lastReport.set(op, at)
      console.error(
        `[nifra/web] ISR store ${op} failed; serving without the cache (${storeErrorDetail(error, key)})`,
      )
    } catch {
      // A failing reporter must not turn a served page into an error.
    }
  }
  // Runs one store call; a throw, a rejection or a timeout is reported and answered with STORE_FAILED.
  const withinTimeout = async <T>(op: string, pending: Promise<T>): Promise<T> => {
    if (storeTimeoutMs === undefined) return pending
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`ISR store ${op} exceeded storeTimeoutMs (${storeTimeoutMs} ms)`)
        error.name = "TimeoutError"
        reject(error)
      }, storeTimeoutMs)
    })
    try {
      return await Promise.race([pending, timeout])
    } finally {
      clearTimeout(timer)
    }
  }
  const attempt = async <T>(
    op: ISRStoreOp,
    key: string,
    call: () => Promise<T>,
  ): Promise<T | typeof STORE_FAILED> => {
    try {
      return await withinTimeout(op, call())
    } catch (error) {
      reportStoreError(op, key, error)
      return STORE_FAILED
    }
  }
  // A store without purge order, or one whose fence failed, stores the render unfenced.
  const fenceFor = async (key: string): Promise<number | undefined> => {
    const { fence } = store
    if (fence === undefined) return undefined
    const taken = await attempt("fence", key, async () => fence.call(store))
    return taken === STORE_FAILED ? undefined : taken
  }
  const partitionOf = cachePartitionOf(app)
  const keys = cacheKeysOf(options, partitionOf)
  const keyOf = keys.request
  const draftSecret = options.draftSecret
  const anonymousCookies = new Set(options.anonymousCookies ?? [])
  // A request whose cookies are all anonymous is judged for storage as if it carried none.
  const judged = (req: Request): Request => {
    if (
      anonymousCookies.size === 0 ||
      req.headers.has("authorization") ||
      isAuthenticatedRequest(req)
    )
      return req
    const cookie = req.headers.get("cookie")
    if (cookie === null || !cookieNamesWithin(cookie, anonymousCookies)) return req
    const headers = new Headers(req.headers)
    headers.delete("cookie")
    return new Request(req.url, { method: req.method, headers })
  }
  const isComponentOwnerRequest = (req: Request): boolean => {
    const partition = partitionOf?.(req)
    return (
      typeof partition === "string" &&
      req.method === "GET" &&
      !req.headers.has("x-nifra-data") &&
      !req.headers.has("x-nifra-component") &&
      !req.headers.has(SWAP_HEADER) &&
      !requestCarriesPrivateState(req)
    )
  }
  const cacheableResponse = (req: Request, res: Response): boolean =>
    isCacheablePage(judged(req), res) ||
    (isComponentOwnerRequest(req) && isCacheableOwnerPage(judged(req), res))
  const regenerating = new Set<string>()
  openCacheChannel(app)
  // This wrapper owns the app's invalidation pipeline from here on: an action's operation comes back
  // by its request, and every stage runs in order before the action's answer leaves.
  const handoff: unknown = Reflect.get(app, INVALIDATION)
  const taken = isHandoff(handoff) ? handoff : undefined
  // The pipeline's purges are bounded like every other store call; their failures reach its own report.
  const invalidateTag = store.invalidateTag
  const targets: InvalidationTargets = {
    dataCaches: options.dataCaches,
    store: {
      delete: (key) => withinTimeout("delete", store.delete(key)),
      invalidateTag:
        invalidateTag === undefined
          ? undefined
          : (tag) => withinTimeout("invalidateTag", invalidateTag.call(store, tag)),
    },
    keyOf: keys.path,
    publish: taken?.publish,
    cdn: options.cdn,
  }
  const passThrough = async (
    req: Request,
    platform: ISRPlatform | undefined,
  ): Promise<Response> => {
    const res = withoutCacheChannel(await app.fetch(req, platform))
    const op = taken?.take(req)
    if (op !== undefined) {
      await settleInvalidation(op, targets, req, platform, {
        onError: options.onInvalidationError,
      })
    }
    return res
  }
  // An outer cache layer (`withCdn`) opens this wrapper's own channel: cached responses then carry how
  // much freshness they have left and their tags, so the CDN never holds a page longer than ISR would.
  let channelOpen = false
  const advertise = (headers: Headers, remainingMs: number, tags: readonly string[]): void => {
    if (!channelOpen) return
    headers.set(ISR_REVALIDATE_HEADER, String(Math.max(0, Math.floor(remainingMs / 1000))))
    const serialized = tags.length === 0 ? undefined : tags.join(",")
    if (serialized !== undefined) headers.set(ISR_REVALIDATE_TAGS_HEADER, serialized)
  }
  const served = (entry: CachedResponse, status: "hit" | "stale"): Response => {
    const res = responseFrom(entry, status)
    advertise(
      res.headers,
      status === "stale" ? 0 : entry.revalidate - (now() - entry.storedAt),
      entry.tags ?? [],
    )
    return res
  }
  if ((app as unknown as Record<symbol, unknown>)[DOCUMENT_POLICY] === "nonce") {
    console.warn(
      "[nifra/web] withISR wraps an app whose every document carries a CSP nonce. Such documents are " +
        "`private, no-store`, so this cache will never store a page. Use " +
        "`createWebApp({ csp: createCspPolicy(...) })` instead of `nonce` to cache pages under a CSP.",
    )
  }
  // Keys whose last render declared itself `private` or `no-store`, with when that memo expires. A
  // remembered key skips the store lookup (a network round trip on a shared store) and renders fresh;
  // a render that turns out cacheable is stored and forgets the key. So the memo can only cost a cache
  // hit, never serve the wrong page. Bounded, oldest first, so a URL flood cannot grow it.
  const uncacheable = new Map<string, number>()
  const rememberUncacheable = (key: string, res: Response): void => {
    if (options.revalidate === 0 || !cacheControlHas(res.headers, ["private", "no-store"])) return
    if (uncacheable.size >= MAX_UNCACHEABLE_KEYS) {
      uncacheable.delete(uncacheable.keys().next().value as string)
    }
    uncacheable.set(key, now() + options.revalidate * 1000)
  }

  // Per-page TTL (ms): the app's `x-nifra-isr-revalidate` header (seconds) if present, else the default.
  const ttlMs = (res: Response): number => {
    const header = res.headers.get(ISR_REVALIDATE_HEADER)
    const seconds = header === null ? options.revalidate : Number(header)
    const safeSeconds = Number.isFinite(seconds) && seconds >= 0 ? seconds : options.revalidate
    return safeSeconds * 1000
  }

  const render = async (
    req: Request,
    platform: ISRPlatform | undefined,
    key: string,
    remember: boolean,
    stored?: (entry: CachedResponse) => void,
  ): Promise<Response> => {
    const fence = await fenceFor(key)
    const res = await app.fetch(req, platform)
    if (!cacheableResponse(req, res)) {
      if (remember) rememberUncacheable(key, res)
      return withoutCacheChannel(res)
    }
    uncacheable.delete(key)
    const body = await res.text()
    const tags = tagsOf(res)
    const entry: CachedResponse = {
      body,
      status: res.status,
      headers: headersOf(res),
      storedAt: now(),
      revalidate: ttlMs(res),
      ...(tags.length === 0 ? {} : { tags }),
      fence,
    }
    // A failed write still answers with the page, and still hands it to concurrent misses: whether it
    // may be shared was decided above, not by the store.
    await attempt("set", key, () => write(key, entry))
    stored?.(entry)
    return fresh(entry)
  }

  const fresh = (entry: CachedResponse): Response => {
    const res = new Response(entry.body, {
      status: entry.status,
      headers: { ...entry.headers, [ISR_STATUS_HEADER]: "miss" },
    })
    advertise(res.headers, entry.revalidate, entry.tags ?? [])
    return res
  }

  // Cold misses in flight per key. Concurrent misses wait for the first one's stored entry instead
  // of each rendering the page; a render that is not stored (private, failed) sends each waiter to
  // render for itself, so a waiter never receives a page that was not safe to share.
  const coldRenders = new Map<string, Promise<CachedResponse | undefined>>()
  const renderCold = async (
    req: Request,
    platform: ISRPlatform | undefined,
    key: string,
  ): Promise<Response> => {
    const pending = coldRenders.get(key)
    if (pending !== undefined) {
      const entry = await pending
      return entry === undefined ? render(req, platform, key, true) : fresh(entry)
    }
    const shared = Promise.withResolvers<CachedResponse | undefined>()
    coldRenders.set(key, shared.promise)
    let entry: CachedResponse | undefined
    try {
      return await render(req, platform, key, true, (stored) => {
        entry = stored
      })
    } finally {
      coldRenders.delete(key)
      shared.resolve(entry)
    }
  }

  // Background regeneration (single-flight per key) - a failed regen keeps the stale entry; the next
  // stale hit retries. Never throws (it runs detached / under waitUntil).
  const regenerate = async (
    req: Request,
    platform: ISRPlatform | undefined,
    key: string,
  ): Promise<void> => {
    if (regenerating.has(key)) return
    regenerating.add(key)
    try {
      const fence = await fenceFor(key)
      const res = await app.fetch(req, platform)
      if (cacheableResponse(req, res)) {
        const tags = tagsOf(res)
        const entry: CachedResponse = {
          body: await res.text(),
          status: res.status,
          headers: headersOf(res),
          storedAt: now(),
          revalidate: ttlMs(res),
          ...(tags.length === 0 ? {} : { tags }),
          fence,
        }
        await attempt("set", key, () => write(key, entry))
      } else if (isInvalidationResponse(judged(req), res)) {
        // A withdrawal is authoritative. Keeping the old entry would make a withdrawn page stay
        // publicly visible forever, because every stale request would retry the same non-cacheable
        // response while continuing to serve the old body.
        await res.body?.cancel()
        await attempt("delete", key, () => store.delete(key))
      } else {
        await res.body?.cancel()
      }
    } catch {
      // keep the stale entry; a later request retries the regeneration
    } finally {
      regenerating.delete(key)
    }
  }

  const handler = async (req: Request, platform?: ISRPlatform): Promise<Response> => {
    // A data-mode soft-nav GET or a slot swap bypasses the cache entirely: entries are full HTML
    // documents keyed by URL, and serving one to either would hand the client a document where it
    // expects the loader payload or one slot. (The write path already refuses both.)
    const privateRoute: unknown = Reflect.get(app, Symbol.for("nifra.web.private-route"))
    const ownsPrivate = typeof privateRoute === "function" && privateRoute(req) === true
    const ownerCacheRequest = isComponentOwnerRequest(req)
    const key =
      req.method === "GET" &&
      req.headers.get("x-nifra-data") === null &&
      !req.headers.has("x-nifra-component") &&
      !req.headers.has(SWAP_HEADER) &&
      (!ownsPrivate || ownerCacheRequest)
        ? keyOf(req)
        : null
    if (key === null) return passThrough(req, platform)

    // Draft/preview: an editor (valid signed cookie) always renders fresh and is never cached, so
    // unpublished content can't leak into the public cache (and the editor isn't served a stale page).
    if (draftSecret !== undefined && (await isDraftEnabled(req, draftSecret))) {
      return passThrough(req, platform)
    }

    // A cookie or Authorization request may be personalized: under the default key it never reads
    // the store, and its private render never marks the URL uncacheable for everyone else.
    const personal = options.key === undefined && requestCarriesPrivateState(judged(req))

    const until = uncacheable.get(key)
    if (until !== undefined) {
      if (now() < until) return render(req, platform, key, !personal)
      uncacheable.delete(key)
    }

    const read = personal ? undefined : await attempt("get", key, () => store.get(key))
    let hit = read === STORE_FAILED ? undefined : read
    if (hit !== undefined && signer !== undefined && !(await verified(signer, key, hit))) {
      reportStoreError("verify", key, new Error("a stored page failed its signature check"))
      hit = undefined
    }
    if (hit !== undefined) {
      if (now() - hit.storedAt < hit.revalidate) return served(hit, "hit")
      // Stale: serve it now, regenerate behind it (waitUntil keeps the edge worker alive for the regen).
      const task = regenerate(req, platform, key)
      if (typeof platform?.waitUntil === "function") platform.waitUntil(task)
      else void task.catch(() => {})
      return served(hit, "stale")
    }
    return personal ? render(req, platform, key, false) : renderCold(req, platform, key)
  }
  Object.defineProperty(handler, CACHE_CHANNEL, {
    value: () => {
      channelOpen = true
    },
  })
  return handler
}

const jsonError = (status: number, error: string): Response =>
  Response.json({ ok: false, error }, { status })

const isHandoff = (value: unknown): value is InvalidationHandoff =>
  typeof value === "object" && value !== null && typeof Reflect.get(value, "take") === "function"

/** What a CDN purge came to: sent and accepted, queued behind a rate limit or retry, or refused. */
export interface CdnPurgeOutcome {
  readonly cdn: "accepted" | "queued" | "failed"
  /** Whether the same purge may succeed if sent again. */
  readonly retryable: boolean
  /** A short reason when it did not succeed (never the provider's credentials). */
  readonly error?: string
}

/** A CDN a revalidation purges after the origin store; every `@nifrajs/web/cdn` provider is one. */
export interface CdnPurgeTarget {
  purge(
    target: { readonly tags?: readonly string[]; readonly paths?: readonly string[] },
    platform?: ISRPlatform,
  ): Promise<CdnPurgeOutcome>
}

/** Most paths and tags one revalidation request may name, so a leaked token cannot fan out. */
export const MAX_REVALIDATE_PATHS = 100
export const MAX_REVALIDATE_TAGS = MAX_ISR_TAGS
// Room for a full batch of long paths; a purge body past it is refused before it is buffered.
const MAX_REVALIDATE_BODY_BYTES = 1024 * 1024

export interface RevalidateEndpointOptions {
  readonly store: CacheStore
  /** The same app instance passed to `withISR`, for deployment-scoped owner-route path purges. */
  readonly app?: object
  /** Shared secret; the request's token must match it (constant-time). */
  readonly secret: string
  /** Header carrying the secret. Default `x-nifra-revalidate-token`. */
  readonly tokenHeader?: string
  /** Map a to-purge path → its cache key - MUST match the `withISR` `key` fn. The default uses the
   * revalidation request's origin plus the purged path, matching `withISR`'s default host-aware key. */
  readonly key?: (path: string, req: Request) => string
  /** The `query` policy given to `withISR`, so a purged path's query string is keyed the same way.
   * Default `"bypass"`. A path whose query `withISR` never caches is refused with `400`. Ignored
   * when `key` is supplied. */
  readonly query?: ISRQuery
  /**
   * A CDN to purge after the origin store (a `@nifrajs/web/cdn` provider). The origin goes first so a
   * CDN refetch cannot repopulate from a stale origin entry. The reply is `200` when the CDN accepted
   * the purge, `202` when it is queued (rate limit or retry), and `502` when the CDN refused it.
   */
  readonly cdn?: CdnPurgeTarget
  /**
   * Caches below the pages whose entries carry the same tags, such as a `@nifrajs/cache` holding
   * loader data. A tag purge invalidates each of them first, then the page store, then the CDN, so a
   * page regenerated mid-purge cannot be rebuilt from stale data. A failure answers `500` before the
   * page store is touched, so a retry purges everything again. Path purges do not reach them.
   */
  readonly dataCaches?: readonly { invalidateTag(tag: string): unknown }[]
  /**
   * The app's live runtime: a purge also tells live pages watching a purged tag to reload, after the
   * caches and before the CDN. A publish that fails answers `502` with `origin: "done"`.
   */
  readonly live?: { publish(...keys: string[]): Promise<void> }
}

const stringList = (value: unknown): string[] | null | undefined => {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null
  return value
}

/**
 * An **on-demand revalidation** (purge) endpoint - a `fetch` handler that drops cached pages by path
 * or invalidates every entry carrying a tag. `POST` with the secret in the token header and either
 * `?path=/blog/x`, `?tag=products`, a JSON `{ "path": "/blog/x" }` / `{ "tag": "products" }` body, or a
 * batch `{ "paths": [...], "tags": [...] }` of at most 100 paths and 32 tags.
 * The token is checked in **constant time** (wrong/missing → `401`); malformed targets → `400`;
 * a JSON body over 1 MiB → `413`; non-POST → `405`. A store without tag support returns `501` for tag requests. Mount it on a nifra route, e.g.
 * `app.post("/__nifra/revalidate", (c) => handler(c.req))`.
 */
export function revalidateEndpoint(
  options: RevalidateEndpointOptions,
): (req: Request, platform?: ISRPlatform) => Promise<Response> {
  // An empty secret matches a request that omits the header (`"" === ""`), so an unset env var passed
  // through `?? ""` would open the purge to anyone. Refuse it at construction instead.
  assertTokenSecret(options.secret, "revalidateEndpoint")
  const tokenHeader = options.tokenHeader ?? "x-nifra-revalidate-token"
  const urlKey = options.key === undefined ? urlKeyOf(options.query) : undefined
  const partitionOf = options.app === undefined ? undefined : cachePartitionOf(options.app)
  // Joined as text, never resolved against the origin: `//host/x` must stay a path on this origin.
  const baseKeyOf =
    options.key ??
    ((path: string, req: Request) => urlKey?.(new URL(new URL(req.url).origin + path)) ?? null)
  const keyOf = (path: string, req: Request): string | null => {
    const key = baseKeyOf(path, req)
    if (key === null || partitionOf === undefined) return key
    const partition = partitionOf(documentGet(path, req))
    if (partition === undefined) return key
    return partition === null ? null : partitionedCacheKey(key, partition)
  }
  return async (req, platform) => {
    if (req.method !== "POST") return jsonError(405, "method_not_allowed")
    if (!timingSafeEqual(req.headers.get(tokenHeader) ?? "", options.secret)) {
      return jsonError(401, "unauthorized")
    }
    const url = new URL(req.url)
    let path = url.searchParams.get("path")
    let tag = url.searchParams.get("tag")
    let batch: { paths: string[]; tags: string[] } | undefined
    if (path === null && tag === null) {
      let body: unknown = null
      try {
        const bytes = await readBoundedBytes(new Response(req.body, { headers: req.headers }), {
          maxBytes: MAX_REVALIDATE_BODY_BYTES,
        })
        body = JSON.parse(new TextDecoder().decode(bytes))
      } catch (error) {
        if (error instanceof TransportCodecError) return jsonError(413, "body_too_large")
      }
      if (typeof body === "object" && body !== null) {
        const candidate = body as { path?: unknown; tag?: unknown; paths?: unknown; tags?: unknown }
        if (candidate.paths !== undefined || candidate.tags !== undefined) {
          const paths = stringList(candidate.paths)
          const tags = stringList(candidate.tags)
          if (paths === null || tags === null) return jsonError(400, "invalid_batch")
          if ((paths?.length ?? 0) > MAX_REVALIDATE_PATHS) return jsonError(400, "too_many_paths")
          if ((tags?.length ?? 0) > MAX_REVALIDATE_TAGS) return jsonError(400, "too_many_tags")
          batch = { paths: paths ?? [], tags: tags ?? [] }
          if (batch.paths.length + batch.tags.length === 0) return jsonError(400, "empty_batch")
        } else {
          path = typeof candidate.path === "string" ? candidate.path : null
          tag = typeof candidate.tag === "string" ? candidate.tag : null
        }
      }
    }
    if (batch === undefined) {
      if (path !== null && tag !== null) return jsonError(400, "choose_path_or_tag")
      if (path === null && tag === null) return jsonError(400, "invalid_path")
      batch = { paths: path === null ? [] : [path], tags: tag === null ? [] : [tag] }
    }

    const tags = [...new Set(batch.tags)]
    for (const candidate of tags) {
      try {
        normalizeTag(candidate)
      } catch {
        return jsonError(400, "invalid_tag")
      }
    }
    const paths = [...new Set(batch.paths)]
    const keys: string[] = []
    for (const candidate of paths) {
      if (!candidate.startsWith("/")) return jsonError(400, "invalid_path")
      const key = keyOf(candidate, req)
      if (key === null) return jsonError(400, "uncached_query")
      keys.push(key)
    }
    const invalidateTag = options.store.invalidateTag
    if (tags.length > 0 && invalidateTag === undefined) {
      return jsonError(501, "tag_invalidation_not_supported")
    }

    // The same pipeline an action's `revalidate()` runs: data caches, this store, live, then the CDN.
    const live = options.live
    const report = await runInvalidation(
      { id: crypto.randomUUID(), paths, tags, keys: [] },
      {
        dataCaches: options.dataCaches,
        store: options.store,
        keyOf: (candidate) => keys[paths.indexOf(candidate)] ?? null,
        publish: live === undefined ? undefined : (names) => live.publish(...names),
        cdn: options.cdn,
      },
      req,
      platform,
    )
    const stageOf = (stage: string) => report.stages.find((each) => each.stage === stage)
    if (stageOf("data")?.ok === false) return jsonError(500, "data_cache_invalidation_failed")
    if (stageOf("pages")?.ok === false) return jsonError(500, "page_store_invalidation_failed")
    const done =
      path !== null
        ? { revalidated: path }
        : tag !== null
          ? { revalidatedTag: tag }
          : { revalidated: paths, revalidatedTags: tags }
    const published = stageOf("publish")
    const cdn = stageOf("cdn")
    if (cdn?.ok === false) {
      const failure: Record<string, unknown> = {
        ok: false,
        error: "cdn_purge_failed",
        origin: "done",
        retryable: cdn.retryable,
      }
      if (cdn.error !== undefined && cdn.error !== "cdn_failed") failure.reason = cdn.error
      return Response.json(failure, { status: 502 })
    }
    if (published?.ok === false) {
      return Response.json(
        { ok: false, error: "live_publish_failed", origin: "done", retryable: true },
        { status: 502 },
      )
    }
    if (cdn === undefined) return Response.json(done)
    return Response.json(
      { ...done, cdn: cdn.queued === true ? "queued" : "accepted" },
      { status: cdn.queued === true ? 202 : 200 },
    )
  }
}

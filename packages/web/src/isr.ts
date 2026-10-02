/**
 * ISR (Incremental Static Regeneration). A caching layer that sits ABOVE the agnostic SSR
 * handler: it stores a rendered `Response` keyed by URL and serves it with stale-while-revalidate
 * freshness, so dynamic pages get static-like speed and revalidate in the background. Agnostic to the
 * UI framework (it caches bytes), coupled to the runtime only through this pluggable {@link CacheStore}.
 *
 * This module is the store primitive; the SWR wrapper (`withISR`) builds on it next.
 */
import { isDraftEnabled } from "./draft.ts"
import { assertTokenSecret, timingSafeEqual } from "./internal/timing-safe-equal.ts"

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
}

const ISR_TAG_PATTERN = /^[A-Za-z][A-Za-z0-9._:/-]{0,127}$/
const MAX_ISR_TAGS = 32

function normalizeTag(tag: string): string {
  if (typeof tag !== "string" || !ISR_TAG_PATTERN.test(tag)) {
    throw new TypeError("[nifra/web] ISR tag must be a bounded token")
  }
  return tag
}

export function normalizeTags(tags: readonly string[] | undefined): readonly string[] {
  if (tags === undefined) return []
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

  set(key: string, value: CachedResponse): Promise<void> {
    const tags = normalizeTags(value.tags)
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
    this.pruneTagEpochs()
    return Promise.resolve()
  }

  invalidateTag(tag: string): Promise<void> {
    normalizeTag(tag)
    this.tagEpoch.set(tag, crypto.randomUUID())
    // This store is bounded and local, so eagerly remove matching rows. It keeps invalidation
    // immediate and lets us discard epoch keys that no retained entry references anymore.
    for (const [key, row] of this.cache) {
      if (Object.hasOwn(row.tagEpochs, tag)) this.cache.delete(key)
    }
    this.pruneTagEpochs()
    return Promise.resolve()
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
  if (
    typeof v.body !== "string" ||
    typeof v.status !== "number" ||
    typeof v.storedAt !== "number" ||
    typeof v.revalidate !== "number" ||
    typeof v.headers !== "object" ||
    v.headers === null
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
  for (const headerValue of Object.values(v.headers as Record<string, unknown>)) {
    if (typeof headerValue !== "string") return false
  }
  return true
}

const KV_TAG_EPOCH_PREFIX = "__nifra_isr_tag_v1:"

type StoredTaggedResponse = CachedResponse & {
  readonly __nifraTagEpochs?: Readonly<Record<string, string>>
}

/**
 * A {@link CacheStore} backed by a **Cloudflare Workers KV** namespace (or any {@link KVNamespaceLike}
 * binding) - the production-grade shared/durable store ISR wants: cached pages and on-demand purges
 * hold *across* worker instances (unlike the per-instance {@link MemoryCacheStore}). Entries serialize
 * to JSON; every read is validated before it's trusted (a malformed/version-skewed entry is treated as
 * a miss). Construct it in your Workers `fetch` from the binding: `new KVCacheStore(env.ISR_CACHE)`.
 *
 * Cloudflare is the default, not a requirement: {@link KVNamespaceLike} is three structural methods,
 * so a Redis, Deno KV, or Upstash binding satisfies it (pass `minExpirationTtl` for their TTL floor).
 * A backend that *can* enumerate keys deserves its own {@link CacheStore} rather than this one - the
 * epoch indirection in {@link KVCacheStore.invalidateTag} exists only because KV cannot list by tag.
 */
export class KVCacheStore implements CacheStore {
  private readonly kv: KVNamespaceLike
  private readonly putOptions: { readonly expirationTtl?: number } | undefined

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
  }

  async get(key: string): Promise<CachedResponse | undefined> {
    const raw = await this.kv.get(key)
    if (raw === null) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // A corrupt (non-JSON) entry: treat as a miss so the page re-renders; the next set overwrites it.
      return undefined
    }
    if (!isCachedResponse(parsed)) return undefined
    const tags = normalizeTags(parsed.tags)
    if (tags.length === 0) return parsed
    const epochs = (parsed as StoredTaggedResponse).__nifraTagEpochs
    if (epochs === undefined) return undefined
    const current = await Promise.all(
      tags.map(async (tag) => [tag, (await this.kv.get(this.tagKey(tag))) ?? "0"] as const),
    )
    if (current.some(([tag, epoch]) => epochs[tag] !== epoch)) return undefined
    const { __nifraTagEpochs: _ignored, ...value } = parsed as StoredTaggedResponse
    return value
  }

  async set(key: string, value: CachedResponse): Promise<void> {
    const tags = normalizeTags(value.tags)
    if (tags.length === 0) {
      await this.kv.put(key, JSON.stringify(value), this.putOptions)
      return
    }
    const epochs = Object.fromEntries(
      await Promise.all(
        tags.map(async (tag) => [tag, (await this.kv.get(this.tagKey(tag))) ?? "0"] as const),
      ),
    )
    const stored: StoredTaggedResponse = {
      ...value,
      tags,
      __nifraTagEpochs: epochs,
    }
    await this.kv.put(key, JSON.stringify(stored), this.putOptions)
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key)
  }

  async invalidateTag(tag: string): Promise<void> {
    normalizeTag(tag)
    // Epoch invalidation avoids KV key enumeration and remains bounded for a tag with millions of
    // pages. Epoch keys intentionally have no expiration: an expired epoch would resurrect entries
    // written before the invalidation when their page key still exists.
    await this.kv.put(this.tagKey(tag), crypto.randomUUID())
  }

  private tagKey(tag: string): string {
    return `${KV_TAG_EPOCH_PREFIX}${encodeURIComponent(tag)}`
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

/** Ask `app` to emit its ISR headers; an app without the channel emits whatever it emits. */
export function openCacheChannel(app: object): void {
  const open: unknown = Reflect.get(app, CACHE_CHANNEL)
  if (typeof open === "function") open()
}

/** Drop the ISR headers from a response that leaves the cache layer. */
export function withoutCacheChannel(res: Response): Response {
  if (!res.headers.has(ISR_REVALIDATE_HEADER) && !res.headers.has(ISR_REVALIDATE_TAGS_HEADER)) {
    return res
  }
  try {
    res.headers.delete(ISR_REVALIDATE_HEADER)
    res.headers.delete(ISR_REVALIDATE_TAGS_HEADER)
    return res
  } catch {
    // A `fetch()` response has immutable headers: rebuild it around the same body instead.
    const headers = new Headers(res.headers)
    headers.delete(ISR_REVALIDATE_HEADER)
    headers.delete(ISR_REVALIDATE_TAGS_HEADER)
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  }
}

export interface ISROptions {
  readonly store: CacheStore
  /** Default freshness window (**seconds**) for a cached page; older ⇒ stale (served, regenerated
   * behind). A route overrides it per-page via `export const revalidate` (surfaced as the
   * `x-nifra-isr-revalidate` response header). */
  readonly revalidate: number
  /** Monotonic clock (ms) - injected for testability; production passes `() => Date.now()`. */
  readonly now: () => number
  /** Cache key for a request. Default: `origin + pathname`, plus the query parameters `query` admits,
   * so host-routed apps do not share entries across tenants. Return `null` to bypass the cache for
   * this request (it goes straight to the app, uncached). Replaces `query` entirely. */
  readonly key?: (req: Request) => string | null
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

const requestKeyOf =
  (urlKey: (url: URL) => string | null) =>
  (req: Request): string | null =>
    urlKey(new URL(req.url))

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

const requestCarriesPrivateState = (req: Request): boolean =>
  req.headers.has("authorization") || req.headers.has("cookie")

const responseIsExplicitlyPublic = (res: Response): boolean =>
  cacheControlHas(res.headers, ["public"])

// `x-nifra-data` alone is not a variation the URL key misses: a navigation data request never reads
// or writes the store, so every stored entry is the document.
const responseDeclaresVary = (res: Response): boolean => {
  const value = res.headers.get("vary")
  if (value === null) return false
  for (const part of value.split(",")) {
    const name = part.trim().toLowerCase()
    if (name !== "" && name !== "x-nifra-data") return true
  }
  return false
}

/**
 * Whether `res` may be stored by a shared cache and served to anyone requesting `req`'s URL: a
 * full-document `GET` 200 `text/html` with no Set-Cookie, no `private`/`no-store`, no `Vary` beyond
 * the data header, and, for a request carrying a cookie or Authorization, an explicit `public`.
 * The one rule both `withISR` and `@nifrajs/web/cdn` cache by.
 */
export const isCacheablePage = (req: Request, res: Response): boolean => {
  if (req.method !== "GET") return false
  if (req.headers.get("x-nifra-data") !== null) return false
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
    if (isCacheableResponseHeader(key)) out[key] = value
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

const isInvalidationResponse = (res: Response): boolean =>
  res.status === 404 || res.status === 410 || (res.status >= 300 && res.status < 400)

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
  const keyOf = options.key ?? requestKeyOf(urlKeyOf(options.query))
  const draftSecret = options.draftSecret
  const regenerating = new Set<string>()
  openCacheChannel(app)
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
  ): Promise<Response> => {
    const res = await app.fetch(req, platform)
    if (!isCacheablePage(req, res)) {
      rememberUncacheable(key, res)
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
    }
    await store.set(key, entry)
    const fresh = new Response(body, {
      status: res.status,
      headers: { ...entry.headers, [ISR_STATUS_HEADER]: "miss" },
    })
    advertise(fresh.headers, entry.revalidate, tags)
    return fresh
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
      const res = await app.fetch(req, platform)
      if (isCacheablePage(req, res)) {
        const tags = tagsOf(res)
        await store.set(key, {
          body: await res.text(),
          status: res.status,
          headers: headersOf(res),
          storedAt: now(),
          revalidate: ttlMs(res),
          ...(tags.length === 0 ? {} : { tags }),
        })
      } else if (isInvalidationResponse(res)) {
        // A successful deletion or redirect is authoritative. Keeping the old entry would make a
        // withdrawn page stay publicly visible forever because every stale request would retry the same
        // non-cacheable response while continuing to serve the old body.
        await store.delete(key)
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
    // A data-mode soft-nav GET bypasses the cache entirely: entries are full HTML documents keyed
    // by URL, and serving one to a loader-data fetch would hand the client HTML where it expects
    // the loader payload. (The write path already refuses to cache data-mode responses.)
    const key = req.method === "GET" && req.headers.get("x-nifra-data") === null ? keyOf(req) : null
    if (key === null) return withoutCacheChannel(await app.fetch(req, platform))

    // Draft/preview: an editor (valid signed cookie) always renders fresh and is never cached, so
    // unpublished content can't leak into the public cache (and the editor isn't served a stale page).
    if (draftSecret !== undefined && (await isDraftEnabled(req, draftSecret))) {
      return withoutCacheChannel(await app.fetch(req, platform))
    }

    const until = uncacheable.get(key)
    if (until !== undefined) {
      if (now() < until) return render(req, platform, key)
      uncacheable.delete(key)
    }

    const hit = await store.get(key)
    if (hit !== undefined) {
      if (now() - hit.storedAt < hit.revalidate) return served(hit, "hit")
      // Stale: serve it now, regenerate behind it (waitUntil keeps the edge worker alive for the regen).
      const task = regenerate(req, platform, key)
      if (typeof platform?.waitUntil === "function") platform.waitUntil(task)
      else void task.catch(() => {})
      return served(hit, "stale")
    }
    return render(req, platform, key)
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

export interface RevalidateEndpointOptions {
  readonly store: CacheStore
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
 * non-POST → `405`. A store without tag support returns `501` for tag requests. Mount it on a nifra route, e.g.
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
  // Joined as text, never resolved against the origin: `//host/x` must stay a path on this origin.
  const keyOf =
    options.key ??
    ((path: string, req: Request) => urlKey?.(new URL(new URL(req.url).origin + path)) ?? null)
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
      const body: unknown = await req.json().catch(() => null)
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

    for (const key of keys) await options.store.delete(key)
    for (const candidate of tags) await invalidateTag?.call(options.store, candidate)
    const done =
      path !== null
        ? { revalidated: path }
        : tag !== null
          ? { revalidatedTag: tag }
          : { revalidated: paths, revalidatedTags: tags }
    if (options.cdn === undefined) return Response.json(done)

    let outcome: CdnPurgeOutcome
    try {
      outcome = await options.cdn.purge({ tags, paths }, platform)
    } catch {
      outcome = { cdn: "failed", retryable: true, error: "cdn_purge_threw" }
    }
    if (outcome.cdn === "failed") {
      const failure: Record<string, unknown> = {
        ok: false,
        error: "cdn_purge_failed",
        origin: "done",
        retryable: outcome.retryable,
      }
      if (outcome.error !== undefined) failure.reason = outcome.error
      return Response.json(failure, { status: 502 })
    }
    return Response.json(
      { ...done, cdn: outcome.cdn },
      { status: outcome.cdn === "queued" ? 202 : 200 },
    )
  }
}

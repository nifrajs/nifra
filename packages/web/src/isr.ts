/**
 * ISR (Incremental Static Regeneration). A caching layer that sits ABOVE the agnostic SSR
 * handler: it stores a rendered `Response` keyed by URL and serves it with stale-while-revalidate
 * freshness, so dynamic pages get static-like speed and revalidate in the background. Agnostic to the
 * UI framework (it caches bytes), coupled to the runtime only through this pluggable {@link CacheStore}.
 *
 * This module is the store primitive; the SWR wrapper (`withISR`) builds on it next.
 */
import { isDraftEnabled } from "./draft.ts"
import { timingSafeEqual } from "./internal/timing-safe-equal.ts"

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

function normalizeTags(tags: readonly string[] | undefined): readonly string[] {
  if (tags === undefined) return []
  if (!Array.isArray(tags) || tags.length > MAX_ISR_TAGS) {
    throw new TypeError("[nifra/web] ISR tags must contain at most 32 bounded tokens")
  }
  const unique = new Set<string>()
  for (const tag of tags) unique.add(normalizeTag(tag))
  return Object.freeze([...unique])
}

function tagsFromHeader(value: string | null): readonly string[] {
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

export interface ISROptions {
  readonly store: CacheStore
  /** Default freshness window (**seconds**) for a cached page; older ⇒ stale (served, regenerated
   * behind). A route overrides it per-page via `export const revalidate` (surfaced as the
   * `x-nifra-isr-revalidate` response header). */
  readonly revalidate: number
  /** Monotonic clock (ms) - injected for testability; production passes `() => Date.now()`. */
  readonly now: () => number
  /** Cache key for a request. Default: `origin + pathname + search` so host-routed apps do not share
   * entries across tenants. Return `null` to bypass the cache for this request (it goes straight to the
   * app, uncached). */
  readonly key?: (req: Request) => string | null
  /** Draft/preview secret (the same one given to `createWebApp({ draftSecret })` + `enableDraft`). When
   * set, a request carrying a valid signed draft cookie **bypasses the cache** - editors always render
   * fresh, and a draft render is never written to the store (it can't poison the public cache). */
  readonly draftSecret?: string
}

const defaultKey = (req: Request): string => {
  const url = new URL(req.url)
  return url.origin + url.pathname + url.search
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

const requestCarriesPrivateState = (req: Request): boolean =>
  req.headers.has("authorization") || req.headers.has("cookie")

const responseIsExplicitlyPublic = (res: Response): boolean =>
  cacheControlHas(res.headers, ["public"])

const isCacheablePage = (req: Request, res: Response): boolean => {
  if (req.method !== "GET") return false
  if (req.headers.get("x-nifra-data") !== null) return false
  if (res.status !== 200) return false
  if (!(res.headers.get("content-type") ?? "").includes("text/html")) return false
  if (hasSetCookie(res.headers)) return false
  if (cacheControlHas(res.headers, ["private", "no-store"])) return false
  // Cookie/Authorization requests often personalize HTML without setting a new cookie. Cache them only
  // when the route explicitly declares the response public.
  if (requestCarriesPrivateState(req) && !responseIsExplicitlyPublic(res)) return false
  return true
}

const CACHEABLE_RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-language",
  "content-type",
  "etag",
  "last-modified",
  "link",
])

const tagsOf = (res: Response): readonly string[] =>
  tagsFromHeader(res.headers.get(ISR_REVALIDATE_TAGS_HEADER))

const headersOf = (res: Response): Record<string, string> => {
  const out: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    if (CACHEABLE_RESPONSE_HEADERS.has(key)) out[key] = value
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
    const normalized = key.toLowerCase()
    if (CACHEABLE_RESPONSE_HEADERS.has(normalized)) out[normalized] = value
  }
  return out
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
  const keyOf = options.key ?? defaultKey
  const draftSecret = options.draftSecret
  const regenerating = new Set<string>()

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
    if (!isCacheablePage(req, res)) return res
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
    return new Response(body, {
      status: res.status,
      headers: { ...entry.headers, [ISR_STATUS_HEADER]: "miss" },
    })
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
      } else {
        await res.body?.cancel()
      }
    } catch {
      // keep the stale entry; a later request retries the regeneration
    } finally {
      regenerating.delete(key)
    }
  }

  return async (req, platform) => {
    // A data-mode soft-nav GET bypasses the cache entirely: entries are full HTML documents keyed
    // by URL, and serving one to a loader-data fetch would hand the client HTML where it expects
    // the loader payload. (The write path already refuses to cache data-mode responses.)
    const key = req.method === "GET" && req.headers.get("x-nifra-data") === null ? keyOf(req) : null
    if (key === null) return app.fetch(req, platform)

    // Draft/preview: an editor (valid signed cookie) always renders fresh and is never cached, so
    // unpublished content can't leak into the public cache (and the editor isn't served a stale page).
    if (draftSecret !== undefined && (await isDraftEnabled(req, draftSecret))) {
      return app.fetch(req, platform)
    }

    const hit = await store.get(key)
    if (hit !== undefined) {
      if (now() - hit.storedAt < hit.revalidate) return responseFrom(hit, "hit")
      // Stale: serve it now, regenerate behind it (waitUntil keeps the edge worker alive for the regen).
      const task = regenerate(req, platform, key)
      if (typeof platform?.waitUntil === "function") platform.waitUntil(task)
      else void task.catch(() => {})
      return responseFrom(hit, "stale")
    }
    return render(req, platform, key)
  }
}

const jsonError = (status: number, error: string): Response =>
  Response.json({ ok: false, error }, { status })

export interface RevalidateEndpointOptions {
  readonly store: CacheStore
  /** Shared secret; the request's token must match it (constant-time). */
  readonly secret: string
  /** Header carrying the secret. Default `x-nifra-revalidate-token`. */
  readonly tokenHeader?: string
  /** Map a to-purge path → its cache key - MUST match the `withISR` `key` fn. The default uses the
   * revalidation request's origin plus the purged path, matching `withISR`'s default host-aware key. */
  readonly key?: (path: string, req: Request) => string
}

/**
 * An **on-demand revalidation** (purge) endpoint - a `fetch` handler that drops a path's cached entry
 * or invalidates every entry carrying a tag. `POST` with the secret in the token header and either
 * `?path=/blog/x`, `?tag=products`, or a JSON `{ "path": "/blog/x" }` / `{ "tag": "products" }` body.
 * The token is checked in **constant time** (wrong/missing → `401`); malformed targets → `400`;
 * non-POST → `405`. A store without tag support returns `501` for tag requests. Mount it on a nifra route, e.g.
 * `app.post("/__nifra/revalidate", (c) => handler(c.req))`.
 */
export function revalidateEndpoint(
  options: RevalidateEndpointOptions,
): (req: Request) => Promise<Response> {
  const tokenHeader = options.tokenHeader ?? "x-nifra-revalidate-token"
  const keyOf = options.key ?? ((path: string, req: Request) => new URL(req.url).origin + path)
  return async (req) => {
    if (req.method !== "POST") return jsonError(405, "method_not_allowed")
    if (!timingSafeEqual(req.headers.get(tokenHeader) ?? "", options.secret)) {
      return jsonError(401, "unauthorized")
    }
    const url = new URL(req.url)
    let path = url.searchParams.get("path")
    let tag = url.searchParams.get("tag")
    if (path === null && tag === null) {
      const body: unknown = await req.json().catch(() => null)
      if (typeof body === "object" && body !== null) {
        const candidate = body as { path?: unknown; tag?: unknown }
        path = typeof candidate.path === "string" ? candidate.path : null
        tag = typeof candidate.tag === "string" ? candidate.tag : null
      }
    }
    if (path !== null && tag !== null) return jsonError(400, "choose_path_or_tag")
    if (tag !== null) {
      try {
        normalizeTag(tag)
      } catch {
        return jsonError(400, "invalid_tag")
      }
      if (options.store.invalidateTag === undefined) {
        return jsonError(501, "tag_invalidation_not_supported")
      }
      await options.store.invalidateTag(tag)
      return Response.json({ revalidatedTag: tag })
    }
    if (path === null || !path.startsWith("/")) return jsonError(400, "invalid_path")
    await options.store.delete(keyOf(path, req))
    return Response.json({ revalidated: path })
  }
}

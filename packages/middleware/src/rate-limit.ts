import { NIFRA_ASSURANCE, withRouteAssurance } from "@nifrajs/core/assurance"
import type {
  Middleware,
  NodeRequestContext,
  NodeResponseContext,
  Platform,
} from "@nifrajs/core/server"
import { ipBucket } from "./_ip.ts"
import { guardName, setNodeHeader, withHeaders } from "./_utils.ts"

export interface RateLimitResult {
  /** Hits recorded in the current window, including this one. */
  readonly count: number
  /** Epoch-ms when the current window resets. */
  readonly resetAt: number
  /** No new key can be admitted without discarding an active quota. */
  readonly limited?: boolean
}

/**
 * Counter backend. Production deploys MUST use a shared store (Redis, etc.) so the
 * limit holds across instances - that's a user dependency, not ours, hence the
 * interface. {@link MemoryStore} is for dev / single-instance only.
 */
export interface RateLimitStore {
  hit(key: string, windowMs: number): Promise<RateLimitResult>
}

export interface MemoryStoreOptions {
  /** Allow the in-memory store in production. Off by default - a per-instance limiter is unsafe across instances. */
  readonly allowInProduction?: boolean
  /** Hard cap on tracked client keys; expired keys are reclaimed, and new keys fail closed at capacity. Default `100_000`.
   * Bounds memory against an unbounded key space (bot scans, per-IP buckets). */
  readonly maxKeys?: number
  /** Minimum interval (ms) between amortized sweeps of expired windows. Default `30_000`. */
  readonly sweepIntervalMs?: number
}

/** Max entries scanned (oldest-first) looking for expired capacity before refusing a new key.
 * Bounds reclamation to O(1) per insertion instead of a full O(n) sweep
 * under a distinct-key flood - the abuse the key cap defends against. */
const MAX_EVICTION_SCAN = 64

/**
 * In-process fixed-window store. Refuses to run in production unless explicitly allowed.
 *
 * Bounded against unbounded growth: expired windows are swept lazily (amortized, at most once per
 * `sweepIntervalMs`) and the key set is hard-capped at `maxKeys` (expired keys are evicted first,
 * then new keys are refused without resetting live quotas).
 * Without this, expired entries for keys never seen again - and the unbounded key space of a bot scan
 * - would accumulate in the map forever and OOM a single-instance deploy.
 */
export class MemoryStore implements RateLimitStore {
  private readonly windows = new Map<string, { count: number; resetAt: number }>()
  private readonly maxKeys: number
  private readonly sweepIntervalMs: number
  private lastSweep = 0
  private evictionScans = 0

  /** Cumulative entries inspected by the eviction scan since construction - an eviction-pressure
   * gauge. The bounded scan keeps this ~O(1) per over-cap insert (≤ {@link MAX_EVICTION_SCAN}); a
   * regressed full O(n) sweep would make it ~maxKeys per insert (what the regression test asserts). */
  get evictionScanCount(): number {
    return this.evictionScans
  }

  constructor(options: MemoryStoreOptions = {}) {
    if (options.allowInProduction !== true && process.env.NODE_ENV === "production") {
      throw new Error(
        "MemoryStore is per-instance and unsafe in production (each instance limits separately). " +
          "Use a shared store (e.g. Redis), or pass { allowInProduction: true } for a single-instance deploy.",
      )
    }
    this.maxKeys = options.maxKeys ?? 100_000
    if (!Number.isInteger(this.maxKeys) || this.maxKeys < 1) {
      throw new Error("MemoryStore: maxKeys must be a positive integer")
    }
    this.sweepIntervalMs = options.sweepIntervalMs ?? 30_000
    if (!Number.isFinite(this.sweepIntervalMs) || this.sweepIntervalMs < 0) {
      throw new Error("MemoryStore: sweepIntervalMs must be a non-negative number")
    }
  }

  hit(key: string, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now()
    // Amortized GC: at most once per sweepIntervalMs, drop every window whose reset has passed. This
    // bounds memory to ~the active key set instead of leaking an entry per distinct key ever seen.
    if (now - this.lastSweep >= this.sweepIntervalMs) {
      this.sweepExpired(now)
      this.lastSweep = now
    }
    const current = this.windows.get(key)
    if (current === undefined || now >= current.resetAt) {
      if (current === undefined && this.windows.size >= this.maxKeys && !this.reclaimExpired(now)) {
        return Promise.resolve({ count: 0, resetAt: now + windowMs, limited: true })
      }
      const fresh = { count: 1, resetAt: now + windowMs }
      this.windows.set(key, fresh)
      return Promise.resolve({ count: fresh.count, resetAt: fresh.resetAt })
    }
    current.count += 1
    return Promise.resolve({ count: current.count, resetAt: current.resetAt })
  }

  private sweepExpired(now: number): void {
    for (const [k, v] of this.windows) if (now >= v.resetAt) this.windows.delete(k)
  }

  private reclaimExpired(now: number): boolean {
    // Evicting a live quota lets a key flood reset blocked callers. Reclaim only expired entries;
    // a bounded scan keeps overflow requests from turning into full-map CPU work.
    let scanned = 0
    for (const [key, window] of this.windows) {
      this.evictionScans++
      if (now >= window.resetAt) {
        this.windows.delete(key)
        return true
      }
      if (++scanned >= MAX_EVICTION_SCAN) break
    }
    return false
  }
}

export interface RateLimitOptions {
  /** Where counters live. `MemoryStore` for dev; a shared store in production. */
  readonly store: RateLimitStore
  /** Max requests allowed per window. */
  readonly max: number
  /** Window length, in milliseconds. */
  readonly windowMs: number
  /**
   * How many trusted reverse proxies sit in front of the app and append to `X-Forwarded-For`.
   * Default `0`. Prefer the app-level `server({ clientIp: { trustedHops } })` declaration, which the
   * default key already honors; this option is for a limiter that must read XFF on its own.
   *
   * The default key reads the client IP from `X-Forwarded-For` as the address your **edge** proxy
   * observed - the entry `trustedProxies` from the right (1 proxy → the rightmost hop; 2 → the
   * second-from-right; …). Your proxies append on the right, so a client can only inject fake hops on
   * the *left*, which this skips → not spoofable when `trustedProxies` matches your topology.
   *
   * ⚠️ With the default `0`, `X-Forwarded-For` is treated as fully client-controlled and **ignored**.
   * Reading the
   * *first* XFF hop - the old behavior - let any client mint a fresh bucket per request and defeat the
   * limiter.
   */
  readonly trustedProxies?: number
  /** Exact trusted single-IP header, e.g. an infra-set `x-real-ip`. Not read unless configured. */
  readonly header?: string
  /**
   * One shared bucket for every request that {@link header}/{@link trustedProxies} cannot key. Off by
   * default because it lets one client consume the quota for everyone. Enable only for intentional
   * global throttles; with neither `header` nor `trustedProxies` set, every request shares the bucket.
   */
  readonly allowGlobalKey?: boolean
  /**
   * Bucket key for a request. Overrides the default key entirely - e.g. an authenticated user id.
   * `platform.clientIp` is the caller the app's `clientIp` trust declaration derived (the socket peer
   * when none is declared).
   */
  readonly key?: (req: Request, platform?: Platform) => string
  /**
   * Leave a request uncharged: it is not counted and carries no `RateLimit-*` headers. Runs before
   * the key is derived, so a health check or an internal probe never touches the store.
   */
  readonly skip?: (req: Request, platform?: Platform) => boolean
}

/** One bucket of a {@link rateLimitTiers} limiter: the requests at `prefix` or below it. */
export interface RateLimitTier {
  /** Static path prefix such as `/api/public`: no params, wildcards, dot segments or trailing slash. */
  readonly prefix: string
  readonly max: number
  readonly windowMs: number
  /** Bucket key for this tier only. Default: the limiter's `key`, or the derived client IP. */
  readonly key?: (req: Request, platform?: Platform) => string
}

export interface RateLimitTiersOptions extends Omit<RateLimitOptions, "max" | "windowMs"> {
  /** The bucket for every request no tier claims. */
  readonly floor: { readonly max: number; readonly windowMs: number }
  readonly tiers: readonly RateLimitTier[]
}

/**
 * The default bucket key. With nothing configured it is the caller IP the server resolved into
 * `platform.clientIp` - the raw socket peer, or the app's `clientIp` trust declaration applied to the
 * forwarding chain. `null` (no adapter-observed peer, e.g. a synthetic `app.fetch`) fails closed.
 * Every IP-derived key goes through {@link ipBucket}: an IPv6 caller counts by its /64.
 */
function defaultKey(
  req: Request,
  platform: Platform | undefined,
  trustedProxies: number,
  header: string | undefined,
  allowGlobalKey: boolean,
): string | null {
  if (header === undefined && trustedProxies === 0 && !allowGlobalKey) {
    const peer = platform?.clientIp
    return peer ? ipBucket(peer) : null
  }
  if (header !== undefined) {
    const ip = req.headers.get(header)
    if (ip !== null && ip.trim() !== "") return ipBucket(ip.trim())
  }
  if (trustedProxies > 0) {
    const xff = req.headers.get("x-forwarded-for")
    if (xff !== null) {
      const parts = xff.split(",")
      // The leftmost of the trusted suffix (your proxies append on the right) = the address your edge
      // proxy observed = the real client. A client can only prepend fakes further left, which this
      // index skips. A chain shorter than `trustedProxies` (misconfig) → undefined → fall through.
      const ip = parts[parts.length - trustedProxies]?.trim()
      if (ip !== undefined && ip !== "") return ipBucket(ip)
    }
  }
  // No trusted proxy (or XFF absent/too-short): XFF isn't trustworthy, so don't derive a per-client key
  // from it. A shared bucket is only safe when the app deliberately asked for a global throttle.
  return allowGlobalKey ? "global" : null
}

/** {@link defaultKey} against the allocation-light native request view - same logic, same order. */
function nativeKey(
  req: NodeRequestContext,
  platform: Platform | undefined,
  trustedProxies: number,
  header: string | undefined,
  allowGlobalKey: boolean,
): string | null {
  if (header === undefined && trustedProxies === 0 && !allowGlobalKey) {
    const peer = platform?.clientIp
    return peer ? ipBucket(peer) : null
  }
  if (header !== undefined) {
    const ip = req.header(header)
    if (ip !== null && ip.trim() !== "") return ipBucket(ip.trim())
  }
  if (trustedProxies > 0) {
    const xff = req.header("x-forwarded-for")
    if (xff !== null) {
      const parts = xff.split(",")
      const ip = parts[parts.length - trustedProxies]?.trim()
      if (ip !== undefined && ip !== "") return ipBucket(ip)
    }
  }
  return allowGlobalKey ? "global" : null
}

interface QuotaInfo {
  readonly limit: number
  readonly remaining: number
  readonly resetSeconds: number
}

/** A counter a request can be charged to. `scope` prefixes its store keys so buckets never share one. */
interface Bucket {
  readonly max: number
  readonly windowMs: number
  readonly scope: string
  readonly key: (req: Request, platform?: Platform) => string | null
  readonly nativeKey: ((req: NodeRequestContext, platform?: Platform) => string | null) | undefined
}

function assertWindow(max: number, windowMs: number, label: string): void {
  if (!Number.isInteger(max) || max < 1) throw new Error(`${label}: max must be a positive integer`)
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error(`${label}: windowMs must be a positive number`)
  }
}

/** The shared keying options, validated once, as the default key pair every bucket starts from. */
function defaultKeys(
  options: RateLimitOptions | RateLimitTiersOptions,
  label: string,
): Pick<Bucket, "key" | "nativeKey"> {
  const trustedProxies = options.trustedProxies ?? 0
  if (!Number.isInteger(trustedProxies) || trustedProxies < 0) {
    throw new Error(`${label}: trustedProxies must be a non-negative integer`)
  }
  const header = options.header?.trim().toLowerCase()
  if (header !== undefined && header.trim() === "") throw new Error(`${label}: header is empty`)
  const allowGlobalKey = options.allowGlobalKey === true
  if (options.key !== undefined) return { key: options.key, nativeKey: undefined }
  return {
    key: (req, platform) => defaultKey(req, platform, trustedProxies, header, allowGlobalKey),
    nativeKey: (req, platform) => nativeKey(req, platform, trustedProxies, header, allowGlobalKey),
  }
}

/**
 * The limiter both public factories build: `bucketFor` picks the one bucket a request is charged to,
 * from its pathname when `pathAware`. The Node twins exist only when every bucket can key the
 * allocation-light native request and nothing needs a real `Request` (`skip`, a custom `key`).
 */
function limiter(
  name: string,
  store: RateLimitStore,
  buckets: readonly Bucket[],
  bucketFor: (pathname: string) => Bucket,
  pathAware: boolean,
  skip: RateLimitOptions["skip"],
): Middleware {
  const quota = new WeakMap<Request, QuotaInfo>()
  // State for the Node twins, keyed by the NodeRequestContext identity (the same object is passed
  // to the request and response twins - the core identity contract that replaces `Request` keying).
  const nativeQuota = new WeakMap<object, QuotaInfo>()

  const charge = async (
    bucket: Bucket,
    key: string | null,
  ): Promise<{ info: QuotaInfo; reject: Response | undefined } | Response> => {
    if (typeof key !== "string" || key.trim() === "") {
      return Response.json({ ok: false, error: "rate_limit_key_unavailable" }, { status: 500 })
    }
    const { count, resetAt, limited } = await store.hit(bucket.scope + key, bucket.windowMs)
    const resetSeconds = Math.max(0, Math.ceil((resetAt - Date.now()) / 1000))
    const info = {
      limit: bucket.max,
      remaining: limited ? 0 : Math.max(0, bucket.max - count),
      resetSeconds,
    }
    if (limited || count > bucket.max) {
      return {
        info,
        reject: new Response(JSON.stringify({ ok: false, error: "rate_limited" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": String(resetSeconds) },
        }),
      }
    }
    return { info, reject: undefined }
  }

  const native = skip === undefined && buckets.every((bucket) => bucket.nativeKey !== undefined)
  const middleware: Middleware = {
    name,
    async onRequest(req, platform) {
      if (skip?.(req, platform) === true) return undefined
      const bucket = bucketFor(pathAware ? pathnameOf(req.url) : "")
      const outcome = await charge(bucket, bucket.key(req, platform))
      if (outcome instanceof Response) return outcome
      quota.set(req, outcome.info)
      return outcome.reject
    },
    onResponse(res, req) {
      const info = quota.get(req)
      if (info === undefined) return res
      quota.delete(req)
      return withHeaders(
        res,
        (headers) => {
          headers.set("RateLimit-Limit", String(info.limit))
          headers.set("RateLimit-Remaining", String(info.remaining))
          headers.set("RateLimit-Reset", String(info.resetSeconds))
        },
        req,
      )
    },
    ...(native
      ? {
          onNodeRequest: async (req: NodeRequestContext, platform?: Platform) => {
            const bucket = bucketFor(pathAware ? pathnameOf(req.url) : "")
            const outcome = await charge(bucket, bucket.nativeKey?.(req, platform) ?? null)
            if (outcome instanceof Response) return outcome
            nativeQuota.set(req, outcome.info)
            return outcome.reject
          },
          onNodeResponse: (res: NodeResponseContext, req: NodeRequestContext) => {
            const info = nativeQuota.get(req)
            if (info === undefined) return
            nativeQuota.delete(req)
            // Lowercase on purpose: the Web path's `Headers` lowercases names on the wire, so this
            // is byte-identical output.
            setNodeHeader(res, "ratelimit-limit", String(info.limit))
            setNodeHeader(res, "ratelimit-remaining", String(info.remaining))
            setNodeHeader(res, "ratelimit-reset", String(info.resetSeconds))
          },
        }
      : {}),
  }
  return middleware
}

/**
 * The pathname the router matches: an absolute URL's path or a raw request target, without query
 * or fragment. A dot segment is resolved the way the server resolves it before routing.
 */
function pathnameOf(url: string): string {
  let start = 0
  if (!url.startsWith("/")) {
    const authority = url.indexOf("//")
    const slash = url.indexOf("/", authority === -1 ? 0 : authority + 2)
    if (slash === -1) return "/"
    start = slash
  }
  let end = url.length
  const query = url.indexOf("?", start)
  if (query !== -1) end = query
  const hash = url.indexOf("#", start)
  if (hash !== -1 && hash < end) end = hash
  const path = url.slice(start, end)
  return DOT_SEGMENT.test(path) ? new URL(path, "http://n").pathname : path
}

const DOT_SEGMENT = /\/(?:\.|%2e)/i

/**
 * Rate limiting as a {@link Middleware}. Runs in `onRequest` (before routing, so it
 * also covers 404s); over the limit → `429` + `Retry-After`. Every response carries
 * `RateLimit-Limit/Remaining/Reset` (added in `onResponse`, keyed off the request).
 */
export function rateLimit(options: RateLimitOptions): Middleware {
  assertWindow(options.max, options.windowMs, "rateLimit")
  if (options.skip !== undefined && typeof options.skip !== "function") {
    throw new TypeError("rateLimit: skip must be a function")
  }
  const bucket: Bucket = {
    max: options.max,
    windowMs: options.windowMs,
    scope: "",
    ...defaultKeys(options, "rateLimit"),
  }
  const middleware = limiter(
    guardName("rate-limit"),
    options.store,
    [bucket],
    () => bucket,
    false,
    options.skip,
  )
  return withRouteAssurance(middleware, {
    id: NIFRA_ASSURANCE.RATE_LIMITED,
    source: "rate-limit",
    scope: "global",
  })
}

const STATIC_PREFIX = /^(?:\/[A-Za-z0-9\-._~%!$&'()+,;=@]+)+$/

function assertTierPrefix(prefix: unknown): asserts prefix is string {
  const bad = (why: string): never => {
    throw new Error(`rateLimitTiers: tier prefix ${JSON.stringify(prefix)} ${why}`)
  }
  if (typeof prefix !== "string" || !STATIC_PREFIX.test(prefix)) {
    return bad('must be a static path such as "/api/public", with no trailing slash')
  }
  for (const segment of prefix.split("/").slice(1)) {
    if (segment === "." || segment === "..") bad("must not contain a dot segment")
    if (segment.startsWith(":") || segment.startsWith("*"))
      bad("must be static: no params or wildcards")
  }
}

/**
 * Rate limiting in tiers under one app-wide floor, as a single {@link Middleware}. Every request is
 * charged to exactly one bucket: the tier with the longest `prefix` that is the request's path or an
 * ancestor of it, else the `floor`. Tiers never stack, so a tier may sit above the floor
 * (`600/min` for `/api/public` under a `120/min` floor). It runs in `onRequest`, before routing, so
 * a 404, a 405 or a body that fails validation is charged too. Prefixes are validated here; each
 * tier counts in its own keys, so tiers can share one store.
 */
export function rateLimitTiers(options: RateLimitTiersOptions): Middleware {
  const label = "rateLimitTiers"
  if (options.floor === null || typeof options.floor !== "object") {
    throw new TypeError(`${label}: floor must be { max, windowMs }`)
  }
  if (!Array.isArray(options.tiers)) throw new TypeError(`${label}: tiers must be an array`)
  if (options.skip !== undefined && typeof options.skip !== "function") {
    throw new TypeError(`${label}: skip must be a function`)
  }
  assertWindow(options.floor.max, options.floor.windowMs, `${label} floor`)
  const keys = defaultKeys(options, label)
  const floor: Bucket = {
    max: options.floor.max,
    windowMs: options.floor.windowMs,
    scope: "floor:",
    ...keys,
  }
  const seen = new Set<string>()
  const tiers: (Bucket & { readonly prefix: string })[] = []
  for (const tier of options.tiers) {
    assertTierPrefix(tier.prefix)
    if (seen.has(tier.prefix)) {
      throw new Error(`${label}: duplicate tier prefix ${JSON.stringify(tier.prefix)}`)
    }
    seen.add(tier.prefix)
    assertWindow(tier.max, tier.windowMs, `${label} tier ${tier.prefix}`)
    if (tier.key !== undefined && typeof tier.key !== "function") {
      throw new TypeError(`${label}: tier ${tier.prefix} key must be a function`)
    }
    tiers.push({
      prefix: tier.prefix,
      max: tier.max,
      windowMs: tier.windowMs,
      scope: `tier:${tier.prefix}:`,
      key: tier.key ?? keys.key,
      nativeKey: tier.key === undefined ? keys.nativeKey : undefined,
    })
  }
  // Longest first, so the first tier whose prefix holds the path is the most specific one.
  tiers.sort((a, b) => b.prefix.length - a.prefix.length)
  const bucketFor = (pathname: string): Bucket => {
    for (const tier of tiers) {
      if (
        pathname.startsWith(tier.prefix) &&
        (pathname.length === tier.prefix.length || pathname.charCodeAt(tier.prefix.length) === 47)
      ) {
        return tier
      }
    }
    return floor
  }
  const middleware = limiter(
    guardName("rate-limit-tiers"),
    options.store,
    [floor, ...tiers],
    bucketFor,
    true,
    options.skip,
  )
  return withRouteAssurance(middleware, {
    id: NIFRA_ASSURANCE.RATE_LIMITED,
    source: "rate-limit-tiers",
    scope: "global",
  })
}

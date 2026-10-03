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
  /** Hard cap on tracked client keys; expired keys are evicted first, then oldest active keys. Default `100_000`.
   * Bounds memory against an unbounded key space (bot scans, per-IP buckets). */
  readonly maxKeys?: number
  /** Minimum interval (ms) between amortized sweeps of expired windows. Default `30_000`. */
  readonly sweepIntervalMs?: number
}

/** Max entries scanned (oldest-first) per eviction looking for an expired victim before falling back
 * to evicting the oldest-inserted. Bounds eviction to O(1) per insertion instead of a full O(n) sweep
 * under a distinct-key flood - the abuse the key cap defends against. */
const MAX_EVICTION_SCAN = 64

/**
 * In-process fixed-window store. Refuses to run in production unless explicitly allowed.
 *
 * Bounded against unbounded growth: expired windows are swept lazily (amortized, at most once per
 * `sweepIntervalMs`) and the key set is hard-capped at `maxKeys` (expired keys are evicted first,
 * then oldest active keys).
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
      const fresh = { count: 1, resetAt: now + windowMs }
      this.windows.set(key, fresh)
      this.enforceMaxKeys(now)
      return Promise.resolve({ count: fresh.count, resetAt: fresh.resetAt })
    }
    current.count += 1
    return Promise.resolve({ count: current.count, resetAt: current.resetAt })
  }

  private sweepExpired(now: number): void {
    for (const [k, v] of this.windows) if (now >= v.resetAt) this.windows.delete(k)
  }

  private enforceMaxKeys(now: number): void {
    if (this.windows.size <= this.maxKeys) return
    // Prefer evicting an expired window over an active user's, but bound the work. A full sweep on
    // every insertion is O(n)/request under a distinct-key flood - the exact abuse the cap defends
    // against. Scan only a small fixed budget (oldest-first, where expired entries cluster) for a
    // victim; if none is found, evict the oldest-inserted (O(1)). Expired entries beyond the budget
    // are still reclaimed by the amortized sweep in `hit`.
    while (this.windows.size > this.maxKeys) {
      let victim: string | undefined
      let scanned = 0
      for (const [k, v] of this.windows) {
        this.evictionScans++
        if (now >= v.resetAt) {
          victim = k
          break
        }
        if (++scanned >= MAX_EVICTION_SCAN) break
      }
      if (victim === undefined) victim = this.windows.keys().next().value
      if (victim === undefined) break
      this.windows.delete(victim)
    }
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

/**
 * Rate limiting as a {@link Middleware}. Runs in `onRequest` (before routing, so it
 * also covers 404s); over the limit → `429` + `Retry-After`. Every response carries
 * `RateLimit-Limit/Remaining/Reset` (added in `onResponse`, keyed off the request).
 */
export function rateLimit(options: RateLimitOptions): Middleware {
  const { store, max, windowMs } = options
  if (!Number.isInteger(max) || max < 1)
    throw new Error("rateLimit: max must be a positive integer")
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error("rateLimit: windowMs must be a positive number")
  }
  const trustedProxies = options.trustedProxies ?? 0
  if (!Number.isInteger(trustedProxies) || trustedProxies < 0) {
    throw new Error("rateLimit: trustedProxies must be a non-negative integer")
  }
  const header = options.header?.trim().toLowerCase()
  if (header !== undefined && header.trim() === "") throw new Error("rateLimit: header is empty")
  const allowGlobalKey = options.allowGlobalKey === true
  const keyOf =
    options.key ??
    ((req: Request, platform?: Platform) =>
      defaultKey(req, platform, trustedProxies, header, allowGlobalKey))
  const quota = new WeakMap<Request, { remaining: number; resetSeconds: number }>()
  // State for the Node twins, keyed by the NodeRequestContext identity (the same object is passed
  // to the request and response twins - the core identity contract that replaces `Request` keying).
  const nativeQuota = new WeakMap<object, { remaining: number; resetSeconds: number }>()

  interface QuotaInfo {
    readonly remaining: number
    readonly resetSeconds: number
  }

  const hitStore = async (
    key: string | null,
  ): Promise<{ info: QuotaInfo; reject: Response | undefined } | Response> => {
    if (typeof key !== "string" || key.trim() === "") {
      return Response.json({ ok: false, error: "rate_limit_key_unavailable" }, { status: 500 })
    }
    const { count, resetAt } = await store.hit(key, windowMs)
    const resetSeconds = Math.max(0, Math.ceil((resetAt - Date.now()) / 1000))
    const info = { remaining: Math.max(0, max - count), resetSeconds }
    if (count > max) {
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

  const middleware: Middleware = {
    name: guardName("rate-limit"),
    async onRequest(req, platform) {
      const outcome = await hitStore(keyOf(req, platform))
      if (outcome instanceof Response) return outcome
      quota.set(req, outcome.info)
      return outcome.reject
    },
    onResponse(res, req) {
      const info = quota.get(req)
      if (info === undefined) return res
      quota.delete(req)
      return withHeaders(res, (headers) => {
        headers.set("RateLimit-Limit", String(max))
        headers.set("RateLimit-Remaining", String(info.remaining))
        headers.set("RateLimit-Reset", String(info.resetSeconds))
      })
    },
    // Node twins exist only for the built-in header/XFF key derivation - a custom `key` callback
    // takes a real `Request`, which is exactly the object the native lane avoids building.
    ...(options.key === undefined
      ? {
          onNodeRequest: async (req: NodeRequestContext, platform?: Platform) => {
            const outcome = await hitStore(
              nativeKey(req, platform, trustedProxies, header, allowGlobalKey),
            )
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
            setNodeHeader(res, "ratelimit-limit", String(max))
            setNodeHeader(res, "ratelimit-remaining", String(info.remaining))
            setNodeHeader(res, "ratelimit-reset", String(info.resetSeconds))
          },
        }
      : {}),
  }
  return withRouteAssurance(middleware, {
    id: NIFRA_ASSURANCE.RATE_LIMITED,
    source: "rate-limit",
    scope: "global",
  })
}

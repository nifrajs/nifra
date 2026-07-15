import { NIFRA_ASSURANCE, withRouteAssurance } from "@nifrajs/core/assurance"
import type { Middleware } from "@nifrajs/core/server"

export interface RateLimitResult {
  /** Hits recorded in the current window, including this one. */
  readonly count: number
  /** Epoch-ms when the current window resets. */
  readonly resetAt: number
}

/**
 * Counter backend. Production deploys MUST use a shared store (Redis, etc.) so the
 * limit holds across instances — that's a user dependency, not ours, hence the
 * interface. {@link MemoryStore} is for dev / single-instance only.
 */
export interface RateLimitStore {
  hit(key: string, windowMs: number): Promise<RateLimitResult>
}

export interface MemoryStoreOptions {
  /** Allow the in-memory store in production. Off by default — a per-instance limiter is unsafe across instances. */
  readonly allowInProduction?: boolean
  /** Hard cap on tracked client keys; expired keys are evicted first, then oldest active keys. Default `100_000`.
   * Bounds memory against an unbounded key space (bot scans, per-IP buckets). */
  readonly maxKeys?: number
  /** Minimum interval (ms) between amortized sweeps of expired windows. Default `30_000`. */
  readonly sweepIntervalMs?: number
}

/** Max entries scanned (oldest-first) per eviction looking for an expired victim before falling back
 * to evicting the oldest-inserted. Bounds eviction to O(1) per insertion instead of a full O(n) sweep
 * under a distinct-key flood — the abuse the key cap defends against. */
const MAX_EVICTION_SCAN = 64

/**
 * In-process fixed-window store. Refuses to run in production unless explicitly allowed.
 *
 * Bounded against unbounded growth: expired windows are swept lazily (amortized, at most once per
 * `sweepIntervalMs`) and the key set is hard-capped at `maxKeys` (expired keys are evicted first,
 * then oldest active keys).
 * Without this, expired entries for keys never seen again — and the unbounded key space of a bot scan
 * — would accumulate in the map forever and OOM a single-instance deploy.
 */
export class MemoryStore implements RateLimitStore {
  private readonly windows = new Map<string, { count: number; resetAt: number }>()
  private readonly maxKeys: number
  private readonly sweepIntervalMs: number
  private lastSweep = 0
  private evictionScans = 0

  /** Cumulative entries inspected by the eviction scan since construction — an eviction-pressure
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
    // every insertion is O(n)/request under a distinct-key flood — the exact abuse the cap defends
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
   * Default `0`.
   *
   * The default key reads the client IP from `X-Forwarded-For` as the address your **edge** proxy
   * observed — the entry `trustedProxies` from the right (1 proxy → the rightmost hop; 2 → the
   * second-from-right; …). Your proxies append on the right, so a client can only inject fake hops on
   * the *left*, which this skips → not spoofable when `trustedProxies` matches your topology.
   *
   * ⚠️ With the default `0`, `X-Forwarded-For` is treated as fully client-controlled and **ignored**.
   * Reading the
   * *first* XFF hop — the old behavior — let any client mint a fresh bucket per request and defeat the
   * limiter. Set `trustedProxies` (only safe behind a proxy you control that appends XFF), configure a
   * trusted single-IP {@link header}, or supply a custom {@link key} (e.g. an authenticated user id).
   */
  readonly trustedProxies?: number
  /** Exact trusted single-IP header, e.g. an infra-set `x-real-ip`. Not read unless configured. */
  readonly header?: string
  /**
   * Allow one shared bucket when no per-request key can be derived. Off by default because it lets one
   * client consume the quota for everyone. Enable only for intentional global throttles.
   */
  readonly allowGlobalKey?: boolean
  /**
   * Bucket key for a request. Overrides the default XFF-based key entirely — set this for accurate
   * per-client limiting (e.g. an authenticated user id, or a header your proxy sets). A `Middleware`
   * can't see the socket IP (that needs the server instance).
   */
  readonly key?: (req: Request) => string
}

function defaultKey(
  req: Request,
  trustedProxies: number,
  header: string | undefined,
  allowGlobalKey: boolean,
): string | null {
  if (header !== undefined) {
    const ip = req.headers.get(header)
    if (ip !== null && ip.trim() !== "") return ip.trim()
  }
  if (trustedProxies > 0) {
    const xff = req.headers.get("x-forwarded-for")
    if (xff !== null) {
      const parts = xff.split(",")
      // The leftmost of the trusted suffix (your proxies append on the right) = the address your edge
      // proxy observed = the real client. A client can only prepend fakes further left, which this
      // index skips. A chain shorter than `trustedProxies` (misconfig) → undefined → fall through.
      const ip = parts[parts.length - trustedProxies]?.trim()
      if (ip !== undefined && ip !== "") return ip
    }
  }
  // No trusted proxy (or XFF absent/too-short): XFF isn't trustworthy, so don't derive a per-client key
  // from it. A shared bucket is only safe when the app deliberately asked for a global throttle.
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
  if (
    options.key === undefined &&
    header === undefined &&
    trustedProxies === 0 &&
    !allowGlobalKey
  ) {
    throw new Error(
      "rateLimit: configure key, header, or trustedProxies; pass allowGlobalKey: true only for an intentional shared bucket",
    )
  }
  const keyOf =
    options.key ?? ((req: Request) => defaultKey(req, trustedProxies, header, allowGlobalKey))
  const quota = new WeakMap<Request, { remaining: number; resetSeconds: number }>()

  const middleware: Middleware = {
    name: "rate-limit",
    async onRequest(req) {
      const key = keyOf(req)
      if (typeof key !== "string" || key.trim() === "") {
        return Response.json({ ok: false, error: "rate_limit_key_unavailable" }, { status: 500 })
      }
      const { count, resetAt } = await store.hit(key, windowMs)
      const resetSeconds = Math.max(0, Math.ceil((resetAt - Date.now()) / 1000))
      quota.set(req, { remaining: Math.max(0, max - count), resetSeconds })
      if (count > max) {
        return new Response(JSON.stringify({ ok: false, error: "rate_limited" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": String(resetSeconds) },
        })
      }
      return undefined
    },
    onResponse(res, req) {
      const info = quota.get(req)
      if (info === undefined) return res
      quota.delete(req)
      const headers = new Headers(res.headers)
      headers.set("RateLimit-Limit", String(max))
      headers.set("RateLimit-Remaining", String(info.remaining))
      headers.set("RateLimit-Reset", String(info.resetSeconds))
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
    },
  }
  return withRouteAssurance(middleware, {
    id: NIFRA_ASSURANCE.RATE_LIMITED,
    source: "rate-limit",
    scope: "global",
  })
}

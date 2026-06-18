import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { MemoryStore, type RateLimitOptions, rateLimit } from "../src/index.ts"

function appWith(options: RateLimitOptions) {
  return server()
    .use(rateLimit(options))
    .get("/", () => "ok")
}

describe("rateLimit", () => {
  test("allows up to max, then 429 with Retry-After + RateLimit headers", async () => {
    const app = appWith({ store: new MemoryStore(), max: 2, windowMs: 60_000, key: () => "k" })

    const first = await app.fetch(new Request("http://x/"))
    expect(first.status).toBe(200)
    expect(first.headers.get("ratelimit-limit")).toBe("2")
    expect(first.headers.get("ratelimit-remaining")).toBe("1")

    const second = await app.fetch(new Request("http://x/"))
    expect(second.status).toBe(200)
    expect(second.headers.get("ratelimit-remaining")).toBe("0")

    const third = await app.fetch(new Request("http://x/"))
    expect(third.status).toBe(429)
    expect(third.headers.get("retry-after")).not.toBeNull()
    expect(third.headers.get("ratelimit-remaining")).toBe("0")
    expect(await third.json()).toEqual({ ok: false, error: "rate_limited" })
  })

  test("the window resets after windowMs", async () => {
    const app = appWith({ store: new MemoryStore(), max: 1, windowMs: 40, key: () => "k" })
    expect((await app.fetch(new Request("http://x/"))).status).toBe(200)
    expect((await app.fetch(new Request("http://x/"))).status).toBe(429)
    await Bun.sleep(60)
    expect((await app.fetch(new Request("http://x/"))).status).toBe(200)
  })

  test("MemoryStore is bounded — caps keys + sweeps expired (no unbounded growth) [AUDIT]", async () => {
    // test-only introspection of the private window map to assert it never grows without bound.
    const sizeOf = (s: MemoryStore): number =>
      (s as unknown as { windows: Map<string, unknown> }).windows.size

    // Hard cap: 50 distinct never-expiring keys with maxKeys 5 → the map stays ≤ 5 (oldest evicted).
    const capped = new MemoryStore({ maxKeys: 5, sweepIntervalMs: 0 })
    for (let i = 0; i < 50; i++) await capped.hit(`k${i}`, 60_000)
    expect(sizeOf(capped)).toBeLessThanOrEqual(5)

    // Lazy sweep: an expired window for a key never hit again is pruned on a later hit.
    const swept = new MemoryStore({ sweepIntervalMs: 0 })
    await swept.hit("ephemeral", 1)
    await Bun.sleep(5)
    await swept.hit("other", 60_000) // this hit sweeps the now-expired "ephemeral"
    expect(sizeOf(swept)).toBe(1) // only "other" remains (pre-fix: both linger forever)

    // Overflow prefers expired entries before evicting active users.
    const overflow = new MemoryStore({ maxKeys: 2, sweepIntervalMs: Number.MAX_SAFE_INTEGER })
    const windows = (
      overflow as unknown as {
        windows: Map<string, { count: number; resetAt: number }>
      }
    ).windows
    const now = Date.now()
    windows.set("active", { count: 1, resetAt: now + 60_000 })
    windows.set("expired", { count: 1, resetAt: now - 1 })
    await overflow.hit("new", 60_000)
    expect(windows.has("expired")).toBe(false)
    expect(windows.has("active")).toBe(true)
    expect(windows.has("new")).toBe(true)
    expect(sizeOf(overflow)).toBe(2)
  })

  test("eviction stays bounded under a distinct-key flood (no full sweep per insert) [AUDIT]", async () => {
    const sizeOf = (s: MemoryStore): number =>
      (s as unknown as { windows: Map<string, unknown> }).windows.size

    // Worst case for eviction: every key is fresh (long window) and the amortized sweep is disabled,
    // so each over-cap insertion hits the eviction path with no expired entry to reclaim. Measure the
    // ALGORITHM (entries scanned per over-cap insert), not wall-clock — wall-clock conflates O() with
    // machine load and flakes under a busy host. A full O(n) sweep per insertion (the pre-fix bug)
    // scans ~maxKeys entries each; the bounded scan caps at MAX_EVICTION_SCAN (64). Cap holds exactly.
    const maxKeys = 20_000
    const store = new MemoryStore({ maxKeys, sweepIntervalMs: Number.MAX_SAFE_INTEGER })
    for (let i = 0; i < maxKeys * 3; i++) await store.hit(`flood${i}`, 600_000)
    expect(sizeOf(store)).toBe(maxKeys) // hard cap held under the flood
    // First maxKeys inserts fill to the cap; the remaining 2*maxKeys each evict once.
    const overCapInserts = maxKeys * 2
    expect(store.evictionScanCount / overCapInserts).toBeLessThan(100) // ~O(1)/insert (≤64); O(n) sweep ≈ maxKeys
  })

  test("distinct keys are limited independently", async () => {
    let current = "a"
    const app = server()
      .use(rateLimit({ store: new MemoryStore(), max: 1, windowMs: 60_000, key: () => current }))
      .get("/", () => "ok")
    current = "a"
    expect((await app.fetch(new Request("http://x/"))).status).toBe(200)
    current = "b"
    expect((await app.fetch(new Request("http://x/"))).status).toBe(200)
    current = "a"
    expect((await app.fetch(new Request("http://x/"))).status).toBe(429)
  })

  test("requires a trusted key source by default instead of silently sharing one bucket", () => {
    expect(() => rateLimit({ store: new MemoryStore(), max: 1, windowMs: 60_000 })).toThrow(
      /configure key/,
    )
  })

  test("allowGlobalKey makes a deliberate shared bucket and still ignores spoofed XFF", async () => {
    const app = appWith({
      store: new MemoryStore(),
      max: 1,
      windowMs: 60_000,
      allowGlobalKey: true,
    })
    const spoof = (ip: string) => new Request("http://x/", { headers: { "x-forwarded-for": ip } })
    expect((await app.fetch(spoof("1.1.1.1"))).status).toBe(200)
    expect((await app.fetch(spoof("2.2.2.2"))).status).toBe(429) // different XFF, same shared bucket
  })

  test("with trustedProxies, default key uses the proxy-appended client hop (anti-spoof) [AUDIT Sec-3]", async () => {
    // One trusted proxy appends the real client IP on the right; the client-sent prefix is noise.
    const app = appWith({ store: new MemoryStore(), max: 1, windowMs: 60_000, trustedProxies: 1 })
    const req = (xff: string) => new Request("http://x/", { headers: { "x-forwarded-for": xff } })
    expect((await app.fetch(req("evil, 1.1.1.1"))).status).toBe(200) // client 1.1.1.1
    expect((await app.fetch(req("other, 1.1.1.1"))).status).toBe(429) // same client, new prefix → SAME bucket
    expect((await app.fetch(req("z, 2.2.2.2"))).status).toBe(200) // a different real client → its own bucket
  })

  test("default key ignores x-real-ip unless explicitly configured as trusted", async () => {
    const untrusted = appWith({
      store: new MemoryStore(),
      max: 1,
      windowMs: 60_000,
      allowGlobalKey: true,
    })
    const ipReq = () => new Request("http://x/", { headers: { "x-real-ip": "9.9.9.9" } })
    expect((await untrusted.fetch(ipReq())).status).toBe(200)
    expect(
      (await untrusted.fetch(new Request("http://x/", { headers: { "x-real-ip": "8.8.8.8" } })))
        .status,
    ).toBe(429)

    const trusted = appWith({
      store: new MemoryStore(),
      max: 1,
      windowMs: 60_000,
      header: "x-real-ip",
    })
    expect((await trusted.fetch(ipReq())).status).toBe(200)
    expect((await trusted.fetch(ipReq())).status).toBe(429)
    expect(
      (await trusted.fetch(new Request("http://x/", { headers: { "x-real-ip": "8.8.8.8" } })))
        .status,
    ).toBe(200)
  })

  test("missing configured client headers fail closed instead of falling back to global", async () => {
    const app = appWith({ store: new MemoryStore(), max: 1, windowMs: 60_000, trustedProxies: 1 })
    const res = await app.fetch(new Request("http://x/"))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: "rate_limit_key_unavailable" })
  })

  test("a custom store is honored", async () => {
    const fixed = { hit: () => Promise.resolve({ count: 99, resetAt: Date.now() + 1000 }) }
    const app = appWith({ store: fixed, max: 10, windowMs: 1000, key: () => "k" })
    expect((await app.fetch(new Request("http://x/"))).status).toBe(429)
  })

  test("onResponse without a prior onRequest leaves the response unchanged", async () => {
    const mw = rateLimit({ store: new MemoryStore(), max: 1, windowMs: 1000, key: () => "k" })
    const original = new Response("x")
    const out = await mw.onResponse?.(original, new Request("http://x/"))
    expect(out).toBe(original)
  })

  test("validates construction", () => {
    expect(() =>
      rateLimit({ store: new MemoryStore(), max: 1, windowMs: 1000, trustedProxies: -1 }),
    ).toThrow(/trustedProxies/)
    expect(() =>
      rateLimit({ store: new MemoryStore(), max: 1, windowMs: 1000, header: "" }),
    ).toThrow(/header/)
    expect(() =>
      rateLimit({ store: new MemoryStore(), max: 0, windowMs: 1000, key: () => "k" }),
    ).toThrow(/max/)
    expect(() =>
      rateLimit({ store: new MemoryStore(), max: 1, windowMs: 0, key: () => "k" }),
    ).toThrow(/windowMs/)
    expect(() =>
      rateLimit({ store: new MemoryStore(), max: 1, windowMs: 1000, header: " X-Real-IP " }),
    ).not.toThrow()
  })
})

describe("MemoryStore production guard", () => {
  test("throws under NODE_ENV=production unless explicitly allowed", () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = "production"
    try {
      expect(() => new MemoryStore()).toThrow(/production/)
      expect(() => new MemoryStore({ allowInProduction: true })).not.toThrow()
    } finally {
      // Restore (never to the string "undefined"); a sane non-prod default if it was unset.
      process.env.NODE_ENV = previous ?? "test"
    }
  })
})

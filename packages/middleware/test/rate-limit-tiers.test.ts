import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { t } from "@nifrajs/schema"
import {
  MemoryStore,
  type RateLimitStore,
  type RateLimitTiersOptions,
  rateLimit,
  rateLimitTiers,
} from "../src/index.ts"

/** A store that records every counter key it is charged, over a real MemoryStore. */
function recordingStore(): RateLimitStore & { readonly hits: string[] } {
  const inner = new MemoryStore()
  const hits: string[] = []
  return {
    hits,
    hit(key, windowMs) {
      hits.push(key)
      return inner.hit(key, windowMs)
    },
  }
}

const tiered = (
  store: RateLimitStore,
  overrides: Partial<RateLimitTiersOptions> = {},
): ReturnType<typeof rateLimitTiers> =>
  rateLimitTiers({
    store,
    key: () => "client",
    floor: { max: 2, windowMs: 60_000 },
    tiers: [
      { prefix: "/api", max: 5, windowMs: 60_000 },
      { prefix: "/api/public", max: 10, windowMs: 60_000 },
    ],
    ...overrides,
  })

const get = (
  app: { fetch(req: Request): Response | Promise<Response> },
  path: string,
  init?: RequestInit,
) => app.fetch(new Request(`http://x${path}`, init))

describe("rateLimit skip", () => {
  test("a skipped request is never charged and carries no quota headers", async () => {
    const store = recordingStore()
    const app = server()
      .use(
        rateLimit({
          store,
          max: 1,
          windowMs: 60_000,
          key: () => "k",
          skip: (req) => new URL(req.url).pathname === "/health",
        }),
      )
      .get("/health", () => "ok")
      .get("/", () => "ok")
    for (let i = 0; i < 3; i++) {
      const res = await get(app, "/health")
      expect([res.status, res.headers.get("ratelimit-limit")]).toEqual([200, null])
    }
    expect(store.hits).toEqual([])
    expect((await get(app, "/")).status).toBe(200)
    expect((await get(app, "/")).status).toBe(429)
  })
})

describe("rateLimitTiers", () => {
  test("each request is charged exactly once, to one tier", async () => {
    const store = recordingStore()
    const app = server()
      .use(tiered(store))
      .get("/", () => "home")
      .get("/api/users", () => "users")
      .get("/api/public/feed", () => "feed")
    for (const path of ["/", "/api/users", "/api/public/feed"]) await get(app, path)
    expect(store.hits).toEqual(["floor:client", "tier:/api:client", "tier:/api/public:client"])
  })

  test("the longest prefix wins, and tiers never stack on the floor", async () => {
    const store = recordingStore()
    const app = server()
      .use(tiered(store))
      .get("/api/public/feed", () => "feed")
    const statuses: number[] = []
    for (let i = 0; i < 10; i++) statuses.push((await get(app, "/api/public/feed")).status)
    expect(statuses).toEqual(Array(10).fill(200)) // above the floor's 2 and /api's 5
    const over = await get(app, "/api/public/feed")
    expect([over.status, over.headers.get("ratelimit-limit")]).toEqual([429, "10"])
  })

  test("a path beside a tier, or one that only shares its spelling, falls to the floor", async () => {
    const store = recordingStore()
    const app = server().use(
      tiered(store, { tiers: [{ prefix: "/api/public", max: 10, windowMs: 60_000 }] }),
    )
    for (const path of ["/api/other", "/api/publicity", "/api", "/API/public/x", "/api/public"]) {
      await get(app, path)
    }
    expect(store.hits).toEqual([
      "floor:client",
      "floor:client",
      "floor:client",
      "floor:client",
      "tier:/api/public:client",
    ])
  })

  test("404s and 405s under a tier prefix are charged to that tier", async () => {
    const store = recordingStore()
    const app = server()
      .use(tiered(store))
      .get("/api/public/feed", () => "feed")
    expect((await get(app, "/api/public/missing")).status).toBe(404)
    expect((await get(app, "/api/public/feed", { method: "DELETE" })).status).toBe(405)
    expect(store.hits).toEqual(["tier:/api/public:client", "tier:/api/public:client"])
  })

  test("a malformed body is charged before validation runs", async () => {
    const store = recordingStore()
    const app = server()
      .use(tiered(store))
      .post("/api/items", { body: t.object({ name: t.string() }) }, (c) => c.body.name)
    const res = await get(app, "/api/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expect(store.hits).toEqual(["tier:/api:client"])
  })

  test("a tier's own key replaces the shared key for that tier only", async () => {
    const store = recordingStore()
    const app = server().use(
      tiered(store, {
        tiers: [
          {
            prefix: "/api",
            max: 5,
            windowMs: 60_000,
            key: (req) => req.headers.get("x-user") ?? "anon",
          },
        ],
      }),
    )
    await get(app, "/api/x", { headers: { "x-user": "u1" } })
    await get(app, "/other")
    expect(store.hits).toEqual(["tier:/api:u1", "floor:client"])
  })

  test("two instances keep distinct names, so neither is deduplicated by use() or merge()", async () => {
    const outer = recordingStore()
    const inner = recordingStore()
    const first = tiered(outer)
    const second = tiered(inner)
    expect(first.name).not.toBe(second.name)
    const bundle = server().use(second)
    const app = server()
      .use(first)
      .merge(bundle)
      .get("/api/x", () => "x")
    expect((await get(app, "/api/x")).status).toBe(200)
    expect([outer.hits, inner.hits]).toEqual([["tier:/api:client"], ["tier:/api:client"]])
  })

  test("the Node lane picks the same tier from a raw request target, dot segments resolved", async () => {
    const store = recordingStore()
    const middleware = rateLimitTiers({
      store,
      floor: { max: 2, windowMs: 60_000 },
      tiers: [{ prefix: "/api/public", max: 10, windowMs: 60_000 }],
    })
    const request = (url: string) => ({ method: "GET", url, header: () => null })
    for (const url of [
      "/api/public/feed?page=2",
      "http://x/api/public",
      "/x/../api/public/a",
      "/api/%2e%2e/b",
    ]) {
      await middleware.onNodeRequest?.(request(url), { clientIp: "203.0.113.9" })
    }
    expect(store.hits).toEqual([
      "tier:/api/public:203.0.113.9",
      "tier:/api/public:203.0.113.9",
      "tier:/api/public:203.0.113.9",
      "floor:203.0.113.9",
    ])
  })

  test("a custom key or a skip keeps the limiter off the Node lane", () => {
    const store = new MemoryStore()
    const floor = { max: 1, windowMs: 1000 }
    expect(rateLimitTiers({ store, floor, tiers: [] }).onNodeRequest).toBeDefined()
    expect(
      rateLimitTiers({ store, floor, tiers: [], key: () => "k" }).onNodeRequest,
    ).toBeUndefined()
    expect(
      rateLimitTiers({ store, floor, tiers: [], skip: () => false }).onNodeRequest,
    ).toBeUndefined()
    expect(
      rateLimitTiers({ store, floor, tiers: [{ prefix: "/a", ...floor, key: () => "k" }] })
        .onNodeRequest,
    ).toBeUndefined()
    expect(rateLimit({ store, ...floor, skip: () => false }).onNodeRequest).toBeUndefined()
  })

  test("prefixes are validated when the limiter is built", () => {
    const store = new MemoryStore()
    const build = (prefix: string) => () =>
      rateLimitTiers({
        store,
        floor: { max: 1, windowMs: 1000 },
        tiers: [{ prefix, max: 1, windowMs: 1000 }],
      })
    for (const prefix of [
      "",
      "/",
      "api",
      "/api/",
      "/api//x",
      "/api/:id",
      "/api/*",
      "/api/*rest",
      "/a/../b",
      "/a/./b",
      "/a?x",
      "/a b",
    ]) {
      expect(build(prefix)).toThrow(/rateLimitTiers: tier prefix/)
    }
    expect(() =>
      rateLimitTiers({
        store,
        floor: { max: 1, windowMs: 1000 },
        tiers: [
          { prefix: "/api", max: 1, windowMs: 1000 },
          { prefix: "/api", max: 2, windowMs: 1000 },
        ],
      }),
    ).toThrow(/duplicate tier prefix "\/api"/)
    expect(() => rateLimitTiers({ store, floor: { max: 0, windowMs: 1000 }, tiers: [] })).toThrow(
      /max must be a positive integer/,
    )
  })
})

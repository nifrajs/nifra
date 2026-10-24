import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { NIFRA_ASSURANCE } from "@nifrajs/core/assurance"
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

  test("over a real socket, any method the HTTP parser accepts is charged, its 405 included", async () => {
    const store = recordingStore()
    const app = server()
      .use(tiered(store))
      .get("/api/public/feed", () => "feed")
    const running = app.listen(0, { hostname: "127.0.0.1" })
    try {
      for (const method of ["PROPFIND", "M-SEARCH", "DELETE"]) {
        const res = await fetch(`http://127.0.0.1:${running.port}/api/public/feed`, { method })
        expect([method, res.status]).toEqual([method, 405])
      }
      expect(store.hits).toEqual(Array(3).fill("tier:/api/public:client"))
    } finally {
      await app.stop()
    }
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

const secret = await crypto.subtle.importKey(
  "raw",
  new TextEncoder().encode("rate-limit-tiers-test-secret-0123"),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign", "verify"],
)

/** A `sid=<id>.<hex hmac>` cookie value, signed the way an app's session middleware would. */
async function sessionCookie(id: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", secret, new TextEncoder().encode(id))
  return `sid=${id}.${Buffer.from(mac).toString("hex")}`
}

/** The session bucket, only for a cookie whose signature verifies; anything else rejects. */
async function signedSessionKey(req: Request): Promise<string> {
  const value = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1]
  const dot = value?.lastIndexOf(".") ?? -1
  if (value === undefined || dot < 1) throw new Error("unsigned cookie")
  const id = value.slice(0, dot)
  const mac = Buffer.from(value.slice(dot + 1), "hex")
  if (!(await crypto.subtle.verify("HMAC", secret, mac, new TextEncoder().encode(id)))) {
    throw new Error("forged session")
  }
  return `session:${id}`
}

describe("rateLimitTiers async keys", () => {
  test("a verified session cookie keys its own bucket, so two sessions on one IP stay apart", async () => {
    const store = recordingStore()
    const app = server()
      .use(
        rateLimitTiers({
          store,
          floor: { max: 100, windowMs: 60_000 },
          tiers: [{ prefix: "/api", max: 1, windowMs: 60_000, key: signedSessionKey }],
        }),
      )
      .get("/api/notes", () => "notes")
    const as = (cookie: string | undefined) =>
      app.fetch(
        new Request("http://x/api/notes", cookie === undefined ? {} : { headers: { cookie } }),
        { clientIp: "203.0.113.9" },
      )
    const a = await sessionCookie("a")
    const b = await sessionCookie("b")
    expect((await as(a)).status).toBe(200)
    expect((await as(b)).status).toBe(200)
    expect((await as(a)).status).toBe(429)
    expect(store.hits).toEqual([
      "tier:/api:session:a",
      "tier:/api:session:b",
      "tier:/api:session:a",
    ])
  })

  test("a forged or missing session is charged to the client IP, never a bucket of its own", async () => {
    const store = recordingStore()
    const app = server().use(
      rateLimitTiers({
        store,
        floor: { max: 100, windowMs: 60_000 },
        tiers: [{ prefix: "/api", max: 2, windowMs: 60_000, key: signedSessionKey }],
      }),
    )
    const forged = `${(await sessionCookie("a")).slice(0, -4)}0000`
    const statuses: number[] = []
    for (const cookie of [forged, "sid=b.00", undefined]) {
      const init = cookie === undefined ? {} : { headers: { cookie } }
      const res = await app.fetch(new Request("http://x/api/notes", init), {
        clientIp: "203.0.113.9",
      })
      statuses.push(res.status)
    }
    expect(statuses).toEqual([404, 404, 429])
    expect(store.hits).toEqual(Array(3).fill("tier:/api:203.0.113.9"))
  })
})

describe("rateLimitTiers without a floor", () => {
  const floorless = (store: RateLimitStore) =>
    rateLimitTiers({ store, tiers: [{ prefix: "/api", max: 1, windowMs: 60_000 }] })

  test("a path no tier claims is neither charged nor given quota headers", async () => {
    const store = recordingStore()
    const app = server()
      .use(floorless(store))
      .get("/", () => "home")
      .get("/api/x", () => "x")
    for (let i = 0; i < 3; i++) {
      const res = await app.fetch(new Request("http://x/"), { clientIp: "203.0.113.9" })
      expect([res.status, res.headers.get("ratelimit-limit")]).toEqual([200, null])
    }
    const first = await app.fetch(new Request("http://x/api/x"), { clientIp: "203.0.113.9" })
    expect([first.status, first.headers.get("ratelimit-limit")]).toEqual([200, "1"])
    const over = await app.fetch(new Request("http://x/api/x"), { clientIp: "203.0.113.9" })
    expect(over.status).toBe(429)
    expect(store.hits).toEqual(["tier:/api:203.0.113.9", "tier:/api:203.0.113.9"])
  })

  test("the Node lane leaves an unclaimed path uncharged too", async () => {
    const store = recordingStore()
    const middleware = floorless(store)
    const request = (url: string) => ({ method: "GET", url, header: () => null })
    const platform = { clientIp: "203.0.113.9" }
    for (const url of ["/", "/apix", "/api/x"]) {
      const req = request(url)
      expect(await middleware.onNodeRequest?.(req, platform)).toBeUndefined()
      const res = { status: 200, headers: undefined, cookies: undefined, body: null }
      middleware.onNodeResponse?.(res, req)
      expect([url, res.headers?.["ratelimit-limit"]]).toEqual([
        url,
        url === "/api/x" ? "1" : undefined,
      ])
    }
    expect(store.hits).toEqual(["tier:/api:203.0.113.9"])
  })

  test("rate-limit evidence covers only the routes under a tier", () => {
    const ids = (app: ReturnType<typeof server>, path: string) =>
      app
        .routes()
        .find((route) => route.path === path)
        ?.assurance?.map((item) => item.id) ?? []
    const app = server()
      .use(floorless(new MemoryStore()))
      .get("/", () => "home")
      .get("/apix", () => "beside")
      .get("/api", () => "root")
      .get("/api/:id", () => "item")
    expect(ids(app, "/")).not.toContain(NIFRA_ASSURANCE.RATE_LIMITED)
    expect(ids(app, "/apix")).not.toContain(NIFRA_ASSURANCE.RATE_LIMITED)
    expect(ids(app, "/api")).toContain(NIFRA_ASSURANCE.RATE_LIMITED)
    expect(ids(app, "/api/:id")).toContain(NIFRA_ASSURANCE.RATE_LIMITED)
    const withFloor = server()
      .use(tiered(new MemoryStore()))
      .get("/", () => "home")
    expect(ids(withFloor, "/")).toContain(NIFRA_ASSURANCE.RATE_LIMITED)
  })

  test("prefixes are still validated when it is built, and it needs a tier", () => {
    const store = new MemoryStore()
    expect(() =>
      rateLimitTiers({ store, tiers: [{ prefix: "/api/", max: 1, windowMs: 1000 }] }),
    ).toThrow(/rateLimitTiers: tier prefix "\/api\/"/)
    expect(() => rateLimitTiers({ store, tiers: [] })).toThrow(/needs a floor or at least one tier/)
    expect(() =>
      rateLimitTiers({
        store,
        // @ts-expect-error a null floor is refused, unlike an omitted one
        floor: null,
        tiers: [{ prefix: "/a", max: 1, windowMs: 1 }],
      }),
    ).toThrow(/floor must be/)
  })
})

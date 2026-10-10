import { describe, expect, spyOn, test } from "bun:test"
import { server } from "@nifrajs/core"
import { authenticated, rejected } from "@nifrajs/core/server"
import {
  apiKey,
  type CachedResponse,
  cache,
  MemoryResponseCache,
  type ResponseCacheStore,
} from "../src/index.ts"

describe("cache() response freshness", () => {
  for (const directive of [
    "no-cache",
    'no-cache="etag"',
    "max-age=0, must-revalidate",
    "s-maxage=0, max-age=60",
  ]) {
    test(`does not reuse ${directive} without validation`, async () => {
      let calls = 0
      const app = server()
        .use(cache({ store: new MemoryResponseCache(), ttlMs: 60_000 }))
        .get(
          "/value",
          () => new Response(String(++calls), { headers: { "cache-control": directive } }),
        )
      for (const expected of ["1", "2"]) {
        const response = await app.fetch(new Request("http://x/value"))
        expect(response.headers.get("x-nifra-cache")).toBe("BYPASS")
        expect(await response.text()).toBe(expected)
      }
    })
  }

  test("rejects a pre-existing stored response that requires validation", async () => {
    const store: ResponseCacheStore = {
      get: () => ({
        status: 200,
        statusText: "",
        headers: [["cache-control", "no-cache"]],
        body: new TextEncoder().encode("old"),
        storedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }),
      set: () => {},
    }
    const app = server()
      .use(cache({ store, ttlMs: 60_000 }))
      .get("/value", () => "fresh")
    const response = await app.fetch(new Request("http://x/value"))
    expect(response.headers.get("x-nifra-cache")).toBe("MISS")
    expect(await response.json()).toBe("fresh")
  })

  for (const [directive, age, lifetime] of [
    ["max-age=2, must-revalidate", "0", 2_000],
    ["s-maxage=1, max-age=60", "0", 1_000],
    ['max-age="3"', "0", 3_000],
    ["max-age=60", "0", 10_000],
    ["max-age=10", "9", 1_000],
  ] as const) {
    test(`caps ${directive} by freshness, Age and application TTL`, async () => {
      const clock = spyOn(Date, "now").mockReturnValue(10_000)
      try {
        let calls = 0
        const entries = new Map<string, CachedResponse>()
        const store: ResponseCacheStore = {
          get: (key) => entries.get(key),
          set: (key, entry) => {
            entries.set(key, entry)
          },
          delete: (key) => {
            entries.delete(key)
          },
        }
        const app = server()
          .use(cache({ store, ttlMs: 10_000 }))
          .get(
            "/value",
            () => new Response(String(++calls), { headers: { "cache-control": directive, age } }),
          )
        await (await app.fetch(new Request("http://x/value"))).text()
        expect([...entries.values()][0]?.expiresAt).toBe(10_000 + lifetime)
        clock.mockReturnValue(10_000 + lifetime - 1)
        const hit = await app.fetch(new Request("http://x/value"))
        expect(hit.headers.get("x-nifra-cache")).toBe("HIT")
        expect(await hit.text()).toBe("1")
        clock.mockReturnValue(10_000 + lifetime)
        const expired = await app.fetch(new Request("http://x/value"))
        expect(expired.headers.get("x-nifra-cache")).toBe("MISS")
        expect(await expired.text()).toBe("2")
      } finally {
        clock.mockRestore()
      }
    })
  }

  test("an explicit response cache-control override keeps the application TTL", async () => {
    let calls = 0
    const app = server()
      .use(
        cache({
          store: new MemoryResponseCache(),
          ttlMs: 60_000,
          respectResponseCacheControl: false,
        }),
      )
      .get(
        "/value",
        () =>
          new Response(String(++calls), {
            headers: { "cache-control": "no-cache, max-age=0, must-revalidate" },
          }),
      )
    await (await app.fetch(new Request("http://x/value"))).text()
    const response = await app.fetch(new Request("http://x/value"))
    expect(response.headers.get("x-nifra-cache")).toBe("HIT")
    expect(await response.text()).toBe("1")
  })
})

describe("cache()", () => {
  test("stores and serves cacheable GET responses", async () => {
    let calls = 0
    const app = server()
      .use(cache({ store: new MemoryResponseCache(), ttlMs: 60_000 }))
      .get("/count", () => ({ calls: ++calls }))

    const first = await app.fetch(new Request("http://x/count"))
    expect(first.headers.get("x-nifra-cache")).toBe("MISS")
    expect(await first.json()).toEqual({ calls: 1 })

    const second = await app.fetch(new Request("http://x/count"))
    expect(second.headers.get("x-nifra-cache")).toBe("HIT")
    expect(second.headers.get("age")).not.toBeNull()
    expect(await second.json()).toEqual({ calls: 1 })
    expect(calls).toBe(1)
  })

  test("honors vary headers in the cache key and response", async () => {
    let calls = 0
    const app = server()
      .use(cache({ store: new MemoryResponseCache(), ttlMs: 60_000, vary: ["accept-language"] }))
      .get("/hello", (c) => ({ calls: ++calls, language: c.req.headers.get("accept-language") }))

    const en = new Request("http://x/hello", { headers: { "accept-language": "en" } })
    const fr = new Request("http://x/hello", { headers: { "accept-language": "fr" } })

    const first = await app.fetch(en)
    expect(first.headers.get("vary")).toBe("accept-language")
    expect(await first.json()).toEqual({ calls: 1, language: "en" })
    expect(await (await app.fetch(en)).json()).toEqual({ calls: 1, language: "en" })
    expect(await (await app.fetch(fr)).json()).toEqual({ calls: 2, language: "fr" })
  })

  test("bypasses storage when a response declares an unkeyed Vary header", async () => {
    let calls = 0
    const app = server()
      .use(cache({ store: new MemoryResponseCache(), ttlMs: 60_000 }))
      .get("/vary", () => {
        calls += 1
        return new Response(`v${calls}`, {
          headers: { "content-type": "text/plain", vary: "accept-language" },
        })
      })
    const first = await app.fetch(new Request("http://x/vary"))
    const second = await app.fetch(new Request("http://x/vary"))
    expect(first.headers.get("x-nifra-cache")).toBe("BYPASS")
    expect(second.headers.get("x-nifra-cache")).toBe("BYPASS")
    expect(await first.text()).toBe("v1")
    expect(await second.text()).toBe("v2")
  })

  test("returns an oversized streamed response without waiting for the clone to drain", async () => {
    const encoder = new TextEncoder()
    const app = server()
      .use(cache({ store: new MemoryResponseCache(), ttlMs: 60_000, maxBytes: 4 }))
      .get(
        "/stream",
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(encoder.encode("12345"))
              },
              pull(controller) {
                controller.enqueue(encoder.encode("67890"))
                controller.close()
              },
            }),
          ),
      )
    const result = await Promise.race([
      app.fetch(new Request("http://x/stream")),
      Bun.sleep(250).then(() => {
        throw new Error("cache response timed out")
      }),
    ])
    expect(result.headers.get("x-nifra-cache")).toBe("BYPASS")
    expect(await result.text()).toBe("1234567890")
  })

  test("respects request and response cache-control plus Set-Cookie by default", async () => {
    let calls = 0
    const app = server()
      .use(cache({ store: new MemoryResponseCache(), ttlMs: 60_000 }))
      .get("/private", () => {
        calls += 1
        return new Response(String(calls), { headers: { "cache-control": "private" } })
      })
      .get("/cookie", () => {
        calls += 1
        return new Response(String(calls), { headers: { "set-cookie": "sid=1" } })
      })
      .get("/request", () => ({ calls: ++calls }))

    const privateOne = await app.fetch(new Request("http://x/private"))
    expect(privateOne.headers.get("x-nifra-cache")).toBe("BYPASS")
    expect(await privateOne.text()).toBe("1")
    expect(await (await app.fetch(new Request("http://x/private"))).text()).toBe("2")

    const cookie = await app.fetch(new Request("http://x/cookie"))
    expect(cookie.headers.get("x-nifra-cache")).toBe("BYPASS")

    const requestNoStore = await app.fetch(
      new Request("http://x/request", { headers: { "cache-control": "no-store" } }),
    )
    expect(requestNoStore.headers.get("x-nifra-cache")).toBe("BYPASS")
  })

  test("skips oversized responses and expires entries", async () => {
    let calls = 0
    const largeApp = server()
      .use(cache({ store: new MemoryResponseCache(), ttlMs: 20, maxBytes: 4 }))
      .get("/large", () => new Response("12345"))

    const ttlApp = server()
      .use(cache({ store: new MemoryResponseCache(), ttlMs: 20 }))
      .get("/ttl", () => ({ calls: ++calls }))

    const large = await largeApp.fetch(new Request("http://x/large"))
    expect(large.headers.get("x-nifra-cache")).toBe("BYPASS")
    expect(await large.text()).toBe("12345")
    expect(await (await largeApp.fetch(new Request("http://x/large"))).text()).toBe("12345")

    expect(await (await ttlApp.fetch(new Request("http://x/ttl"))).json()).toEqual({ calls: 1 })
    expect(await (await ttlApp.fetch(new Request("http://x/ttl"))).json()).toEqual({ calls: 1 })
    await Bun.sleep(30)
    expect(await (await ttlApp.fetch(new Request("http://x/ttl"))).json()).toEqual({ calls: 2 })
  })

  test("validates construction and guards the memory store in production", () => {
    expect(() => cache({ store: new MemoryResponseCache(), ttlMs: 0 })).toThrow(/ttlMs/)
    expect(() => cache({ store: new MemoryResponseCache(), ttlMs: 1, maxBytes: -1 })).toThrow(
      /maxBytes/,
    )
    expect(() => new MemoryResponseCache({ maxEntries: 0 })).toThrow(/maxEntries/)

    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = "production"
    try {
      expect(() => new MemoryResponseCache()).toThrow(/production/)
      expect(() => new MemoryResponseCache({ allowInProduction: true })).not.toThrow()
    } finally {
      process.env.NODE_ENV = previous ?? "test"
    }
  })

  test("does NOT cache a response to an authenticated request by default (no cross-user leak)", async () => {
    let calls = 0
    const app = server()
      .use(cache({ store: new MemoryResponseCache(), ttlMs: 60_000 }))
      .get("/me", () => ({ user: ++calls }))

    const authed = (): Request =>
      new Request("http://x/me", { headers: { authorization: "Bearer t" } })
    expect((await app.fetch(authed())).headers.get("x-nifra-cache")).toBe("BYPASS")
    const second = await app.fetch(authed())
    expect(second.headers.get("x-nifra-cache")).toBe("BYPASS")
    expect(await second.json()).toEqual({ user: 2 }) // re-ran, not replayed
    const cookie = await app.fetch(new Request("http://x/me", { headers: { cookie: "s=1" } }))
    expect(cookie.headers.get("x-nifra-cache")).toBe("BYPASS")
  })

  // The write side was already guarded; the read side is the other half. An entry stored from an
  // anonymous request is a pre-auth artifact, so replaying it to a credentialed request answers
  // before the route's own authentication ever runs.
  test("an anonymously-cached entry is not replayed to a credentialed request", async () => {
    let calls = 0
    const app = server()
      .use(cache({ store: new MemoryResponseCache(), ttlMs: 60_000 }))
      .get("/feed", () => ({ n: ++calls }))

    expect((await app.fetch(new Request("http://x/feed"))).headers.get("x-nifra-cache")).toBe(
      "MISS",
    )
    expect((await app.fetch(new Request("http://x/feed"))).headers.get("x-nifra-cache")).toBe("HIT")

    const authed = await app.fetch(
      new Request("http://x/feed", { headers: { authorization: "Bearer t" } }),
    )
    expect(authed.headers.get("x-nifra-cache")).toBe("BYPASS")
    expect(await authed.json()).toEqual({ n: 2 }) // the handler ran; the stored entry was not served
  })

  test("caches an authenticated request when the response is explicitly public", async () => {
    let calls = 0
    const app = server()
      .use(cache({ store: new MemoryResponseCache(), ttlMs: 60_000 }))
      .get("/pub", (c) => {
        c.set.headers["cache-control"] = "public, max-age=60"
        return { n: ++calls }
      })
    const authed = (): Request =>
      new Request("http://x/pub", { headers: { authorization: "Bearer t" } })
    expect((await app.fetch(authed())).headers.get("x-nifra-cache")).toBe("MISS")
    const hit = await app.fetch(authed())
    expect(hit.headers.get("x-nifra-cache")).toBe("HIT")
    expect(await hit.json()).toEqual({ n: 1 })
  })
})

// A hit is served before authentication runs, so a credential header outside
// `authenticatedHeaders` must still keep the authenticated response out of the store.
describe("cache() with a credential header it does not list", () => {
  const key = "k".repeat(40)
  const call = (app: { fetch(req: Request): Response | Promise<Response> }, headers = {}) =>
    app.fetch(new Request("http://x/secret", { headers }))

  test("apiKey on a custom header: the authenticated 200 is never replayed to an anonymous caller", async () => {
    const auth = apiKey({ keys: [key], header: "x-service-key" })
    const app = server()
      .use(auth)
      .use(cache({ store: new MemoryResponseCache(), ttlMs: 60_000 }))
      .get("/secret", () => ({ secret: "payroll" }))
    const authed = await call(app, { "x-service-key": key })
    expect(authed.status).toBe(200)
    expect(authed.headers.get("x-nifra-cache")).toBe("BYPASS")
    const anon = await call(app)
    expect(anon.status).toBe(401)
    expect(await anon.text()).not.toContain("payroll")
  })

  test("an optional apiKey guard keeps the personalized response out of the store", async () => {
    const auth = apiKey({ keys: [key], header: "x-service-key", optional: true })
    const app = server()
      .use(cache({ store: new MemoryResponseCache(), ttlMs: 60_000 }))
      .use(auth)
      .get("/secret", (c) => ({ who: auth.principal(c.req) === null ? "anon" : "member" }))
    expect(await (await call(app, { "x-service-key": key })).json()).toEqual({ who: "member" })
    expect(await (await call(app)).json()).toEqual({ who: "anon" })
  })

  test("an app's own authentication stage on any header", async () => {
    let calls = 0
    const app = server()
      .use(cache({ store: new MemoryResponseCache(), ttlMs: 60_000 }))
      .authenticate({
        id: "service",
        run: (input) =>
          input.headers.get("x-tenant-token") === "t1" ? authenticated("t1") : rejected(),
      })
      .get("/secret", () => ({ n: ++calls }))
    expect((await call(app, { "x-tenant-token": "t1" })).headers.get("x-nifra-cache")).toBe(
      "BYPASS",
    )
    expect((await call(app)).status).toBe(401)
    expect((await call(app, { "x-tenant-token": "t1" })).headers.get("x-nifra-cache")).toBe(
      "BYPASS",
    )
    expect(calls).toBe(2)
  })

  test("an explicitly public response to an authenticated request is still cached", async () => {
    const auth = apiKey({ keys: [key], header: "x-service-key" })
    const app = server()
      .use(auth)
      .use(cache({ store: new MemoryResponseCache(), ttlMs: 60_000 }))
      .get("/secret", (c) => {
        c.set.headers["cache-control"] = "public, max-age=60"
        return { shared: true }
      })
    expect((await call(app, { "x-service-key": key })).headers.get("x-nifra-cache")).toBe("MISS")
    expect((await call(app, { "x-service-key": key })).headers.get("x-nifra-cache")).toBe("HIT")
  })
})

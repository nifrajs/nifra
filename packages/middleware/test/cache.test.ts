import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { cache, MemoryResponseCache } from "../src/index.ts"

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
})

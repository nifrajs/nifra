import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test"
import { type CachedResponse, type CacheStore, MemoryCacheStore } from "../src/isr.ts"

const STORE_SECRET = "isr-test-store-secret-0123456789abcdef"

const entry = (body: string): CachedResponse => ({
  body,
  status: 200,
  headers: { "content-type": "text/html" },
  storedAt: 0,
  revalidate: 60_000,
})

describe("MemoryCacheStore", () => {
  test("rejects a non-finite entry cap", () => {
    expect(() => new MemoryCacheStore({ max: Number.NaN })).toThrow(/max must be/)
  })

  test("get/set/delete round-trip", async () => {
    const store = new MemoryCacheStore()
    expect(await store.get("/a")).toBeUndefined()
    await store.set("/a", entry("A"))
    expect((await store.get("/a"))?.body).toBe("A")
    await store.set("/a", entry("A2")) // overwrite
    expect((await store.get("/a"))?.body).toBe("A2")
    await store.delete("/a")
    expect(await store.get("/a")).toBeUndefined()
    await store.delete("/missing") // no-op, no throw
  })

  test("bounded - oldest-inserted entries evict past `max`", async () => {
    const store = new MemoryCacheStore({ max: 2 })
    await store.set("/1", entry("1"))
    await store.set("/2", entry("2"))
    await store.set("/3", entry("3")) // evicts /1 (oldest)
    expect(await store.get("/1")).toBeUndefined()
    expect((await store.get("/2"))?.body).toBe("2")
    expect((await store.get("/3"))?.body).toBe("3")
  })

  test("a read bumps recency (LRU) - a frequently-read entry survives a burst of new pages [AUDIT]", async () => {
    const store = new MemoryCacheStore({ max: 2 })
    await store.set("/1", entry("1"))
    await store.set("/2", entry("2"))
    await store.get("/1") // READ /1 → most-recently-used; /2 becomes least-recently-used
    await store.set("/3", entry("3")) // evicts the LRU (/2), NOT the read-hot /1
    expect((await store.get("/1"))?.body).toBe("1") // survived because it was read (pre-fix: evicted as oldest)
    expect(await store.get("/2")).toBeUndefined() // evicted as least-recently-used
    expect((await store.get("/3"))?.body).toBe("3")
  })

  test("re-setting a key refreshes its recency (not evicted as oldest)", async () => {
    const store = new MemoryCacheStore({ max: 2 })
    await store.set("/1", entry("1"))
    await store.set("/2", entry("2"))
    await store.set("/1", entry("1b")) // touch /1 → now /2 is oldest
    await store.set("/3", entry("3")) // evicts /2
    expect((await store.get("/1"))?.body).toBe("1b")
    expect(await store.get("/2")).toBeUndefined()
    expect((await store.get("/3"))?.body).toBe("3")
  })

  test("tag invalidation makes every tagged entry miss without enumerating pages", async () => {
    const store = new MemoryCacheStore()
    await store.set("/products/1", { ...entry("one"), tags: ["products"] })
    await store.set("/products/2", { ...entry("two"), tags: ["products", "featured"] })
    await store.set("/about", { ...entry("about"), tags: ["marketing"] })

    await store.invalidateTag("products")

    expect(await store.get("/products/1")).toBeUndefined()
    expect(await store.get("/products/2")).toBeUndefined()
    expect((await store.get("/about"))?.body).toBe("about")
  })

  describe("production guard", () => {
    const prev = process.env.NODE_ENV
    afterEach(() => {
      process.env.NODE_ENV = prev ?? "test"
    })

    test("throws under NODE_ENV=production unless explicitly allowed", () => {
      process.env.NODE_ENV = "production"
      expect(() => new MemoryCacheStore()).toThrow(/per-instance and unsafe in production/)
      expect(() => new MemoryCacheStore({ allowInProduction: true })).not.toThrow()
    })

    test("allowed outside production", () => {
      process.env.NODE_ENV = "test"
      expect(() => new MemoryCacheStore()).not.toThrow()
    })
  })

  test("a purge whose mark was evicted still refuses a render that began before it", async () => {
    const store = new MemoryCacheStore({ max: 3 })
    const before = store.fence()
    await store.delete("/target")
    await store.invalidateTag("posts")
    for (let i = 0; i < 4; i++) {
      await store.delete(`/other-${i}`)
      await store.invalidateTag(`other-${i}`)
    }
    await store.set("/target", { ...entry("stale"), fence: before })
    expect(await store.get("/target")).toBeUndefined()
    await store.set("/tagged", { ...entry("stale"), tags: ["posts"], fence: before })
    expect(await store.get("/tagged")).toBeUndefined()

    const after = store.fence()
    await store.set("/target", { ...entry("fresh"), fence: after })
    expect((await store.get("/target"))?.body).toBe("fresh")
    await store.set("/tagged", { ...entry("fresh"), tags: ["posts"], fence: after })
    expect((await store.get("/tagged"))?.body).toBe("fresh")
  })
})

import {
  type ISRApp,
  type ISROptions,
  type ISRPlatform,
  type ISRStoreOp,
  withISR,
} from "../src/isr.ts"

const html = (body: string, headers: Record<string, string> = {}): Response =>
  new Response(body, { status: 200, headers: { "content-type": "text/html", ...headers } })

const pageKey = (path: string): string => `http://x${path}`

function trackApp(respond: (req: Request) => Response): { app: ISRApp; calls: () => number } {
  let calls = 0
  return {
    app: {
      fetch: async (req) => {
        calls++
        return respond(req)
      },
    },
    calls: () => calls,
  }
}

const collectWaitUntil = (): ISRPlatform & { settle: () => Promise<unknown> } => {
  const tasks: Promise<unknown>[] = []
  return { waitUntil: (p) => void tasks.push(p), settle: () => Promise.all(tasks) }
}

describe("withISR", () => {
  test("rejects a non-finite default revalidation window", () => {
    const store = new MemoryCacheStore()
    expect(() =>
      withISR({ fetch: async () => html("x") }, { store, revalidate: Number.NaN, now: () => 0 }),
    ).toThrow(/revalidate/)
  })

  test("miss renders + stores + serves (x-nifra-isr: miss)", async () => {
    const store = new MemoryCacheStore()
    const { app, calls } = trackApp(() => html("v1"))
    const handler = withISR(app, { store, revalidate: 60, now: () => 0 })
    const res = await handler(new Request("http://x/p"))
    expect(res.headers.get("x-nifra-isr")).toBe("miss")
    expect(await res.text()).toBe("v1")
    expect(calls()).toBe(1)
    expect((await store.get(pageKey("/p")))?.body).toBe("v1")
  })

  test("fresh hit serves from cache without re-rendering", async () => {
    const store = new MemoryCacheStore()
    const { app, calls } = trackApp(() => html("v1"))
    const handler = withISR(app, { store, revalidate: 60, now: () => 0 })
    await handler(new Request("http://x/p"))
    const res = await handler(new Request("http://x/p"))
    expect(res.headers.get("x-nifra-isr")).toBe("hit")
    expect(await res.text()).toBe("v1")
    expect(calls()).toBe(1)
  })

  test("a data-mode GET bypasses the cache entirely (never served a cached HTML document)", async () => {
    const store = new MemoryCacheStore()
    const { app, calls } = trackApp(() => html("v1"))
    const handler = withISR(app, { store, revalidate: 60, now: () => 0 })
    await handler(new Request("http://x/p")) // prime the cache with the document render
    const res = await handler(new Request("http://x/p", { headers: { "x-nifra-data": "1" } }))
    expect(res.headers.get("x-nifra-isr")).toBeNull() // passed through, not a cache hit
    expect(calls()).toBe(2)
  })

  test("a slot swap bypasses the cache: never served the cached document, never stored", async () => {
    const store = new MemoryCacheStore()
    const swap = { headers: { "x-nifra-swap": "results" } }
    const { app, calls } = trackApp((req) => html(req.headers.has("x-nifra-swap") ? "slot" : "v1"))
    const handler = withISR(app, { store, revalidate: 60, now: () => 0 })
    const cold = await handler(new Request("http://x/p", swap))
    expect(await cold.text()).toBe("slot")
    expect(await store.get(pageKey("/p"))).toBeUndefined()
    await handler(new Request("http://x/p"))
    const res = await handler(new Request("http://x/p", swap))
    expect(res.headers.get("x-nifra-isr")).toBeNull()
    expect(await res.text()).toBe("slot")
    expect((await store.get(pageKey("/p")))?.body).toBe("v1")
    expect(calls()).toBe(3)
  })

  test("default query policy: a query string bypasses, so distinct queries store nothing", async () => {
    const store = new MemoryCacheStore()
    const keys: string[] = []
    const spy: typeof store = Object.assign(Object.create(store), {
      get: (key: string) => {
        keys.push(key)
        return store.get(key)
      },
    })
    const { app, calls } = trackApp(() => html("v1"))
    const handler = withISR(app, {
      store: spy,
      storeSecret: STORE_SECRET,
      revalidate: 60,
      now: () => 0,
    })
    for (const query of ["?a=1", "?a=2", "?utm_source=x"]) {
      const res = await handler(new Request(`http://x/p${query}`))
      expect(res.headers.get("x-nifra-isr")).toBeNull()
    }
    expect(keys).toEqual([]) // never even looked up
    expect(calls()).toBe(3)
    expect(await store.get("http://x/p?a=1")).toBeUndefined()
    // The bare path still caches, under the path-only key.
    expect((await handler(new Request("http://x/p"))).headers.get("x-nifra-isr")).toBe("miss")
    expect((await store.get("http://x/p"))?.body).toBe("v1")
  })

  test("a query allowlist keys on those parameters only, in any order", async () => {
    const store = new MemoryCacheStore()
    const { app, calls } = trackApp((req) => html(new URL(req.url).search))
    const handler = withISR(app, { store, revalidate: 60, now: () => 0, query: ["page", "sort"] })
    expect(
      (await handler(new Request("http://x/l?sort=new&page=2"))).headers.get("x-nifra-isr"),
    ).toBe("miss")
    const reordered = await handler(new Request("http://x/l?page=2&sort=new"))
    expect(reordered.headers.get("x-nifra-isr")).toBe("hit")
    expect(await reordered.text()).toBe("?sort=new&page=2")
    expect((await store.get("http://x/l?page=2&sort=new"))?.body).toBe("?sort=new&page=2")
    // Any parameter outside the list bypasses rather than being dropped from the key.
    const extra = await handler(new Request("http://x/l?page=2&sort=new&ref=mail"))
    expect(extra.headers.get("x-nifra-isr")).toBeNull()
    expect(await extra.text()).toBe("?page=2&sort=new&ref=mail")
    // A repeated name keeps its value order, so `?tag=a&tag=b` and `?tag=b&tag=a` stay distinct.
    const tags = withISR(app, { store, revalidate: 60, now: () => 0, query: ["tag"] })
    await tags(new Request("http://x/t?tag=a&tag=b"))
    expect((await tags(new Request("http://x/t?tag=b&tag=a"))).headers.get("x-nifra-isr")).toBe(
      "miss",
    )
    expect(calls()).toBe(4)
  })

  test('query: "all" keys on the whole query string', async () => {
    const store = new MemoryCacheStore()
    const { app } = trackApp(() => html("v1"))
    const handler = withISR(app, { store, revalidate: 60, now: () => 0, query: "all" })
    expect((await handler(new Request("http://x/p?a=1"))).headers.get("x-nifra-isr")).toBe("miss")
    expect((await handler(new Request("http://x/p?a=1"))).headers.get("x-nifra-isr")).toBe("hit")
    expect((await store.get("http://x/p?a=1"))?.body).toBe("v1")
  })

  test("an invalid query policy is refused at construction", () => {
    const store = new MemoryCacheStore()
    const app = { fetch: async () => html("x") }
    for (const query of ["some", [""], [1]] as unknown as ISROptions["query"][]) {
      expect(() =>
        withISR(app, { store, revalidate: 60, now: () => 0, ...(query && { query }) }),
      ).toThrow(TypeError)
    }
  })

  test("a key whose page said no-store skips the store lookup until the memo expires", async () => {
    const store = new MemoryCacheStore()
    const gets: string[] = []
    const spy: typeof store = Object.assign(Object.create(store), {
      get: (key: string) => {
        gets.push(key)
        return store.get(key)
      },
    })
    let cacheControl = "private, no-store"
    let t = 0
    const { app, calls } = trackApp(() => html("v", { "cache-control": cacheControl }))
    const handler = withISR(app, {
      store: spy,
      storeSecret: STORE_SECRET,
      revalidate: 60,
      now: () => t,
    })
    await handler(new Request("http://x/p"))
    await handler(new Request("http://x/p"))
    expect(gets).toEqual(["http://x/p"]) // the second request went straight to the app
    expect(calls()).toBe(2)
    // Once the page becomes cacheable it is stored and the memo forgets the key.
    cacheControl = "public, max-age=0"
    expect((await handler(new Request("http://x/p"))).headers.get("x-nifra-isr")).toBe("miss")
    expect((await handler(new Request("http://x/p"))).headers.get("x-nifra-isr")).toBe("hit")
    // An expired memo looks the store up again.
    cacheControl = "no-store"
    await handler(new Request("http://x/q"))
    t = 61_000
    gets.length = 0
    await handler(new Request("http://x/q"))
    expect(gets).toEqual(["http://x/q"])
  })

  test("an anonymous refusal does not suppress a later cache lookup", async () => {
    for (const status of [401, 403] as const) {
      const store = new MemoryCacheStore()
      const gets: string[] = []
      const spy: typeof store = Object.assign(Object.create(store), {
        get: (key: string) => {
          gets.push(key)
          return store.get(key)
        },
      })
      let refused = true
      const { app } = trackApp(() =>
        refused
          ? new Response("refused", {
              status,
              headers: { "cache-control": "private, no-store", "content-type": "text/html" },
            })
          : html("PUBLIC"),
      )
      const handler = withISR(app, {
        store: spy,
        storeSecret: STORE_SECRET,
        revalidate: 60,
        now: () => 0,
      })
      const url = "http://x/private-transition"

      const denied = await handler(new Request(url))
      expect(denied.status).toBe(status)
      await denied.arrayBuffer()
      refused = false

      const recovered = await handler(new Request(url))
      expect(recovered.headers.get("x-nifra-isr")).toBe("miss")
      expect(gets).toEqual([url, url])
      await recovered.arrayBuffer()

      const warm = await handler(new Request(url))
      expect(warm.headers.get("x-nifra-isr")).toBe("hit")
      expect(gets).toEqual([url, url, url])
      await warm.arrayBuffer()
    }
  })

  test("revalidate 0 keeps no no-store memo", async () => {
    const store = new MemoryCacheStore()
    let gets = 0
    const spy: typeof store = Object.assign(Object.create(store), {
      get: (key: string) => {
        gets++
        return store.get(key)
      },
    })
    const { app } = trackApp(() => html("v", { "cache-control": "no-store" }))
    const handler = withISR(app, {
      store: spy,
      storeSecret: STORE_SECRET,
      revalidate: 0,
      now: () => 0,
    })
    await handler(new Request("http://x/p"))
    await handler(new Request("http://x/p"))
    expect(gets).toBe(2)
  })

  test("stale serves the old body + regenerates behind it (waitUntil)", async () => {
    const store = new MemoryCacheStore()
    let body = "v1"
    let t = 0
    const { app, calls } = trackApp(() => html(body))
    const handler = withISR(app, { store, revalidate: 1, now: () => t })
    await handler(new Request("http://x/p")) // miss @ t=0 (ttl 1000ms)
    body = "v2"
    t = 2000 // stale
    const plat = collectWaitUntil()
    const res = await handler(new Request("http://x/p"), plat)
    expect(res.headers.get("x-nifra-isr")).toBe("stale")
    expect(await res.text()).toBe("v1") // the stale body, served immediately
    await plat.settle()
    expect(calls()).toBe(2)
    const res2 = await handler(new Request("http://x/p"))
    expect(res2.headers.get("x-nifra-isr")).toBe("hit")
    expect(await res2.text()).toBe("v2") // regenerated
  })

  test("stale content is removed when regeneration returns 404", async () => {
    const store = new MemoryCacheStore()
    let t = 0
    let gone = false
    const app: ISRApp = {
      fetch: async () =>
        gone
          ? new Response("gone", { status: 404, headers: { "content-type": "text/html" } })
          : html("v1"),
    }
    const handler = withISR(app, { store, revalidate: 1, now: () => t })
    await handler(new Request("http://x/p"))
    gone = true
    t = 2000
    const platform = collectWaitUntil()
    const stale = await handler(new Request("http://x/p"), platform)
    expect(await stale.text()).toBe("v1")
    await platform.settle()
    expect(await store.get(pageKey("/p"))).toBeUndefined()
    expect((await handler(new Request("http://x/p"))).status).toBe(404)
  })

  test("ISR preserves security headers and does not cache a response with Vary", async () => {
    const store = new MemoryCacheStore()
    const response = () =>
      html("localized", {
        "content-security-policy": "default-src 'none'",
        "x-frame-options": "DENY",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "permissions-policy": "geolocation=()",
        "cross-origin-opener-policy": "same-origin",
        vary: "accept-language",
      })
    const { app, calls } = trackApp(response)
    const handler = withISR(app, { store, revalidate: 60, now: () => 0 })
    const first = await handler(new Request("http://x/p"))
    expect(first.headers.get("content-security-policy")).toBe("default-src 'none'")
    expect(first.headers.get("x-frame-options")).toBe("DENY")
    expect(first.headers.get("x-content-type-options")).toBe("nosniff")
    expect(first.headers.get("vary")).toBe("accept-language")
    expect(await store.get(pageKey("/p"))).toBeUndefined()
    const second = await handler(new Request("http://x/p"))
    expect(second.headers.get("content-security-policy")).toBe("default-src 'none'")
    expect(calls()).toBe(2)
  })

  test("stale without waitUntil regenerates fire-and-forget", async () => {
    const store = new MemoryCacheStore()
    let body = "v1"
    let t = 0
    const { app } = trackApp(() => html(body))
    const handler = withISR(app, { store, revalidate: 1, now: () => t })
    await handler(new Request("http://x/p"))
    body = "v2"
    t = 2000
    expect((await handler(new Request("http://x/p"))).headers.get("x-nifra-isr")).toBe("stale")
    await new Promise((r) => setTimeout(r, 10))
    expect((await store.get(pageKey("/p")))?.body).toBe("v2")
  })

  test("concurrent stale hits regenerate once (single-flight)", async () => {
    const store = new MemoryCacheStore()
    let t = 0
    const { app, calls } = trackApp(() => html("v"))
    const handler = withISR(app, { store, revalidate: 1, now: () => t })
    await handler(new Request("http://x/p"))
    t = 2000
    const plat = collectWaitUntil()
    await Promise.all([
      handler(new Request("http://x/p"), plat),
      handler(new Request("http://x/p"), plat),
    ])
    await plat.settle()
    expect(calls()).toBe(2) // one regen, not two
  })

  test("per-page x-nifra-isr-revalidate header overrides the default TTL", async () => {
    const store = new MemoryCacheStore()
    let t = 0
    const { app } = trackApp(() => html("v", { "x-nifra-isr-revalidate": "1" })) // 1s
    const handler = withISR(app, { store, revalidate: 100000, now: () => t }) // huge default
    await handler(new Request("http://x/p"))
    t = 1500 // past the 1s header TTL, under the default → header wins → stale
    expect((await handler(new Request("http://x/p"))).headers.get("x-nifra-isr")).toBe("stale")
  })

  test("tagged pages are invalidated independently of their freshness window", async () => {
    const store = new MemoryCacheStore()
    let body = "v1"
    const { app, calls } = trackApp(() => html(body, { "x-nifra-isr-tags": "products, catalog" }))
    const handler = withISR(app, { store, revalidate: 1000, now: () => 0 })

    await handler(new Request("http://x/p"))
    body = "v2"
    await store.invalidateTag("products")
    const freshAfterInvalidation = await handler(new Request("http://x/p"))

    expect(freshAfterInvalidation.headers.get("x-nifra-isr")).toBe("miss")
    expect(await freshAfterInvalidation.text()).toBe("v2")
    expect(calls()).toBe(2)
    expect((await store.get(pageKey("/p")))?.tags).toEqual(["products", "catalog"])
  })

  test("a non-numeric revalidate header falls back to the default TTL", async () => {
    const store = new MemoryCacheStore()
    let t = 0
    const { app } = trackApp(() => html("v", { "x-nifra-isr-revalidate": "abc" }))
    const handler = withISR(app, { store, revalidate: 1, now: () => t })
    await handler(new Request("http://x/p"))
    t = 2000
    expect((await handler(new Request("http://x/p"))).headers.get("x-nifra-isr")).toBe("stale")
  })

  test("non-GET + data-mode requests pass through uncached", async () => {
    const store = new MemoryCacheStore()
    const { app } = trackApp(() => html("v"))
    const handler = withISR(app, { store, revalidate: 60, now: () => 0 })
    const post = await handler(new Request("http://x/p", { method: "POST" }))
    expect(post.headers.get("x-nifra-isr")).toBeNull()
    expect(await store.get(pageKey("/p"))).toBeUndefined()
    await handler(new Request("http://x/p", { headers: { "x-nifra-data": "1" } }))
    expect(await store.get(pageKey("/p"))).toBeUndefined() // data-mode GET not cached
  })

  test("non-200 / non-html responses are not cached", async () => {
    const s1 = new MemoryCacheStore()
    const h404 = withISR(
      trackApp(() => new Response("no", { status: 404, headers: { "content-type": "text/html" } }))
        .app,
      { store: s1, revalidate: 60, now: () => 0 },
    )
    expect((await h404(new Request("http://x/p"))).status).toBe(404)
    expect(await s1.get(pageKey("/p"))).toBeUndefined()
    const s2 = new MemoryCacheStore()
    const hJson = withISR(
      trackApp(
        () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      ).app,
      { store: s2, revalidate: 60, now: () => 0 },
    )
    await hJson(new Request("http://x/q"))
    expect(await s2.get(pageKey("/q"))).toBeUndefined()
  })

  test("responses with Set-Cookie or private cache-control bypass ISR storage", async () => {
    const cookieStore = new MemoryCacheStore()
    const cookieApp = trackApp(() => html("session", { "set-cookie": "sid=1; Path=/; HttpOnly" }))
    const cookieHandler = withISR(cookieApp.app, {
      store: cookieStore,
      revalidate: 60,
      now: () => 0,
    })
    const first = await cookieHandler(new Request("http://x/account"))
    const second = await cookieHandler(new Request("http://x/account"))
    expect(first.headers.get("x-nifra-isr")).toBeNull()
    expect(second.headers.get("x-nifra-isr")).toBeNull()
    expect(cookieApp.calls()).toBe(2)
    expect(await cookieStore.get(pageKey("/account"))).toBeUndefined()

    const privateStore = new MemoryCacheStore()
    const privateApp = trackApp(() => html("private", { "cache-control": "private" }))
    const privateHandler = withISR(privateApp.app, {
      store: privateStore,
      revalidate: 60,
      now: () => 0,
    })
    await privateHandler(new Request("http://x/private"))
    expect(await privateStore.get(pageKey("/private"))).toBeUndefined()
  })

  test("cached hits never replay sensitive headers from legacy store entries", async () => {
    const store = new MemoryCacheStore()
    await store.set(pageKey("/legacy"), {
      body: "legacy",
      status: 200,
      headers: {
        "content-type": "text/html",
        "set-cookie": "sid=leaked; Path=/; HttpOnly",
        "content-security-policy": "default-src 'none'",
        "x-frame-options": "DENY",
        vary: "accept-language",
        "x-custom": "internal",
      },
      storedAt: 0,
      revalidate: 60_000,
    })
    const { app, calls } = trackApp(() => html("fresh"))
    const handler = withISR(app, { store, revalidate: 60, now: () => 0 })
    const res = await handler(new Request("http://x/legacy"))
    expect(await res.text()).toBe("legacy")
    expect(res.headers.get("x-nifra-isr")).toBe("hit")
    expect(res.headers.get("set-cookie")).toBeNull()
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'")
    expect(res.headers.get("x-frame-options")).toBe("DENY")
    expect(res.headers.get("vary")).toBe("accept-language")
    expect(res.headers.get("x-custom")).toBeNull()
    expect(calls()).toBe(0)
  })

  test("cookie or authorization requests cache only when the response is explicitly public", async () => {
    const privateStore = new MemoryCacheStore()
    const privateApp = trackApp(() => html("user"))
    const privateHandler = withISR(privateApp.app, {
      store: privateStore,
      revalidate: 60,
      now: () => 0,
    })
    await privateHandler(new Request("http://x/me", { headers: { cookie: "sid=1" } }))
    expect(await privateStore.get(pageKey("/me"))).toBeUndefined()

    const publicStore = new MemoryCacheStore()
    const publicApp = trackApp(() => html("public", { "cache-control": "public, max-age=60" }))
    const publicHandler = withISR(publicApp.app, {
      store: publicStore,
      revalidate: 60,
      now: () => 0,
    })
    await publicHandler(new Request("http://x/news", { headers: { cookie: "prefs=compact" } }))
    expect((await publicStore.get(pageKey("/news")))?.body).toBe("public")
  })

  test("default key includes origin so host-routed pages do not share cache entries", async () => {
    const store = new MemoryCacheStore()
    const app: ISRApp = {
      fetch: async (req) =>
        html(`host=${new URL(req.url).host}`, { "cache-control": "public, max-age=60" }),
    }
    const handler = withISR(app, { store, revalidate: 60, now: () => 0 })
    const first = await handler(new Request("http://tenant-a.example/account"))
    const second = await handler(new Request("http://tenant-b.example/account"))
    expect(await first.text()).toBe("host=tenant-a.example")
    expect(await second.text()).toBe("host=tenant-b.example")
    expect((await store.get("http://tenant-a.example/account"))?.body).toBe("host=tenant-a.example")
    expect((await store.get("http://tenant-b.example/account"))?.body).toBe("host=tenant-b.example")
  })

  test("a key returning null bypasses the cache", async () => {
    const store = new MemoryCacheStore()
    const { app, calls } = trackApp(() => html("v"))
    const handler = withISR(app, { store, revalidate: 60, now: () => 0, key: () => null })
    await handler(new Request("http://x/p"))
    await handler(new Request("http://x/p"))
    expect(calls()).toBe(2) // never cached
    expect(await store.get("/p")).toBeUndefined()
  })

  test("a failed regeneration keeps the stale entry served", async () => {
    const store = new MemoryCacheStore()
    let fail = false
    let t = 0
    const { app } = trackApp(() => {
      if (fail) throw new Error("render boom")
      return html("v1")
    })
    const handler = withISR(app, { store, revalidate: 1, now: () => t })
    await handler(new Request("http://x/p"))
    fail = true
    t = 2000
    const plat = collectWaitUntil()
    const res = await handler(new Request("http://x/p"), plat)
    expect(await res.text()).toBe("v1") // stale served despite the regen throwing
    await plat.settle()
    expect((await store.get(pageKey("/p")))?.body).toBe("v1") // entry unchanged
  })

  test("a fire-and-forget regen failure is swallowed (no platform, no unhandled rejection)", async () => {
    const store = new MemoryCacheStore()
    let fail = false
    let t = 0
    const { app } = trackApp(() => {
      if (fail) throw new Error("boom")
      return html("v1")
    })
    const handler = withISR(app, { store, revalidate: 1, now: () => t })
    await handler(new Request("http://x/p"))
    fail = true
    t = 2000
    const res = await handler(new Request("http://x/p")) // no platform → fire-and-forget regen
    expect(await res.text()).toBe("v1")
    await new Promise((r) => setTimeout(r, 10)) // regen rejects; the `.catch(() => {})` swallows it
    expect((await store.get(pageKey("/p")))?.body).toBe("v1")
  })

  test("a cookie request is not served the anonymous page, and does not evict it", async () => {
    const store = new MemoryCacheStore()
    const { app, calls } = trackApp((req) =>
      req.headers.has("cookie")
        ? html("ACCOUNT", { "cache-control": "private, no-store" })
        : html("LANDING"),
    )
    const handler = withISR(app, { store, revalidate: 60, now: () => 0 })
    await handler(new Request("http://x/"))
    const signedIn = await handler(new Request("http://x/", { headers: { cookie: "sid=a" } }))
    expect(await signedIn.text()).toBe("ACCOUNT")
    expect(signedIn.headers.get("cache-control")).toBe("private, no-store")
    const anonymous = await handler(new Request("http://x/"))
    expect(await anonymous.text()).toBe("LANDING")
    expect(anonymous.headers.get("x-nifra-isr")).toBe("hit")
    expect(calls()).toBe(2)
  })

  test("only anonymousCookies keep a cookie request on the cache; a custom key decides for itself", async () => {
    const store = new MemoryCacheStore()
    const { app, calls } = trackApp(() => html("SHARED", { "cache-control": "public, max-age=0" }))
    const handler = withISR(app, {
      store,
      revalidate: 60,
      now: () => 0,
      anonymousCookies: ["consent", "_ga"],
    })
    await handler(new Request("http://x/"))
    const consented = await handler(
      new Request("http://x/", { headers: { cookie: "consent=yes; _ga=GA1" } }),
    )
    expect(consented.headers.get("x-nifra-isr")).toBe("hit")
    const session = await handler(
      new Request("http://x/", { headers: { cookie: "consent=yes; sid=a" } }),
    )
    expect(session.headers.get("x-nifra-isr")).toBe("miss")
    const bearer = await handler(
      new Request("http://x/", { headers: { authorization: "Bearer a" } }),
    )
    expect(bearer.headers.get("x-nifra-isr")).toBe("miss")
    expect(calls()).toBe(3)

    const keyed = trackApp(() => html("KEYED"))
    const custom = withISR(keyed.app, {
      store: new MemoryCacheStore(),
      revalidate: 60,
      now: () => 0,
      key: (req) => new URL(req.url).pathname,
    })
    await custom(new Request("http://x/"))
    const hit = await custom(new Request("http://x/", { headers: { cookie: "sid=a" } }))
    expect(hit.headers.get("x-nifra-isr")).toBe("hit")
    expect(keyed.calls()).toBe(1)
  })

  test("a page rendered for consent-only cookies is stored like an anonymous one", async () => {
    const store = new MemoryCacheStore()
    const { app } = trackApp(() => html("PAGE"))
    const handler = withISR(app, {
      store,
      revalidate: 60,
      now: () => 0,
      anonymousCookies: ["consent"],
    })
    await handler(new Request("http://x/", { headers: { cookie: "consent=yes" } }))
    expect((await store.get(pageKey("/")))?.body).toBe("PAGE")
  })

  test("concurrent cold misses for one page share a single render", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const app: ISRApp = {
      fetch: async () => {
        calls++
        await gate
        return html("PAGE")
      },
    }
    const handler = withISR(app, { store: new MemoryCacheStore(), revalidate: 60, now: () => 0 })
    const pending = Array.from({ length: 8 }, () => handler(new Request("http://x/slow")))
    release()
    const responses = await Promise.all(pending)
    expect(calls).toBe(1)
    expect(await Promise.all(responses.map((res) => res.text()))).toEqual(Array(8).fill("PAGE"))
    expect(responses.map((res) => res.headers.get("x-nifra-isr"))).toEqual(Array(8).fill("miss"))
  })

  test("a cold render that is not stored sends each waiting miss to render for itself", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const app: ISRApp = {
      fetch: async () => {
        const call = ++calls
        await gate
        return html(`PRIVATE-${call}`, { "cache-control": "private" })
      },
    }
    const handler = withISR(app, { store: new MemoryCacheStore(), revalidate: 60, now: () => 0 })
    const pending = Array.from({ length: 3 }, () => handler(new Request("http://x/me")))
    release()
    const bodies = await Promise.all((await Promise.all(pending)).map((res) => res.text()))
    expect(calls).toBe(3)
    expect(new Set(bodies).size).toBe(3)
  })

  test("a regeneration that turns private or refused removes the stale entry; a 5xx keeps it", async () => {
    const withdrawals: readonly [string, () => Response][] = [
      ["private", () => html("mine", { "cache-control": "private, max-age=0" })],
      ["no-store", () => html("mine", { "cache-control": "no-store" })],
      [
        "401",
        () => new Response("sign in", { status: 401, headers: { "content-type": "text/html" } }),
      ],
      ["403", () => new Response("no", { status: 403, headers: { "content-type": "text/html" } })],
    ]
    for (const [label, withdrawn] of withdrawals) {
      const store = new MemoryCacheStore()
      let t = 0
      let changed = false
      const { app } = trackApp(() => (changed ? withdrawn() : html("PREVIOUS_PUBLIC")))
      const handler = withISR(app, { store, revalidate: 1, now: () => t })
      await handler(new Request("http://x/p"))
      changed = true
      t = 2000
      const plat = collectWaitUntil()
      await handler(new Request("http://x/p"), plat)
      await plat.settle()
      expect({ label, stored: await store.get(pageKey("/p")) }).toEqual({
        label,
        stored: undefined,
      })
      expect(await (await handler(new Request("http://x/p"))).text()).not.toBe("PREVIOUS_PUBLIC")
    }
    // Kept: a server failure, and a signed-in visitor's own private copy or refusal.
    const kept: readonly [string, () => Response, Record<string, string>][] = [
      [
        "503",
        () => new Response("down", { status: 503, headers: { "content-type": "text/html" } }),
        {},
      ],
      [
        "signed-in private",
        () => html("mine", { "cache-control": "private" }),
        { cookie: "sid=a" },
      ],
      ["signed-in 403", () => new Response("no", { status: 403 }), { authorization: "Bearer a" }],
    ]
    for (const [label, answer, headers] of kept) {
      const store = new MemoryCacheStore()
      let t = 0
      let changed = false
      const { app } = trackApp(() => (changed ? answer() : html("v1")))
      const handler = withISR(app, { store, revalidate: 1, now: () => t })
      await handler(new Request("http://x/p"))
      changed = true
      t = 2000
      const plat = collectWaitUntil()
      await handler(new Request("http://x/p", { headers }), plat)
      await plat.settle()
      expect({ label, body: (await store.get(pageKey("/p")))?.body }).toEqual({ label, body: "v1" })
    }
  })

  test("a regeneration that becomes a redirect removes the stale entry", async () => {
    const store = new MemoryCacheStore()
    let cacheable = true
    let t = 0
    const { app } = trackApp(() =>
      cacheable ? html("v1") : new Response("x", { status: 302, headers: { location: "/" } }),
    )
    const handler = withISR(app, { store, revalidate: 1, now: () => t })
    await handler(new Request("http://x/p"))
    cacheable = false
    t = 2000
    const plat = collectWaitUntil()
    await handler(new Request("http://x/p"), plat) // stale; regen → 302 (non-cacheable)
    await plat.settle()
    expect(await store.get(pageKey("/p"))).toBeUndefined()
    expect((await handler(new Request("http://x/p"))).status).toBe(302)
  })
})

import type { Manifest, RenderAdapter } from "../src/index.ts"
import { createWebApp } from "../src/index.ts"
import {
  type CdnPurgeOutcome,
  openCacheChannel,
  type RevalidateTags,
  revalidateEndpoint,
  withoutCacheChannel,
} from "../src/isr.ts"

describe("a route's ISR freshness and tags never reach a visitor", () => {
  const adapter: RenderAdapter = {
    renderToString: () => "<p>page</p>",
    renderToStream: () => new Blob(["<p>page</p>"]).stream(),
    hydrationHead: () => "",
  }
  const manifest: Manifest = {
    routes: [
      {
        id: "isr",
        pattern: "/isr",
        layoutIds: [],
        file: "isr.tsx",
        load: async () => ({ default: "isr", revalidate: 60, revalidateTags: ["catalog"] }),
      },
    ],
    layouts: {},
  }
  const channel = (res: Response) => [
    res.headers.get("x-nifra-isr-revalidate"),
    res.headers.get("x-nifra-isr-tags"),
  ]

  test("an app nothing caches sends neither header", async () => {
    const app = createWebApp({ adapter, manifest, clientEntry: "/c.js" })
    expect(channel(await app.fetch(new Request("http://x/isr")))).toEqual([null, null])
  })

  test("withISR strips them from stored, cached and bypassing responses alike", async () => {
    const app = createWebApp({ adapter, manifest, clientEntry: "/c.js" })
    const handler = withISR(app, { store: new MemoryCacheStore(), revalidate: 30, now: () => 0 })
    const miss = await handler(new Request("http://x/isr"))
    expect(miss.headers.get("x-nifra-isr")).toBe("miss")
    const hit = await handler(new Request("http://x/isr"))
    expect(hit.headers.get("x-nifra-isr")).toBe("hit")
    const bypass = await handler(new Request("http://x/isr?q=1"))
    expect(bypass.headers.get("x-nifra-isr")).toBeNull()
    for (const res of [miss, hit, bypass]) expect(channel(res)).toEqual([null, null])
  })

  test("a page withISR refuses to store, and a keyless bypass, carry neither header", async () => {
    const app = createWebApp({ adapter, manifest, clientEntry: "/c.js" })
    const stored = withISR(app, { store: new MemoryCacheStore(), revalidate: 30, now: () => 0 })
    const cookie = await stored(new Request("http://x/isr", { headers: { cookie: "sid=1" } }))
    expect(channel(cookie)).toEqual([null, null])
    const keyless = withISR(app, {
      store: new MemoryCacheStore(),
      revalidate: 30,
      now: () => 0,
      key: () => null,
    })
    expect(channel(await keyless(new Request("http://x/isr")))).toEqual([null, null])
  })

  test("a response with immutable headers is rebuilt around the same body", async () => {
    const res = new Response("body", {
      status: 201,
      statusText: "Made",
      headers: { "x-nifra-isr-tags": "catalog", "x-nifra-isr-revalidate": "60", "x-kept": "1" },
    })
    Object.defineProperty(res.headers, "delete", {
      value: () => {
        throw new TypeError("immutable")
      },
    })
    const out = withoutCacheChannel(res)
    expect(out).not.toBe(res)
    expect(channel(out)).toEqual([null, null])
    expect([out.status, out.statusText, out.headers.get("x-kept")]).toEqual([201, "Made", "1"])
    expect(await out.text()).toBe("body")
  })
})

describe("revalidateEndpoint (on-demand purge)", () => {
  const seed = async (store: MemoryCacheStore) => store.set(pageKey("/p"), entry("cached"))

  test("valid token + path (query) purges the entry", async () => {
    const store = new MemoryCacheStore()
    await seed(store)
    const handler = revalidateEndpoint({ store, secret: "s3cret" })
    const res = await handler(
      new Request("http://x/__nifra/revalidate?path=/p", {
        method: "POST",
        headers: { "x-nifra-revalidate-token": "s3cret" },
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ revalidated: "/p" })
    expect(await store.get(pageKey("/p"))).toBeUndefined() // purged
  })

  test("a purged path's query is keyed by the same policy withISR stores under", async () => {
    const store = new MemoryCacheStore()
    const purge = (handler: (req: Request) => Promise<Response>, path: string) =>
      handler(
        new Request("http://x/__nifra/revalidate", {
          method: "POST",
          headers: { "x-nifra-revalidate-token": "s3cret", "content-type": "application/json" },
          body: JSON.stringify({ path }),
        }),
      )
    await store.set("http://x/l?page=2&sort=new", entry("L"))
    const allowlisted = revalidateEndpoint({ store, secret: "s3cret", query: ["page", "sort"] })
    expect((await purge(allowlisted, "/l?sort=new&page=2")).status).toBe(200)
    expect(await store.get("http://x/l?page=2&sort=new")).toBeUndefined()
    // Under the default policy a query string is never cached, so there is nothing to purge.
    const res = await purge(revalidateEndpoint({ store, secret: "s3cret" }), "/l?page=2")
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, error: "uncached_query" })
    // A protocol-relative path stays a path on the endpoint's own origin.
    await store.set("http://x//evil.test/p", entry("E"))
    expect(
      (await purge(revalidateEndpoint({ store, secret: "s3cret" }), "//evil.test/p")).status,
    ).toBe(200)
    expect(await store.get("http://x//evil.test/p")).toBeUndefined()
  })

  test("reads the path from a JSON body when no query param", async () => {
    const store = new MemoryCacheStore()
    await seed(store)
    const handler = revalidateEndpoint({ store, secret: "s3cret" })
    const res = await handler(
      new Request("http://x/__nifra/revalidate", {
        method: "POST",
        headers: { "x-nifra-revalidate-token": "s3cret", "content-type": "application/json" },
        body: JSON.stringify({ path: "/p" }),
      }),
    )
    expect(res.status).toBe(200)
    expect(await store.get(pageKey("/p"))).toBeUndefined()
  })

  test("a purge body past 1 MiB is 413 before it is buffered, and purges nothing", async () => {
    const store = new MemoryCacheStore()
    await seed(store)
    const handler = revalidateEndpoint({ store, secret: "s3cret" })
    const chunk = new Uint8Array(64 * 1024).fill(0x20)
    let pulled = 0
    // No content-length: the cap has to hold while the body streams, 4 MiB on offer.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        if (pulled > 64) controller.close()
        else controller.enqueue(chunk)
      },
    })
    const res = await handler(
      new Request("http://x/__nifra/revalidate", {
        method: "POST",
        headers: { "x-nifra-revalidate-token": "s3cret", "content-type": "application/json" },
        body,
      }),
    )
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ ok: false, error: "body_too_large" })
    expect(pulled).toBeLessThanOrEqual(18)
    expect(await store.get(pageKey("/p"))).toBeDefined()
  })

  test("a wrong or missing token is 401 (and doesn't purge)", async () => {
    const store = new MemoryCacheStore()
    await seed(store)
    const handler = revalidateEndpoint({ store, secret: "s3cret" })
    // Different length → rejected by the length check.
    const shortWrong = await handler(
      new Request("http://x/__nifra/revalidate?path=/p", {
        method: "POST",
        headers: { "x-nifra-revalidate-token": "nope" },
      }),
    )
    expect(shortWrong.status).toBe(401)
    // Same length, different content → must still be rejected (the constant-time XOR path, not just
    // the length guard - proving a same-length forgery can't slip through).
    const sameLenWrong = await handler(
      new Request("http://x/__nifra/revalidate?path=/p", {
        method: "POST",
        headers: { "x-nifra-revalidate-token": "xxxxxx" }, // 6 chars, like "s3cret"
      }),
    )
    expect(sameLenWrong.status).toBe(401)
    const missing = await handler(
      new Request("http://x/__nifra/revalidate?path=/p", { method: "POST" }),
    )
    expect(missing.status).toBe(401)
    expect((await store.get(pageKey("/p")))?.body).toBe("cached") // untouched
  })

  test("an empty secret is refused at construction, never matched against a missing header", () => {
    const store = new MemoryCacheStore()
    expect(() => revalidateEndpoint({ store, secret: "" })).toThrow(/non-empty secret/)
    expect(() => revalidateEndpoint({ store, secret: "  " })).toThrow(/non-empty secret/)
    expect(() => revalidateEndpoint({ store, secret: undefined as unknown as string })).toThrow(
      /non-empty secret/,
    )
  })

  test("non-POST is 405; a missing/relative path is 400", async () => {
    const store = new MemoryCacheStore()
    const handler = revalidateEndpoint({ store, secret: "s" })
    expect((await handler(new Request("http://x/__nifra/revalidate"))).status).toBe(405) // GET
    const noPath = await handler(
      new Request("http://x/__nifra/revalidate", {
        method: "POST",
        headers: { "x-nifra-revalidate-token": "s" },
      }),
    )
    expect(noPath.status).toBe(400) // no path (body parse fails → null)
    const relative = await handler(
      new Request("http://x/__nifra/revalidate?path=relative", {
        method: "POST",
        headers: { "x-nifra-revalidate-token": "s" },
      }),
    )
    expect(relative.status).toBe(400) // not an absolute path
  })

  test("honors a custom key + token header", async () => {
    const store = new MemoryCacheStore()
    await store.set("page::/p", entry("x"))
    const handler = revalidateEndpoint({
      store,
      secret: "s",
      tokenHeader: "authorization",
      key: (path) => `page::${path}`,
    })
    const res = await handler(
      new Request("http://x/r?path=/p", { method: "POST", headers: { authorization: "s" } }),
    )
    expect(res.status).toBe(200)
    expect(await store.get("page::/p")).toBeUndefined()
  })

  test("tag purge invalidates every matching page", async () => {
    const store = new MemoryCacheStore()
    await store.set("/one", { ...entry("one"), tags: ["catalog"] })
    await store.set("/two", { ...entry("two"), tags: ["catalog"] })
    await store.set("/other", { ...entry("other"), tags: ["other"] })
    const handler = revalidateEndpoint({ store, secret: "s3cret" })

    const res = await handler(
      new Request("http://x/__nifra/revalidate?tag=catalog", {
        method: "POST",
        headers: { "x-nifra-revalidate-token": "s3cret" },
      }),
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ revalidatedTag: "catalog" })
    expect(await store.get("/one")).toBeUndefined()
    expect(await store.get("/two")).toBeUndefined()
    expect((await store.get("/other"))?.body).toBe("other")
  })
})

import { KVCacheStore, type KVNamespaceLike } from "../src/isr.ts"

// A faithful in-memory KV double - proves KVCacheStore works against the structural binding (real
// workerd KV needs wrangler + creds; this verifies the contract locally). Records puts for TTL asserts.
class FakeKV implements KVNamespaceLike {
  readonly store = new Map<string, string>()
  readonly puts: Array<{ key: string; value: string; ttl: number | undefined }> = []
  get(key: string): Promise<string | null> {
    return Promise.resolve(this.store.get(key) ?? null)
  }
  put(key: string, value: string, options?: { readonly expirationTtl?: number }): Promise<void> {
    this.puts.push({ key, value, ttl: options?.expirationTtl })
    this.store.set(key, value)
    return Promise.resolve()
  }
  delete(key: string): Promise<void> {
    this.store.delete(key)
    return Promise.resolve()
  }
}

describe("KVCacheStore", () => {
  test("set/get round-trip through KV (JSON serialized)", async () => {
    const kv = new FakeKV()
    const store = new KVCacheStore(kv)
    const e = entry("hello")
    await store.set("/p", e)
    expect(JSON.parse(kv.store.get("/p") as string)).toEqual(e) // stored as JSON
    expect(await store.get("/p")).toEqual(e) // read back + validated
  })

  test("a miss returns undefined", async () => {
    expect(await new KVCacheStore(new FakeKV()).get("/nope")).toBeUndefined()
  })

  test("a path purge reads as a miss and refuses a render begun before it", async () => {
    const kv = new FakeKV()
    const store = new KVCacheStore(kv)
    await store.set("/p", entry("x"))
    const before = store.fence()
    await store.delete("/p")
    expect(await store.get("/p")).toBeUndefined()
    await store.set("/p", { ...entry("stale"), fence: before })
    expect(await store.get("/p")).toBeUndefined()
    await store.set("/p", { ...entry("fresh"), fence: store.fence() })
    expect((await store.get("/p"))?.body).toBe("fresh")
    // The fence is the store's business, not the page's.
    expect(kv.store.get("/p")).not.toContain("fence")
  })

  describe("purges between locations", () => {
    // KV as Cloudflare runs it: a location reads its own copy, sees its own writes at once and other
    // locations' writes only after `sync`; the last write wins.
    class KVLocation implements KVNamespaceLike {
      private readonly seen = new Map<string, string>()
      private readonly origin: Map<string, string>
      constructor(origin: Map<string, string>) {
        this.origin = origin
      }
      get(key: string): Promise<string | null> {
        return Promise.resolve(this.seen.get(key) ?? null)
      }
      put(key: string, value: string): Promise<void> {
        this.origin.set(key, value)
        this.seen.set(key, value)
        return Promise.resolve()
      }
      delete(key: string): Promise<void> {
        this.origin.delete(key)
        this.seen.delete(key)
        return Promise.resolve()
      }
      sync(): void {
        this.seen.clear()
        for (const [key, value] of this.origin) this.seen.set(key, value)
      }
    }

    const race = async (purge: (store: KVCacheStore) => Promise<void>) => {
      const origin = new Map<string, string>()
      const purging = new KVLocation(origin)
      const rebuilding = new KVLocation(origin)
      const there = new KVCacheStore(purging)
      const here = new KVCacheStore(rebuilding)
      await there.set("/p", { ...entry("v1"), tags: ["post"] })
      rebuilding.sync()
      const fence = here.fence()
      await purge(there)
      await here.set("/p", { ...entry("v1"), tags: ["post"], fence })
      purging.sync()
      rebuilding.sync()
      const missed = [await there.get("/p"), await here.get("/p")]
      await here.set("/p", { ...entry("v2"), tags: ["post"], fence: here.fence() })
      purging.sync()
      return { missed, next: (await there.get("/p"))?.body }
    }

    test("a page another location rebuilt before a path purge reached it reads as a miss once it does", async () => {
      expect(await race((store) => store.delete("/p"))).toEqual({
        missed: [undefined, undefined],
        next: "v2",
      })
    })

    test("a page another location rebuilt before a tag purge reached it reads as a miss once it does", async () => {
      expect(await race((store) => store.invalidateTag("post"))).toEqual({
        missed: [undefined, undefined],
        next: "v2",
      })
    })
  })

  test("a read asks for the page and its path epoch together", async () => {
    const requested: string[] = []
    const held: Array<() => void> = []
    const kv: KVNamespaceLike = {
      get: (key) => {
        requested.push(key)
        return new Promise((resolve) => held.push(() => resolve(null)))
      },
      put: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    }
    const reading = new KVCacheStore(kv).get("/p")
    for (let turn = 0; turn < 10 && requested.length < 2; turn++) await Promise.resolve()
    expect(requested).toEqual(["/p", "__nifra_isr_path_v1:/p"])
    for (const release of held) release()
    expect(await reading).toBeUndefined()
  })

  test("a page key too long for the prefix keeps its path epoch under a digest", async () => {
    const kv = new FakeKV()
    const store = new KVCacheStore(kv)
    const long = `/${"é".repeat(250)}`
    const ascii = `/${"a".repeat(300)}`
    for (const key of [long, ascii]) {
      await store.set(key, entry("x"))
      await store.delete(key)
      expect(await store.get(key)).toBeUndefined()
      await store.set(key, { ...entry("y"), fence: store.fence() })
      expect((await store.get(key))?.body).toBe("y")
    }
    const epochKeys = kv.puts.map(({ key }) => key).filter((key) => key.startsWith("__nifra"))
    expect(epochKeys).toEqual([
      expect.stringMatching(/^__nifra_isr_path_v1#[0-9a-f]{64}$/),
      `__nifra_isr_path_v1:${ascii}`,
    ])
    expect(epochKeys.every((key) => new TextEncoder().encode(key).byteLength <= 512)).toBe(true)
  })

  test("a path epoch outlives every page stored under the epoch it replaced", async () => {
    const kv = new FakeKV()
    await new KVCacheStore(kv, { expirationTtl: 86_400 }).delete("/p")
    expect(kv.puts.at(-1)?.key).toBe("__nifra_isr_path_v1:/p")
    expect(kv.puts.at(-1)?.ttl).toBe(172_800)
    await new KVCacheStore(kv).delete("/q")
    expect(kv.puts.at(-1)?.ttl).toBeUndefined()
  })

  test("a page stored before path epochs reads as current until its path is purged", async () => {
    const kv = new FakeKV()
    const store = new KVCacheStore(kv)
    kv.store.set("/p", JSON.stringify(entry("old")))
    expect((await store.get("/p"))?.body).toBe("old")
    await store.delete("/p")
    expect(await store.get("/p")).toBeUndefined()
  })

  describe("purge order across clocks", () => {
    const TEN_MINUTES = 600_000
    afterEach(() => setSystemTime())

    test("a purge from a host whose monotonic clock stalled in sleep still refuses an earlier render", async () => {
      const kv = new FakeKV()
      const renderer = new KVCacheStore(kv)
      const purger = new KVCacheStore(kv)
      await renderer.set("/p", { ...entry("v1"), tags: ["post"] })
      const pageFence = renderer.fence()
      const tagFence = renderer.fence()
      const realNow = performance.now.bind(performance)
      const stalled = spyOn(performance, "now").mockImplementation(() => realNow() - TEN_MINUTES)
      try {
        await purger.delete("/p")
        await purger.invalidateTag("post")
      } finally {
        stalled.mockRestore()
      }
      await renderer.set("/p", { ...entry("v1"), fence: pageFence })
      expect(await renderer.get("/p")).toBeUndefined()
      await renderer.set("/q", { ...entry("v1"), tags: ["post"], fence: tagFence })
      expect(await renderer.get("/q")).toBeUndefined()
    })

    test("a wall clock stepped back after a render began cannot order a purge before it", async () => {
      const store = new KVCacheStore(new FakeKV())
      const fence = store.fence()
      setSystemTime(new Date(Date.now() - TEN_MINUTES))
      await store.invalidateTag("post")
      await store.set("/p", { ...entry("v1"), tags: ["post"], fence })
      expect(await store.get("/p")).toBeUndefined()
    })

    test("within one frozen millisecond, a purge orders after the render before it and before the one after", async () => {
      setSystemTime(new Date(Date.now() + TEN_MINUTES))
      const store = new KVCacheStore(new FakeKV())
      const before = store.fence()
      await store.delete("/p")
      const after = store.fence()
      await store.set("/p", { ...entry("stale"), fence: before })
      expect(await store.get("/p")).toBeUndefined()
      await store.set("/p", { ...entry("fresh"), fence: after })
      expect((await store.get("/p"))?.body).toBe("fresh")
    })
  })

  test("a tag epoch written before epochs carried a time fences nothing", async () => {
    const kv = new FakeKV()
    const store = new KVCacheStore(kv)
    kv.store.set("__nifra_isr_tag_v1:product", crypto.randomUUID())
    await store.set("/p", { ...entry("x"), tags: ["product"], fence: store.fence() })
    expect((await store.get("/p"))?.body).toBe("x")
  })

  test("a corrupt (non-JSON) entry reads as a miss, not a throw", async () => {
    const kv = new FakeKV()
    kv.store.set("/p", "}{ not json")
    expect(await new KVCacheStore(kv).get("/p")).toBeUndefined()
  })

  test("an entry Response could not replay reads as a miss, and withISR renders", async () => {
    const valid = { body: "h", status: 200, storedAt: 0, revalidate: 60_000, headers: {} }
    const corrupt: Record<string, unknown>[] = [
      { ...valid, status: 999 },
      { ...valid, status: 200.5 },
      { ...valid, status: 101 },
      { ...valid, storedAt: Number.NaN },
      { ...valid, revalidate: -1 },
      { ...valid, headers: ["content-type", "text/html"] },
      { ...valid, headers: { "bad name": "x" } },
      { ...valid, headers: { "x-a": "line\r\nbreak" } },
    ]
    for (const record of corrupt) {
      const kv = new FakeKV()
      kv.store.set("/p", JSON.stringify(record))
      expect({ record, read: await new KVCacheStore(kv).get("/p") }).toEqual({
        record,
        read: undefined,
      })
    }
    const kv = new FakeKV()
    kv.store.set("http://x/p", JSON.stringify({ ...valid, status: 999 }))
    const handler = withISR(
      { fetch: async () => html("fresh") },
      {
        store: new KVCacheStore(kv),
        storeSecret: STORE_SECRET,
        revalidate: 60,
        now: () => 0,
      },
    )
    expect(await (await handler(new Request("http://x/p"))).text()).toBe("fresh")
  })

  test("a valid-JSON but wrong-shape entry reads as a miss", async () => {
    const kv = new FakeKV()
    const store = new KVCacheStore(kv)
    kv.store.set("/bad-top", JSON.stringify({ body: 123 })) // body not a string
    expect(await store.get("/bad-top")).toBeUndefined()
    kv.store.set(
      "/bad-headers",
      JSON.stringify({ body: "h", status: 200, storedAt: 0, revalidate: 1, headers: { x: 9 } }),
    ) // a non-string header value
    expect(await store.get("/bad-headers")).toBeUndefined()
    kv.store.set("/null", JSON.stringify(null)) // null is typeof "object"
    expect(await store.get("/null")).toBeUndefined()
  })

  test("expirationTtl is forwarded to KV put as a GC backstop", async () => {
    const kv = new FakeKV()
    const store = new KVCacheStore(kv, { expirationTtl: 86_400 })
    await store.set("/p", entry("x"))
    expect(kv.puts.at(-1)?.ttl).toBe(86_400)
    // No TTL configured ⇒ put gets no expiration (entries persist until overwritten/purged).
    const plain = new KVCacheStore(kv)
    await plain.set("/q", entry("y"))
    expect(kv.puts.at(-1)?.ttl).toBeUndefined()
  })

  test("tag invalidation uses a KV tag epoch and does not enumerate page keys", async () => {
    const kv = new FakeKV()
    const store = new KVCacheStore(kv)
    await store.set("/one", { ...entry("one"), tags: ["catalog"] })
    await store.set("/two", { ...entry("two"), tags: ["catalog"] })

    await store.invalidateTag("catalog")

    expect(await store.get("/one")).toBeUndefined()
    expect(await store.get("/two")).toBeUndefined()
    expect([...kv.store.keys()].some((key) => key === "/one" || key === "/two")).toBe(true)
  })

  test("rejects an expirationTtl below KV's 60s minimum", () => {
    expect(() => new KVCacheStore(new FakeKV(), { expirationTtl: 30 })).toThrow(/>= 60/)
    expect(() => new KVCacheStore(new FakeKV(), { expirationTtl: 60 })).not.toThrow()
  })

  test("the 60s floor belongs to the binding, not to the store", async () => {
    // KVNamespaceLike is structural, so Redis/Deno KV/Upstash satisfy it too - and they accept TTLs
    // Cloudflare would reject. Their floor is theirs to declare.
    expect(
      () => new KVCacheStore(new FakeKV(), { expirationTtl: 30, minExpirationTtl: 30 }),
    ).not.toThrow()
    expect(
      () => new KVCacheStore(new FakeKV(), { expirationTtl: 1, minExpirationTtl: 0 }),
    ).not.toThrow()
    // A declared floor is still enforced; lowering it is a statement about the backend, not a bypass.
    expect(
      () => new KVCacheStore(new FakeKV(), { expirationTtl: 5, minExpirationTtl: 10 }),
    ).toThrow(/>= 10/)

    // And the TTL still reaches the binding.
    const kv = new FakeKV()
    const store = new KVCacheStore(kv, { expirationTtl: 30, minExpirationTtl: 30 })
    await store.set("/p", {
      body: "<html>x</html>",
      status: 200,
      headers: {},
      storedAt: 0,
      revalidate: 1_000,
    })
    expect(kv.puts.at(-1)?.ttl).toBe(30)
  })

  test("a malformed expirationTtl or floor is rejected outright", () => {
    expect(() => new KVCacheStore(new FakeKV(), { expirationTtl: 60.5 })).toThrow(/non-negative/)
    expect(() => new KVCacheStore(new FakeKV(), { expirationTtl: -1 })).toThrow(/non-negative/)
    expect(() => new KVCacheStore(new FakeKV(), { minExpirationTtl: -1 })).toThrow(/non-negative/)
  })
})

describe("withISR over KVCacheStore (the production store path)", () => {
  test("drives miss → hit → stale → regenerate identically to the memory store", async () => {
    const kv = new FakeKV()
    const store = new KVCacheStore(kv)
    let body = "v1"
    let t = 0
    const { app, calls } = trackApp(() => html(body))
    const handler = withISR(app, { store, storeSecret: STORE_SECRET, revalidate: 1, now: () => t })

    const miss = await handler(new Request("http://x/p"))
    expect(miss.headers.get("x-nifra-isr")).toBe("miss")
    expect(await miss.text()).toBe("v1")
    expect(JSON.parse(kv.store.get(pageKey("/p")) as string).body).toBe("v1") // persisted through KV

    const hit = await handler(new Request("http://x/p")) // still fresh
    expect(hit.headers.get("x-nifra-isr")).toBe("hit")
    expect(calls()).toBe(1) // no re-render on a hit

    body = "v2"
    t = 2000 // stale
    const plat = collectWaitUntil()
    const stale = await handler(new Request("http://x/p"), plat)
    expect(stale.headers.get("x-nifra-isr")).toBe("stale")
    expect(await stale.text()).toBe("v1") // stale body served immediately
    await plat.settle()
    expect(calls()).toBe(2) // regenerated behind it

    const fresh = await handler(new Request("http://x/p"))
    expect(await fresh.text()).toBe("v2") // KV now holds the regenerated body
  })

  test("a purge (revalidateEndpoint) against the shared KV store forces a re-render", async () => {
    const kv = new FakeKV()
    const store = new KVCacheStore(kv)
    let t = 0
    const { app, calls } = trackApp(() => html("v"))
    const handler = withISR(app, {
      store,
      storeSecret: STORE_SECRET,
      revalidate: 1000,
      now: () => t,
    }) // long freshness
    const purge = revalidateEndpoint({ store, secret: "s" })

    await handler(new Request("http://x/p")) // miss → cached
    expect((await handler(new Request("http://x/p"))).headers.get("x-nifra-isr")).toBe("hit")
    expect(calls()).toBe(1)

    t = 1 // still well within the 1000s window - only a purge can invalidate it
    const purged = await purge(
      new Request("http://x/__nifra/revalidate?path=/p", {
        method: "POST",
        headers: { "x-nifra-revalidate-token": "s" },
      }),
    )
    expect(purged.status).toBe(200)
    const afterPurge = await handler(new Request("http://x/p"))
    expect(afterPurge.headers.get("x-nifra-isr")).toBe("miss") // re-rendered after the purge
    expect(calls()).toBe(2)
  })
})

describe("tags per request, and freshness handed to an outer cache", () => {
  const adapter: RenderAdapter = {
    renderToString: () => "<p>page</p>",
    renderToStream: () => new Blob(["<p>page</p>"]).stream(),
    hydrationHead: () => "",
  }
  const appWith = (revalidateTags: RevalidateTags) =>
    createWebApp({
      adapter,
      clientEntry: "/c.js",
      manifest: {
        routes: [
          {
            id: "product",
            pattern: "/p/:id",
            layoutIds: [],
            file: "p.tsx",
            load: async () => ({ default: "p", revalidate: 60, revalidateTags }),
          },
        ],
        layouts: {},
      },
    })
  const outer = <T extends object>(handler: T): T => {
    openCacheChannel(handler)
    return handler
  }

  test("a tag function sees the route's params and URL, per request", async () => {
    const seen: string[] = []
    const app = appWith(({ params, url }: { params: { id: string }; url: URL }) => {
      seen.push(url.pathname)
      return [`product:${params.id}`, "catalog"]
    })
    openCacheChannel(app)
    const res = await app.fetch(new Request("http://x/p/42"))
    expect(res.headers.get("x-nifra-isr-tags")).toBe("product:42,catalog")
    expect(seen).toEqual(["/p/42"])
  })

  test("invalid tags from a function are dropped, with one warning naming the route only", async () => {
    const warnings: string[] = []
    const warn = console.warn
    console.warn = (message: string) => warnings.push(message)
    try {
      const app = appWith(() => ["ok", "has space", "secret value!", "x".repeat(200)])
      openCacheChannel(app)
      for (let i = 0; i < 2; i++) {
        const res = await app.fetch(new Request("http://x/p/1"))
        expect(res.headers.get("x-nifra-isr-tags")).toBe("ok")
      }
    } finally {
      console.warn = warn
    }
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('NIFRA_CDN_TAG_INVALID: revalidateTags of route "product"')
    expect(warnings[0]).not.toContain("secret value")
  })

  test("withISR hands an outer layer the freshness left and the tags, never more", async () => {
    let clock = 0
    const handler = outer(
      withISR(appWith(["catalog"]), {
        store: new MemoryCacheStore(),
        revalidate: 30,
        now: () => clock,
      }),
    )
    const advertised = (res: Response) => [
      res.headers.get("x-nifra-isr"),
      res.headers.get("x-nifra-isr-revalidate"),
      res.headers.get("x-nifra-isr-tags"),
    ]
    expect(advertised(await handler(new Request("http://x/p/1")))).toEqual([
      "miss",
      "60",
      "catalog",
    ])
    clock = 45_500
    expect(advertised(await handler(new Request("http://x/p/1")))).toEqual(["hit", "14", "catalog"])
    clock = 61_000
    expect(advertised(await handler(new Request("http://x/p/1")))).toEqual([
      "stale",
      "0",
      "catalog",
    ])
    const bypass = await handler(new Request("http://x/p/1?q=1"))
    expect([
      bypass.headers.get("x-nifra-isr-revalidate"),
      bypass.headers.get("x-nifra-isr-tags"),
    ]).toEqual([null, null])
  })
})

describe("revalidateEndpoint batches and the CDN after it", () => {
  const post = (handler: (req: Request) => Promise<Response>, body: unknown) =>
    handler(
      new Request("http://x/__nifra/revalidate", {
        method: "POST",
        headers: { "x-nifra-revalidate-token": "s3cret", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    )
  const cdnThat = (outcome: CdnPurgeOutcome, log: string[] = []) => ({
    async purge(target: { tags?: readonly string[]; paths?: readonly string[] }) {
      log.push(`cdn ${JSON.stringify(target)}`)
      return outcome
    },
  })

  test("a batch purges every path and tag, origin first, then the CDN", async () => {
    const log: string[] = []
    const store = new MemoryCacheStore()
    await store.set("http://x/a", entry("A"))
    await store.set("http://x/b", { ...entry("B"), tags: ["catalog"] })
    const originDelete = store.delete.bind(store)
    store.delete = async (key: string) => {
      log.push(`origin ${key}`)
      return originDelete(key)
    }
    const handler = revalidateEndpoint({
      store,
      secret: "s3cret",
      cdn: cdnThat({ cdn: "accepted", retryable: false }, log),
    })
    const res = await post(handler, { paths: ["/a", "/a"], tags: ["catalog"] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      revalidated: ["/a"],
      revalidatedTags: ["catalog"],
      cdn: "accepted",
    })
    expect(log).toEqual(["origin http://x/a", 'cdn {"tags":["catalog"],"paths":["/a"]}'])
    expect(await store.get("http://x/a")).toBeUndefined()
    expect(await store.get("http://x/b")).toBeUndefined()
  })

  test("a queued CDN purge answers 202; a refused one 502, after the origin purge held", async () => {
    const store = new MemoryCacheStore()
    const queued = revalidateEndpoint({
      store,
      secret: "s3cret",
      cdn: cdnThat({ cdn: "queued", retryable: true }),
    })
    const accepted = await post(queued, { path: "/a" })
    expect([accepted.status, await accepted.json()]).toEqual([
      202,
      { revalidated: "/a", cdn: "queued" },
    ])
    await store.set("http://x/a", entry("A"))
    const refused = revalidateEndpoint({
      store,
      secret: "s3cret",
      cdn: cdnThat({ cdn: "failed", retryable: false, error: "unauthorized" }),
    })
    const res = await post(refused, { path: "/a" })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({
      ok: false,
      error: "cdn_purge_failed",
      origin: "done",
      retryable: false,
      reason: "unauthorized",
    })
    expect(await store.get("http://x/a")).toBeUndefined()
  })

  test("a CDN purge that throws is a retryable 502, not a success", async () => {
    const handler = revalidateEndpoint({
      store: new MemoryCacheStore(),
      secret: "s3cret",
      cdn: {
        purge: async () => {
          throw new Error("network down")
        },
      },
    })
    const res = await post(handler, { tag: "catalog" })
    expect(res.status).toBe(502)
    expect((await res.json()).retryable).toBe(true)
  })

  test("a batch is capped, typed and non-empty, and nothing is purged when it is refused", async () => {
    const store = new MemoryCacheStore()
    await store.set("http://x/a", entry("A"))
    const handler = revalidateEndpoint({ store, secret: "s3cret" })
    const paths = Array.from({ length: 101 }, (_, i) => `/p${i}`)
    const tags = Array.from({ length: 33 }, (_, i) => `t${i}`)
    const refusals = [
      [{ paths }, "too_many_paths"],
      [{ tags }, "too_many_tags"],
      [{ paths: "/a" }, "invalid_batch"],
      [{ paths: [] }, "empty_batch"],
      [{ paths: ["/a", "nope"] }, "invalid_path"],
      [{ paths: ["/a"], tags: ["bad tag"] }, "invalid_tag"],
    ] as const
    for (const [body, error] of refusals) {
      const res = await post(handler, body)
      expect([res.status, (await res.json()).error]).toEqual([400, error])
    }
    expect((await store.get("http://x/a"))?.body).toBe("A")
  })
})

describe("withISR store failures", () => {
  type Op = ISRStoreOp
  // `fail` answers for the store: a promise it returns stands in for the call, undefined passes through.
  const failing = (
    fail: (op: Op) => Promise<never> | undefined,
    base = new MemoryCacheStore(),
  ): CacheStore => ({
    get: (key) => fail("get") ?? base.get(key),
    set: (key, value) => fail("set") ?? base.set(key, value),
    delete: (key) => fail("delete") ?? base.delete(key),
  })
  const quiet = (): {
    seen: { op: Op; error: unknown }[]
    onStoreError: NonNullable<ISROptions["onStoreError"]>
  } => {
    const seen: { op: Op; error: unknown }[] = []
    return { seen, onStoreError: (error, { op }) => void seen.push({ op, error }) }
  }

  test("a get that throws is a miss and the page renders", async () => {
    const { seen, onStoreError } = quiet()
    const store = {
      get: () => {
        throw new Error("offline")
      },
      set: async () => {},
      delete: async () => {},
    }
    const handler = withISR(trackApp(() => html("PAGE")).app, {
      store,
      storeSecret: STORE_SECRET,
      revalidate: 60,
      now: () => 0,
      onStoreError,
    })
    const res = await handler(new Request("http://x/p"))
    expect([res.status, await res.text()]).toEqual([200, "PAGE"])
    expect(seen.map((s) => s.op)).toEqual(["get"])
  })

  test("a get that rejects is a miss and the page renders", async () => {
    const { seen, onStoreError } = quiet()
    const store = failing((op) => (op === "get" ? Promise.reject(new Error("offline")) : undefined))
    const handler = withISR(trackApp(() => html("PAGE")).app, {
      store,
      storeSecret: STORE_SECRET,
      revalidate: 60,
      now: () => 0,
      onStoreError,
    })
    const res = await handler(new Request("http://x/p"))
    expect([res.status, await res.text()]).toEqual([200, "PAGE"])
    expect(seen.map((s) => s.op)).toEqual(["get"])
  })

  test("a get that hangs past storeTimeoutMs is a miss", async () => {
    const { seen, onStoreError } = quiet()
    const store = failing((op) => (op === "get" ? new Promise<never>(() => {}) : undefined))
    const handler = withISR(trackApp(() => html("PAGE")).app, {
      store,
      storeSecret: STORE_SECRET,
      revalidate: 60,
      now: () => 0,
      storeTimeoutMs: 5,
      onStoreError,
    })
    const res = await handler(new Request("http://x/p"))
    expect([res.status, await res.text()]).toEqual([200, "PAGE"])
    expect(seen.map((s) => s.op)).toEqual(["get"])
  })

  test("a set that throws still returns the rendered page", async () => {
    const { seen, onStoreError } = quiet()
    const store = failing((op) => {
      if (op === "set") throw new Error("read-only replica")
      return undefined
    })
    const handler = withISR(trackApp(() => html("PAGE")).app, {
      store,
      storeSecret: STORE_SECRET,
      revalidate: 60,
      now: () => 0,
      onStoreError,
    })
    const res = await handler(new Request("http://x/p"))
    expect([res.status, res.headers.get("x-nifra-isr"), await res.text()]).toEqual([
      200,
      "miss",
      "PAGE",
    ])
    expect(seen.map((s) => s.op)).toEqual(["set"])
  })

  test("a set that hangs past storeTimeoutMs does not hold the response", async () => {
    const { seen, onStoreError } = quiet()
    const store = failing((op) => (op === "set" ? new Promise<never>(() => {}) : undefined))
    const handler = withISR(trackApp(() => html("PAGE")).app, {
      store,
      storeSecret: STORE_SECRET,
      revalidate: 60,
      now: () => 0,
      storeTimeoutMs: 5,
      onStoreError,
    })
    const res = await handler(new Request("http://x/p"))
    expect([res.status, await res.text()]).toEqual([200, "PAGE"])
    expect(seen.map((s) => s.op)).toEqual(["set"])
  })

  test("concurrent misses during a set outage still share one render", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const app: ISRApp = {
      fetch: async () => {
        calls++
        await gate
        return html("PAGE")
      },
    }
    const store = failing((op) => (op === "set" ? Promise.reject(new Error("down")) : undefined))
    const handler = withISR(app, {
      store,
      storeSecret: STORE_SECRET,
      revalidate: 60,
      now: () => 0,
      onStoreError: () => {},
    })
    const pending = Array.from({ length: 4 }, () => handler(new Request("http://x/p")))
    release()
    const bodies = await Promise.all((await Promise.all(pending)).map((res) => res.text()))
    expect([calls, bodies]).toEqual([1, Array(4).fill("PAGE")])
  })

  test("a failed regeneration write keeps the stale entry and is reported", async () => {
    const base = new MemoryCacheStore()
    let broken = false
    const store = failing(
      (op) => (broken && op === "set" ? Promise.reject(new Error("down")) : undefined),
      base,
    )
    const { seen, onStoreError } = quiet()
    let t = 0
    let version = 1
    const handler = withISR(trackApp(() => html(`v${version}`)).app, {
      store,
      storeSecret: STORE_SECRET,
      revalidate: 1,
      now: () => t,
      onStoreError,
    })
    await handler(new Request("http://x/p"))
    broken = true
    version = 2
    t = 2000
    const plat = collectWaitUntil()
    const res = await handler(new Request("http://x/p"), plat)
    expect(await res.text()).toBe("v1")
    await plat.settle()
    expect((await base.get(pageKey("/p")))?.body).toBe("v1")
    expect(seen.map((s) => s.op)).toEqual(["set"])
  })

  test("the default report is rate-limited and never prints the key", async () => {
    const lines: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "))
    try {
      let t = 0
      const store = failing(() => Promise.reject(new Error("GET http://x/secret-path failed")))
      const handler = withISR(trackApp(() => html("PAGE")).app, {
        store,
        storeSecret: STORE_SECRET,
        revalidate: 60,
        now: () => t,
      })
      for (let i = 0; i < 5; i++) await handler(new Request("http://x/secret-path"))
      expect(lines.length).toBe(2) // one get + one set report inside the window
      t = 120_000
      await handler(new Request("http://x/secret-path"))
      expect(lines.length).toBe(4)
      expect(lines.join("\n")).not.toContain("secret-path")
    } finally {
      console.error = original
    }
  })

  test("storeTimeoutMs must be a positive finite number", () => {
    const store = new MemoryCacheStore()
    for (const storeTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        withISR(trackApp(() => html("x")).app, {
          store,
          revalidate: 60,
          now: () => 0,
          storeTimeoutMs,
        }),
      ).toThrow(/storeTimeoutMs/)
    }
  })
})

describe("revalidateEndpoint and the data caches under the pages", () => {
  const post = (handler: (req: Request) => Promise<Response>, body: unknown) =>
    handler(
      new Request("http://x/__nifra/revalidate", {
        method: "POST",
        headers: { "x-nifra-revalidate-token": "s3cret", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    )
  const logged = (log: string[], name: string, fail = false) => ({
    invalidateTag(tag: string) {
      log.push(`${name} ${tag}`)
      if (fail) throw new Error(`${name} down`)
    },
  })

  test("a tag purge reaches each data cache first, then the page store, then the CDN", async () => {
    const log: string[] = []
    const store = new MemoryCacheStore()
    await store.set("http://x/b", { ...entry("B"), tags: ["catalog"] })
    const originInvalidate = store.invalidateTag.bind(store)
    store.invalidateTag = async (tag: string) => {
      log.push(`pages ${tag}`)
      return originInvalidate(tag)
    }
    const handler = revalidateEndpoint({
      store,
      secret: "s3cret",
      dataCaches: [logged(log, "loaders"), logged(log, "search")],
      cdn: {
        async purge(target) {
          log.push(`cdn ${JSON.stringify(target.tags)}`)
          return { cdn: "accepted", retryable: false }
        },
      },
    })
    const res = await post(handler, { tags: ["catalog"] })
    expect(res.status).toBe(200)
    expect(log).toEqual(["loaders catalog", "search catalog", "pages catalog", 'cdn ["catalog"]'])
    expect(await store.get("http://x/b")).toBeUndefined()
  })

  test("a path-only purge leaves the data caches alone", async () => {
    const log: string[] = []
    const handler = revalidateEndpoint({
      store: new MemoryCacheStore(),
      secret: "s3cret",
      dataCaches: [logged(log, "loaders")],
    })
    expect((await post(handler, { path: "/a" })).status).toBe(200)
    expect(log).toEqual([])
  })

  test("a data cache that fails stops the purge before the pages, so a retry finds them intact", async () => {
    const log: string[] = []
    const store = new MemoryCacheStore()
    await store.set("http://x/b", { ...entry("B"), tags: ["catalog"] })
    const handler = revalidateEndpoint({
      store,
      secret: "s3cret",
      dataCaches: [logged(log, "loaders", true)],
    })
    const res = await post(handler, { tags: ["catalog"] })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: "data_cache_invalidation_failed" })
    expect(await store.get("http://x/b")).toBeDefined()
  })
})

describe("a purge that lands while a page renders", () => {
  const stores: ReadonlyArray<readonly [string, () => CacheStore]> = [
    ["MemoryCacheStore", () => new MemoryCacheStore()],
    ["KVCacheStore", () => new KVCacheStore(new FakeKV())],
  ]
  for (const [name, makeStore] of stores)
    for (const purge of ["path", "tag"] as const)
      test(`${name}: a ${purge} purge is not undone by the render it overtook`, async () => {
        const store = makeStore()
        let data = "v1"
        const started = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const app: ISRApp = {
          async fetch() {
            const read = data
            started.resolve()
            await release.promise
            return new Response(`<p>${read}</p>`, {
              headers: { "content-type": "text/html", "x-nifra-isr-tags": "product" },
            })
          },
        }
        const isr = withISR(app, {
          store,
          storeSecret: STORE_SECRET,
          revalidate: 3600,
          now: () => 0,
        })
        const first = isr(new Request("http://x/p"))
        await started.promise
        data = "v2"
        if (purge === "path") await store.delete("http://x/p")
        else await store.invalidateTag?.("product")
        release.resolve()
        expect(await (await first).text()).toBe("<p>v1</p>")

        const next = await isr(new Request("http://x/p"))
        expect([next.headers.get("x-nifra-isr"), await next.text()]).toEqual(["miss", "<p>v2</p>"])
        const again = await isr(new Request("http://x/p"))
        expect([again.headers.get("x-nifra-isr"), await again.text()]).toEqual(["hit", "<p>v2</p>"])
      })

  test("a store whose fence fails stores the render unfenced and reports it", async () => {
    const inner = new MemoryCacheStore()
    const reports: string[] = []
    const store: CacheStore = {
      get: (key) => inner.get(key),
      set: (key, value) => inner.set(key, value),
      delete: (key) => inner.delete(key),
      fence: () => Promise.reject(new Error("down")),
    }
    const app: ISRApp = {
      fetch: () => new Response("<p>x</p>", { headers: { "content-type": "text/html" } }),
    }
    const isr = withISR(app, {
      store,
      storeSecret: STORE_SECRET,
      revalidate: 3600,
      now: () => 0,
      onStoreError: (_error, { op }) => reports.push(op),
    })
    await (await isr(new Request("http://x/p"))).text()
    expect((await isr(new Request("http://x/p"))).headers.get("x-nifra-isr")).toBe("hit")
    expect(reports).toEqual(["fence"])
  })
})

describe("pages a shared store holds are signed", () => {
  const MAC = "x-nifra-isr-mac"
  const stored = (kv: FakeKV, path = "/p"): Record<string, unknown> & CachedResponse =>
    JSON.parse(kv.store.get(pageKey(path)) ?? "null")
  const plant = (kv: FakeKV, value: unknown, path = "/p"): void => {
    kv.store.set(pageKey(path), JSON.stringify(value))
  }
  const signedSetup = ({ defaultReport = false } = {}) => {
    const kv = new FakeKV()
    const reports: ISRStoreOp[] = []
    let body = "real"
    const tracked = trackApp(() =>
      html(body, { "content-security-policy": "script-src 'self'", "x-nifra-isr-tags": "b,a" }),
    )
    const options: ISROptions = {
      store: new KVCacheStore(kv),
      storeSecret: STORE_SECRET,
      revalidate: 60,
      now: () => 0,
    }
    const handler = withISR(
      tracked.app,
      defaultReport ? options : { ...options, onStoreError: (_error, { op }) => reports.push(op) },
    )
    const read = async (path = "/p") => {
      const res = await handler(new Request(`http://x${path}`))
      return { status: res.headers.get("x-nifra-isr"), body: await res.text(), res }
    }
    return {
      kv,
      reports,
      handler,
      read,
      calls: tracked.calls,
      setBody: (next: string) => (body = next),
    }
  }

  test("a store other processes can write refuses to start without a secret", () => {
    const app = trackApp(() => html("x")).app
    const kv = new KVCacheStore(new FakeKV())
    expect(() => withISR(app, { store: kv, revalidate: 60, now: () => 0 })).toThrow(
      /needs storeSecret, at least 32 characters/,
    )
    const custom: CacheStore = {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
    }
    expect(() => withISR(app, { store: custom, revalidate: 60, now: () => 0 })).toThrow(
      /needs storeSecret/,
    )
  })

  test("a secret shorter than 32 characters is refused, even for the memory store", () => {
    const app = trackApp(() => html("x")).app
    for (const store of [new MemoryCacheStore(), new KVCacheStore(new FakeKV())]) {
      expect(() =>
        withISR(app, { store, storeSecret: "x".repeat(31), revalidate: 60, now: () => 0 }),
      ).toThrow(/storeSecret must be a string of at least 32 characters/)
    }
  })

  test("the memory store keeps its pages unsigned, with or without a secret", async () => {
    for (const storeSecret of [undefined, STORE_SECRET]) {
      const store = new MemoryCacheStore()
      const options: ISROptions = { store, revalidate: 60, now: () => 0 }
      const handler = withISR(
        trackApp(() => html("v")).app,
        storeSecret === undefined ? options : { ...options, storeSecret },
      )
      await (await handler(new Request("http://x/p"))).text()
      expect((await store.get(pageKey("/p")))?.headers[MAC]).toBeUndefined()
      expect((await handler(new Request("http://x/p"))).headers.get("x-nifra-isr")).toBe("hit")
    }
  })

  test("a page this app stored verifies, and its MAC never reaches the visitor", async () => {
    const { kv, read, calls, reports } = signedSetup()
    expect((await read()).status).toBe("miss")
    expect(stored(kv).headers[MAC]).toMatch(/^[0-9a-f]{64}$/)
    const hit = await read()
    expect([hit.status, hit.body, hit.res.headers.has(MAC)]).toEqual(["hit", "real", false])
    expect(hit.res.headers.get("content-security-policy")).toBe("script-src 'self'")
    expect([calls(), reports]).toEqual([1, []])
  })

  test("a page whose MAC was copied onto planted content is a miss, rendered and stored again", async () => {
    const { kv, read, calls, reports } = signedSetup()
    await read()
    plant(kv, { ...stored(kv), body: "<script>steal()</script>" })
    const after = await read()
    expect([after.status, after.body, calls(), reports]).toEqual(["miss", "real", 2, ["verify"]])
    // The render overwrote the planted page with one that verifies.
    expect((await read()).status).toBe("hit")
    expect(calls()).toBe(2)
  })

  test("every field a replay serves is covered", async () => {
    const mutations: Array<(page: CachedResponse) => CachedResponse> = [
      (page) => ({ ...page, status: 201 }),
      (page) => ({ ...page, storedAt: page.storedAt + 1 }),
      (page) => ({ ...page, revalidate: page.revalidate * 1000 }),
      (page) => ({ ...page, tags: ["a"] }),
      (page) => ({ ...page, headers: { ...page.headers, "content-security-policy": "" } }),
      (page) => ({ ...page, headers: { ...page.headers, link: "</evil.js>; rel=preload" } }),
    ]
    for (const mutate of mutations) {
      const { kv, read, reports } = signedSetup()
      await read()
      const { __nifraTagEpochs, ...page } = stored(kv)
      plant(kv, { ...mutate(page), __nifraTagEpochs })
      expect((await read()).status).toBe("miss")
      expect(reports).toEqual(["verify"])
    }
  })

  test("a page with no MAC, or one that is not 64 lowercase hex digits, is a miss", async () => {
    for (const mac of [undefined, "", "zz".repeat(32), "AB".repeat(32), "ab".repeat(31)]) {
      const { kv, read, reports } = signedSetup()
      await read()
      const page = stored(kv)
      const headers: Record<string, unknown> = { ...page.headers }
      if (mac === undefined) delete headers[MAC]
      else headers[MAC] = mac
      plant(kv, { ...page, headers })
      const after = await read()
      expect([after.status, after.body, reports]).toEqual(["miss", "real", ["verify"]])
    }
  })

  test("a page signed under another secret is a miss", async () => {
    const first = signedSetup()
    await first.read()
    const reports: ISRStoreOp[] = []
    const other = withISR(trackApp(() => html("other")).app, {
      store: new KVCacheStore(first.kv),
      storeSecret: `${STORE_SECRET}-rotated`,
      revalidate: 60,
      now: () => 0,
      onStoreError: (_error, { op }) => reports.push(op),
    })
    const res = await other(new Request("http://x/p"))
    expect([res.headers.get("x-nifra-isr"), await res.text(), reports]).toEqual([
      "miss",
      "other",
      ["verify"],
    ])
    // Each secret refuses the other's pages.
    expect((await first.read()).status).toBe("miss")
    expect(first.reports).toEqual(["verify"])
  })

  test("a page copied to another key never verifies there", async () => {
    const { kv, read, setBody, reports } = signedSetup()
    setBody("admin only")
    await read("/a")
    setBody("public")
    plant(kv, stored(kv, "/a"), "/b")
    const res = await read("/b")
    expect([res.status, res.body, reports]).toEqual(["miss", "public", ["verify"]])
  })

  test("a store that reorders headers and tags still serves the page", async () => {
    const base = new MemoryCacheStore()
    const reorder = (page: CachedResponse): CachedResponse => ({
      ...page,
      headers: Object.fromEntries(Object.entries(page.headers).reverse()),
      ...(page.tags === undefined ? {} : { tags: [...page.tags].reverse() }),
    })
    const store: CacheStore = {
      get: async (key) => {
        const page = await base.get(key)
        return page === undefined ? undefined : reorder(page)
      },
      set: (key, value) => base.set(key, value),
      delete: (key) => base.delete(key),
    }
    const handler = withISR(
      trackApp(() => html("v", { "x-nifra-isr-tags": "a,b", "content-language": "en" })).app,
      { store, storeSecret: STORE_SECRET, revalidate: 60, now: () => 0 },
    )
    await (await handler(new Request("http://x/p"))).text()
    expect((await handler(new Request("http://x/p"))).headers.get("x-nifra-isr")).toBe("hit")
  })

  test("a malformed record from a custom store is a miss, not an error", async () => {
    const reports: ISRStoreOp[] = []
    const store: CacheStore = {
      // A record a store deserialized without the fields a page needs.
      get: async () => JSON.parse('{"body":"planted"}'),
      set: async () => {},
      delete: async () => {},
    }
    const handler = withISR(trackApp(() => html("real")).app, {
      store,
      storeSecret: STORE_SECRET,
      revalidate: 60,
      now: () => 0,
      onStoreError: (_error, { op }) => reports.push(op),
    })
    const res = await handler(new Request("http://x/p"))
    expect([res.status, await res.text(), reports]).toEqual([200, "real", ["verify"]])
  })

  test("the default report says the check failed, never names the key, and is rate-limited", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {})
    try {
      const { kv, read } = signedSetup({ defaultReport: true })
      await read("/secret-path")
      plant(kv, { ...stored(kv, "/secret-path"), body: "planted" }, "/secret-path")
      await read("/secret-path")
      plant(kv, { ...stored(kv, "/secret-path"), body: "planted" }, "/secret-path")
      await read("/secret-path")
      expect(error).toHaveBeenCalledTimes(1)
      const line = String(error.mock.calls[0]?.[0])
      expect(line).toContain("ISR store verify failed")
      expect(line).toContain("signature check")
      expect(line).not.toContain("secret-path")
    } finally {
      error.mockRestore()
    }
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { type CachedResponse, MemoryCacheStore } from "../src/isr.ts"

const entry = (body: string): CachedResponse => ({
  body,
  status: 200,
  headers: { "content-type": "text/html" },
  storedAt: 0,
  revalidate: 60_000,
})

describe("MemoryCacheStore", () => {
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

  test("bounded — oldest-inserted entries evict past `max`", async () => {
    const store = new MemoryCacheStore({ max: 2 })
    await store.set("/1", entry("1"))
    await store.set("/2", entry("2"))
    await store.set("/3", entry("3")) // evicts /1 (oldest)
    expect(await store.get("/1")).toBeUndefined()
    expect((await store.get("/2"))?.body).toBe("2")
    expect((await store.get("/3"))?.body).toBe("3")
  })

  test("a read bumps recency (LRU) — a frequently-read entry survives a burst of new pages [AUDIT]", async () => {
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
})

import { type ISRApp, type ISRPlatform, withISR } from "../src/isr.ts"

const html = (body: string, headers: Record<string, string> = {}): Response =>
  new Response(body, { status: 200, headers: { "content-type": "text/html", ...headers } })

const pageKey = (path: string): string => `http://x${path}`

function trackApp(respond: () => Response): { app: ISRApp; calls: () => number } {
  let calls = 0
  return {
    app: {
      fetch: async () => {
        calls++
        return respond()
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

  test("a regeneration that becomes non-cacheable keeps the stale entry", async () => {
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
    expect((await store.get(pageKey("/p")))?.body).toBe("v1") // unchanged
  })
})

import { revalidateEndpoint } from "../src/isr.ts"

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
    // the length guard — proving a same-length forgery can't slip through).
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
})

import { KVCacheStore, type KVNamespaceLike } from "../src/isr.ts"

// A faithful in-memory KV double — proves KVCacheStore works against the structural binding (real
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

  test("delete drops the key", async () => {
    const kv = new FakeKV()
    const store = new KVCacheStore(kv)
    await store.set("/p", entry("x"))
    await store.delete("/p")
    expect(kv.store.has("/p")).toBe(false)
    expect(await store.get("/p")).toBeUndefined()
  })

  test("a corrupt (non-JSON) entry reads as a miss, not a throw", async () => {
    const kv = new FakeKV()
    kv.store.set("/p", "}{ not json")
    expect(await new KVCacheStore(kv).get("/p")).toBeUndefined()
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

  test("rejects an expirationTtl below KV's 60s minimum", () => {
    expect(() => new KVCacheStore(new FakeKV(), { expirationTtl: 30 })).toThrow(/>= 60/)
    expect(() => new KVCacheStore(new FakeKV(), { expirationTtl: 60 })).not.toThrow()
  })
})

describe("withISR over KVCacheStore (the production store path)", () => {
  test("drives miss → hit → stale → regenerate identically to the memory store", async () => {
    const kv = new FakeKV()
    const store = new KVCacheStore(kv)
    let body = "v1"
    let t = 0
    const { app, calls } = trackApp(() => html(body))
    const handler = withISR(app, { store, revalidate: 1, now: () => t })

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
    const handler = withISR(app, { store, revalidate: 1000, now: () => t }) // long freshness
    const purge = revalidateEndpoint({ store, secret: "s" })

    await handler(new Request("http://x/p")) // miss → cached
    expect((await handler(new Request("http://x/p"))).headers.get("x-nifra-isr")).toBe("hit")
    expect(calls()).toBe(1)

    t = 1 // still well within the 1000s window — only a purge can invalidate it
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

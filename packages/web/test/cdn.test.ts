import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { detectServerOnlyInClient } from "../src/build.ts"
import {
  CDN_BROWSER_CACHE_CONTROL,
  type CdnProvider,
  cloudflareWorkersCache,
  cloudflareZone,
  createInvalidator,
  defineCdnProvider,
  fastly,
  type PurgeAttempt,
  pathTag,
  vercel,
  withCdn,
} from "../src/cdn.ts"
import { createWebApp, type Manifest, type RenderAdapter } from "../src/index.ts"
import { MemoryCacheStore, withISR } from "../src/isr.ts"
import { fromBunMetafile } from "../src/module-graph.ts"

const ZONE = "0123456789abcdef0123456789abcdef"
const TAG = /^[A-Za-z][A-Za-z0-9._:/-]{0,127}$/

const adapter: RenderAdapter = {
  renderToString: () => "<p>page</p>",
  renderToStream: () => new Response("<p>page</p>").body as ReadableStream<Uint8Array>,
  hydrationHead: () => "",
}

const routes: Manifest = {
  routes: [
    {
      id: "product",
      pattern: "/p/:id",
      layoutIds: [],
      file: "p.tsx",
      load: async () => ({
        default: "p",
        revalidate: 60,
        revalidateTags: ({ params }: { params: { id: string } }) => [`product:${params.id}`],
      }),
    },
    {
      id: "plain",
      pattern: "/plain",
      layoutIds: [],
      file: "plain.tsx",
      load: async () => ({ default: "plain" }),
    },
    {
      id: "varies",
      pattern: "/varies",
      layoutIds: [],
      file: "varies.tsx",
      load: async () => ({
        default: "varies",
        revalidate: 60,
        loader: (ctx: { set: { headers: Record<string, string> } }) => {
          ctx.set.headers.vary = "accept-language"
          return {}
        },
      }),
    },
  ],
  layouts: {},
} as unknown as Manifest

/** A provider whose API calls are recorded, answering each with the next scripted result. */
function recording(script: PurgeAttempt[] = [], name = "test", tagsPerCall = 100) {
  const calls: string[][] = []
  const waits: number[] = []
  const provider = defineCdnProvider(
    {
      name,
      tagsPerCall,
      maxResponseTags: 128,
      cacheHeaders: (input) => ({
        "x-cdn-tags": input.tags.join(","),
        "x-cdn-ttl": `${input.maxAge}/${input.staleWhileRevalidate}/${input.staleIfError ?? "-"}`,
      }),
      noStoreHeaders: () => ({ "x-cdn-ttl": "no-store" }),
      purgeTags: async (tags) => {
        calls.push([...tags])
        return script.shift() ?? { ok: true }
      },
    },
    {
      debounceMs: 0,
      sleep: async (ms) => {
        waits.push(ms)
      },
      onError: () => {},
    },
  )
  return { provider, calls, waits }
}

const leaks = (res: Response) =>
  [res.headers.get("x-nifra-isr-revalidate"), res.headers.get("x-nifra-isr-tags")].filter(
    (value) => value !== null,
  )

describe("withCdn headers", () => {
  const app = () =>
    createWebApp({ adapter, manifest: routes, clientEntry: "/c.js", draftSecret: "d".repeat(32) })

  test("a cacheable page carries its route tags, its path tag and the route's freshness", async () => {
    const { provider } = recording()
    const handler = withCdn(app(), { provider, staleIfError: 600 })
    const res = await handler(new Request("http://x/p/42"))
    expect(res.headers.get("x-cdn-tags")).toBe(`product:42,${await pathTag("/p/42")}`)
    expect(res.headers.get("x-cdn-ttl")).toBe("60/60/600")
    expect(res.headers.get("cache-control")).toBe(CDN_BROWSER_CACHE_CONTROL)
    expect(leaks(res)).toEqual([])
  })

  test("pages a shared cache must not hold are no-store for the CDN, and carry no tags", async () => {
    const { provider } = recording()
    const handler = withCdn(app(), { provider })
    const cases = [
      new Request("http://x/p/1", { headers: { cookie: "sid=1" } }),
      new Request("http://x/p/1", { headers: { authorization: "Bearer t" } }),
      new Request("http://x/plain"),
      new Request("http://x/varies"),
    ]
    for (const req of cases) {
      const res = await handler(req)
      expect([req.url, res.headers.get("x-cdn-ttl"), res.headers.get("x-cdn-tags")]).toEqual([
        req.url,
        "no-store",
        null,
      ])
      expect(leaks(res)).toEqual([])
    }
  })

  test("a draft render is never stored by the CDN", async () => {
    const { provider } = recording()
    const secret = "d".repeat(32)
    const { enableDraft } = await import("../src/draft.ts")
    let cookie = ""
    await enableDraft(
      {
        set: {
          cookie: (name, value) => {
            cookie = `${name}=${value}`
          },
          deleteCookie: () => {},
        },
      },
      secret,
    )
    const handler = withCdn(app(), { provider, draftSecret: secret })
    const res = await handler(new Request("http://x/p/1", { headers: { cookie } }))
    expect(res.headers.get("x-cdn-ttl")).toBe("no-store")
  })

  test("non-HTML responses keep the app's own headers: navigation data, assets, redirects", async () => {
    const { provider } = recording()
    const data = await withCdn(app(), { provider })(
      new Request("http://x/p/1", { headers: { "x-nifra-data": "1" } }),
    )
    expect(data.headers.get("x-cdn-ttl")).toBeNull()
    expect(data.headers.get("cache-control")).toBe("private, no-store")
    const plain = withCdn(
      () =>
        new Response(null, { status: 302, headers: { location: "/x", "x-nifra-isr-tags": "a" } }),
      { provider },
    )
    const redirect = await plain(new Request("http://x/old"))
    expect([redirect.headers.get("x-cdn-ttl"), leaks(redirect)]).toEqual([null, []])
  })

  test("an HTML error page is no-store for the CDN even when it advertises freshness", async () => {
    const { provider } = recording()
    const notFound = withCdn(
      () =>
        new Response("<p>gone</p>", {
          status: 404,
          headers: { "content-type": "text/html", "x-nifra-isr-revalidate": "60" },
        }),
      { provider },
    )
    const res = await notFound(new Request("http://x/missing"))
    expect([res.headers.get("x-cdn-ttl"), leaks(res)]).toEqual(["no-store", []])
  })

  test("over withISR, the CDN gets the freshness ISR has left, and nothing for a stale page", async () => {
    let clock = 0
    const { provider } = recording()
    const handler = withCdn(
      withISR(app(), { store: new MemoryCacheStore(), revalidate: 30, now: () => clock }),
      { provider, staleWhileRevalidate: 5 },
    )
    const ttl = async () => (await handler(new Request("http://x/p/9"))).headers.get("x-cdn-ttl")
    expect(await ttl()).toBe("60/5/-")
    clock = 50_000
    expect(await ttl()).toBe("10/5/-")
    clock = 70_000
    expect(await ttl()).toBe("no-store")
  })

  test("a response with immutable headers is rebuilt, not dropped", async () => {
    const { provider } = recording()
    const handler = withCdn(
      async () => {
        const res = new Response("<p>x</p>", { headers: { "content-type": "text/html" } })
        Object.defineProperty(res.headers, "set", {
          value: () => {
            throw new TypeError("immutable")
          },
        })
        return res
      },
      { provider },
    )
    const res = await handler(new Request("http://x/"))
    expect(res.headers.get("x-cdn-ttl")).toBe("no-store")
    expect(await res.text()).toBe("<p>x</p>")
  })
})

describe("pathTag", () => {
  test("a valid tag from the normalized pathname alone", async () => {
    const tag = await pathTag("/p/42")
    expect(tag).toMatch(TAG)
    expect(tag).toMatch(/^nifra\.p:[a-z2-7]{26}$/)
    expect(await pathTag("/p/42?utm=1#top")).toBe(tag)
    expect(await pathTag("/p/x/../42")).toBe(tag)
    expect(await pathTag("/p/42/")).not.toBe(tag)
    expect(await pathTag("/café")).toBe(await pathTag("/caf%C3%A9"))
  })
})

describe("purge queue", () => {
  test("purges arriving together go out as one call, chunked to the provider's limit", async () => {
    const { provider, calls } = recording([], "test", 100)
    const tags = Array.from({ length: 101 }, (_, i) => `t${i}`)
    const [a, b] = await Promise.all([
      provider.purge({ tags: tags.slice(0, 60) }),
      provider.purge({ tags: tags.slice(60) }),
    ])
    expect([a?.cdn, b?.cdn]).toEqual(["accepted", "accepted"])
    expect(calls.map((c) => c.length)).toEqual([100, 1])
  })

  test("paths become their path tags", async () => {
    const { provider, calls } = recording()
    await provider.purge({ paths: ["/p/42?x=1"] })
    expect(calls).toEqual([[await pathTag("/p/42")]])
  })

  test("a 429 is queued and retried after Retry-After; a 401 fails at once and is not retried", async () => {
    const limited = recording([
      { ok: false, retryable: true, rateLimited: true, reason: "rate_limited", retryAfterMs: 7000 },
      { ok: true },
    ])
    const background: Promise<unknown>[] = []
    const platform = { waitUntil: (p: Promise<unknown>) => void background.push(p) }
    const outcome = await limited.provider.purge({ tags: ["a"] }, platform)
    expect(outcome).toEqual({ cdn: "queued", retryable: true })
    await Promise.all(background)
    expect(limited.calls).toEqual([["a"], ["a"]])
    expect(limited.waits).toContain(7000)

    const refused = recording([{ ok: false, retryable: false, reason: "cloudflare_401" }])
    expect(await refused.provider.purge({ tags: ["a"] })).toEqual({
      cdn: "failed",
      retryable: false,
      error: "cloudflare_401",
    })
    expect(refused.calls).toHaveLength(1)
  })

  test("retries back off exponentially, capped, and give up after maxAttempts", async () => {
    const errors: string[] = []
    const waits: number[] = []
    const calls: number[] = []
    const provider = defineCdnProvider(
      {
        name: "flaky",
        tagsPerCall: 10,
        maxResponseTags: 10,
        cacheHeaders: () => ({}),
        noStoreHeaders: () => ({}),
        purgeTags: async () => {
          calls.push(1)
          return { ok: false, retryable: true, reason: "flaky_503" }
        },
      },
      {
        debounceMs: 0,
        maxAttempts: 4,
        maxBackoffMs: 3000,
        sleep: async (ms) => void waits.push(ms),
        onError: (e) => errors.push(`${e.code} ${e.reason} final=${e.final}`),
      },
    )
    const background: Promise<unknown>[] = []
    await provider.purge({ tags: ["a"] }, { waitUntil: (p) => void background.push(p) })
    await Promise.all(background)
    expect(calls).toHaveLength(4)
    expect(waits.filter((ms) => ms > 0)).toEqual([1000, 2000, 3000])
    expect(errors.at(-1)).toBe("NIFRA_CDN_PURGE_FAILED flaky_503 final=true")
  })

  test("a thrown provider call is a retryable network error, its text never reported", async () => {
    const reported: string[] = []
    const provider = defineCdnProvider(
      {
        name: "boom",
        tagsPerCall: 10,
        maxResponseTags: 10,
        cacheHeaders: () => ({}),
        noStoreHeaders: () => ({}),
        purgeTags: async () => {
          throw new Error("token=SECRET leaked in message")
        },
      },
      { debounceMs: 0, maxAttempts: 1, onError: (e) => reported.push(JSON.stringify(e)) },
    )
    expect(await provider.purge({ tags: ["a"] })).toEqual({
      cdn: "failed",
      retryable: true,
      error: "network_error",
    })
    expect(reported.join()).not.toContain("SECRET")
  })

  test("a full queue refuses as retryable instead of growing", async () => {
    const provider = defineCdnProvider(
      {
        name: "full",
        tagsPerCall: 10,
        maxResponseTags: 10,
        cacheHeaders: () => ({}),
        noStoreHeaders: () => ({}),
        purgeTags: async () => ({ ok: true }),
      },
      { debounceMs: 0, maxQueuedTags: 2 },
    )
    expect(await provider.purge({ tags: ["a", "b", "c"] })).toEqual({
      cdn: "failed",
      retryable: true,
      error: "queue_full",
    })
  })
})

/** A fetch that records each call and answers from `reply`. */
function fakeFetch(reply: (url: string, init: RequestInit) => Response) {
  const seen: { url: string; headers: Record<string, string>; body: unknown }[] = []
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    seen.push({
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body ?? "null")),
    })
    return reply(url, init ?? {})
  }) as typeof fetch
  return { fn, seen }
}

const QUICK = { debounceMs: 0, sleep: async () => {}, onError: () => {} }

describe("providers", () => {
  test("cloudflareZone: the purge API shape, 100 tags a call, success:false is a failure", async () => {
    const api = fakeFetch(() => Response.json({ success: true }))
    const cf = cloudflareZone({ zoneId: ZONE, apiToken: "tok", fetch: api.fn, queue: QUICK })
    const tags = Array.from({ length: 101 }, (_, i) => `t${i}`)
    expect((await cf.purge({ tags })).cdn).toBe("accepted")
    expect(api.seen.map((s) => (s.body as { tags: string[] }).tags.length)).toEqual([100, 1])
    expect(api.seen[0]?.url).toBe(`https://api.cloudflare.com/client/v4/zones/${ZONE}/purge_cache`)
    expect(api.seen[0]?.headers.authorization).toBe("Bearer tok")
    expect(cf.cacheHeaders({ tags: ["a", "b"], maxAge: 60, staleWhileRevalidate: 30 })).toEqual({
      "cache-tag": "a,b",
      "cloudflare-cdn-cache-control": "max-age=60, stale-while-revalidate=30",
    })
    const unsuccessful = cloudflareZone({
      zoneId: ZONE,
      apiToken: "tok",
      fetch: fakeFetch(() => Response.json({ success: false, errors: [{ code: 1134 }] })).fn,
      queue: QUICK,
    })
    expect(await unsuccessful.purge({ tags: ["a"] })).toEqual({
      cdn: "failed",
      retryable: false,
      error: "cloudflare_error_1134",
    })
    const limited = cloudflareZone({
      zoneId: ZONE,
      apiToken: "tok",
      fetch: fakeFetch(() => new Response(null, { status: 429, headers: { "retry-after": "12" } }))
        .fn,
      queue: { ...QUICK, maxAttempts: 1 },
    })
    expect(await limited.purge({ tags: ["a"] })).toEqual({
      cdn: "failed",
      retryable: true,
      error: "rate_limited",
    })
    expect(() => cloudflareZone({ zoneId: "zone", apiToken: "tok" })).toThrow(/32-character/)
    expect(() => cloudflareZone({ zoneId: ZONE, apiToken: "" })).toThrow(/apiToken is empty/)
  })

  test("vercel REST: invalidate or delete endpoint, 16 tags a call, target kept", async () => {
    const api = fakeFetch(() => Response.json({}))
    const v = vercel({
      token: "tok",
      projectId: "prj",
      teamId: "team",
      target: "production",
      fetch: api.fn,
      queue: QUICK,
    })
    await v.purge({ tags: Array.from({ length: 17 }, (_, i) => `t${i}`) })
    expect(api.seen.map((s) => (s.body as { tags: string[] }).tags.length)).toEqual([16, 1])
    expect(api.seen[0]?.url).toBe(
      "https://api.vercel.com/v1/edge-cache/invalidate-by-tags?projectIdOrName=prj&teamId=team",
    )
    expect(api.seen[0]?.body).toEqual({
      tags: api.seen[0]?.body && (api.seen[0].body as { tags: string[] }).tags,
      target: "production",
    })
    expect(api.seen[0]?.headers.authorization).toBe("Bearer tok")
    const del = fakeFetch(() => Response.json({}))
    await vercel({
      token: "tok",
      projectId: "prj",
      mode: "delete",
      fetch: del.fn,
      queue: QUICK,
    }).purge({ tags: ["a"] })
    expect(del.seen[0]?.url).toBe(
      "https://api.vercel.com/v1/edge-cache/dangerously-delete-by-tags?projectIdOrName=prj",
    )
    expect(v.cacheHeaders({ tags: ["a"], maxAge: 5, staleWhileRevalidate: 5 })).toEqual({
      "vercel-cache-tag": "a",
      "vercel-cdn-cache-control": "max-age=5, stale-while-revalidate=5",
    })
    const unauthorized = vercel({
      token: "tok",
      projectId: "prj",
      fetch: fakeFetch(() => new Response(null, { status: 403 })).fn,
      queue: QUICK,
    })
    expect(await unauthorized.purge({ tags: ["a"] })).toEqual({
      cdn: "failed",
      retryable: false,
      error: "vercel_403",
    })
  })

  test("vercel inside a function: invalidateByTag is called with the tags", async () => {
    const got: unknown[] = []
    const v = vercel({ invalidateByTag: async (tags) => void got.push(tags), queue: QUICK })
    expect((await v.purge({ tags: ["a", "b"] })).cdn).toBe("accepted")
    expect(got).toEqual([["a", "b"]])
    expect(() => vercel({ invalidateByTag: async () => {}, mode: "delete" })).toThrow(
      /dangerouslyDeleteByTag/,
    )
  })

  test("fastly: Fastly-Key, soft purge by default, 256 keys a call", async () => {
    const api = fakeFetch(() => Response.json({}))
    const f = fastly({
      serviceId: "SU1Z0isxPaozGVKXdv0eY",
      apiToken: "tok",
      fetch: api.fn,
      queue: QUICK,
    })
    await f.purge({ tags: Array.from({ length: 257 }, (_, i) => `t${i}`) })
    expect(
      api.seen.map((s) => (s.body as { surrogate_keys: string[] }).surrogate_keys.length),
    ).toEqual([256, 1])
    expect(api.seen[0]?.url).toBe("https://api.fastly.com/service/SU1Z0isxPaozGVKXdv0eY/purge")
    expect(api.seen[0]?.headers["fastly-key"]).toBe("tok")
    expect(api.seen[0]?.headers["fastly-soft-purge"]).toBe("1")
    expect(f.cacheHeaders({ tags: ["a", "b"], maxAge: 9, staleWhileRevalidate: 1 })).toEqual({
      "surrogate-key": "a b",
      "surrogate-control": "max-age=9, stale-while-revalidate=1",
    })
    const hard = fakeFetch(() => Response.json({}))
    await fastly({
      serviceId: "abc",
      apiToken: "tok",
      soft: false,
      fetch: hard.fn,
      queue: QUICK,
    }).purge({
      tags: ["a"],
    })
    expect(hard.seen[0]?.headers["fastly-soft-purge"]).toBeUndefined()
  })

  test("cloudflareWorkersCache: purges through the Worker's cache; a host-routed app is refused", async () => {
    const got: unknown[] = []
    const wc = cloudflareWorkersCache({
      cache: {
        purge: async (options) => {
          got.push(options)
          return got.length === 1
            ? { success: true }
            : { success: false, errors: [{ code: 10_429, message: "Rate limited" }] }
        },
      },
      queue: { ...QUICK, maxAttempts: 1 },
    })
    expect((await wc.purge({ tags: ["a"] })).cdn).toBe("accepted")
    expect(got).toEqual([{ tags: ["a"] }])
    expect(await wc.purge({ tags: ["b"] })).toEqual({
      cdn: "failed",
      retryable: true,
      error: "workers_cache_10429",
    })
    expect(() =>
      cloudflareWorkersCache({
        cache: { purge: async () => ({ success: true }) },
        hostRouted: true,
      }),
    ).toThrow(/NIFRA_CDN_HOST_ROUTED/)
  })
})

describe("createInvalidator", () => {
  test("the origin store goes first, then the CDN, and paths key like withISR", async () => {
    const order: string[] = []
    const store = new MemoryCacheStore()
    await store.set("https://shop.test/p/1", {
      body: "x",
      status: 200,
      headers: {},
      storedAt: 0,
      revalidate: 1000,
    })
    const remove = store.delete.bind(store)
    store.delete = async (key) => {
      order.push(`origin ${key}`)
      return remove(key)
    }
    const cdn = {
      purge: async (target: { tags?: readonly string[]; paths?: readonly string[] }) => {
        order.push(`cdn ${target.paths?.join()} ${target.tags?.join()}`)
        return { cdn: "accepted" as const, retryable: false }
      },
    }
    const { invalidate } = createInvalidator({ store, cdn, origin: "https://shop.test/ignored" })
    expect(await invalidate({ paths: ["/p/1"], tags: ["catalog"] })).toEqual({
      origin: "done",
      cdn: "accepted",
      retryable: false,
    })
    expect(order).toEqual(["origin https://shop.test/p/1", "cdn /p/1 catalog"])
    expect(await store.get("https://shop.test/p/1")).toBeUndefined()
  })

  test("a store needs an origin; bad tags, paths and oversized calls are refused", async () => {
    expect(() => createInvalidator({ store: new MemoryCacheStore() })).toThrow(/needs `origin`/)
    const { invalidate } = createInvalidator({ cdn: recording().provider })
    await expect(invalidate({ tags: ["bad tag"] })).rejects.toThrow(TypeError)
    await expect(invalidate({ paths: ["nope"] })).rejects.toThrow(/start with/)
    await expect(
      invalidate({ paths: Array.from({ length: 101 }, (_, i) => `/p${i}`) }),
    ).rejects.toThrow(/at most/)
    expect(await invalidate({ tags: ["a"] })).toEqual({
      origin: "skipped",
      cdn: "accepted",
      retryable: false,
    })
  })
})

describe("@nifrajs/web/cdn stays on the server", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test("a browser build that reaches it is flagged with the import chain", async () => {
    const dir = mkdtempSync(join(import.meta.dir, ".tmp-cdn-browser-"))
    dirs.push(dir)
    const entry = join(dir, "page.ts")
    writeFileSync(entry, 'import { withCdn } from "@nifrajs/web/cdn"\nconsole.log(withCdn)\n')
    const result = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      conditions: ["bun"],
      metafile: true,
    })
    const found = detectServerOnlyInClient(fromBunMetafile(result.metafile as never))
    expect(found.length).toBeGreaterThan(0)
    expect(found[0]?.chain.at(-1)).toContain("marked backend-only")
  })
})

const _typecheck: CdnProvider | undefined = undefined
void _typecheck

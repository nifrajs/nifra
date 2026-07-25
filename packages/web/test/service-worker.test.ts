import { describe, expect, test } from "bun:test"
import { generateServiceWorker, serviceWorkerRegistration } from "../src/service-worker.ts"

/**
 * A service worker outlives a deploy and can hand one visitor a response produced for another, so the
 * tests that matter here are the refusals, not the happy path.
 */
const manifest = {
  entry: "/assets/entry-abc123.js",
  assets: ["/assets/entry-abc123.js", "/assets/chunk-def456.js"],
  css: ["/assets/app-789.css"],
}

describe("generateServiceWorker", () => {
  test("precaches the hashed assets, de-duped and sorted", () => {
    const sw = generateServiceWorker(manifest, { buildId: "v1" })
    const list = JSON.parse(sw.match(/const PRECACHE = (\[.*?\])\n/s)?.[1] ?? "[]")
    expect(list).toEqual([
      "/assets/app-789.css",
      "/assets/chunk-def456.js",
      "/assets/entry-abc123.js",
    ])
  })

  test("is byte-identical for an unchanged build", () => {
    // A changed worker file is an update the browser acts on; regenerating must not invent one.
    expect(generateServiceWorker(manifest, { buildId: "v1" })).toBe(
      generateServiceWorker(manifest, { buildId: "v1" }),
    )
  })

  test("the cache name carries the build id, so a deploy cannot be pinned", () => {
    expect(generateServiceWorker(manifest, { buildId: "v1" })).toContain('"nifra-v1"')
    expect(generateServiceWorker(manifest, { buildId: "v2" })).toContain('"nifra-v2"')
  })

  describe("what it refuses to do", () => {
    test("never caches a document", () => {
      const sw = generateServiceWorker(manifest, { buildId: "v1", offlineUrl: "/offline" })
      // The navigate branch may only read the offline page; it must not put anything.
      const navigate = sw.slice(sw.indexOf('request.mode === "navigate"'), sw.indexOf("// Assets:"))
      expect(navigate).not.toContain("caches.open")
      expect(navigate).not.toContain(".put(")
    })

    test("ignores non-GET and cross-origin requests", () => {
      const sw = generateServiceWorker(manifest, { buildId: "v1" })
      expect(sw).toContain('request.method !== "GET"')
      expect(sw).toContain("url.origin !== self.location.origin")
    })

    test("does not store a failed, opaque or no-store response", () => {
      const sw = generateServiceWorker(manifest, { buildId: "v1" })
      expect(sw).toContain("response.ok")
      expect(sw).toContain('response.type === "basic"')
      expect(sw).toContain("no-store")
    })

    test("deletes every older cache on activate", () => {
      expect(generateServiceWorker(manifest, { buildId: "v1" })).toContain(
        "keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))",
      )
    })

    test("without an offline page, a failed navigation is left to fail", () => {
      const sw = generateServiceWorker(manifest, { buildId: "v1" })
      expect(sw).toContain("const OFFLINE = null")
      expect(sw).toContain("if (OFFLINE === null) return")
    })
  })

  describe("input validation", () => {
    test("refuses a cross-origin or protocol-relative precache url", () => {
      const bad = { ...manifest, assets: ["https://cdn.example.com/x.js"] }
      expect(() => generateServiceWorker(bad, { buildId: "v1" })).toThrow(/same-origin/)
      expect(() =>
        generateServiceWorker(
          { ...manifest, assets: ["//evil.example.com/x.js"] },
          { buildId: "v1" },
        ),
      ).toThrow(/same-origin/)
    })

    test("refuses a build id or cache name that could break out of the generated literal", () => {
      expect(() => generateServiceWorker(manifest, { buildId: '" + evil() + "' })).toThrow(
        /buildId/,
      )
      expect(() => generateServiceWorker(manifest, { buildId: "" })).toThrow(/buildId/)
      expect(() =>
        generateServiceWorker(manifest, { buildId: "v1", cacheName: 'x"; evil()' }),
      ).toThrow(/cacheName/)
    })

    test("refuses an offline url that is not a static same-origin path", () => {
      expect(() =>
        generateServiceWorker(manifest, { buildId: "v1", offlineUrl: "https://x.example/offline" }),
      ).toThrow(/same-origin/)
    })
  })
})

describe("serviceWorkerRegistration", () => {
  test("registers after load and swallows failure", () => {
    const snippet = serviceWorkerRegistration()
    expect(snippet).toContain('"serviceWorker"in navigator')
    expect(snippet).toContain('addEventListener("load"')
    expect(snippet).toContain('register("/sw.js")')
    expect(snippet).toContain(".catch(")
  })

  test("refuses a cross-origin script url", () => {
    expect(() => serviceWorkerRegistration("https://cdn.example.com/sw.js")).toThrow(/same-origin/)
  })
})

/**
 * The tests above read the generated SOURCE, which proves the text says the right thing and nothing
 * about whether it works. This executes it against a fake worker scope and drives the handlers, so a
 * generator that emits confident, broken JavaScript fails here.
 */
describe("the generated worker, executed", () => {
  interface Scope {
    listeners: Map<string, (event: never) => void>
    store: Map<string, Response>
    deleted: string[]
    claimed: boolean
  }

  const boot = (sw: string): Scope => {
    const listeners = new Map<string, (event: never) => void>()
    const store = new Map<string, Response>()
    const deleted: string[] = []
    const scope: Scope = { listeners, store, deleted, claimed: false }
    const names = new Set<string>()

    const cacheFor = (name: string) => ({
      addAll: async (urls: string[]) => {
        names.add(name)
        for (const u of urls) store.set(u, new Response(`asset:${u}`))
      },
      put: async (req: Request, res: Response) => {
        store.set(new URL(req.url).pathname, res)
      },
    })
    const caches = {
      open: async (name: string) => cacheFor(name),
      keys: async () => [...names, "nifra-old"],
      delete: async (name: string) => {
        deleted.push(name)
        return true
      },
      match: async (key: Request | string) => {
        const path = typeof key === "string" ? key : new URL(key.url).pathname
        return store.get(path)
      },
    }
    const self = {
      location: { origin: "https://app.test" },
      addEventListener: (type: string, fn: (event: never) => void) => listeners.set(type, fn),
      skipWaiting: async () => undefined,
      clients: {
        claim: async () => {
          scope.claimed = true
        },
      },
      caches,
    }
    // Indirect eval in a controlled scope: the point is to run exactly the emitted text.
    new Function("self", "caches", "Response", "Request", "URL", "fetch", sw)(
      self,
      caches,
      Response,
      Request,
      URL,
      globalThis.fetch,
    )
    return scope
  }

  const run = async (
    scope: Scope,
    type: string,
    event: Record<string, unknown>,
  ): Promise<Response | undefined> => {
    let responded: Promise<Response> | undefined
    const waits: Promise<unknown>[] = []
    scope.listeners.get(type)?.({
      ...event,
      respondWith: (r: Promise<Response>) => {
        responded = r
      },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    } as never)
    await Promise.all(waits)
    return responded === undefined ? undefined : await responded
  }

  const SW = generateServiceWorker(manifest, { buildId: "v1", offlineUrl: "/offline" })

  test("parses and registers install, activate and fetch", () => {
    const scope = boot(SW)
    expect([...scope.listeners.keys()].sort()).toEqual(["activate", "fetch", "install"])
  })

  test("install precaches, activate drops older caches and claims clients", async () => {
    const scope = boot(SW)
    await run(scope, "install", {})
    expect(scope.store.has("/assets/entry-abc123.js")).toBe(true)
    expect(scope.store.has("/offline")).toBe(true)
    await run(scope, "activate", {})
    expect(scope.deleted).toEqual(["nifra-old"])
    expect(scope.claimed).toBe(true)
  })

  test("serves a precached asset from cache", async () => {
    const scope = boot(SW)
    await run(scope, "install", {})
    const res = await run(scope, "fetch", {
      request: new Request("https://app.test/assets/entry-abc123.js"),
    })
    expect(await res?.text()).toBe("asset:/assets/entry-abc123.js")
  })

  test("a failed navigation gets the offline page, and nothing is written for it", async () => {
    const scope = boot(SW)
    await run(scope, "install", {})
    const before = scope.store.size
    const request = new Request("https://app.test/dashboard")
    Object.defineProperty(request, "mode", { value: "navigate" })
    // The generated worker calls the ambient fetch; make it fail the way an offline device does.
    const original = globalThis.fetch
    // Cast: the test only needs the callable half, not fetch's `preconnect` companion.
    globalThis.fetch = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch
    try {
      const res = await run(scope, "fetch", { request })
      expect(await res?.text()).toBe("asset:/offline")
    } finally {
      globalThis.fetch = original
    }
    expect(scope.store.size).toBe(before)
    expect(scope.store.has("/dashboard")).toBe(false)
  })

  test("a POST is passed through untouched", async () => {
    const scope = boot(SW)
    await run(scope, "install", {})
    const res = await run(scope, "fetch", {
      request: new Request("https://app.test/assets/entry-abc123.js", { method: "POST" }),
    })
    expect(res).toBeUndefined()
  })

  test("a cross-origin GET is passed through untouched", async () => {
    const scope = boot(SW)
    await run(scope, "install", {})
    const res = await run(scope, "fetch", { request: new Request("https://cdn.other/x.js") })
    expect(res).toBeUndefined()
  })
})

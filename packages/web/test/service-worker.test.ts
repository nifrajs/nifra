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
    expect(generateServiceWorker(manifest, { buildId: "v1" })).toContain('const OWNED = "nifra:"')
    expect(generateServiceWorker(manifest, { buildId: "v2" })).toContain('OWNED + "v2"')
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

  /** Never defaults to the real `fetch`: a test that can reach the network can pass without the code. */
  const OFFLINE_FETCH = (): Promise<Response> => Promise.reject(new Error("offline"))

  /** A same-origin response as a worker's `fetch` returns it: `type` is "basic", not "default". */
  const basic = (
    body: string,
    init?: ResponseInit & { readonly redirected?: boolean },
  ): Response => {
    const response = new Response(body, init)
    Object.defineProperty(response, "type", { value: "basic" })
    if (init?.redirected === true) Object.defineProperty(response, "redirected", { value: true })
    return response
  }

  // Install fetches each precache URL by its string path; the fetch handler passes a Request. So
  // `precache` answers the install and `fetchImpl` everything else.
  const boot = (
    sw: string,
    fetchImpl: (request: Request) => Promise<Response> = OFFLINE_FETCH,
    precache: (path: string) => Response = (path) => basic(`asset:${path}`),
  ): Scope => {
    const listeners = new Map<string, (event: never) => void>()
    const store = new Map<string, Response>()
    const foreign = new Map<string, Response>([
      ["/api/me", new Response("another visitor's profile")],
      ["/assets/entry-abc123.js", new Response("another app's script")],
      ["/offline", new Response("another app's offline page")],
    ])
    const deleted: string[] = []
    const scope: Scope = { listeners, store, deleted, claimed: false }
    const names = new Set<string>()

    const cacheFor = (name: string) => ({
      put: async (key: Request | string, res: Response) => {
        names.add(name)
        store.set(typeof key === "string" ? key : new URL(key.url).pathname, res)
      },
    })
    const caches = {
      open: async (name: string) => cacheFor(name),
      keys: async () => [
        ...names,
        "nifra:v0",
        "nifra-old",
        "nifra-admin:v0",
        "another-app-offline",
        "user-data",
      ],
      delete: async (name: string) => {
        deleted.push(name)
        return true
      },
      // Without `cacheName`, CacheStorage.match answers from every cache on the origin.
      match: async (key: Request | string, options?: { cacheName?: string }) => {
        const path = typeof key === "string" ? key : new URL(key.url).pathname
        if (options?.cacheName !== undefined && !names.has(options.cacheName)) return undefined
        return store.get(path) ?? (options?.cacheName === undefined ? foreign.get(path) : undefined)
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
    //
    // `fetchImpl` is a PARAMETER rather than a later `globalThis.fetch` reassignment, because the
    // binding happens here at boot: a test that swapped the global afterwards was swapping something
    // the worker had already captured, so its "offline" case went to the real network and passed off a
    // DNS failure. A test that reaches the internet is not testing the code.
    new Function("self", "caches", "Response", "Request", "URL", "fetch", sw)(
      self,
      caches,
      Response,
      Request,
      URL,
      (input: Request | string) =>
        typeof input === "string" ? Promise.resolve(precache(input)) : fetchImpl(input),
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
    expect(scope.deleted).toEqual(["nifra:v0"])
    expect(scope.claimed).toBe(true)
  })

  test("install refuses a precache response it may not share, and stores nothing", async () => {
    for (const bad of [
      basic("Alice's offline page", { headers: { "cache-control": "private, no-store" } }),
      basic("Alice's offline page", { headers: { "cache-control": 'private="set-cookie"' } }),
      basic("Alice's offline page", { headers: { "cache-control": "max-age=60, NO-STORE" } }),
      basic("the login page", { redirected: true }),
      basic("missing", { status: 404 }),
      new Response("opaque-ish"),
    ]) {
      const scope = boot(SW, OFFLINE_FETCH, (path) => (path === "/offline" ? bad : basic(path)))
      await expect(run(scope, "install", {})).rejects.toThrow()
      expect(scope.store.size).toBe(0)
    }
    // A directive that only mentions the words is not one of them.
    const scope = boot(SW, OFFLINE_FETCH, (path) =>
      basic(path, { headers: { "cache-control": 'max-age=60, community="no-store"' } }),
    )
    await run(scope, "install", {})
    expect(scope.store.has("/offline")).toBe(true)
  })

  test("a runtime miss stores only a response it may share", async () => {
    for (const [cacheControl, stored] of [
      ["public, max-age=31536000, immutable", true],
      ["private, max-age=60", false],
      ["no-store", false],
    ] as const) {
      const online = () =>
        Promise.resolve(basic("fresh", { headers: { "cache-control": cacheControl } }))
      const scope = boot(SW, online)
      await run(scope, "fetch", { request: new Request("https://app.test/assets/entry-abc123.js") })
      // The put is fire-and-forget; one turn lets it land.
      await Promise.resolve()
      expect({ cacheControl, stored: scope.store.has("/assets/entry-abc123.js") }).toEqual({
        cacheControl,
        stored,
      })
    }
  })

  test("activate leaves caches outside its namespace alone", async () => {
    const scope = boot(generateServiceWorker(manifest, { buildId: "v1", cacheName: "nifra-admin" }))
    await run(scope, "install", {})
    await run(scope, "activate", {})
    expect(scope.deleted).toEqual(["nifra-admin:v0"])
  })

  test("serves a precached asset from cache", async () => {
    const scope = boot(SW)
    await run(scope, "install", {})
    const res = await run(scope, "fetch", {
      request: new Request("https://app.test/assets/entry-abc123.js"),
    })
    expect(await res?.text()).toBe("asset:/assets/entry-abc123.js")
  })

  const navigation = (url: string): Request => {
    const request = new Request(url)
    Object.defineProperty(request, "mode", { value: "navigate" })
    return request
  }

  test("a failed navigation gets the offline page, and nothing is written for it", async () => {
    const scope = boot(SW) // fetch rejects by default - nothing here touches the network
    await run(scope, "install", {})
    const before = scope.store.size

    const res = await run(scope, "fetch", { request: navigation("https://app.test/dashboard") })
    expect(await res?.text()).toBe("asset:/offline")

    expect(scope.store.size).toBe(before)
    expect(scope.store.has("/dashboard")).toBe(false)
  })

  /**
   * The case the suite was missing entirely, and the one whose absence hides the worst possible bug: a
   * worker that answered EVERY navigation with the offline page passed all nineteen tests, because the
   * only navigation exercised was a failing one. That worker installs itself instantly
   * (`skipWaiting` + `clients.claim`) and outlives the deploy, so every visitor would get a static
   * "you are offline" document in place of the app.
   */
  test("an ONLINE navigation gets the network response, not the offline page", async () => {
    let asked: string | undefined
    const online = ((request: Request) => {
      asked = request.url
      return Promise.resolve(new Response("<!doctype html><title>real page</title>"))
    }) as never
    const scope = boot(SW, online)
    await run(scope, "install", {})
    const before = scope.store.size

    const res = await run(scope, "fetch", { request: navigation("https://app.test/dashboard") })
    expect(asked).toBe("https://app.test/dashboard")
    expect(await res?.text()).toBe("<!doctype html><title>real page</title>")
    // Not the offline document, and not stored: a cached HTML response is how one signed-in user gets
    // served the page rendered for another.
    expect(scope.store.size).toBe(before)
    expect(scope.store.has("/dashboard")).toBe(false)
  })

  test("another cache on the origin is never read, and an unlisted GET goes to the network", async () => {
    const online = (request: Request) =>
      Promise.resolve(new Response(`network:${new URL(request.url).pathname}`))
    const scope = boot(SW, online)
    // Not installed yet: this build's cache is empty, while another cache holds the same paths.
    const api = await run(scope, "fetch", { request: new Request("https://app.test/api/me") })
    expect(api).toBeUndefined()
    const asset = await run(scope, "fetch", {
      request: new Request("https://app.test/assets/entry-abc123.js"),
    })
    expect(await asset?.text()).toBe("network:/assets/entry-abc123.js")
    const offline = await run(boot(SW), "fetch", {
      request: navigation("https://app.test/dashboard"),
    })
    expect(offline?.type).toBe("error")
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

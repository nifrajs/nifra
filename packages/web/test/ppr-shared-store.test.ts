import { describe, expect, spyOn, test } from "bun:test"
import type { BoundaryStates } from "../src/boundary.ts"
import { shellDeployment } from "../src/internal/ppr/integration.ts"
import { resolvePprOptions } from "../src/internal/ppr/options.ts"
import {
  createPprServer,
  type PprRequest,
  type PprServerConfig,
} from "../src/internal/ppr/server.ts"
import { digest, sharedShellStore } from "../src/internal/ppr/shell-store.ts"
import { notFound } from "../src/internal/render-document.ts"
import { type CachedResponse, type CacheStore, MemoryCacheStore } from "../src/isr.ts"
import { partialPrerendering } from "../src/ppr.ts"
import type { RenderAdapter } from "../src/render-seam.ts"

const SECRET = "a shell signing secret of 32+ chars"
const DEPLOYMENT = "d1~0123456789abcdef"

const adapter: RenderAdapter = {
  renderToStream: () => new ReadableStream(),
  hydrationHead: () => "",
  renderFragment: (ui) => `<p>${String(ui())}</p>`,
}

const PROSE = `<p>${"Loose-leaf tea, packed by hand and shipped the same day. ".repeat(4)}</p>`

const document = (data: unknown, states: BoundaryStates): string =>
  `<!doctype html><html><head><title>t</title></head><body>${PROSE}<h1>${JSON.stringify(data)}</h1>${Object.keys(
    states,
  )
    .map((name) => `<div data-nifra-hole="${name}" aria-busy="true"></div>`)
    .join("")}</body></html>`

interface Probe {
  builds: number
  readonly writes: Array<Promise<unknown>>
}

const pprRequest = (probe: Probe, overrides: Partial<PprRequest> = {}): PprRequest => ({
  routeId: "product/[id]",
  path: "/p/1",
  locale: undefined,
  variations: {},
  request: new Request("https://shop.test/p/1"),
  holes: [
    {
      name: "cart",
      mode: "dynamic",
      render: (data: never) => `cart ${String(data)}`,
      fallback: "loading",
      load: () => "3 items",
    },
  ],
  holeContext: {
    request: new Request("https://shop.test/p/1"),
    params: { id: "1" },
    api: undefined,
    env: undefined,
    draft: false,
    search: {},
  },
  loadShell: async () => {
    probe.builds++
    return { title: `Tea ${probe.builds}` }
  },
  renderShellDocument: async (data, states) => document(data, states),
  revalidate: undefined,
  tags: () => [],
  waitUntil: (promise) => {
    probe.writes.push(promise)
  },
  ...overrides,
})

const serverOn = (store: CacheStore, overrides: Partial<PprServerConfig> = {}) =>
  createPprServer({
    options: resolvePprOptions(),
    adapter,
    deployment: DEPLOYMENT,
    clientEntry: "d1",
    cancelUrl: "/__nifra/ppr/cancel",
    shellChecks: { v: 1, deployment: "d1", routes: { "product/[id]": "h1" } },
    shared: sharedShellStore(store, SECRET, DEPLOYMENT),
    ...overrides,
  })

const probeOf = (): Probe => ({ builds: 0, writes: [] })

/** The shell's `<h1>`, which names the build that made it. */
const titleOf = async (response: Response): Promise<string> =>
  /<h1>([^<]*)<\/h1>/.exec(await response.text())?.[1] ?? ""

/** The one key a store holds. */
const onlyKey = (seen: string[]): string => {
  expect(seen.length).toBeGreaterThan(0)
  return seen[0] ?? ""
}

const entryAt = async (store: CacheStore, key: string): Promise<CachedResponse> => {
  const entry = await store.get(key)
  if (entry === undefined) throw new Error(`no entry at ${key}`)
  return entry
}

/** A store that records the keys written to it. */
const recording = (store: CacheStore): { store: CacheStore; keys: string[] } => {
  const keys: string[] = []
  return {
    keys,
    store: {
      get: (key) => store.get(key),
      set: (key, value) => {
        keys.push(key)
        return store.set(key, value)
      },
      delete: (key) => store.delete(key),
      invalidateTag: (tag) => store.invalidateTag?.(tag) ?? Promise.resolve(),
      fence: () => store.fence?.() ?? 0,
    },
  }
}

describe("PPR shared shell store", () => {
  test("a shell one process built is served by another without a build", async () => {
    const shared = new MemoryCacheStore()
    const first = probeOf()
    await titleOf(await serverOn(shared).respond(pprRequest(first)))
    await Promise.all(first.writes)
    const second = probeOf()
    const other = serverOn(shared)
    const responses = await Promise.all([
      other.respond(pprRequest(second)),
      other.respond(pprRequest(second)),
    ])
    const texts = await Promise.all(responses.map((response) => response.text()))
    expect(first.builds).toBe(1)
    expect(second.builds).toBe(0)
    for (const text of texts) {
      expect(text).toContain('<h1>{"title":"Tea 1"}</h1>')
      expect(text).toContain("cart 3 items")
    }
    // Each response prints its own token into the shared bytes.
    const tokens = texts.map((text) => /"token":"([A-Za-z0-9_-]+)"/.exec(text)?.[1])
    expect(tokens[0]).not.toBe(tokens[1])
  })

  test("an entry whose bytes were changed in the store is a miss, and the process builds its own", async () => {
    const shared = recording(new MemoryCacheStore())
    const first = probeOf()
    await titleOf(await serverOn(shared.store).respond(pprRequest(first)))
    await Promise.all(first.writes)
    const key = onlyKey(shared.keys)
    const stored = await entryAt(shared.store, key)
    const poisoned = stored.body.replace("Tea 1", "<script>steal()</script>")
    await shared.store.set(key, { ...stored, body: poisoned })
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      const second = probeOf()
      const text = await (await serverOn(shared.store).respond(pprRequest(second))).text()
      expect(second.builds).toBe(1)
      expect(text).not.toContain("steal()")
      expect(errors).toHaveBeenCalledWith(
        "[nifra/web] ppr: a shared shell entry failed its signature check",
        { key },
      )
    } finally {
      errors.mockRestore()
    }
  })

  test("an entry signed with another secret, or moved to another key, is a miss", async () => {
    const shared = recording(new MemoryCacheStore())
    const first = probeOf()
    await titleOf(await serverOn(shared.store).respond(pprRequest(first)))
    await Promise.all(first.writes)
    const key = onlyKey(shared.keys)
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      const otherSecret = sharedShellStore(shared.store, `${SECRET}, rotated`, DEPLOYMENT)
      expect(await otherSecret.get(key)).toBeUndefined()
      const stored = await entryAt(shared.store, key)
      const movedKey = key.replace("/p/1", "/p/2")
      await shared.store.set(movedKey, stored)
      expect(await sharedShellStore(shared.store, SECRET, DEPLOYMENT).get(movedKey)).toBeUndefined()
      expect(await sharedShellStore(shared.store, SECRET, "d2~0").get(key)).toBeUndefined()
      expect(await sharedShellStore(shared.store, SECRET, DEPLOYMENT).get(key)).toMatchObject({
        routeId: "product/[id]",
      })
    } finally {
      errors.mockRestore()
    }
  })

  test("a shell loader's notFound() is shared for its short time to live", async () => {
    const shared = new MemoryCacheStore()
    const first = probeOf()
    const missing = (probe: Probe) =>
      pprRequest(probe, {
        loadShell: async () => {
          probe.builds++
          return notFound()
        },
      })
    await expect(serverOn(shared).respond(missing(first))).rejects.toMatchObject({ status: 404 })
    await Promise.all(first.writes)
    const second = probeOf()
    await expect(serverOn(shared).respond(missing(second))).rejects.toMatchObject({ status: 404 })
    expect(second.builds).toBe(0)
  })

  test("a stale shared shell is served while this process rebuilds it", async () => {
    const shared = new MemoryCacheStore()
    let clock = 1_000_000
    const now = () => clock
    const first = probeOf()
    await serverOn(shared, { now }).respond(pprRequest(first, { revalidate: 60 }))
    await Promise.all(first.writes)
    clock += 61_000
    const second = probeOf()
    const rebuilt = (probe: Probe) =>
      pprRequest(probe, {
        revalidate: 60,
        loadShell: async () => {
          probe.builds++
          return { title: "rebuilt" }
        },
      })
    const other = serverOn(shared, { now })
    expect(await titleOf(await other.respond(rebuilt(second)))).toBe('{"title":"Tea 1"}')
    await Promise.all(second.writes)
    expect(second.builds).toBe(1)
    expect(await titleOf(await other.respond(rebuilt(second)))).toBe('{"title":"rebuilt"}')
  })

  test("a purge by tag drops the shared shell for every process", async () => {
    const shared = new MemoryCacheStore()
    const tagged = (probe: Probe) => pprRequest(probe, { tags: () => ["product:1"] })
    const first = probeOf()
    const one = serverOn(shared)
    await one.respond(tagged(first))
    await Promise.all(first.writes)
    await one.invalidateTag("product:1")
    const second = probeOf()
    await serverOn(shared).respond(tagged(second))
    expect(second.builds).toBe(1)
  })

  test("a build that began before a purge is not written to the shared store", async () => {
    const shared = new MemoryCacheStore()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = probeOf()
    const one = serverOn(shared)
    const building = one.respond(
      pprRequest(first, {
        tags: () => ["product:1"],
        loadShell: async () => {
          first.builds++
          await held
          return { title: "before the purge" }
        },
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    await one.invalidateTag("product:1")
    release()
    await (await building).text()
    await Promise.all(first.writes)
    const second = probeOf()
    await serverOn(shared).respond(pprRequest(second, { tags: () => ["product:1"] }))
    expect(second.builds).toBe(1)
  })

  test("a route whose tags the store cannot drop keeps its shells in the process", async () => {
    const memory = new MemoryCacheStore()
    const keys: string[] = []
    const untaggable: CacheStore = {
      get: (key) => memory.get(key),
      set: (key, value) => {
        keys.push(key)
        return memory.set(key, value)
      },
      delete: (key) => memory.delete(key),
    }
    const warnings = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const probe = probeOf()
      const server = serverOn(untaggable)
      for (const path of ["/p/1", "/p/2"])
        await (await server.respond(pprRequest(probe, { path, tags: () => ["product:1"] }))).text()
      await (await server.respond(pprRequest(probe, { path: "/p/3" }))).text()
      await Promise.all(probe.writes)
      expect(keys).toHaveLength(1)
      expect(keys[0]).toContain("/p/3")
      expect(warnings).toHaveBeenCalledTimes(1)
    } finally {
      warnings.mockRestore()
    }
  })

  test("a store that fails to answer is a miss, and one that fails to write is logged", async () => {
    const failing: CacheStore = {
      get: () => Promise.reject(new Error("down")),
      set: () => Promise.reject(new Error("down")),
      delete: () => Promise.reject(new Error("down")),
    }
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      const probe = probeOf()
      const text = await (await serverOn(failing).respond(pprRequest(probe))).text()
      await Promise.all(probe.writes)
      expect(probe.builds).toBe(1)
      expect(text).toContain("cart 3 items")
      expect(errors).toHaveBeenCalledWith(
        "[nifra/web] ppr: writing a shell to the shared store failed",
        { route: "product/[id]", kind: "error" },
      )
    } finally {
      errors.mockRestore()
    }
  })
})

describe("PPR deployment id", () => {
  const checks = (hash: string) => ({ v: 1 as const, deployment: "/c-1.js", routes: { p: hash } })

  test("a change to a route's shell code alone gives a new id", () => {
    expect(shellDeployment("/c-1.js", checks("h1"), undefined)).not.toBe(
      shellDeployment("/c-1.js", checks("h2"), undefined),
    )
    expect(shellDeployment("/c-1.js", checks("h1"), undefined)).toBe(
      shellDeployment("/c-1.js", checks("h1"), undefined),
    )
  })

  test("the platform's name adds to the build's id, never replaces it", () => {
    const named = shellDeployment("/c-1.js", checks("h1"), "commit-a")
    expect(named).not.toBe(shellDeployment("/c-1.js", checks("h1"), undefined))
    expect(named).not.toBe(shellDeployment("/c-1.js", checks("h2"), "commit-a"))
    expect(named.startsWith("/c-1.js~")).toBe(true)
  })

  test("unchecked development shells are named by the client entry", () => {
    expect(shellDeployment("/c-1.js", "unchecked-development", undefined)).toBe("/c-1.js")
  })

  test("the digest is 64-bit FNV-1a", () => {
    expect(digest("")).toBe("cbf29ce484222325")
    expect(digest("a")).toBe("af63dc4c8601ec8c")
    expect(digest("foobar")).toBe("85944171f73967e8")
  })
})

describe("partialPrerendering store options", () => {
  const record = { v: 1 as const, deployment: "/c.js", routes: {} }

  test("a store needs a signing secret of at least 32 characters", () => {
    const store = new MemoryCacheStore()
    expect(() => partialPrerendering({ shellChecks: record, store })).toThrow(/storeSecret/)
    expect(() => partialPrerendering({ shellChecks: record, store, storeSecret: "short" })).toThrow(
      /at least 32/,
    )
    expect(() =>
      partialPrerendering({ shellChecks: record, store, storeSecret: SECRET }),
    ).not.toThrow()
  })

  test("unchecked shells are never shared", () => {
    expect(() =>
      partialPrerendering({
        shellChecks: "unchecked-development",
        store: new MemoryCacheStore(),
        storeSecret: SECRET,
      }),
    ).toThrow(/shell check records/)
  })

  test("a named deployment is a non-empty string", () => {
    expect(() => partialPrerendering({ shellChecks: record, deployment: "" })).toThrow(/non-empty/)
  })
})

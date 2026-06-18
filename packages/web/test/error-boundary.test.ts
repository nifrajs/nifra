import { describe, expect, test } from "bun:test"
import {
  buildManifest,
  createWebApp,
  type Manifest,
  type RenderAdapter,
  redirect,
  renderPage,
} from "../src/index.ts"

// Stub adapter: emits `chain=<len>:<data>` so assertions can see the chain length + the props.data
// (which, for an error page, is the serialized `{ name, message }`).
const streamOf = (s: string): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(s)
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
}
const stub: RenderAdapter = {
  renderToStream: (chain, props) =>
    streamOf(`<p>chain=${chain.length}:${JSON.stringify(props.data)}</p>`),
  hydrationHead: () => "",
}

const fakeImporter = (file: string) => () =>
  Promise.resolve({ default: file } as { default: unknown }) as Promise<never>

describe("_error discovery (buildManifest)", () => {
  test("detects _error per dir; routes carry their ancestor errorIds (outermost → innermost)", () => {
    const m = buildManifest(
      ["index.tsx", "_error.tsx", "a/index.tsx", "a/_error.tsx", "a/b/index.tsx", "_404.tsx"],
      fakeImporter,
    )
    expect(Object.keys(m.errors ?? {}).sort()).toEqual(["_error", "a/_error"])
    const byPattern = (p: string) => m.routes.find((r) => r.pattern === p)
    expect(byPattern("/")?.errorIds).toEqual(["_error"])
    expect(byPattern("/a")?.errorIds).toEqual(["_error", "a/_error"]) // nearest is last
    expect(byPattern("/a/b")?.errorIds).toEqual(["_error", "a/_error"]) // a/b inherits a's + root
    expect(m.notFound).toBeDefined() // _error doesn't shadow _404 detection
  })

  test("no _error files → empty errors map + no errorIds", () => {
    const m = buildManifest(["index.tsx"], fakeImporter)
    expect(m.errors).toEqual({})
    expect(m.routes[0]?.errorIds).toEqual([])
  })
})

// A manifest whose `/boom` loader throws; root + `a/b` have `_error`; layered layouts to test "kept".
const errorManifest = (thrown: unknown): Manifest => ({
  routes: [
    {
      id: "boom",
      pattern: "/boom",
      layoutIds: ["_layout"],
      errorIds: ["_error"],
      file: "boom.tsx",
      load: async () => ({
        default: "boom-page",
        loader: () => {
          throw thrown
        },
      }),
    },
    {
      id: "a/b/deep",
      pattern: "/a/b/deep",
      layoutIds: ["_layout", "a/_layout", "a/b/_layout"],
      errorIds: ["_error", "a/_error"], // nearest = a/_error (a/b has none)
      file: "a/b/deep.tsx",
      load: async () => ({
        default: "deep-page",
        loader: () => {
          throw new Error("deep boom")
        },
      }),
    },
    {
      id: "naked",
      pattern: "/naked",
      layoutIds: [],
      errorIds: [], // no boundary
      file: "naked.tsx",
      load: async () => ({
        default: "naked",
        loader: () => {
          throw new Error("unhandled")
        },
      }),
    },
  ],
  layouts: {
    _layout: { file: "_layout.tsx", load: async () => ({ default: "L0" }) },
    "a/_layout": { file: "a/_layout.tsx", load: async () => ({ default: "La" }) },
    "a/b/_layout": { file: "a/b/_layout.tsx", load: async () => ({ default: "Lab" }) },
  },
  errors: {
    _error: { file: "_error.tsx", load: async () => ({ default: "RootError" }) },
    "a/_error": { file: "a/_error.tsx", load: async () => ({ default: "AError" }) },
  },
})

describe("agnostic loader-error rendering", () => {
  test("a thrown error renders the nearest _error (status 500), non-hydrated, no stack", async () => {
    const app = createWebApp({
      adapter: stub,
      manifest: errorManifest(new Error("boom")),
      clientEntry: "/c.js",
    })
    const res = await app.fetch(new Request("http://x/boom"))
    expect(res.status).toBe(500)
    expect(res.headers.get("content-type")).toContain("text/html")
    const html = await res.text()
    // chain = [_layout, _error] = 2, with the serialized error as data.
    expect(html).toContain('chain=2:{"name":"Error","message":"boom"}')
    // Non-hydrated: no client entry module script, no data global, no modulepreload, no stack leak.
    expect(html).not.toContain('type="module"')
    expect(html).not.toContain("__NIFRA_DATA__")
    expect(html).not.toContain("modulepreload")
    expect(html).not.toContain("stack")
  })

  test("nearest boundary keeps layouts at/above its segment, drops deeper ones", async () => {
    const app = createWebApp({
      adapter: stub,
      manifest: errorManifest(new Error("x")),
      clientEntry: "/c.js",
    })
    const html = await (await app.fetch(new Request("http://x/a/b/deep"))).text()
    // nearest _error is a/_error → keep [_layout, a/_layout] + AError = chain 3 (a/b/_layout dropped).
    expect(html).toContain("chain=3:")
    expect(html).toContain('"message":"deep boom"')
  })

  test("a thrown Response (guard redirect) passes through — not caught as an error", async () => {
    const app = createWebApp({
      adapter: stub,
      manifest: errorManifest(redirect("/login")),
      clientEntry: "/c.js",
    })
    const res = await app.fetch(new Request("http://x/boom"))
    expect(res.status).toBeGreaterThanOrEqual(300)
    expect(res.status).toBeLessThan(400)
    expect(res.headers.get("location")).toBe("/login")
  })

  test("no _error boundary → the error propagates (500), not an error page", async () => {
    const app = createWebApp({
      adapter: stub,
      manifest: errorManifest(new Error("x")),
      clientEntry: "/c.js",
    })
    const res = await app.fetch(new Request("http://x/naked"))
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain("chain=") // core's generic 500, not a rendered boundary
  })

  test("a soft-nav data fetch that errors returns 500 (client then falls back to full-page nav)", async () => {
    const app = createWebApp({
      adapter: stub,
      manifest: errorManifest(new Error("boom")),
      clientEntry: "/c.js",
    })
    const res = await app.fetch(new Request("http://x/boom", { headers: { "x-nifra-data": "1" } }))
    expect(res.status).toBe(500)
    expect(res.headers.get("content-type")).toContain("text/plain")
    expect(await res.text()).not.toContain("chain=") // not an HTML boundary render
  })
})

describe("renderPage hydrate:false", () => {
  const chain = ["page"]
  test("default (hydrate:true) emits the client entry + data global", async () => {
    const html = await (
      await renderPage({ adapter: stub, chain, data: { a: 1 }, clientEntry: "/c.js" })
    ).text()
    expect(html).toContain('<script type="module" src="/c.js">')
    expect(html).toContain("__NIFRA_DATA__")
    expect(html).toContain('modulepreload" href="/c.js"')
  })

  test("hydrate:false emits a complete but non-hydrated document", async () => {
    const html = await (
      await renderPage({
        adapter: stub,
        chain,
        data: { a: 1 },
        clientEntry: "/c.js",
        hydrate: false,
      })
    ).text()
    expect(html).toContain("chain=1:") // app markup still rendered
    expect(html).toContain("</body></html>")
    expect(html).not.toContain('type="module"')
    expect(html).not.toContain("__NIFRA_DATA__")
    expect(html).not.toContain("modulepreload")
  })
})

describe("SSR render-throw (not a loader throw)", () => {
  // An adapter that throws while rendering the *page* chain, but renders the error chain fine.
  const throwStub: RenderAdapter = {
    renderToStream: (chain, props) => {
      if (chain.includes("render-bomb")) throw new Error("render boom")
      return streamOf(`<p>chain=${chain.length}:${JSON.stringify(props.data)}</p>`)
    },
    hydrationHead: () => "",
  }
  const renderThrowManifest = (): Manifest => ({
    routes: [
      {
        id: "bomb",
        pattern: "/bomb",
        layoutIds: [],
        errorIds: ["_error"],
        file: "bomb.tsx",
        load: async () => ({ default: "render-bomb" }), // no loader — the *render* throws
      },
    ],
    layouts: {},
    errors: { _error: { file: "_error.tsx", load: async () => ({ default: "RootError" }) } },
  })

  test("a shell render-throw renders the nearest _error page (500, non-hydrated)", async () => {
    const app = createWebApp({
      adapter: throwStub,
      manifest: renderThrowManifest(),
      clientEntry: "/c.js",
    })
    const res = await app.fetch(new Request("http://x/bomb"))
    expect(res.status).toBe(500)
    const html = await res.text()
    expect(html).toContain('{"name":"Error","message":"render boom"}')
    expect(html).not.toContain('type="module"') // non-hydrated error page
  })
})

describe("onLoaderError reporting hook", () => {
  test("observes loader failures — boundary-rendered AND rethrown — with route + error", async () => {
    const seen: Array<{ route: string; message: string }> = []
    const app = createWebApp({
      adapter: stub,
      manifest: errorManifest(new Error("boom")),
      clientEntry: "/c.js",
      onLoaderError: (err, ctx) => seen.push({ route: ctx.route, message: (err as Error).message }),
    })
    await app.fetch(new Request("http://x/boom")) // renders the nearest _error boundary
    await app.fetch(new Request("http://x/naked")) // no boundary → rethrows (core → 500)
    expect(seen).toEqual([
      { route: "/boom", message: "boom" },
      { route: "/naked", message: "unhandled" },
    ])
  })

  test("a thrown Response (redirect/guard) is NOT reported — it's control flow", async () => {
    const seen: unknown[] = []
    const m = errorManifest(new Error("x"))
    // Swap /boom's loader to throw a Response (a guard redirect).
    const boom = m.routes.find((r) => r.pattern === "/boom")
    if (boom) {
      ;(boom as { load: () => Promise<unknown> }).load = async () => ({
        default: "boom",
        loader: () => {
          throw redirect("/login")
        },
      })
    }
    const app = createWebApp({
      adapter: stub,
      manifest: m,
      clientEntry: "/c.js",
      onLoaderError: (err) => seen.push(err),
    })
    const res = await app.fetch(new Request("http://x/boom"))
    expect(res.status).toBe(303) // redirect() → 303 See Other
    expect(seen).toHaveLength(0)
  })

  test("a faulty reporter never breaks error rendering", async () => {
    const app = createWebApp({
      adapter: stub,
      manifest: errorManifest(new Error("boom")),
      clientEntry: "/c.js",
      onLoaderError: () => {
        throw new Error("reporter blew up")
      },
    })
    const res = await app.fetch(new Request("http://x/boom"))
    expect(res.status).toBe(500) // boundary still rendered
  })
})

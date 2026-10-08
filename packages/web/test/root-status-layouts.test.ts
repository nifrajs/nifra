import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  buildManifest,
  createClientRouter,
  createWebApp,
  type LoaderContext,
  type RenderAdapter,
  type RouteModule,
  redirect,
  statusPage,
} from "../src/index.ts"
import { generateClientEntry } from "../src/internal/codegen.ts"
import { DATA_HEADER, STATUS_HEADER } from "../src/router.ts"
import { isBackendHalf, splitRouteHalves } from "./_route-halves.ts"

// A root status page or `_error` that exports `inLayouts` renders inside the root layout with its
// loader data and meta, and alone - same status - when that layout cannot render.

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
    streamOf(
      `<main>${JSON.stringify({ chain, data: props.data, layoutData: props.layoutData ?? null })}</main>`,
    ),
  hydrationHead: () => "",
}

interface Rendered {
  readonly chain: readonly string[]
  readonly data: unknown
  readonly layoutData: readonly unknown[] | null
}

const renderedOf = (html: string): Rendered => {
  const match = /<main>(.*?)<\/main>/s.exec(html)
  if (match === null) throw new Error(`no render in: ${html}`)
  return JSON.parse(match[1] ?? "null")
}

// `gate` and `middleware` are layout-module exports; the importer returns route and layout modules alike.
type Modules = Record<
  string,
  Partial<RouteModule> & {
    readonly gate?: boolean
    readonly middleware?: (ctx: LoaderContext) => unknown
  }
>

const appOf = (modules: Modules, adapter: RenderAdapter = stub) => {
  const halves = splitRouteHalves(modules)
  const manifest = buildManifest(Object.keys(halves), (file) => () => {
    const half = halves[file]
    // A backend half carries no `default`; the frontend half's is its file name, for the stub to print.
    return Promise.resolve(
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a backend half has no `default` by contract, which RouteModule types as required; the manifest merges it with its frontend half.
      (isBackendHalf(file) ? { ...half } : { default: file, ...half }) as RouteModule,
    )
  })
  return createWebApp({ adapter, manifest, clientEntry: "/c.js" })
}

const get = (
  app: { fetch(r: Request): Response | Promise<Response> },
  path: string,
  headers: Record<string, string> = {},
) => app.fetch(new Request(`http://x${path}`, { headers }))

const failing = async (): Promise<never> => {
  await Promise.resolve()
  throw new Error("layout store down")
}

const site = (overrides: Modules = {}): Modules => ({
  "_layout.tsx": { loader: () => ({ site: "root" }), meta: { title: "Site" } },
  "_404.tsx": { inLayouts: true, meta: { title: "Not found" } },
  "_503.tsx": { inLayouts: true, meta: { title: "Down for maintenance" } },
  "_error.tsx": { inLayouts: true },
  "index.tsx": {},
  "maintenance.tsx": {
    loader: () => {
      throw statusPage(503)
    },
  },
  "broken.tsx": {
    loader: () => {
      throw new Error("page store down")
    },
  },
  ...overrides,
})

describe("a root status page with inLayouts", () => {
  test("an unmatched URL renders the root _404 inside the root layout with its data and meta", async () => {
    const res = await get(appOf(site()), "/nope")
    expect(res.status).toBe(404)
    expect(res.headers.get("cache-control")).toBe("private, no-store")
    const html = await res.text()
    expect(renderedOf(html)).toEqual({
      chain: ["_layout.tsx", "_404.tsx"],
      data: null,
      layoutData: [{ site: "root" }],
    })
    expect(html).toContain("<title>Not found</title>")
    // The browser hydrates the same chain: the root layout's data travels in the handover.
    expect(html).toContain('"__NIFRA_LAYOUT_DATA__":[{"site":"root"}],"__NIFRA_ROUTE__":"_404"')
    expect(html).toContain("/c.js")
  })

  test("statusPage(503) from a loader renders _503 inside the layout data the request loaded", async () => {
    const res = await get(appOf(site()), "/maintenance")
    expect(res.status).toBe(503)
    const html = await res.text()
    expect(renderedOf(html)).toMatchObject({
      chain: ["_layout.tsx", "_503.tsx"],
      layoutData: [{ site: "root" }],
    })
    expect(html).toContain("<title>Down for maintenance</title>")
  })

  test("statusPage(503) returned from a loader renders _503 inside the settled layout data", async () => {
    const res = await get(
      appOf(site({ "paused.tsx": { loader: () => statusPage(503) } })),
      "/paused",
    )
    expect(res.status).toBe(503)
    const html = await res.text()
    expect(renderedOf(html)).toMatchObject({
      chain: ["_layout.tsx", "_503.tsx"],
      layoutData: [{ site: "root" }],
    })
    expect(html).toContain("<title>Down for maintenance</title>")
  })

  test("statusPage(503) thrown while rendering renders _503 inside the layouts that loaded", async () => {
    const throwing: RenderAdapter = {
      ...stub,
      renderToStream: (chain, props) => {
        if (chain.includes("paused.tsx")) throw statusPage(503)
        return stub.renderToStream(chain, props)
      },
    }
    const res = await get(appOf(site({ "paused.tsx": {} }), throwing), "/paused")
    expect(res.status).toBe(503)
    const html = await res.text()
    expect(renderedOf(html)).toMatchObject({
      chain: ["_layout.tsx", "_503.tsx"],
      layoutData: [{ site: "root" }],
    })
    expect(html).toContain("<title>Down for maintenance</title>")
  })

  test("a _503 whose root loader throws still renders, alone, as a 503", async () => {
    const res = await get(
      appOf(site({ "_layout.tsx": { loader: failing, meta: { title: "Site" } } })),
      "/maintenance",
    )
    expect(res.status).toBe(503)
    const html = await res.text()
    expect(renderedOf(html)).toEqual({ chain: ["_503.tsx"], data: null, layoutData: null })
    expect(html).toContain("<title>Down for maintenance</title>")
    // The browser would render the layout around it, so the page alone stays server-only.
    expect(html).not.toContain("/c.js")
  })

  test("a root layout that cannot load leaves the _404 alone, with the same status", async () => {
    const res = await get(
      appOf(site({ "_layout.tsx": { loader: failing, meta: { title: "Site" } } })),
      "/nope",
    )
    expect(res.status).toBe(404)
    expect(renderedOf(await res.text()).chain).toEqual(["_404.tsx"])
  })

  test("middleware that refuses an unmatched URL leaves the _404 alone instead of redirecting", async () => {
    const res = await get(
      appOf(
        site({
          "_layout.tsx": {
            loader: () => ({ site: "root" }),
            middleware: () => redirect("/login"),
          },
        }),
      ),
      "/nope",
    )
    expect(res.status).toBe(404)
    expect(renderedOf(await res.text()).chain).toEqual(["_404.tsx"])
  })

  test("a gate that refuses leaves the _404 alone", async () => {
    const res = await get(
      appOf(
        site({
          "_layout.tsx": {
            gate: true,
            loader: () => {
              throw redirect("/login")
            },
          },
        }),
      ),
      "/nope",
    )
    expect(res.status).toBe(404)
    expect(renderedOf(await res.text()).layoutData).toBeNull()
  })

  test("a data request keeps the empty status answer", async () => {
    const res = await get(appOf(site()), "/maintenance", { [DATA_HEADER]: "1" })
    expect(res.status).toBe(503)
    expect(res.headers.get(STATUS_HEADER)).toBe("503")
    expect(await res.text()).toBe("")
  })
})

describe("_error with inLayouts", () => {
  test("renders inside the layouts with their loader data", async () => {
    const res = await get(appOf(site()), "/broken")
    expect(res.status).toBe(500)
    expect(res.headers.get("cache-control")).toBe("private, no-store")
    expect(renderedOf(await res.text())).toMatchObject({
      chain: ["_layout.tsx", "_error.tsx"],
      layoutData: [{ site: "root" }],
    })
  })

  test("renders alone when a layout loader is what failed", async () => {
    const res = await get(appOf(site({ "_layout.tsx": { loader: failing } })), "/")
    expect(res.status).toBe(500)
    expect(renderedOf(await res.text())).toMatchObject({ chain: ["_error.tsx"], layoutData: null })
  })
})

describe("without inLayouts", () => {
  const plain = site({
    "_404.tsx": { meta: { title: "Not found" } },
    "_503.tsx": {},
    "_error.tsx": {},
  })

  test("a root status page renders alone and runs no layout loader, but applies its meta", async () => {
    let ran = 0
    const res = await get(
      appOf({
        ...plain,
        "_layout.tsx": {
          loader: () => {
            ran++
            return { site: "root" }
          },
        },
      }),
      "/nope",
    )
    expect(res.status).toBe(404)
    expect(res.headers.get("cache-control")).not.toBe("private, no-store")
    const html = await res.text()
    expect(renderedOf(html)).toEqual({ chain: ["_404.tsx"], data: null, layoutData: null })
    expect(html).toContain("<title>Not found</title>")
    expect(html).toContain("/c.js")
    expect(ran).toBe(0)
  })

  test("_error keeps rendering inside its layouts without their data", async () => {
    const res = await get(appOf(plain), "/broken")
    expect(renderedOf(await res.text())).toMatchObject({
      chain: ["_layout.tsx", "_error.tsx"],
      layoutData: null,
    })
  })
})

describe("the browser side", () => {
  const dir = mkdtempSync(join(import.meta.dir, ".tmp-status-layouts-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test("the client entry loads the root layout around an inLayouts status page only", async () => {
    const files: Record<string, string> = {
      "_layout.tsx": 'export default "layout"\n',
      "_404.tsx": 'export const inLayouts = true\nexport default "not-found"\n',
      "_410.tsx": 'export default "gone"\n',
      "index.tsx": 'export default "home"\n',
    }
    mkdirSync(join(dir, "routes"), { recursive: true })
    for (const [file, source] of Object.entries(files)) {
      writeFileSync(join(dir, "routes", file), source)
    }
    const manifest = buildManifest(
      Object.keys(files),
      () => () => Promise.resolve({ default: null }),
    )
    const entry = generateClientEntry(manifest, {
      clientModule: "@nifrajs/web-react/client",
      resolve: (file) => pathToFileURL(join(dir, "routes", file)).href,
    })
    expect(entry).toContain("statusRoutes, layoutStatusRoutes,")
    // Evaluate just the loaders and the tables they fill.
    const start = entry.indexOf("const layoutStatusRoutes = {}")
    const end = entry.indexOf("const chains = {}")
    const layoutIdsLine = entry.split("\n").find((line) => line.startsWith("const layoutIdsOf ="))
    const module = join(dir, "loaders.mjs")
    writeFileSync(
      module,
      `${layoutIdsLine}\n${entry.slice(start, end)}\nexport { loaders, layoutStatusRoutes, layoutIdsOf }\n`,
    )
    const loaded = await import(pathToFileURL(module).href)
    const notFound: { default: string }[] = await loaded.loaders._404()
    expect(notFound.map((mod) => mod.default)).toEqual(["layout", "not-found"])
    expect(loaded.layoutStatusRoutes).toEqual({ _404: true })
    expect(loaded.layoutIdsOf._404).toEqual(["_layout"])
    const gone: { default: string }[] = await loaded.loaders._410()
    expect(gone.map((mod) => mod.default)).toEqual(["gone"])
  })

  test("a soft navigation that ends on an inLayouts status page loads the URL as a document", async () => {
    const router = createClientRouter({
      patterns: [{ routeId: "item", pattern: "/item/:id" }],
      initial: {
        routeId: "item",
        params: { id: "1" },
        path: "/item/1",
        data: null,
        pending: false,
      },
      fetchData: async () => ({ v: 1, status: 404, data: null }),
      statusRoutes: { 404: "_404" },
      layoutStatusRoutes: { _404: true },
    })
    await expect(router.navigate("/item/2")).rejects.toThrow("loading /item/2 as a document")
    const plain = createClientRouter({
      patterns: [{ routeId: "item", pattern: "/item/:id" }],
      initial: {
        routeId: "item",
        params: { id: "1" },
        path: "/item/1",
        data: null,
        pending: false,
      },
      fetchData: async () => ({ v: 1, status: 404, data: null }),
      statusRoutes: { 404: "_404" },
    })
    await plain.navigate("/item/2")
    expect(plain.snapshot().routeId).toBe("_404")
  })
})

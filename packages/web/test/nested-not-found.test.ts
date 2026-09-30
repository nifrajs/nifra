import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildClient } from "../src/build.ts"
import {
  buildManifest,
  createWebApp,
  generateServerManifest,
  gone,
  type LoaderContext,
  notFound,
  type RenderAdapter,
  type RouteModule,
  redirect,
} from "../src/index.ts"
import { DATA_HEADER, STATUS_HEADER } from "../src/router.ts"

// A `_404` below the routes root answers for its own part of the app: the unmatched URLs under its
// directory and `notFound()` from the routes beneath it, inside the layouts around it.

const streamOf = (s: string): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(s)
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
}

// Emits what was rendered as JSON, so a test reads the chain and the props back.
const stub: RenderAdapter = {
  renderToStream: (chain, props) =>
    streamOf(
      `<main>${JSON.stringify({
        chain,
        data: props.data,
        layoutData: props.layoutData ?? null,
        params: props.params ?? null,
      })}</main>`,
    ),
  hydrationHead: () => "",
}

interface Rendered {
  readonly chain: readonly string[]
  readonly data: unknown
  readonly layoutData: readonly unknown[] | null
  readonly params: Record<string, string> | null
}

const renderedOf = (html: string): Rendered => {
  const match = /<main>(.*?)<\/main>/s.exec(html)
  if (match === null) throw new Error(`no render in: ${html}`)
  return JSON.parse(match[1] as string) as Rendered
}

// `gate` is a layout module's export; the importer returns route and layout modules alike.
type Modules = Record<string, Partial<RouteModule> & { readonly gate?: boolean }>

const appOf = (modules: Modules, options: Partial<Parameters<typeof createWebApp>[0]> = {}) => {
  const manifest = buildManifest(
    Object.keys(modules),
    (file) => () => Promise.resolve({ default: file, ...modules[file] } as RouteModule),
  )
  return {
    manifest,
    app: createWebApp({ adapter: stub, manifest, clientEntry: "/c.js", ...options }),
  }
}

const get = (
  app: { fetch(r: Request): Response | Promise<Response> },
  path: string,
  headers: Record<string, string> = {},
) => app.fetch(new Request(`http://x${path}`, { headers }))

const searchParam = (ctx: LoaderContext, name: string): string | null =>
  new URL(ctx.request.url).searchParams.get(name)

// An admin area behind a gate, with its own `_404`, and a deeper one for `/admin/reports`.
const admin = (): Modules => ({
  "_layout.tsx": { loader: () => ({ site: "root" }) },
  "_404.tsx": {},
  "index.tsx": {},
  "login.tsx": {},
  "[lang]/docs/[slug].tsx": {},
  "admin/_layout.tsx": {
    gate: true,
    loader: (ctx) => {
      if (searchParam(ctx, "auth") === "no") throw redirect("/login")
      if (searchParam(ctx, "auth") === "hidden") notFound()
      return { user: "ada" }
    },
  },
  "admin/_404.tsx": {},
  "admin/index.tsx": {},
  "admin/users/[id].tsx": {
    loader: (ctx) => {
      if (ctx.params.id === "thrown") notFound()
      if (ctx.params.id === "headers") notFound({ headers: { "x-reason": "no-user" } })
      if (ctx.params.id === "gone") gone()
      if (ctx.params.id === "returned") {
        try {
          notFound()
        } catch (signal) {
          return signal
        }
      }
      return { id: ctx.params.id }
    },
  },
  "admin/reports/_404.tsx": {},
  "admin/reports/[id].tsx": {},
})

describe("buildManifest", () => {
  test("a nested _404 is listed beside the root one, which it no longer replaces", () => {
    const { manifest } = appOf(admin())
    expect(manifest.notFound?.file).toBe("_404.tsx")
    expect(Object.keys(manifest.notFounds ?? {}).sort()).toEqual([
      "admin/_404",
      "admin/reports/_404",
    ])
    expect(manifest.notFounds?.["admin/_404"]).toMatchObject({
      file: "admin/_404.tsx",
      layoutIds: ["_layout", "admin/_layout"],
      scopes: [
        { pattern: "/admin", layoutParams: [[], []] },
        { pattern: "/admin/*", layoutParams: [[], []] },
      ],
    })
  })

  test("a route lists the nested pages above it, nearest last; the root one is not listed", () => {
    const { manifest } = appOf(admin())
    const idsOf = (pattern: string) =>
      manifest.routes.find((route) => route.pattern === pattern)?.notFoundIds
    expect(idsOf("/")).toBeUndefined()
    expect(idsOf("/admin/users/:id")).toEqual(["admin/_404"])
    expect(idsOf("/admin/reports/:id")).toEqual(["admin/_404", "admin/reports/_404"])
  })

  test("an app with only a root _404 has no nested map", () => {
    const { manifest } = appOf({ "index.tsx": {}, "_404.tsx": {} })
    expect(manifest.notFounds).toBeUndefined()
    expect(manifest.notFound?.file).toBe("_404.tsx")
  })

  test("an optional directory answers with the segment present and absent", () => {
    const { manifest } = appOf({ "[[lang]]/shop/_layout.tsx": {}, "[[lang]]/shop/_404.tsx": {} })
    expect(manifest.notFounds?.["[[lang]]/shop/_404"]?.scopes).toEqual([
      { pattern: "/shop", layoutParams: [[]] },
      { pattern: "/shop/*", layoutParams: [[]] },
      { pattern: "/:lang/shop", layoutParams: [["lang"]] },
      { pattern: "/:lang/shop/*", layoutParams: [["lang"]] },
    ])
  })

  test("a _404 in a catch-all directory answers no unmatched URL", () => {
    const { manifest } = appOf({ "docs/[...rest]/index.tsx": {}, "docs/[...rest]/_404.tsx": {} })
    expect(manifest.notFounds?.["docs/[...rest]/_404"]?.scopes).toEqual([])
    expect(manifest.routes[0]?.notFoundIds).toEqual(["docs/[...rest]/_404"])
  })

  test("two route groups with a _404 at one URL prefix are refused", () => {
    expect(() => appOf({ "(a)/_404.tsx": {}, "(b)/_404.tsx": {} })).toThrow(
      '[nifra/web] ambiguous _404: "(a)/_404.tsx" and "(b)/_404.tsx" both answer unmatched URLs under "/"',
    )
    expect(() => appOf({ "shop/(a)/_404.tsx": {}, "shop/(b)/_404.tsx": {} })).toThrow(
      'both answer unmatched URLs under "/shop"',
    )
    expect(() => appOf({ "[a]/_404.tsx": {}, "[b]/_404.tsx": {} })).toThrow("ambiguous _404")
  })

  test("a _404 in the directory that contains both settles it", () => {
    const { manifest } = appOf({ "_404.tsx": {}, "(a)/_404.tsx": {}, "(b)/_404.tsx": {} })
    expect(manifest.notFounds?.["(a)/_404"]?.scopes).toEqual([])
    expect(manifest.notFounds?.["(b)/_404"]?.scopes).toEqual([])
    const nested = appOf({ "shop/_404.tsx": {}, "shop/(a)/_404.tsx": {}, "shop/(b)/_404.tsx": {} })
    expect(nested.manifest.notFounds?.["shop/_404"]?.scopes.map((scope) => scope.pattern)).toEqual([
      "/shop",
      "/shop/*",
    ])
  })
})

describe("an unmatched URL", () => {
  test("under the directory renders its _404 inside the layouts, with their data", async () => {
    const { app } = appOf(admin())
    const res = await get(app, "/admin/nope")
    expect(res.status).toBe(404)
    const html = await res.text()
    expect(renderedOf(html)).toEqual({
      chain: ["_layout.tsx", "admin/_layout.tsx", "admin/_404.tsx"],
      data: null,
      layoutData: [{ site: "root" }, { user: "ada" }],
      params: {},
    })
    // Rendered on the server only: no client entry, no data for one.
    expect(html).not.toContain("/c.js")
    expect(res.headers.get("cache-control")).toBe("private, no-store")
  })

  test("the deepest directory wins, bare prefix included", async () => {
    const { app } = appOf(admin())
    for (const path of ["/admin/reports", "/admin/reports/", "/admin/reports/2024/q1"]) {
      const res = await get(app, path)
      expect(res.status).toBe(404)
      expect(renderedOf(await res.text()).chain.at(-1)).toBe("admin/reports/_404.tsx")
    }
  })

  test("outside every nested directory renders the root _404, bare", async () => {
    const { app } = appOf(admin())
    const res = await get(app, "/nope")
    expect(res.status).toBe(404)
    expect(renderedOf(await res.text()).chain).toEqual(["_404.tsx"])
  })

  test("a route still wins, including one the router reaches by another branch", async () => {
    const { app } = appOf(admin())
    const docs = await get(app, "/admin/docs/intro")
    expect(docs.status).toBe(200)
    expect(renderedOf(await docs.text())).toMatchObject({
      chain: ["_layout.tsx", "[lang]/docs/[slug].tsx"],
      params: { lang: "admin", slug: "intro" },
    })
    const report = await get(app, "/admin/reports/7")
    expect(report.status).toBe(200)
    expect(renderedOf(await report.text()).chain.at(-1)).toBe("admin/reports/[id].tsx")
  })

  test("a catch-all route beside the _404 takes every URL beneath it", async () => {
    const { app } = appOf({ "shop/_404.tsx": {}, "shop/[...rest].tsx": {} })
    const res = await get(app, "/shop/a/b")
    expect(res.status).toBe(200)
    expect(renderedOf(await res.text()).chain).toEqual(["shop/[...rest].tsx"])
    const bare = await get(app, "/shop")
    expect(bare.status).toBe(404)
    expect(renderedOf(await bare.text()).chain).toEqual(["shop/_404.tsx"])
  })

  test("the gate runs first: its redirect is the answer", async () => {
    const { app } = appOf(admin())
    const res = await get(app, "/admin/nope?auth=no")
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe("/login")
    expect(await res.text()).not.toContain("admin/_404.tsx")
  })

  test("a data request gets a bare 404 once the gate has passed", async () => {
    const { app } = appOf(admin())
    const res = await get(app, "/admin/nope", { [DATA_HEADER]: "1" })
    expect(res.status).toBe(404)
    expect(res.headers.get(STATUS_HEADER)).toBeNull()
    expect(res.headers.get("cache-control")).toBe("private, no-store")
    expect(await res.text()).toBe("")
    const denied = await get(app, "/admin/nope?auth=no", { [DATA_HEADER]: "1" })
    expect(denied.headers.get("location") ?? denied.headers.get("x-nifra-redirect")).toBe("/login")
  })

  test("a nonce reaches the page and keeps it private", async () => {
    const { app } = appOf(
      { "shop/_404.tsx": { meta: { title: "Not in the shop" } } },
      { nonce: () => "n0nce" },
    )
    const res = await get(app, "/shop/nope")
    expect(res.status).toBe(404)
    expect(res.headers.get("cache-control")).toBe("private, no-store")
    expect(await res.text()).toContain("<title>Not in the shop</title>")
  })

  test("a gate that answers notFound() shows the root page, not the area's own", async () => {
    const { app } = appOf(admin())
    const res = await get(app, "/admin/nope?auth=hidden")
    expect(res.status).toBe(404)
    expect(renderedOf(await res.text()).chain).toEqual(["_404.tsx"])
  })

  test("the layouts read the params of the matched prefix", async () => {
    const { app } = appOf({
      "[org]/_layout.tsx": { loader: (ctx) => ({ org: ctx.params.org }) },
      "[org]/_404.tsx": {},
      "[org]/index.tsx": {},
    })
    const res = await get(app, "/acme/nope/deeper")
    expect(res.status).toBe(404)
    expect(renderedOf(await res.text())).toMatchObject({
      chain: ["[org]/_layout.tsx", "[org]/_404.tsx"],
      layoutData: [{ org: "acme" }],
      params: { org: "acme" },
    })
  })

  test("directories that name one segment differently do not collide", async () => {
    const { app } = appOf({ "[a]/_404.tsx": {}, "[b]/x/_404.tsx": {} })
    const shallow = await get(app, "/q/zz")
    expect(renderedOf(await shallow.text())).toMatchObject({
      chain: ["[a]/_404.tsx"],
      params: { a: "q" },
    })
    const deep = await get(app, "/q/x/zz")
    expect(renderedOf(await deep.text())).toMatchObject({
      chain: ["[b]/x/_404.tsx"],
      params: { b: "q" },
    })
  })

  test("a route group's _404 answers for the whole app when it is the only one", async () => {
    const { app } = appOf({
      "(site)/_layout.tsx": {},
      "(site)/_404.tsx": {},
      "(site)/index.tsx": {},
    })
    const res = await get(app, "/nope")
    expect(res.status).toBe(404)
    expect(renderedOf(await res.text()).chain).toEqual(["(site)/_layout.tsx", "(site)/_404.tsx"])
    // No layout loaded anything for the visitor, so nothing makes the page private.
    expect(res.headers.get("cache-control")).toBeNull()
  })

  test("a layout loader that fails renders the _error boundary", async () => {
    const errors: unknown[] = []
    const { app } = appOf(
      {
        "_error.tsx": {},
        "shop/_layout.tsx": {
          loader: () => {
            throw new Error("db down")
          },
        },
        "shop/_404.tsx": {},
      },
      { onLoaderError: (error) => errors.push(error) },
    )
    const res = await get(app, "/shop/nope")
    expect(res.status).toBe(500)
    expect(renderedOf(await res.text())).toMatchObject({
      chain: ["_error.tsx"],
      data: { name: "Error", message: "db down" },
    })
    expect(errors).toHaveLength(1)
    const data = await get(app, "/shop/nope", { [DATA_HEADER]: "1" })
    expect(data.status).toBe(500)
    expect(await data.text()).toBe("Internal Server Error")
  })

  test("a cookie queued by a layout travels with the page and keeps it private", async () => {
    const { app } = appOf({
      "shop/_layout.tsx": {
        loader: (ctx) => {
          ctx.set.cookie("seen", "1")
          return null
        },
      },
      "shop/_404.tsx": {},
    })
    const res = await get(app, "/shop/nope")
    expect(res.status).toBe(404)
    expect(res.headers.get("set-cookie")).toContain("seen=1")
    expect(res.headers.get("cache-control")).toBe("private, no-store")
  })

  test("the page's stylesheet is linked", async () => {
    const { app } = appOf(admin(), {
      styles: ["/all.css"],
      routeStyles: { "admin/_404": ["/admin-404.css"] },
    })
    const html = await (await get(app, "/admin/nope")).text()
    expect(html).toContain("/admin-404.css")
    expect(html).not.toContain("/all.css")
  })
})

describe("notFound() from a route's loader", () => {
  test("renders the nearest _404 inside the layouts above it", async () => {
    const { app } = appOf(admin())
    for (const id of ["thrown", "returned"]) {
      const res = await get(app, `/admin/users/${id}`)
      expect(res.status).toBe(404)
      expect(renderedOf(await res.text())).toEqual({
        chain: ["_layout.tsx", "admin/_layout.tsx", "admin/_404.tsx"],
        data: null,
        layoutData: [{ site: "root" }, { user: "ada" }],
        params: { id },
      })
      expect(res.headers.get("cache-control")).toBe("private, no-store")
    }
  })

  test("keeps only the layouts at or above the _404", async () => {
    const { app } = appOf({
      "_layout.tsx": { loader: () => "root" },
      "shop/_404.tsx": {},
      "shop/items/_layout.tsx": { loader: () => "items" },
      "shop/items/[id].tsx": { loader: () => notFound() },
    })
    const res = await get(app, "/shop/items/9")
    expect(res.status).toBe(404)
    expect(renderedOf(await res.text())).toMatchObject({
      chain: ["_layout.tsx", "shop/_404.tsx"],
      layoutData: ["root"],
    })
  })

  test("carries the headers the signal named", async () => {
    const { app } = appOf(admin())
    const res = await get(app, "/admin/users/headers")
    expect(res.status).toBe(404)
    expect(res.headers.get("x-reason")).toBe("no-user")
    expect(res.headers.get("vary")).toContain(DATA_HEADER)
  })

  test("a navigation's data request gets a bare 404, so it loads the URL as a document", async () => {
    const { app } = appOf(admin())
    const res = await get(app, "/admin/users/thrown", { [DATA_HEADER]: "1" })
    expect(res.status).toBe(404)
    expect(res.headers.get(STATUS_HEADER)).toBeNull()
    expect(res.headers.get("cache-control")).toBe("private, no-store")
    expect(res.headers.get("vary")).toContain(DATA_HEADER)
    expect(await res.text()).toBe("")
  })

  test("a route under the root _404 only keeps the status header on its data request", async () => {
    const { app } = appOf({ "_404.tsx": {}, "jobs/[id].tsx": { loader: () => notFound() } })
    const res = await get(app, "/jobs/7", { [DATA_HEADER]: "1" })
    expect(res.status).toBe(404)
    expect(res.headers.get(STATUS_HEADER)).toBe("404")
  })

  test("another status stays with the root pages", async () => {
    const { app } = appOf(admin())
    const res = await get(app, "/admin/users/gone")
    expect(res.status).toBe(410)
    expect(renderedOf(await res.text()).chain).toEqual(["_404.tsx"])
  })

  test("a layout loader that answers notFound() shows the root page", async () => {
    const { app } = appOf({
      "_404.tsx": {},
      "shop/_layout.tsx": { loader: () => notFound() },
      "shop/_404.tsx": {},
      "shop/index.tsx": {},
    })
    const res = await get(app, "/shop")
    expect(res.status).toBe(404)
    expect(renderedOf(await res.text()).chain).toEqual(["_404.tsx"])
  })

  test("a layout that fails while the route answers notFound() shows the root page", async () => {
    const { app } = appOf({
      "_404.tsx": {},
      "shop/_layout.tsx": {
        loader: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5))
          throw new Error("late failure")
        },
      },
      "shop/_404.tsx": {},
      "shop/[id].tsx": { loader: () => notFound() },
    })
    const res = await get(app, "/shop/1")
    expect(res.status).toBe(404)
    expect(renderedOf(await res.text()).chain).toEqual(["_404.tsx"])
  })
})

describe("generateServerManifest", () => {
  test("imports the nested _404 files, so the built manifest carries them", () => {
    const { manifest } = appOf(admin())
    const source = generateServerManifest(manifest, {
      clientEntry: "/c.js",
      resolve: (file) => `./routes/${file}`,
    })
    expect(source).toContain('"admin/_404.tsx"')
    expect(source).toContain('"admin/reports/_404.tsx"')
  })
})

describe("the client build", () => {
  // Inside the workspace, so the generated bootstrap resolves `@nifrajs/web` through node_modules.
  const root = mkdtempSync(`${import.meta.dir}/.tmp-nested-404-`)
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test("a nested _404 links the stylesheets of the layouts around it, then its own", async () => {
    const files: Record<string, string> = {
      "routes/_layout.tsx":
        'import "../app.css"\nexport default function Layout() { return null }\n',
      "routes/index.tsx": "export default function Index() { return null }\n",
      "routes/admin/_layout.tsx": "export default function Admin() { return null }\n",
      "routes/admin/index.tsx": "export default function AdminIndex() { return null }\n",
      "routes/admin/_404.tsx":
        'import "../../missing.css"\nexport default function Missing() { return null }\n',
      "app.css": "body { color: rebeccapurple }\n",
      "missing.css": ".missing { color: tomato }\n",
      "client-stub.ts": "export function mountRouter() {}\n",
    }
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(root, rel, ".."), { recursive: true })
      writeFileSync(join(root, rel), content)
    }
    const manifest = await buildClient({
      routesDir: join(root, "routes"),
      outDir: join(root, "dist", "assets"),
      clientModule: join(root, "client-stub.ts"),
      publicDir: false,
      minify: false,
    })

    const styles = manifest.routeStyles?.["admin/_404"] ?? []
    expect(styles).toHaveLength(2)
    expect(styles[0]).toBe(manifest.routeStyles?.index?.[0] as string)
    for (const url of styles) expect(manifest.css).toContain(url)
    // It is not a page the client navigates to, so it has no chunk list.
    expect(Object.keys(manifest.routes).sort()).toEqual(["admin/index", "index"])
  }, 60_000)
})

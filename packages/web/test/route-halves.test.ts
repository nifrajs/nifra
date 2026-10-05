import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import {
  BACKEND_ROUTE_EXPORTS,
  backendFileFor,
  buildManifest,
  FRONTEND_ROUTE_EXPORTS,
  mergeRouteHalves,
  type RouteModule,
} from "../src/manifest.ts"

// A route is two files: `x.tsx`, which the browser bundle imports whole, and `x.backend.ts`, which only
// the server loads. These are the rules for what may live where, checked wherever the two meet.

const load = () => () => Promise.resolve({ default: null } as RouteModule)
const asModule = (value: Record<string, unknown>): RouteModule => value as unknown as RouteModule

describe("pairing", () => {
  test("a frontend file and its backend half are one route; the backend half is no route of its own", () => {
    const manifest = buildManifest(["index.tsx", "index.backend.ts", "about.tsx"], load)
    expect(manifest.routes.map((route) => [route.pattern, route.file, route.backend])).toEqual([
      ["/", "index.tsx", "index.backend.ts"],
      ["/about", "about.tsx", undefined],
    ])
  })

  test("every special file pairs too", () => {
    const manifest = buildManifest(
      [
        "_layout.tsx",
        "_layout.backend.ts",
        "_404.tsx",
        "_404.backend.ts",
        "_error.tsx",
        "_error.backend.ts",
        "_410.tsx",
        "_410.backend.ts",
        "admin/_404.tsx",
        "admin/_404.backend.mjs",
        "admin/index.vue",
        "admin/index.backend.js",
      ],
      load,
    )
    expect(manifest.layouts._layout?.backend).toBe("_layout.backend.ts")
    expect(manifest.notFound?.backend).toBe("_404.backend.ts")
    expect(manifest.errors?._error?.backend).toBe("_error.backend.ts")
    expect(manifest.statusPages?.["410"]?.backend).toBe("_410.backend.ts")
    expect(manifest.notFounds?.["admin/_404"]?.backend).toBe("admin/_404.backend.mjs")
    expect(manifest.routes[0]?.backend).toBe("admin/index.backend.js")
  })

  test("a backend half with no frontend file is refused", () => {
    expect(() => buildManifest(["index.tsx", "orphan.backend.ts"], load)).toThrow(
      '"orphan.backend.ts" has no frontend half',
    )
  })

  test("a _loading page has no backend half", () => {
    expect(() => buildManifest(["_loading.tsx", "_loading.backend.ts"], load)).toThrow(
      "renders in the browser only",
    )
  })

  test("two frontend files for one route are refused", () => {
    expect(() => buildManifest(["index.tsx", "index.vue"], load)).toThrow(
      "two frontend files for one route",
    )
  })

  test("a zone suffix on a route file is refused rather than becoming a URL segment", () => {
    for (const file of ["page.backend.tsx", "page.server.tsx", "page.shared.tsx"]) {
      expect(() => buildManifest([file], load)).toThrow("is a route file with a zone suffix")
    }
  })

  test("the backend file a frontend file pairs with", () => {
    expect(backendFileFor("blog/[slug].tsx")).toBe("blog/[slug].backend.ts")
    expect(backendFileFor("index.svelte")).toBe("index.backend.ts")
  })
})

describe("export placement", () => {
  test("the two export lists never overlap", () => {
    for (const name of FRONTEND_ROUTE_EXPORTS) expect(BACKEND_ROUTE_EXPORTS.has(name)).toBe(false)
  })

  test.each([
    ...BACKEND_ROUTE_EXPORTS,
  ])("%s in a frontend file is refused, even when the route has no backend half", (name) => {
    expect(() =>
      mergeRouteHalves(
        "page.tsx",
        asModule({ default: null, [name]: () => 1 }),
        undefined,
        undefined,
      ),
    ).toThrow(
      `"page.tsx" exports "${name}", which runs on the server only. Move it to "page.backend.ts"`,
    )
  })

  test.each([...FRONTEND_ROUTE_EXPORTS])("%s in a backend half is refused", (name) => {
    expect(() =>
      mergeRouteHalves("page.tsx", asModule({ default: null }), "page.backend.ts", { [name]: 1 }),
    ).toThrow(`"page.backend.ts" exports "${name}", which the browser needs. Move it to "page.tsx"`)
  })

  test("a backend half exports nothing nifra does not read", () => {
    expect(() =>
      mergeRouteHalves("page.tsx", asModule({ default: null }), "page.backend.ts", { loadr: 1 }),
    ).toThrow("which nifra does not read from a backend half")
  })

  test("a frontend file may export anything else: it is browser code either way", () => {
    const front = asModule({ default: null, Helper: () => null, CONSTANT: 1 })
    expect(mergeRouteHalves("page.tsx", front, undefined, undefined)).toBe(front)
  })

  test("the merged module is the frontend's exports plus the backend's", () => {
    const loader = () => ({ n: 1 })
    const merged = mergeRouteHalves(
      "page.tsx",
      asModule({ default: "Page", meta: { title: "t" } }),
      "page.backend.ts",
      { loader, revalidate: 60 },
    )
    expect(merged).toMatchObject({ default: "Page", meta: { title: "t" }, loader, revalidate: 60 })
  })

  test("one merge per pair of module namespaces", () => {
    const front = asModule({ default: null })
    const back = { loader: () => 1 }
    expect(mergeRouteHalves("page.tsx", front, "page.backend.ts", back)).toBe(
      mergeRouteHalves("page.tsx", front, "page.backend.ts", back),
    )
  })
})

describe("boundaries", () => {
  const render = () => null

  test("a boundary's loader comes from boundaryLoaders in the backend half, behind its output", async () => {
    const load = () => ({ stock: 3, supplierCost: 1 })
    const merged = mergeRouteHalves(
      "page.tsx",
      asModule({
        default: null,
        boundaries: [{ name: "stock", mode: "dynamic", render }],
      }),
      "page.backend.ts",
      { boundaryLoaders: { stock: { load, output: t.object({ stock: t.number() }) } } },
    )
    const guarded = merged.boundaries?.[0]?.load as (ctx: unknown) => unknown
    expect(await guarded({})).toEqual({ stock: 3 })
    expect(merged).not.toHaveProperty("boundaryLoaders")
  })

  test("a load function in the frontend file is refused", () => {
    expect(() =>
      mergeRouteHalves(
        "page.tsx",
        asModule({
          default: null,
          boundaries: [{ name: "stock", mode: "dynamic", render, load: () => 1 }],
        }),
        undefined,
        undefined,
      ),
    ).toThrow('boundary "stock" in "page.tsx" declares its load function in the frontend file')
  })

  test("a loader for a boundary the frontend does not declare is refused", () => {
    expect(() =>
      mergeRouteHalves("page.tsx", asModule({ default: null }), "page.backend.ts", {
        boundaryLoaders: { ghost: { load: () => 1 } },
      }),
    ).toThrow('declares no boundary named "ghost"')
  })

  test("a boundary loader must be a function", () => {
    expect(() =>
      mergeRouteHalves(
        "page.tsx",
        asModule({
          default: null,
          boundaries: [{ name: "stock", mode: "dynamic", render }],
        }),
        "page.backend.ts",
        { boundaryLoaders: { stock: { load: "nope" } } },
      ),
    ).toThrow('boundaryLoaders["stock"].load in "page.backend.ts" must be a function')
  })
})

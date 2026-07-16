import { expect, test } from "bun:test"
import {
  buildManifest,
  enumerateStaticRoutes,
  filePathToPattern,
  filePathToPatterns,
  fillRoutePattern,
  type RouteEntry,
  type RouteModule,
} from "../src/manifest.ts"

test("filePathToPattern: index, static, nested, dynamic param", () => {
  expect(filePathToPattern("index.tsx")).toBe("/")
  expect(filePathToPattern("about.tsx")).toBe("/about")
  expect(filePathToPattern("users/index.tsx")).toBe("/users")
  expect(filePathToPattern("users/[id].tsx")).toBe("/users/:id")
  expect(filePathToPattern("a/b/[slug].tsx")).toBe("/a/b/:slug")
})

test("filePathToPattern: .mdx routes get the extension stripped like .tsx", () => {
  expect(filePathToPattern("docs/content.mdx")).toBe("/docs/content")
  expect(filePathToPattern("blog/[slug].mdx")).toBe("/blog/:slug")
  expect(filePathToPattern("index.mdx")).toBe("/")
})

test("filePathToPattern: catch-all [...slug] → *slug", () => {
  expect(filePathToPattern("blog/[...slug].tsx")).toBe("/blog/*slug")
  expect(filePathToPattern("[...all].tsx")).toBe("/*all")
  // A trailing `index` after the catch-all collapses (still the last meaningful segment).
  expect(filePathToPattern("docs/[...path]/index.tsx")).toBe("/docs/*path")
})

test("filePathToPattern: (group) folders drop from the URL", () => {
  expect(filePathToPattern("(marketing)/about.tsx")).toBe("/about")
  expect(filePathToPattern("(marketing)/index.tsx")).toBe("/")
  expect(filePathToPattern("(app)/dashboard/[id].tsx")).toBe("/dashboard/:id")
  expect(filePathToPattern("(a)/(b)/deep.tsx")).toBe("/deep")
})

test("filePathToPattern rejects invalid/unsupported params", () => {
  expect(() => filePathToPattern("users/[1bad].tsx")).toThrow(/invalid route param/)
  expect(() => filePathToPattern("users/[id.tsx")).toThrow(/invalid route param/) // malformed
  // A catch-all that isn't the last segment is rejected (the core requires the wildcard last).
  expect(() => filePathToPattern("blog/[...all]/edit.tsx")).toThrow(/must be the last segment/)
})

test("filePathToPatterns: optional [[x]] expands to with-and-without patterns", () => {
  // A single optional segment → two patterns; the canonical filePathToPattern is the all-present form.
  expect(filePathToPatterns("[[lang]]/about.tsx")).toEqual(["/about", "/:lang/about"])
  expect(filePathToPattern("[[lang]]/about.tsx")).toBe("/:lang/about")
  // Optional at the leaf, with index → "/" and "/:lang".
  expect(filePathToPatterns("[[lang]]/index.tsx")).toEqual(["/", "/:lang"])
  // Two optionals → 2² combinations (order: each optional appends the present-variant after the absent).
  expect(filePathToPatterns("[[a]]/[[b]]/x.tsx")).toEqual(["/x", "/:b/x", "/:a/x", "/:a/:b/x"])
  // Optional composes with a required param and a catch-all (catch-all still must be last).
  expect(filePathToPatterns("[[lang]]/[id].tsx")).toEqual(["/:id", "/:lang/:id"])
  expect(filePathToPatterns("[[lang]]/[...rest].tsx")).toEqual(["/*rest", "/:lang/*rest"])
  // A file with no optionals yields exactly one pattern.
  expect(filePathToPatterns("users/[id].tsx")).toEqual(["/users/:id"])
})

test("buildManifest: an optional segment registers every pattern against the same module", () => {
  const m = buildManifest(["[[lang]]/about.tsx", "index.tsx"], (file) => async () => ({
    default: file,
  }))
  const about = m.routes.filter((r) => r.id === "[[lang]]/about")
  expect(about.map((r) => r.pattern).sort()).toEqual(["/:lang/about", "/about"])
  // Both expanded entries share id + layout chain (same module, different URL shape).
  expect(new Set(about.map((r) => r.id)).size).toBe(1)
  expect(about.every((r) => r.file === "[[lang]]/about.tsx")).toBe(true)
})

test("supports .svelte routes (loader/action/meta come from <script module>)", () => {
  // The extension is stripped for the route id + pattern, and `_layout.svelte` is detected like .tsx.
  expect(filePathToPattern("index.svelte")).toBe("/")
  expect(filePathToPattern("users/[id].svelte")).toBe("/users/:id")
  const m = buildManifest(
    ["_layout.svelte", "index.svelte", "todos.svelte"],
    (file) => async () => ({ default: file }),
  )
  expect(m.routes.map((r) => r.pattern).sort()).toEqual(["/", "/todos"])
  expect(m.routes.find((r) => r.pattern === "/todos")?.id).toBe("todos") // ".svelte" stripped
  expect(Object.keys(m.layouts)).toEqual(["_layout"]) // _layout.svelte detected
})

// A fake importer — the manifest logic is pure; the module never actually loads here.
const fakeImporter = (file: string) => async (): Promise<RouteModule> => ({ default: file })

const route = (files: string[], pattern: string) => {
  const m = buildManifest(files, fakeImporter)
  const found = m.routes.find((r) => r.pattern === pattern)
  if (found === undefined) throw new Error(`no route for ${pattern}`)
  return found
}

test("buildManifest derives routes, nested layout chains, and notFound", () => {
  const files = [
    "_layout.tsx",
    "index.tsx",
    "about.tsx",
    "users/_layout.tsx",
    "users/index.tsx",
    "users/[id].tsx",
    "_404.tsx",
    "_private.tsx", // underscore, not layout/404 → ignored
  ]
  const m = buildManifest(files, fakeImporter)
  expect(m.routes.map((r) => r.pattern).sort()).toEqual(["/", "/about", "/users", "/users/:id"])
  expect(route(files, "/").layoutIds).toEqual(["_layout"])
  expect(route(files, "/about").layoutIds).toEqual(["_layout"])
  expect(route(files, "/users").layoutIds).toEqual(["_layout", "users/_layout"])
  expect(route(files, "/users/:id").layoutIds).toEqual(["_layout", "users/_layout"])
  expect(route(files, "/users/:id").id).toBe("users/[id]")
  expect(Object.keys(m.layouts).sort()).toEqual(["_layout", "users/_layout"])
  expect(m.notFound).toBeDefined()
})

test("buildManifest: route groups drop from the URL but keep their layout chain", () => {
  const files = [
    "_layout.tsx",
    "(marketing)/_layout.tsx",
    "(marketing)/index.tsx", // → "/"
    "(marketing)/about.tsx", // → "/about"
    "(app)/dashboard.tsx", // → "/dashboard" (no group layout)
    "blog/[...slug].tsx", // → "/blog/*slug"
  ]
  const m = buildManifest(files, fakeImporter)
  expect(m.routes.map((r) => r.pattern).sort()).toEqual([
    "/",
    "/about",
    "/blog/*slug",
    "/dashboard",
  ])
  // The (marketing) group contributes no URL segment, yet its _layout still wraps its routes.
  expect(route(files, "/about").layoutIds).toEqual(["_layout", "(marketing)/_layout"])
  expect(route(files, "/").layoutIds).toEqual(["_layout", "(marketing)/_layout"])
  expect(route(files, "/dashboard").layoutIds).toEqual(["_layout"]) // (app) has no _layout
})

test("buildManifest omits notFound when _404 is absent", () => {
  expect(buildManifest(["index.tsx"], fakeImporter).notFound).toBeUndefined()
})

test("buildManifest rejects duplicate routes at boot", () => {
  expect(() => buildManifest(["users.tsx", "users/index.tsx"], fakeImporter)).toThrow(
    /duplicate route/,
  )
})

test("a route's load() resolves its module", async () => {
  const m = buildManifest(["index.tsx"], fakeImporter)
  const first = m.routes[0]
  if (first === undefined) throw new Error("no routes")
  expect((await first.load()).default).toBe("index.tsx")
})

// --- SSG enumeration (fillRoutePattern + enumerateStaticRoutes) -------------------------------------
function rt(pattern: string, mod: Partial<RouteModule>): RouteEntry {
  return {
    id: pattern,
    pattern,
    layoutIds: [],
    file: `${pattern}.tsx`,
    load: async () => ({ default: () => null, ...mod }),
  }
}

test("fillRoutePattern substitutes params; reports missing ones", () => {
  expect(fillRoutePattern("/users/:id", { id: "7" })).toEqual({ path: "/users/7", missing: [] })
  expect(fillRoutePattern("/blog/:year/:slug", { year: "2026", slug: "hi" })).toEqual({
    path: "/blog/2026/hi",
    missing: [],
  })
  expect(fillRoutePattern("/blog/:slug", { slug: "../../escape hatch" })).toEqual({
    path: "/blog/..%2F..%2Fescape%20hatch",
    missing: [],
  })
  expect(fillRoutePattern("/blog/:slug", { slug: ".." })).toEqual({
    path: "/blog/%2E%2E",
    missing: [],
  })
  expect(fillRoutePattern("/users/:id", {})).toEqual({ path: "/users/:id", missing: ["id"] })
})

test("enumerateStaticRoutes: static opt-ins + dynamic getStaticPaths, skips the rest", async () => {
  const { paths } = await enumerateStaticRoutes([
    rt("/", { prerender: true }),
    rt("/about", {}), // not opted in
    rt("/users/:id", {
      getStaticPaths: async () => ({ paths: [{ params: { id: "1" } }, { params: { id: "2" } }] }),
    }),
    rt("/posts/:slug", {}), // dynamic without getStaticPaths
    rt("/files/*path", { prerender: true }), // wildcard
  ])
  expect(paths.sort()).toEqual(["/", "/users/1", "/users/2"])
})

test("enumerateStaticRoutes: a getStaticPaths entry missing a param is dropped", async () => {
  const { paths } = await enumerateStaticRoutes([
    rt("/users/:id", { getStaticPaths: async () => ({ paths: [{ params: {} }] }) }),
  ])
  expect(paths).toEqual([])
})

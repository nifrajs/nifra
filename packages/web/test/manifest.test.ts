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
import { createMatcher } from "../src/router.ts"

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

// A fake importer - the manifest logic is pure; the module never actually loads here.
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

test("a route file name cannot carry a param constraint", () => {
  for (const file of [
    "users/[id]{[0-9]+}.tsx",
    "img/[kind]{thumb|full}.tsx",
    "f/[name].[ext]{png|jpg}.tsx",
    "c/[code]{[A-Z]{2}}/edit.tsx",
  ]) {
    expect(() => filePathToPattern(file)).toThrow(
      /a param constraint cannot be written in a route file name/,
    )
    expect(() => buildManifest([file], fakeImporter)).toThrow(
      /Check the value in the route's loader/,
    )
  }
  // Braces the router reads as plain text are an ordinary part-literal segment.
  expect(filePathToPattern("x/[id]{int}.tsx")).toBe("/x/:id{int}")
  expect(filePathToPattern("x/{a|b}-[id].tsx")).toBe("/x/{a|b}-:id")
})

test("buildManifest rejects two routes of one shape at boot", () => {
  expect(() => buildManifest(["users/[id].tsx", "users/[slug].tsx"], fakeImporter)).toThrow(
    /overlapping routes.*users\/\[id\]\.tsx.*\/users\/:id.*users\/\[slug\]\.tsx.*\/users\/:slug.*same shape/,
  )
  expect(() => buildManifest(["[lang]/about.tsx", "[section]/about.tsx"], fakeImporter)).toThrow(
    /overlapping routes.*same shape/,
  )
})

test("buildManifest keeps a static route beside a dynamic one, and the static one serves its path", () => {
  for (const files of [
    ["users/[id].tsx", "users/me.tsx"],
    ["users/me.tsx", "users/[id].tsx"],
    ["[lang]/index.tsx", "[lang]/about.tsx", "about.tsx", "index.tsx", "pricing.tsx"],
    ["docs/[...path].tsx", "docs/[page].tsx", "docs/intro.tsx"],
  ]) {
    const m = buildManifest(files, fakeImporter)
    const match = createMatcher(m.routes.map((r) => ({ routeId: r.id, pattern: r.pattern })))
    for (const r of m.routes) {
      const literal = !r.pattern.includes(":") && !r.pattern.includes("*")
      if (literal) expect(match(r.pattern)?.routeId).toBe(r.id)
    }
  }
  const m = buildManifest(["users/[id].tsx", "users/me.tsx"], fakeImporter)
  const match = createMatcher(m.routes.map((r) => ({ routeId: r.id, pattern: r.pattern })))
  expect(match("/users/me")?.routeId).toBe("users/me")
  expect(match("/users/42")?.routeId).toBe("users/[id]")
})

test("buildManifest keeps disjoint dynamic route patterns", () => {
  expect(() => buildManifest(["users/[id].tsx", "teams/[id].tsx"], fakeImporter)).not.toThrow()
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

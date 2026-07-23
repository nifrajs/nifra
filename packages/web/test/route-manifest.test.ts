import { expect, test } from "bun:test"
import type { Manifest, RouteModule } from "../src/manifest.ts"
import { buildRouteManifest, deriveRouteEntry, renderRouteManifest } from "../src/route-manifest.ts"

// A hand-built manifest — `buildRouteManifest` is fs-free by design, so no fixture app is needed.
const manifestOf = (
  routes: ReadonlyArray<{ id: string; pattern: string; module: Partial<RouteModule> }>,
): Manifest =>
  ({
    routes: routes.map((r) => ({
      id: r.id,
      pattern: r.pattern,
      file: `${r.id}.tsx`,
      layoutIds: [],
      load: () => Promise.resolve(r.module as RouteModule),
    })),
    layouts: {},
  }) as unknown as Manifest

const mod = (m: Partial<RouteModule>): Partial<RouteModule> => m

// --- Render mode derivation -------------------------------------------------------------------------

test("a plain route is ssr and needs a server", () => {
  const entry = deriveRouteEntry("index", "/", mod({}))
  expect(entry.mode).toBe("ssr")
  expect(entry.requires).toEqual(["server"])
  expect(entry.hydrate).toBe(true)
})

test("`prerender: true` on a static route is static, and needs nothing from the host", () => {
  const entry = deriveRouteEntry("about", "/about", mod({ prerender: true }))
  expect(entry.mode).toBe("static")
  expect(entry.requires).toEqual([])
})

test("`revalidate` makes a route isr, requiring revalidation as well as a server", () => {
  const entry = deriveRouteEntry("feed", "/feed", mod({ revalidate: 60 }))
  expect(entry.mode).toBe("isr")
  expect(entry.revalidate).toBe(60)
  expect(entry.requires).toEqual(["server", "revalidation"])
})

test("prerender WINS over revalidate — a build-time page is not revalidated at runtime", () => {
  // Declaring both is contradictory. The build-time answer is the one that describes what actually
  // ships, so that is what the manifest reports rather than the more optimistic reading.
  const entry = deriveRouteEntry("both", "/both", mod({ prerender: true, revalidate: 60 }))
  expect(entry.mode).toBe("static")
  expect(entry.revalidate).toBeUndefined()
})

test("a dynamic route with getStaticPaths but NO emitted paths is not static", () => {
  // The distinction that stops a "static" build shipping a page that 404s: `getStaticPaths` is the
  // intent, the emitted paths are the evidence. Intent alone prerenders nothing.
  const declared = deriveRouteEntry(
    "post",
    "/blog/:slug",
    mod({ getStaticPaths: () => ({ paths: [] }) }),
  )
  expect(declared.mode).toBe("ssr")

  const built = deriveRouteEntry(
    "post",
    "/blog/:slug",
    mod({ getStaticPaths: () => ({ paths: [] }) }),
    ["/blog/a", "/blog/b"],
  )
  expect(built.mode).toBe("static")
  expect(built.prerenderedPaths).toEqual(["/blog/a", "/blog/b"])
})

test("a STATIC pattern needs no enumerated paths to count as prerendered", () => {
  // There is only one path, and the build emits it — nothing to enumerate.
  expect(deriveRouteEntry("about", "/about", mod({ prerender: true })).mode).toBe("static")
})

test("`hydrate: false` is reported (the route ships no framework JS)", () => {
  expect(deriveRouteEntry("docs", "/docs", mod({ hydrate: false })).hydrate).toBe(false)
})

// --- Target resolution ------------------------------------------------------------------------------

test("a static target flags every route that needs a server, with the consequence", async () => {
  const manifest = await buildRouteManifest(
    manifestOf([
      { id: "index", pattern: "/", module: mod({ prerender: true }) },
      { id: "feed", pattern: "/feed", module: mod({}) },
    ]),
    { target: "static" },
  )
  expect(manifest.conflicts).toHaveLength(1)
  expect(manifest.conflicts[0]?.pattern).toBe("/feed")
  expect(manifest.conflicts[0]?.capability).toBe("server")
  // The message names what HAPPENS, not which rule fired — "404s in production while working in dev" is
  // the sentence that makes someone act.
  expect(manifest.conflicts[0]?.consequence).toContain("404s in production")
})

test("an isr route on a static target reports BOTH unmet capabilities", async () => {
  const manifest = await buildRouteManifest(
    manifestOf([{ id: "feed", pattern: "/feed", module: mod({ revalidate: 30 }) }]),
    { target: "static" },
  )
  expect(manifest.conflicts.map((c) => c.capability).sort()).toEqual(["revalidation", "server"])
})

test("a server target has no conflicts for the same app", async () => {
  const manifest = await buildRouteManifest(
    manifestOf([
      { id: "index", pattern: "/", module: mod({ prerender: true }) },
      { id: "feed", pattern: "/feed", module: mod({ revalidate: 30 }) },
    ]),
    { target: "bun" },
  )
  expect(manifest.conflicts).toEqual([])
  expect(manifest.totals).toEqual({ static: 1, isr: 1, ssr: 0 })
})

test("with no target, behaviour is still derived but nothing is gated", async () => {
  const manifest = await buildRouteManifest(
    manifestOf([{ id: "feed", pattern: "/feed", module: mod({}) }]),
  )
  expect(manifest.target).toBeUndefined()
  expect(manifest.conflicts).toEqual([])
  expect(manifest.routes[0]?.mode).toBe("ssr")
})

test("an unknown target does not invent conflicts", async () => {
  // Reporting a route as broken because the target string was not recognised would be worse than
  // reporting nothing: it is a false alarm about production.
  const manifest = await buildRouteManifest(
    manifestOf([{ id: "feed", pattern: "/feed", module: mod({}) }]),
    { target: "some-future-platform" },
  )
  expect(manifest.conflicts).toEqual([])
})

test("routes are sorted by pattern, so the artifact is diffable", async () => {
  const manifest = await buildRouteManifest(
    manifestOf([
      { id: "z", pattern: "/zebra", module: mod({}) },
      { id: "a", pattern: "/apple", module: mod({}) },
    ]),
  )
  expect(manifest.routes.map((r) => r.pattern)).toEqual(["/apple", "/zebra"])
})

test("prerendered paths passed from a build feed the dynamic route's mode", async () => {
  const manifest = await buildRouteManifest(
    manifestOf([
      {
        id: "post",
        pattern: "/blog/:slug",
        module: mod({ getStaticPaths: () => ({ paths: [] }) }),
      },
    ]),
    { target: "static", prerendered: { post: ["/blog/a"] } },
  )
  expect(manifest.routes[0]?.mode).toBe("static")
  expect(manifest.conflicts).toEqual([])
})

// --- Report ------------------------------------------------------------------------------------------

test("the report shows mode, hydration and cache policy per route", async () => {
  const manifest = await buildRouteManifest(
    manifestOf([
      { id: "index", pattern: "/", module: mod({ prerender: true, hydrate: false }) },
      { id: "feed", pattern: "/feed", module: mod({ revalidate: 60 }) },
      { id: "user", pattern: "/users/:id", module: mod({}) },
    ]),
    { target: "bun" },
  )
  const report = renderRouteManifest(manifest)
  expect(report).toContain("target: bun")
  expect(report).toContain("prerendered")
  expect(report).toContain("revalidate 60s")
  expect(report).toContain("per request")
  expect(report).toContain("1 static · 1 isr · 1 ssr")
})

test("the report surfaces conflicts rather than burying them in the table", async () => {
  const manifest = await buildRouteManifest(
    manifestOf([{ id: "feed", pattern: "/feed", module: mod({}) }]),
    { target: "static" },
  )
  expect(renderRouteManifest(manifest)).toContain("the target cannot honour")
})

test("an empty app renders without throwing", async () => {
  expect(renderRouteManifest(await buildRouteManifest(manifestOf([])))).toContain("no routes found")
})

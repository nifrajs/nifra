import { expect, test } from "bun:test"
import {
  buildManifest,
  createWebApp,
  generateClientEntry,
  generateServerManifest,
  type RenderAdapter,
  type RouteModule,
} from "../src/index.ts"

const importer = (file: string) => async (): Promise<RouteModule> => ({ default: file })

// Minimal stub adapter (mirrors app.test.ts) for the server-manifest round-trip through createWebApp.
const streamOf = (s: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(s))
      c.close()
    },
  })
const stub: RenderAdapter = {
  renderToStream: (chain, props) =>
    streamOf(`<p>chain=${chain.length}:${JSON.stringify(props.data)}</p>`),
  hydrationHead: () => "",
}

test("generateClientEntry emits lazy code-split loaders + router wiring + patterns", () => {
  const m = buildManifest(
    ["_layout.tsx", "index.tsx", "users/[id].tsx", "_404.tsx", "_410.tsx"],
    importer,
  )
  const code = generateClientEntry(m, {
    clientModule: "@nifrajs/web-solid/client",
    resolve: (file) => `/routes/${file}`,
  })
  expect(code).toContain(
    'import { createClientRouter, createMatcher, mergeHeads, resolveMeta } from "@nifrajs/web"',
  )
  expect(code).toContain(
    'import { applyHead, installForms, installHistory, signalHydrated } from "@nifrajs/web/client"',
  )
  expect(code).toContain('import * as __adapter from "@nifrajs/web-solid/client"')
  expect(code).toContain("const { mountRouter } = __adapter")
  expect(code).toContain("const errorBoundary = __adapter.errorBoundary")
  expect(code).toContain("const errorRouteIds = new Set([])") // no _error files in this manifest
  // Routes are LAZY loaders (dynamic import → one chunk per route at build time).
  expect(code).toContain('import("/routes/index.tsx")')
  expect(code).toContain('import("/routes/users/[id].tsx")')
  expect(code).toContain('import("/routes/_layout.tsx")')
  expect(code).toContain('"index": () => Promise.all([')
  expect(code).toContain('"users/[id]": () => Promise.all([')
  expect(code).toContain('"_404": () => Promise.all([')
  expect(code).toContain('"_410": () => Promise.all([')
  // loadModule caches the component chain + the chain's meta list (layouts→page) per route, so a
  // soft-nav merges the layout chain's head with the page's (matching the SSR <head>) — #3.
  expect(code).toContain("const loadModule = async (id) =>")
  expect(code).toContain("chains[id] = mods.map((m) => m.default)")
  expect(code).toContain("metas[id] = mods.map((m) => m.meta)")
  // patterns drive client-side matching and must mirror the server routes.
  expect(code).toContain('{ routeId: "index", pattern: "/" }')
  expect(code).toContain('{ routeId: "users/[id]", pattern: "/users/:id" }')
  expect(code).toContain("createMatcher(patterns)(location.pathname)")
  expect(code).toContain('const statusRoutes = {"404":"_404","410":"_410"}')
  expect(code).toContain(
    "const router = createClientRouter({ patterns, initial, loadModule, statusRoutes })",
  )
  expect(code).toContain("installHistory(router)")
  expect(code).toContain("installForms(router)")
  expect(code).toContain("mountRouter({ router, routes: chains, container: root })")
  // The hydration signal fires on the frame after the adapter mounts (see the Hydration guide).
  expect(code).toContain("requestAnimationFrame(signalHydrated)")
  // head updates on navigation from the matched route's MERGED chain meta (layouts→page) + data — #3.
  expect(code).toContain(
    "applyHead(mergeHeads((metas[s.routeId] ?? [undefined]).map((m) => resolveMeta(m, args))))",
  )
  // Item 1: the client passes `origin: location.origin` into MetaArgs. It equals the SSR-side
  // `URL(req.url).origin`, so a soft-nav re-resolves the SAME absolute canonical/og:url — no head drift.
  expect(code).toContain("const args = { data: s.data, params: s.params, origin: location.origin }")
  // Initial data is mapped through `mapDeferred` so `{__nifra_deferred: id}` placeholders become the
  // registry's promises (a no-op for non-deferred pages).
  expect(code).toContain("const mapDeferred = (d) =>")
  expect(code).toContain("data: mapDeferred(window.__NIFRA_DATA__)")
  // Recursive mapping (nested defer): walks placeholders at any depth via `d.__nifra_deferred`.
  expect(code).toContain("window.__nifraDeferred(d.__nifra_deferred)")
  expect(code).toContain("d.map(mapDeferred)")
  expect(code).toContain("actionData: mapDeferred(window.__NIFRA_ACTION__)")
  // Initial `path` carries the query too (`pathname + search`) — SSR threads `pathname+search` into
  // useLocation/useSearchParams, so the hydrating state must match or a query-reading page would drift.
  expect(code).toContain("path: location.pathname + location.search")
})

test("generateClientEntry wires the client error boundary for routes with a nearest _error", () => {
  const m = buildManifest(
    ["index.tsx", "_error.tsx", "admin/dash.tsx", "admin/_error.tsx"],
    importer,
  )
  const code = generateClientEntry(m, {
    clientModule: "@nifrajs/web-react/client",
    resolve: (f) => `/r/${f}`,
  })
  // Both routes have a nearest _error → tracked, and each loader appends its _error module LAST.
  expect(code).toContain('const errorRouteIds = new Set(["index","admin/dash"])')
  expect(code).toContain('import("/r/_error.tsx")') // root route appends root _error
  expect(code).toContain('import("/r/admin/_error.tsx")') // nested route appends nearest (admin) _error
  // loadModule wraps the page in errorBoundary(fallback) for error routes.
  expect(code).toContain("if (errorBoundary && errorRouteIds.has(id)) {")
  expect(code).toContain("chains[id] = [...layouts, errorBoundary(fallback), page]")
})

test("generateClientEntry folds a route's layout chain into its lazy loader", () => {
  const m = buildManifest(["_layout.tsx", "index.tsx", "about.tsx"], importer)
  const code = generateClientEntry(m, { clientModule: "x", resolve: (file) => `./${file}` })
  // Each route that uses the layout dynamic-imports it in its own loader (Bun dedupes the chunk
  // at build time, not the codegen). Two routes use the root layout ⇒ two import() sites.
  expect(code.match(/import\("\.\/_layout\.tsx"\)/g)?.length).toBe(2)
  expect(code).toContain(
    '"index": () => Promise.all([import("./_layout.tsx"), import("./index.tsx")])',
  )
})

test("generateServerManifest emits STATIC imports + a buildManifest-backed manifest + baked clientEntry", () => {
  const m = buildManifest(
    ["_layout.tsx", "index.tsx", "users/[id].tsx", "_404.tsx", "_410.tsx"],
    importer,
  )
  const code = generateServerManifest(m, {
    resolve: (file) => `./routes/${file}`,
    clientEntry: "/assets/entry-abc123.js",
  })
  expect(code).toContain('import { buildManifest } from "@nifrajs/web"')
  // STATIC `import * as` per unique file (5) — including dedicated terminal status pages.
  expect(code.match(/^import \* as m\d+ from /gm)?.length).toBe(5)
  // Files are sorted: _404 (m0), _410 (m1), _layout (m2), index (m3), users/[id] (m4).
  expect(code).toContain('import * as m1 from "./routes/_410.tsx"')
  expect(code).toContain('import * as m2 from "./routes/_layout.tsx"')
  expect(code).toContain('import * as m4 from "./routes/users/[id].tsx"')
  // modules map keyed by the route-relative path buildManifest expects (derives patterns from them).
  expect(code).toContain('"_410.tsx": m1,')
  expect(code).toContain('"index.tsx": m3,')
  expect(code).toContain('"users/[id].tsx": m4,')
  // clientEntry baked — a disk-less worker can't read manifest.json at runtime.
  expect(code).toContain('export const clientEntry = "/assets/entry-abc123.js"')
  // Rebuilt via the SAME pure logic discoverRoutes feeds (patterns + layout chains match exactly).
  expect(code).toContain(
    "export const manifest = buildManifest(Object.keys(modules), (file) => () => Promise.resolve(modules[file]))",
  )
  // The whole point: NO dynamic-path import, NO fs (unlike the client entry / discoverRoutes).
  expect(code).not.toContain("import(")
  expect(code).not.toContain("node:fs")
})

test("generateServerManifest's runtime pattern round-trips through createWebApp (no fs)", async () => {
  // The exact expression generateServerManifest emits — exercised with in-memory route modules
  // (the bundled worker's `import * as` namespaces) to prove createWebApp SSRs from it, unchanged.
  const modules: Record<string, RouteModule> = {
    "_layout.tsx": { default: "layout" },
    "index.tsx": { default: "home", loader: () => ({ hello: "edge" }) },
    "users/[id].tsx": { default: "user", loader: (ctx) => ({ id: ctx.params.id }) },
    "_404.tsx": { default: "not-found" },
  }
  const manifest = buildManifest(
    Object.keys(modules),
    (file) => () => Promise.resolve(modules[file] as RouteModule),
  )
  const app = createWebApp({ adapter: stub, manifest, clientEntry: "/c.js" })
  // index: loader ran, wrapped in the root _layout (chain 2 = [layout, page]) — buildManifest applies
  // the root layout to every route, proving the layout-chain derivation survives the codegen pattern.
  expect(await (await app.fetch(new Request("http://x/"))).text()).toContain(
    'chain=2:{"hello":"edge"}',
  )
  // users/:id: same root layout chain + a params-driven loader.
  expect(await (await app.fetch(new Request("http://x/users/42"))).text()).toContain(
    'chain=2:{"id":"42"}',
  )
  // unmatched → _404 (status 404).
  expect((await app.fetch(new Request("http://x/nope"))).status).toBe(404)
})

test("generateServerManifest({ lazy }) emits per-route import() loaders (no eager import * as)", () => {
  const m = buildManifest(["_layout.tsx", "index.tsx", "users/[id].tsx", "_404.tsx"], importer)
  const code = generateServerManifest(m, {
    resolve: (file) => `./routes/${file}`,
    clientEntry: "/assets/entry-abc123.js",
    lazy: true,
  })
  // LAZY loaders: `() => import("./routes/x")` (static specifier → one chunk per route).
  expect(code).toContain('"index.tsx": () => import("./routes/index.tsx"),')
  expect(code).toContain('"users/[id].tsx": () => import("./routes/users/[id].tsx"),')
  expect(code.match(/=> import\("\.\/routes\//g)?.length).toBe(4)
  // No eager `import * as` namespace imports in lazy mode.
  expect(code).not.toContain("import * as m")
  // Built from the per-file loaders; clientEntry still baked; still fs-free.
  expect(code).toContain(
    "export const manifest = buildManifest(Object.keys(loaders), (file) => () => loaders[file]())",
  )
  expect(code).toContain('export const clientEntry = "/assets/entry-abc123.js"')
  expect(code).not.toContain('"node:fs"')
})

test("the lazy runtime pattern round-trips through createWebApp (loaders called on demand)", async () => {
  // Mirror lazy codegen: a per-file loader map (here `() => Promise.resolve(mod)` stands in for
  // `() => import(...)`), behind the same `(file) => () => loaders[file]()` importer the codegen emits.
  const loaded: string[] = []
  const make = (mod: RouteModule) => () => {
    loaded.push((mod.default as string) ?? "?")
    return Promise.resolve(mod)
  }
  const loaders: Record<string, () => Promise<RouteModule>> = {
    "_layout.tsx": make({ default: "layout" }),
    "index.tsx": make({ default: "home", loader: () => ({ hi: "lazy" }) }),
    "_404.tsx": make({ default: "nf" }),
  }
  const manifest = buildManifest(
    Object.keys(loaders),
    (file) => () => loaders[file]?.() as Promise<RouteModule>,
  )
  const app = createWebApp({ adapter: stub, manifest, clientEntry: "/c.js" })
  expect(await (await app.fetch(new Request("http://x/"))).text()).toContain(
    'chain=2:{"hi":"lazy"}',
  )
  // The index + its layout were loaded on demand (lazily) when the route was hit.
  expect(loaded).toContain("home")
  expect(loaded).toContain("layout")
})

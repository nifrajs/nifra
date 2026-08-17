import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import ts from "typescript"
import {
  buildManifest,
  generateClientEntry,
  generateRouteSearchTypes,
  generateServerManifest,
  type RouteModule,
} from "../src/index.ts"

const importer = (file: string) => async (): Promise<RouteModule> => ({ default: file })

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
    // `/client`, not the root: the root drags the server graph into the browser (see
    // client-graph-boundary.test.ts).
    'import { createClientRouter, createMatcher, mergeHeads, resolveMeta } from "@nifrajs/web/client"',
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
  // soft-nav merges the layout chain's head with the page's (matching the SSR <head>) - #3.
  expect(code).toContain("const loadModule = async (id) =>")
  expect(code).toContain("chains[id] = mods.map((m) => m.default)")
  expect(code).toContain("metas[id] = mods.map((m) => m.meta)")
  // Typed search: the page module's `searchSchema` is registered per route (undefined when absent), so
  // the mount derives this route's `search` from the URL, matching the server's `ctx.search`.
  expect(code).toContain("const searchSchemas = {}")
  // The schema chain is every module (layouts + page), so a layout searchSchema merges with the page's.
  expect(code).toContain("searchSchemas[id] = mods.map((m) => m.searchSchema)")
  // Client-only search keys: registry + per-route population (drives the revalidation opt-out).
  expect(code).toContain("const searchClientKeys = {}")
  expect(code).toContain("searchClientKeys[id] = mods[mods.length - 1].searchClientKeys ?? []")
  // patterns drive client-side matching and must mirror the server routes.
  expect(code).toContain('{ routeId: "index", pattern: "/" }')
  expect(code).toContain('{ routeId: "users/[id]", pattern: "/users/:id" }')
  expect(code).toContain("createMatcher(patterns)(location.pathname)")
  expect(code).toContain('const statusRoutes = {"404":"_404","410":"_410"}')
  expect(code).toContain(
    "const router = createClientRouter({ patterns, initial, loadModule, statusRoutes, searchClientKeys, routeHooks })",
  )
  expect(code).toContain("installHistory(router)")
  expect(code).toContain("installForms(router)")
  expect(code).toContain("mountRouter({ router, routes: chains, searchSchemas, container: root })")
  // The hydration signal fires on the frame after the adapter mounts (see the Hydration guide).
  expect(code).toContain("requestAnimationFrame(signalHydrated)")
  // head updates on navigation from the matched route's MERGED chain meta (layouts→page) + data - #3.
  expect(code).toContain(
    "applyHead(mergeHeads((metas[s.routeId] ?? [undefined]).map((m) => resolveMeta(m, args))))",
  )
  // Item 1: the client passes `origin: location.origin` into MetaArgs. It equals the SSR-side
  // `URL(req.url).origin`, so a soft-nav re-resolves the SAME absolute canonical/og:url - no head drift.
  expect(code).toContain("const args = { data: s.data, params: s.params, origin: location.origin }")
  // Initial data is mapped through `mapDeferred` so `{__nifra_deferred: id}` placeholders become the
  // registry's promises (a no-op for non-deferred pages).
  expect(code).toContain("const mapDeferred = (d) =>")
  expect(code).toContain("data: mapDeferred(window.__NIFRA_DATA__)")
  // Recursive mapping (nested defer): walks placeholders at any depth via `d.__nifra_deferred`.
  expect(code).toContain("window.__nifraDeferred(d.__nifra_deferred)")
  expect(code).toContain("d.map(mapDeferred)")
  expect(code).toContain("actionData: mapDeferred(window.__NIFRA_ACTION__)")
  // Initial `path` carries the query too (`pathname + search`) - SSR threads `pathname+search` into
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
  // The schema chain excludes the appended _error module (layouts + page = all but the last).
  expect(code).toContain(
    "searchSchemas[id] = mods.slice(0, mods.length - 1).map((m) => m.searchSchema)",
  )
  expect(code).toContain("searchClientKeys[id] = mods[mods.length - 2].searchClientKeys ?? []")
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
  expect(code).toContain('import { buildManifest, type RouteModule } from "@nifrajs/web"')
  expect(code).toContain("const modules: Record<string, RouteModule> = {")
  // STATIC `import * as` per unique file (5) - including dedicated terminal status pages.
  expect(code.match(/^import \* as m\d+ from /gm)?.length).toBe(5)
  // Files are sorted: _404 (m0), _410 (m1), _layout (m2), index (m3), users/[id] (m4). Import specifiers
  // are EXTENSIONLESS so the manifest typechecks under a bare `tsc`; the map keys below keep `.tsx`.
  expect(code).toContain('import * as m1 from "./routes/_410"')
  expect(code).toContain('import * as m2 from "./routes/_layout"')
  expect(code).toContain('import * as m4 from "./routes/users/[id]"')
  // No source extension survives in an `import * as` specifier (the map keys below still carry it).
  expect(code).not.toMatch(/^import \* as m\d+ from .*\.tsx"/gm)
  // modules map keyed by the route-relative path buildManifest expects (derives patterns from them).
  expect(code).toContain('"_410.tsx": m1,')
  expect(code).toContain('"index.tsx": m3,')
  expect(code).toContain('"users/[id].tsx": m4,')
  // clientEntry baked - a disk-less worker can't read manifest.json at runtime.
  expect(code).toContain('export const clientEntry = "/assets/entry-abc123.js"')
  // Rebuilt via the SAME pure logic discoverRoutes feeds (patterns + layout chains match exactly).
  expect(code).toContain(
    "export const manifest = buildManifest(Object.keys(modules), (file) => () => Promise.resolve(modules[file]))",
  )
  // The whole point: NO dynamic-path import, NO fs (unlike the client entry / discoverRoutes).
  expect(code).not.toContain("import(")
  expect(code).not.toContain("node:fs")
})

test("generateServerManifest({ lazy }) emits per-route import() loaders (no eager import * as)", () => {
  const m = buildManifest(["_layout.tsx", "index.tsx", "users/[id].tsx", "_404.tsx"], importer)
  const code = generateServerManifest(m, {
    resolve: (file) => `./routes/${file}`,
    clientEntry: "/assets/entry-abc123.js",
    lazy: true,
  })
  // LAZY loaders: `() => import("./routes/x")` (static specifier → one chunk per route). The specifier
  // is EXTENSIONLESS so the manifest typechecks under a bare `tsc`; the map KEY keeps its `.tsx`.
  expect(code).toContain('"index.tsx": () => import("./routes/index"),')
  expect(code).toContain("const loaders: Record<string, () => Promise<RouteModule>> = {")
  expect(code).toContain('"users/[id].tsx": () => import("./routes/users/[id]"),')
  expect(code.match(/=> import\("\.\/routes\//g)?.length).toBe(4)
  // No source extension survives in an import specifier (TS5097 under a plain tsc).
  expect(code).not.toContain('import("./routes/index.tsx")')
  // No eager `import * as` namespace imports in lazy mode.
  expect(code).not.toContain("import * as m")
  // Built from the per-file loaders; clientEntry still baked; still fs-free.
  expect(code).toContain(
    "export const manifest = buildManifest(Object.keys(loaders), (file) => () => loaders[file]())",
  )
  expect(code).toContain('export const clientEntry = "/assets/entry-abc123.js"')
  expect(code).not.toContain('"node:fs"')
})

test("generated server manifests compile under a strict consumer tsconfig", async () => {
  const root = await mkdtemp(join(tmpdir(), "nifra-server-manifest-types-"))
  try {
    const routesDir = join(root, "routes")
    await mkdir(routesDir, { recursive: true })
    await writeFile(
      join(routesDir, "index.tsx"),
      "export default function Index() { return null }\n",
    )
    const manifest = buildManifest(["index.tsx"], importer)
    // NOTE: `allowImportingTsExtensions` is deliberately NOT set - the generated manifest must typecheck
    // under a bare consumer tsconfig. It used to emit `.tsx` import specifiers (TS5097 without the flag);
    // extensionless specifiers resolve to the source file under any `moduleResolution` and need no flag.
    const compilerOptions: ts.CompilerOptions = {
      baseUrl: process.cwd(),
      jsx: ts.JsxEmit.ReactJSX,
      ignoreDeprecations: "6.0",
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      paths: {
        "@nifrajs/web": [join(import.meta.dir, "../dist/index.d.ts")],
      },
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ESNext,
    }

    for (const [name, lazy] of [
      ["eager", false],
      ["lazy", true],
    ] as const) {
      const file = join(root, `${name}-server-manifest.ts`)
      await writeFile(
        file,
        generateServerManifest(manifest, {
          resolve: (route) => join(routesDir, route),
          clientEntry: "/assets/entry.js",
          lazy,
        }),
      )
      const program = ts.createProgram([file], compilerOptions)
      const diagnostics = ts.getPreEmitDiagnostics(program)
      expect(
        diagnostics.map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        ),
      ).toEqual([])
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("generateRouteSearchTypes augments RouteSearch for static routes only", () => {
  const m = buildManifest(
    ["index.tsx", "reports.tsx", "users/[id].tsx", "files/[...p].tsx"],
    importer,
  )
  const code = generateRouteSearchTypes(m, {
    resolve: (f) => `./routes/${f.replace(/\.tsx$/, "")}`,
  })
  expect(code).toContain('import type { SearchOf } from "@nifrajs/web"')
  expect(code).toContain('declare module "@nifrajs/web" {')
  expect(code).toContain("interface RouteSearch {")
  // Static routes map their pattern -> the route module's search output type.
  expect(code).toContain('"/": SearchOf<typeof import("./routes/index")>')
  expect(code).toContain('"/reports": SearchOf<typeof import("./routes/reports")>')
  // Dynamic routes (a :param or catch-all) are excluded - their pattern is not a concrete `to`.
  expect(code).not.toContain("/users/:id")
  expect(code).not.toContain("/files/")
})

test("generateRouteSearchTypes targets a custom module when asked", () => {
  const m = buildManifest(["index.tsx"], importer)
  const code = generateRouteSearchTypes(m, { resolve: (f) => `./${f}`, module: "@my/router" })
  expect(code).toContain('declare module "@my/router" {')
})

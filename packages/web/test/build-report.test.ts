import { describe, expect, test } from "bun:test"
import {
  aggregateSizeReport,
  type ChunkSize,
  cloudflareRouteRules,
  diffManifestRoutes,
  formatBytes,
  formatManifestDrift,
  generateServerEntry,
  isManifestInSync,
  parseManifestClientEntry,
  parseManifestRouteFiles,
  renderSizeReport,
} from "../src/build.ts"
import { generateServerManifest } from "../src/index.ts"

// Pure size + drift helpers for `nifra build --report` and the #7 server-manifest drift guard. They're
// the deterministic cores (no fs / no Bun.build), measured + bundled by the orchestrators in build.ts.

// --- Bundle-size report -------------------------------------------------------------------------------

describe("aggregateSizeReport — sorts biggest gzip first + sums totals", () => {
  test("orders by gzip desc, ties by raw bytes then name; totals are the sums", () => {
    const chunks: ChunkSize[] = [
      { name: "small.js", bytes: 100, gzip: 50 },
      { name: "big.js", bytes: 5000, gzip: 2000 },
      { name: "mid.js", bytes: 1000, gzip: 400 },
    ]
    const report = aggregateSizeReport(chunks)
    expect(report.chunks.map((c) => c.name)).toEqual(["big.js", "mid.js", "small.js"])
    expect(report.totalBytes).toBe(6100)
    expect(report.totalGzip).toBe(2450)
  })

  test("equal gzip → larger raw first; equal raw → name asc (stable)", () => {
    const chunks: ChunkSize[] = [
      { name: "b.js", bytes: 100, gzip: 50 },
      { name: "a.js", bytes: 100, gzip: 50 },
      { name: "c.js", bytes: 200, gzip: 50 },
    ]
    const report = aggregateSizeReport(chunks)
    expect(report.chunks.map((c) => c.name)).toEqual(["c.js", "a.js", "b.js"])
  })

  test("empty input → zero totals, no chunks", () => {
    const report = aggregateSizeReport([])
    expect(report.chunks).toEqual([])
    expect(report.totalBytes).toBe(0)
    expect(report.totalGzip).toBe(0)
  })
})

describe("formatBytes", () => {
  test("B under 1 KiB, KB to one decimal, MB above 1 MiB", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(1024)).toBe("1.0 KB")
    expect(formatBytes(1536)).toBe("1.5 KB")
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB")
    expect(formatBytes(3 * 1024 * 1024 + 512 * 1024)).toBe("3.5 MB")
  })
})

describe("renderSizeReport", () => {
  test("renders an aligned table, biggest first, with a Total row", () => {
    const report = aggregateSizeReport([
      { name: "index-abc.js", bytes: 2048, gzip: 800 },
      { name: "vendor-xyz.js", bytes: 100000, gzip: 30000 },
    ])
    const text = renderSizeReport(report)
    const lines = text.split("\n")
    expect(lines[0]).toContain("Chunk")
    expect(lines[0]).toContain("Raw")
    expect(lines[0]).toContain("Gzip")
    // First data row is the biggest chunk.
    expect(lines[2]).toContain("vendor-xyz.js")
    expect(lines[3]).toContain("index-abc.js")
    // Total row sums both.
    const total = lines[lines.length - 1]
    expect(total).toContain("Total")
    expect(total).toContain(formatBytes(102048))
    expect(total).toContain(formatBytes(30800))
  })
})

// --- Server-manifest drift (#7) -----------------------------------------------------------------------

// An eager manifest (the default `generateServerManifest` shape) importing three routes + the bare
// `@nifrajs/web` import (which must be ignored) + a baked clientEntry.
const EAGER_MANIFEST = [
  'import { buildManifest } from "@nifrajs/web"',
  'import * as m0 from "./routes/_layout.tsx"',
  'import * as m1 from "./routes/about.tsx"',
  'import * as m2 from "./routes/index.tsx"',
  "const modules = { }",
  'export const clientEntry = "/assets/_nifra-entry-deadbeef.js"',
  "export const manifest = buildManifest(Object.keys(modules), (file) => () => Promise.resolve(modules[file]))",
].join("\n")

// A lazy manifest (`() => import(...)`), the other shape generateServerManifest emits.
const LAZY_MANIFEST = [
  'import { buildManifest } from "@nifrajs/web"',
  "const loaders = {",
  '  "_layout.tsx": () => import("./routes/_layout.tsx"),',
  '  "index.tsx": () => import("./routes/index.tsx"),',
  "}",
  'export const clientEntry = "/assets/_nifra-entry-cafe1234.js"',
  "export const manifest = buildManifest(Object.keys(loaders), (file) => () => loaders[file]())",
].join("\n")

describe("parseManifestRouteFiles", () => {
  test("extracts route-relative files from an eager manifest, ignoring the @nifrajs/web import", () => {
    expect(parseManifestRouteFiles(EAGER_MANIFEST)).toEqual([
      "_layout.tsx",
      "about.tsx",
      "index.tsx",
    ])
  })

  test("handles the lazy `() => import(...)` shape too", () => {
    expect(parseManifestRouteFiles(LAZY_MANIFEST)).toEqual(["_layout.tsx", "index.tsx"])
  })

  test("respects a custom routes prefix", () => {
    const src = 'import * as m0 from "../app/routes/index.tsx"'
    expect(parseManifestRouteFiles(src, "../app/routes/")).toEqual(["index.tsx"])
  })
})

describe("parseManifestClientEntry", () => {
  test("reads the baked clientEntry URL", () => {
    expect(parseManifestClientEntry(EAGER_MANIFEST)).toBe("/assets/_nifra-entry-deadbeef.js")
  })
  test("undefined when absent", () => {
    expect(parseManifestClientEntry("const x = 1")).toBeUndefined()
  })
})

describe("diffManifestRoutes + formatManifestDrift", () => {
  test("in sync → no missing/extra, formatManifestDrift returns undefined", () => {
    const manifestFiles = parseManifestRouteFiles(EAGER_MANIFEST)
    const drift = diffManifestRoutes(manifestFiles, ["index.tsx", "about.tsx", "_layout.tsx"])
    expect(isManifestInSync(drift)).toBe(true)
    expect(drift.missing).toEqual([])
    expect(drift.extra).toEqual([])
    expect(formatManifestDrift(drift)).toBeUndefined()
  })

  test("a new route in routes/ not in the manifest → reported as missing", () => {
    const manifestFiles = parseManifestRouteFiles(EAGER_MANIFEST)
    const drift = diffManifestRoutes(manifestFiles, [
      "index.tsx",
      "about.tsx",
      "_layout.tsx",
      "blog.tsx",
    ])
    expect(isManifestInSync(drift)).toBe(false)
    expect(drift.missing).toEqual(["blog.tsx"])
    expect(drift.extra).toEqual([])
    const msg = formatManifestDrift(drift, "site/server-manifest.ts")
    expect(msg).toContain("server-manifest drift")
    expect(msg).toContain("blog.tsx")
    expect(msg).toContain("site/server-manifest.ts")
    expect(msg).toContain("re-run the build")
  })

  test("a deleted route still imported by the manifest → reported as extra", () => {
    const manifestFiles = parseManifestRouteFiles(EAGER_MANIFEST)
    const drift = diffManifestRoutes(manifestFiles, ["index.tsx", "_layout.tsx"])
    expect(drift.extra).toEqual(["about.tsx"])
    expect(drift.missing).toEqual([])
    expect(formatManifestDrift(drift)).toContain("about.tsx")
  })
})

// --- Generated server entry (per-target) --------------------------------------------------------------

describe("generateServerEntry", () => {
  test("cf-pages → a fetch handler that delegates static paths to ASSETS, never to disk", () => {
    const src = generateServerEntry({
      target: "cf-pages",
      adapterImport: "../framework.ts",
      backendImport: "../backend.ts",
      title: "my site",
    })
    expect(src).toContain('import { toFetchHandler } from "@nifrajs/core/server"')
    expect(src).toContain("toFetchHandler(app)")
    expect(src).toContain("api: inProcessClient(backend)")
    expect(src).toContain('title: "my site"')
    // Static paths go to Pages' asset server, NOT to a filesystem read - the edge has no disk, and
    // `_routes.json` cannot always keep every static request off the worker.
    expect(src).toContain("env.ASSETS.fetch(request)")
    expect(src).not.toContain("readFile")
    expect(src).not.toContain("Bun.file")
  })

  test("bun → self-hosting Bun.serve that serves /assets/* from disk", () => {
    const src = generateServerEntry({ target: "bun", adapterImport: "../framework.ts" })
    expect(src).toContain("Bun.serve(")
    expect(src).toContain('pathname.startsWith("/assets/")')
    // Frontend-only (no backend) → no inProcessClient/api line.
    expect(src).not.toContain("inProcessClient")
    expect(src).not.toContain("api:")
  })

  test("node → @nifrajs/node serve + node:fs readFile", () => {
    const src = generateServerEntry({
      target: "node",
      adapterImport: "../framework.ts",
      backendImport: "../backend.ts",
      publicFiles: ["/robots.txt", "/.well-known/acme-challenge/token"],
    })
    expect(src).toContain('import { serve } from "@nifrajs/node"')
    expect(src).toContain('import { readFile } from "node:fs/promises"')
    expect(src).toContain("await serve(")
    expect(src).toContain('new Set(["/robots.txt","/.well-known/acme-challenge/token"])')
    expect(src).toContain("PUBLIC_FILES.has(pathname)")
    expect(src).toContain("new URL(filePath, STATIC_ROOT)")
  })

  test("deno → Deno.serve + fetch handler", () => {
    const src = generateServerEntry({ target: "deno", adapterImport: "../framework.ts" })
    expect(src).toContain("Deno.serve(")
    expect(src).toContain("toFetchHandler(app)")
  })

  test("vercel → edge config + default fetch export", () => {
    const src = generateServerEntry({ target: "vercel", adapterImport: "../framework.ts" })
    expect(src).toContain('export const config = { runtime: "edge" }')
    expect(src).toContain("export default")
  })

  test("static has no server entry — throws", () => {
    expect(() =>
      generateServerEntry({ target: "static", adapterImport: "../framework.ts" }),
    ).toThrow(/static/)
  })

  test("imports + passes styles/routeStyles to createWebApp (so the SSR head links CSS)", () => {
    const src = generateServerEntry({ target: "bun", adapterImport: "../framework.ts" })
    expect(src).toContain(
      'import { clientEntry, manifest, styles, routeStyles } from "./server-manifest"',
    )
    expect(src).toContain("  styles,")
    expect(src).toContain("  routeStyles,")
  })
})

describe("generateServerManifest — bakes styles for createWebApp", () => {
  const EMPTY = { routes: [], layouts: {} } as unknown as Parameters<
    typeof generateServerManifest
  >[0]

  test("bakes styles + routeStyles exports from the build's CSS manifest", () => {
    const src = generateServerManifest(EMPTY, {
      resolve: (f) => `./routes/${f}`,
      clientEntry: "/assets/x.js",
      styles: ["/assets/x.css"],
      routeStyles: { index: ["/assets/x.css"] },
    })
    expect(src).toContain('export const styles = ["/assets/x.css"]')
    expect(src).toContain('export const routeStyles = {"index":["/assets/x.css"]}')
  })

  test("defaults to empty exports when the app imports no CSS (so consumers can always import them)", () => {
    const src = generateServerManifest(EMPTY, {
      resolve: (f) => `./routes/${f}`,
      clientEntry: "/assets/x.js",
    })
    expect(src).toContain("export const styles = []")
    expect(src).toContain("export const routeStyles = {}")
  })
})

// Cloudflare rejects a `_routes.json` carrying more than 100 include+exclude rules, or any rule over
// 100 characters - and it rejects it at `wrangler pages deploy`, after a build that reported success.
// One exclude per public file clears that ceiling with an ordinary icon-and-font `public/`, so the
// budget is enforced where the file is written rather than discovered at the deploy.
describe("cloudflareRouteRules", () => {
  test("names every public file when they fit", () => {
    const rules = cloudflareRouteRules(["/robots.txt", "/fonts/inter.woff2"], ["/", "/about"])
    expect(rules.include).toEqual(["/*"])
    expect(rules.exclude).toEqual(["/assets/*", "/robots.txt", "/fonts/inter.woff2"])
    expect(rules.omitted).toEqual([])
  })

  test("stays inside the 100-rule budget and reports what it dropped", () => {
    // Routes claim `/icons`, so the directory cannot be collapsed and the budget has to truncate.
    const files = Array.from({ length: 260 }, (_, i) => `/icons/icon-${i}.png`)
    const rules = cloudflareRouteRules(files, ["/icons/:id"])
    expect(rules.include.length + rules.exclude.length).toBeLessThanOrEqual(100)
    // Everything unnamed is accounted for, not silently lost.
    expect(rules.exclude.length - 1 + rules.omitted.length).toBe(files.length)
    expect(rules.omitted.length).toBeGreaterThan(0)
  })

  test("drops an over-long path rather than emitting a rule Cloudflare rejects", () => {
    const long = `/fonts/${"a".repeat(120)}.woff2`
    const rules = cloudflareRouteRules(["/robots.txt", long], ["/fonts/:id"])
    expect(rules.exclude).toEqual(["/assets/*", "/robots.txt"])
    expect(rules.omitted).toEqual([long])
  })

  test("a filename containing * is dropped rather than becoming a wildcard", () => {
    const rules = cloudflareRouteRules(["/blog/logo.png", "/weird*name.txt"], ["/blog/:slug"])
    expect(rules.exclude).toEqual(["/assets/*", "/blog/logo.png"])
    expect(rules.omitted).toEqual(["/weird*name.txt"])
  })

  test("the root route reserves nothing - `/` cannot match below a directory", () => {
    // `/` has no first segment, which must not read as "could match anywhere".
    const files = Array.from({ length: 200 }, (_, i) => `/icons/icon-${i}.png`)
    expect(cloudflareRouteRules(files, ["/"]).exclude).toEqual(["/assets/*", "/icons/*"])
  })

  // Collapsing a directory into `/dir/*` fits far more files and hands Pages every FUTURE path under
  // that prefix, so it is only correct where the route table proves nothing is served beneath it.
  describe("directory collapsing", () => {
    const many = (dir: string, n: number) =>
      Array.from({ length: n }, (_, i) => `/${dir}/file-${i}.png`)

    test("collapses a directory no route can be served under", () => {
      const rules = cloudflareRouteRules(many("icons", 200), ["/", "/about", "/blog/:slug"])
      expect(rules.exclude).toEqual(["/assets/*", "/icons/*"])
      // Every file is covered by the glob, so nothing is left for the worker.
      expect(rules.omitted).toEqual([])
    })

    test("REFUSES to collapse a directory a route is served under", () => {
      // `public/blog/hero.png` beside a `/blog/:slug` route: `/blog/*` would send `/blog/my-post` to
      // the CDN, which has no such file, and the page would 404 in production only.
      const files = many("blog", 200)
      const rules = cloudflareRouteRules(files, ["/", "/blog/:slug"])
      expect(rules.exclude).not.toContain("/blog/*")
      expect(rules.include.length + rules.exclude.length).toBeLessThanOrEqual(100)
      // Falls back to exact paths, so the overflow is dropped to the worker instead of widened.
      expect(rules.omitted.length).toBeGreaterThan(0)
    })

    test("one dynamic first segment disables collapsing everywhere", () => {
      // `/:locale/…` can match under ANY directory name, so no prefix is provably free.
      const rules = cloudflareRouteRules(many("icons", 200), ["/:locale/about"])
      expect(rules.exclude).not.toContain("/icons/*")
    })

    test("unrecognised pattern syntax blocks collapsing rather than permitting it", () => {
      const rules = cloudflareRouteRules(many("icons", 200), ["/{weird}/thing"])
      expect(rules.exclude).not.toContain("/icons/*")
    })

    test("does not collapse when the exact paths already fit", () => {
      // A smaller file is worth nothing on its own, and exact paths keep the app's own 404 for a
      // missing file under that directory.
      const rules = cloudflareRouteRules(many("icons", 3), ["/about"])
      expect(rules.exclude).toEqual([
        "/assets/*",
        "/icons/file-0.png",
        "/icons/file-1.png",
        "/icons/file-2.png",
      ])
    })

    test("collapses only the safe directories, leaving the rest exact", () => {
      const files = [...many("icons", 120), "/blog/hero.png", "/robots.txt"]
      const rules = cloudflareRouteRules(files, ["/blog/:slug"])
      expect(rules.exclude).toContain("/icons/*")
      expect(rules.exclude).toContain("/blog/hero.png")
      expect(rules.exclude).toContain("/robots.txt")
      expect(rules.exclude).not.toContain("/blog/*")
      expect(rules.omitted).toEqual([])
    })
  })
})

describe("generateServerEntry — cf-pages static fallback", () => {
  test("serves an allowlisted public path through ASSETS instead of 404ing in the router", () => {
    // `_routes.json` cannot always name every public file, so a static request CAN reach the worker.
    // Correctness must not depend on how much of that list fit.
    const src = generateServerEntry({
      target: "cf-pages",
      adapterImport: "../framework.ts",
      publicFiles: ["/robots.txt"],
    })
    expect(src).toContain('new Set(["/robots.txt"])')
    expect(src).toContain("env.ASSETS.fetch(request)")
    // Confined to the build's own outputs - never an arbitrary path.
    expect(src).toContain('pathname.startsWith("/assets/") || PUBLIC_FILES.has(pathname)')
  })
})

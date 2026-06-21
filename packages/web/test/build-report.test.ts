import { describe, expect, test } from "bun:test"
import {
  aggregateSizeReport,
  type ChunkSize,
  diffManifestRoutes,
  formatBytes,
  formatManifestDrift,
  generateServerEntry,
  isManifestInSync,
  parseManifestClientEntry,
  parseManifestRouteFiles,
  renderSizeReport,
} from "../src/build.ts"

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
  test("cf-pages → default-exports the fetch handler, no disk-asset server", () => {
    const src = generateServerEntry({
      target: "cf-pages",
      adapterImport: "../framework.ts",
      backendImport: "../backend.ts",
      title: "my site",
    })
    expect(src).toContain('import { toFetchHandler } from "@nifrajs/core"')
    expect(src).toContain("export default toFetchHandler(app)")
    expect(src).toContain("api: inProcessClient(backend)")
    expect(src).toContain('title: "my site"')
    // The edge handler doesn't serve /assets from disk (Pages does).
    expect(src).not.toContain("/assets/")
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
    })
    expect(src).toContain('import { serve } from "@nifrajs/node"')
    expect(src).toContain('import { readFile } from "node:fs/promises"')
    expect(src).toContain("await serve(")
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
})

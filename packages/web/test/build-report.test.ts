import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { type ServeStaticOptions, serveStatic } from "@nifrajs/core/serve-static"
import {
  aggregateSizeReport,
  BUILD_TARGETS,
  type BuildTarget,
  type ChunkSize,
  cloudflareRouteRules,
  diffManifestRoutes,
  formatBytes,
  formatManifestDrift,
  generateServerEntry,
  isManifestInSync,
  parseManifestClientEntry,
  parseManifestCssLoading,
  parseManifestRouteFiles,
  parseManifestRouteStyles,
  parseManifestStyles,
  renderSizeReport,
  resyncServerManifestSource,
  type ServerEntrySelfHost,
} from "../src/build.ts"
import { generateServerManifest } from "../src/index.ts"

// Pure size + drift helpers for `nifra build --report` and the #7 server-manifest drift guard. They're
// the deterministic cores (no fs / no Bun.build), measured + bundled by the orchestrators in build.ts.

// --- Bundle-size report -------------------------------------------------------------------------------

describe("aggregateSizeReport - sorts biggest gzip first + sums totals", () => {
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
// `@nifrajs/web` import (which must be ignored) + a baked clientEntry. Import specifiers are emitted
// extensionless (so a bare `tsc` compiles the manifest); the route-map KEYS carry the `.tsx` identity.
const EAGER_MANIFEST = [
  'import { buildManifest, type RouteModule } from "@nifrajs/web"',
  'import * as m0 from "./routes/_layout"',
  'import * as m1 from "./routes/about"',
  'import * as m2 from "./routes/index"',
  "const modules: Record<string, object> = {",
  '  "_layout.tsx": m0,',
  '  "about.tsx": m1,',
  '  "index.tsx": m2,',
  "}",
  'export const clientEntry = "/assets/_nifra-entry-deadbeef.js"',
  "export const styles = []",
  "export const routeStyles = {}",
  "export const manifest = buildManifest(Object.keys(modules), (file) => () => Promise.resolve(modules[file] as RouteModule))",
].join("\n")

// A lazy manifest (`() => import(...)`), the other shape generateServerManifest emits.
const LAZY_MANIFEST = [
  'import { buildManifest, type RouteModule } from "@nifrajs/web"',
  "const loaders: Record<string, () => Promise<object>> = {",
  '  "_layout.tsx": () => import("./routes/_layout"),',
  '  "index.tsx": () => import("./routes/index"),',
  "}",
  'export const clientEntry = "/assets/_nifra-entry-cafe1234.js"',
  "export const styles = []",
  "export const routeStyles = {}",
  "export const manifest = buildManifest(Object.keys(loaders), (file) => loaders[file] as () => Promise<RouteModule>)",
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

  test("reads the extension-bearing keys regardless of import prefix, ignoring baked routeStyles", () => {
    const src = [
      "const loaders: Record<string, () => Promise<object>> = {",
      '  "index.tsx": () => import("../app/routes/index"),',
      "}",
      // A single-line `routeStyles` whose keys must NOT be mistaken for route-map entries - including
      // one (`gone.tsx`) that is not a live route at all.
      'export const routeStyles = {"index.tsx":["/a.css"],"gone.tsx":["/b.css"]}',
    ].join("\n")
    expect(parseManifestRouteFiles(src)).toEqual(["index.tsx"])
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

describe("parseManifestCssLoading", () => {
  test("reads the baked stylesheet activation mode", () => {
    expect(parseManifestCssLoading('export const cssLoading = "deferred"')).toBe("deferred")
    expect(parseManifestCssLoading('export const cssLoading = "blocking"')).toBe("blocking")
  })

  test("returns undefined for older or malformed manifests", () => {
    expect(parseManifestCssLoading('export const cssLoading = "other"')).toBeUndefined()
    expect(parseManifestCssLoading("const x = 1")).toBeUndefined()
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

/**
 * The options a generated self-hosting entry passes to its server, evaluated with its folder at
 * `dir` and no PORT set. Its `static` is the mount list it hands `serveStatic`.
 */
async function entryOptions(src: string, dir: string): Promise<Record<string, unknown>> {
  const section = src
    .slice(src.indexOf("const STATIC_ROOT"), src.indexOf("console.log("))
    .replace('new URL("./", import.meta.url)', "ROOT_URL")
    .replace('new URL("./assets/", import.meta.url)', 'new URL("./assets/", ROOT_URL)')
    .replace("const server = app.listen(Number(Bun.env.PORT ?? 3000),", "return capture(")
    .replace("const server = await serve(app,", "return capture(")
    .replace("await serve(app,", "return capture(")
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: an async function's constructor is AsyncFunction, which TS does not name.
  const AsyncFunction = (async () => {}).constructor as new (
    ...source: string[]
  ) => (...args: unknown[]) => Promise<unknown>
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the evaluated section returns the options object it passed to the capture stub.
  return (await new AsyncFunction(
    "ROOT_URL",
    "capture",
    "serveStatic",
    "Deno",
    new Bun.Transpiler({ loader: "ts" }).transformSync(section),
  )(
    pathToFileURL(dir.endsWith(sep) ? dir : dir + sep),
    (options: unknown) => options,
    // The mounts themselves, so a test reads what the entry passes serveStatic.
    (mounts: unknown) => mounts,
    { env: { get: (): string | undefined => undefined } },
  )) as Record<string, unknown>
}

/** An entry's mounts with each `dir` as its URL's text, so two lists compare by where they read. */
function staticOf(options: Record<string, unknown>): ServeStaticOptions[] {
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: entryOptions returns the list the entry passes serveStatic.
  return options.static as ServeStaticOptions[]
}

function mountsOf(options: Record<string, unknown>): ServeStaticOptions[] {
  return staticOf(options).map((mount) => ({
    ...mount,
    dir: String(mount.dir),
  }))
}

describe("generateServerEntry", () => {
  test("cloudflare → a fetch handler that delegates static paths to ASSETS, never to disk", () => {
    const src = generateServerEntry({
      target: "cloudflare",
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

  test("bun → app.listen() with /assets/* served from disk in front of every route", () => {
    const src = generateServerEntry({ target: "bun", adapterImport: "../framework.ts" })
    // listen() names the socket peer, trusts Bun's framing, and holds Bun's table and stop().
    expect(src).toContain("const server = app.listen(Number(Bun.env.PORT ?? 3000), {")
    expect(src).toContain('import { serveStatic } from "@nifrajs/core/serve-static"')
    expect(src).toContain("  static: serveStatic([")
    expect(src).not.toContain("Bun.serve(")
    expect(src).not.toContain("app.fetch(")
    // Frontend-only (no backend) → no inProcessClient/api line.
    expect(src).not.toContain("inProcessClient")
    expect(src).not.toContain("api:")
  })

  // Each runtime's serveStatic answers these mounts the same way: internal/invariants/test/static-files.test.ts
  // runs one tree through the Bun, Node and Deno entries and requires the same answers.
  test("every self-hosting entry passes serveStatic the same mounts, which answer as dev does", async () => {
    const root = mkdtempSync(join(tmpdir(), "nifra-static-entry-"))
    const dir = join(root, "static")
    mkdirSync(join(dir, "assets"), { recursive: true })
    mkdirSync(join(dir, ".well-known/acme-challenge"), { recursive: true })
    writeFileSync(join(dir, "robots.txt"), "User-agent: *")
    writeFileSync(join(dir, "logo.SVG"), "<svg/>")
    writeFileSync(join(dir, ".well-known/acme-challenge/token"), "token")
    writeFileSync(join(dir, "assets/page-1a2b3c.js"), "x".repeat(100))
    writeFileSync(join(root, "server-secret.txt"), "secret")
    writeFileSync(join(dir, "server.js"), "// the server bundle")
    // A link planted in the deployed tree, pointing outside it.
    symlinkSync(join(root, "server-secret.txt"), join(dir, "assets/leak.js"))
    // A visible name linking to a hidden file inside it, and a hidden directory under /assets/.
    writeFileSync(join(dir, ".env"), "SECRET=1")
    symlinkSync(join(dir, ".env"), join(dir, "assets/env.js"))
    mkdirSync(join(dir, "assets/.cache"))
    writeFileSync(join(dir, "assets/.cache/x.js"), "cached")
    try {
      const [bun, node, deno] = await Promise.all(
        (["bun", "node", "deno"] as const).map(async (target) => {
          const src = generateServerEntry({
            target,
            adapterImport: "../framework.ts",
            publicFiles: ["/robots.txt", "/logo.SVG", "/.well-known/acme-challenge/token"],
          })
          return staticOf(await entryOptions(src, dir))
        }),
      )
      expect(mountsOf({ static: node })).toEqual(mountsOf({ static: bun }))
      expect(mountsOf({ static: deno })).toEqual(mountsOf({ static: bun }))
      const files = serveStatic(bun)
      const get = async (path: string, init?: RequestInit) => {
        const response = await files(new Request(`http://app.test${path}`, init))
        if (response === undefined) throw new Error(`no mount took ${path}`)
        return response
      }
      const robots = await get("/robots.txt")
      expect(robots.headers.get("content-type")).toBe("text/plain; charset=utf-8")
      expect(robots.headers.get("cache-control")).toBe("public, max-age=86400")
      expect(robots.headers.get("x-content-type-options")).toBe("nosniff")
      expect((await get("/logo.SVG")).headers.get("content-type")).toBe("image/svg+xml")
      expect((await get("/.well-known/acme-challenge/token")).headers.get("content-type")).toBe(
        "application/octet-stream",
      )
      const asset = await get("/assets/page-1a2b3c.js")
      expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
      expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
      expect(await asset.text()).toHaveLength(100)
      const head = await get("/assets/page-1a2b3c.js", { method: "HEAD" })
      expect(head.headers.get("content-length")).toBe("100")
      expect(head.body).toBeNull()
      const part = await get("/assets/page-1a2b3c.js", { headers: { range: "bytes=0-9" } })
      expect(part.status).toBe(206)
      expect(part.headers.get("content-range")).toBe("bytes 0-9/100")
      expect(await part.text()).toBe("x".repeat(10))
      expect((await get("/assets/leak.js")).status).toBe(404)
      expect((await get("/assets/env.js")).status).toBe(404)
      expect((await get("/assets/.cache/x.js")).status).toBe(404)
      // The server bundle beside the client files, and any page, are the app's.
      expect(files(new Request("http://app.test/server.js"))).toBeUndefined()
      expect(files(new Request("http://app.test/about"))).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("node → the app itself on @nifrajs/node, files through the adapter's reader", async () => {
    const src = generateServerEntry({
      target: "node",
      adapterImport: "../framework.ts",
      backendImport: "../backend.ts",
      publicFiles: ["/robots.txt", "/.well-known/acme-challenge/token"],
      hashedFiles: ["/assets/page-1a2b3c.js"],
    })
    expect(src).toContain('import { serve, serveStatic } from "@nifrajs/node"')
    expect(src).toContain('import { createWebApp } from "@nifrajs/web"')
    // A `{ fetch }` wrapper around app.fetch would hide the node-direct lane from the adapter.
    expect(src).toContain("await serve(app, {")
    expect(src).not.toContain("app.fetch(")
    const root = "/srv/app/"
    const options = await entryOptions(src, root)
    expect(options.port).toBe(3000)
    const rootUrl = pathToFileURL(root).href
    expect(mountsOf(options)).toEqual([
      {
        dir: `${rootUrl}assets/`,
        prefix: "/assets",
        hashedFiles: new Set(["/assets/page-1a2b3c.js"]),
        cacheControl: "public, max-age=86400",
      },
      {
        dir: rootUrl,
        prefix: "/",
        // The root mount also holds server.js: only the build's listed files are served from it.
        files: new Set(["/robots.txt", "/.well-known/acme-challenge/token"]),
        immutable: false,
        cacheControl: "public, max-age=86400",
      },
    ])
    // No manifest list: every /assets/ file is content-hashed output.
    const unlisted = await entryOptions(
      generateServerEntry({ target: "node", adapterImport: "../framework.ts" }),
      root,
    )
    expect(staticOf(unlisted)[0]).not.toHaveProperty("hashedFiles")
  })

  test("deno → the app itself on @nifrajs/deno, the build's files in front of it", async () => {
    const src = generateServerEntry({
      target: "deno",
      adapterImport: "../framework.ts",
      publicFiles: ["/robots.txt"],
    })
    // The adapter marks the body framing, passes the socket peer and drains on stop().
    expect(src).toContain('import { serve, serveStatic } from "@nifrajs/deno"')
    expect(src).not.toContain("Deno.serve(")
    expect(src).not.toContain("app.fetch(")
    expect(src).not.toContain("toFetchHandler")
    const options = await entryOptions(src, "/srv/app/")
    expect(options.port).toBe(3000)
    expect(options).not.toHaveProperty("signals")
    expect(mountsOf(options).map((mount) => mount.dir)).toEqual([
      `${pathToFileURL("/srv/app/").href}assets/`,
      pathToFileURL("/srv/app/").href,
    ])
  })

  test("selfHost reaches each self-hosting server, idleTimeoutSec Bun's alone; an edge target ignores it", async () => {
    const selfHost = { gracefulSignals: { drainMs: 5000, delayMs: 1000 }, idleTimeoutSec: 120 }
    const entry = (target: BuildTarget, settings: ServerEntrySelfHost = selfHost) =>
      generateServerEntry({
        target,
        adapterImport: "../framework.ts",
        selfHost: settings,
      })
    const bare = (target: BuildTarget) =>
      generateServerEntry({ target, adapterImport: "../framework.ts" })
    const bun = entry("bun")
    expect(bun).toContain('  server: { gracefulSignals: {"drainMs":5000,"delayMs":1000} },')
    expect(bun).toContain("  idleTimeoutSec: 120,")
    expect(entry("bun", { gracefulSignals: true })).toContain(
      "  server: { gracefulSignals: true },",
    )
    for (const target of ["bun", "node", "deno"] as const) {
      expect(entry(target, { gracefulSignals: false })).toBe(bare(target))
    }
    for (const target of ["node", "deno"] as const) {
      expect(entry(target)).not.toContain("idleTimeoutSec")
      expect(entry(target)).not.toContain("server:")
    }
    const node = await entryOptions(entry("node"), "/srv/app/")
    expect(node.gracefulSignals).toEqual(selfHost.gracefulSignals)
    const deno = await entryOptions(entry("deno"), "/srv/app/")
    expect(deno.gracefulSignals).toEqual(selfHost.gracefulSignals)
    for (const target of ["cloudflare", "vercel"] as const) {
      expect(entry(target)).toBe(bare(target))
    }
  })

  test("a selfHost setting of the wrong shape is refused, naming it", () => {
    const refused: [unknown, string][] = [
      [null, "selfHost must be an object"],
      [{ gracefulSignals: "yes" }, "gracefulSignals must be a boolean or { drainMs, delayMs }"],
      [{ gracefulSignals: { drainMs: -1 } }, "gracefulSignals.drainMs must be a number"],
      [{ gracefulSignals: { delayMs: Number.NaN } }, "gracefulSignals.delayMs must be a number"],
      [{ idleTimeoutSec: 256 }, "idleTimeoutSec must be a whole number of seconds from 0 to 255"],
      [{ idleTimeoutSec: 1.5 }, "idleTimeoutSec must be a whole number"],
      [{ idleTimeoutSec: "30" }, "idleTimeoutSec must be a whole number"],
    ]
    for (const [selfHost, message] of refused) {
      expect(() =>
        generateServerEntry({
          target: "bun",
          adapterImport: "../framework.ts",
          // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the wrong shapes a JavaScript config can hand the generator.
          selfHost: selfHost as ServerEntrySelfHost,
        }),
      ).toThrow(message)
    }
    expect(() =>
      generateServerEntry({
        target: "bun",
        adapterImport: "../framework.ts",
        selfHost: { gracefulSignals: { drainMs: 0, delayMs: 0 }, idleTimeoutSec: 0 },
      }),
    ).not.toThrow()
  })

  test("vercel → edge config + default fetch export", () => {
    const src = generateServerEntry({ target: "vercel", adapterImport: "../framework.ts" })
    expect(src).toContain('export const config = { runtime: "edge" }')
    expect(src).toContain("export default")
  })

  test("static has no server entry - throws", () => {
    expect(() =>
      generateServerEntry({ target: "static", adapterImport: "../framework.ts" }),
    ).toThrow(/static/)
  })

  test("no target trusts a client-address header unless the app declares clientIp", () => {
    for (const target of BUILD_TARGETS.filter((t) => t !== "static")) {
      const src = generateServerEntry({ target, adapterImport: "../framework.ts" })
      expect(src).not.toContain("server:")
      expect(src).not.toContain("clientIp: {")
      expect(src).not.toContain("cf-connecting-ip")
      expect(src).not.toContain("x-real-ip")
      expect(src).not.toContain("x-forwarded-for")
    }
  })

  test('clientIp "platform" trusts exactly the header each edge platform overwrites', () => {
    const header = (target: "cloudflare" | "vercel") =>
      generateServerEntry({ target, adapterImport: "../framework.ts", clientIp: "platform" })
    // Core's `{ header }` trust on the page app, so the /api mount and loaders get the derived caller.
    expect(header("cloudflare")).toContain(
      '  server: { clientIp: { header: "cf-connecting-ip" } },\n})',
    )
    expect(header("vercel")).toContain('  server: { clientIp: { header: "x-real-ip" } },\n})')
    // One header each - nothing a client could append to (`x-forwarded-for`) is consulted.
    expect(header("cloudflare")).not.toContain("x-real-ip")
    expect(header("cloudflare")).not.toContain("x-forwarded-for")
    expect(header("vercel")).not.toContain("cf-connecting-ip")
    expect(header("vercel")).not.toContain("x-forwarded-for")
  })

  test('clientIp "platform" leaves self-hosting targets on the socket peer', () => {
    for (const target of ["bun", "node", "deno"] as const) {
      const base = { target, adapterImport: "../framework.ts", backendImport: "../backend.ts" }
      expect(generateServerEntry({ ...base, clientIp: "platform" })).toBe(generateServerEntry(base))
    }
  })

  test("an unknown clientIp value is refused, not silently ignored", () => {
    expect(() =>
      generateServerEntry({
        target: "cloudflare",
        adapterImport: "../framework.ts",
        clientIp: "cf-connecting-ip" as "platform",
      }),
    ).toThrow(/clientIp must be "platform"/)
  })

  test("imports + passes styles/routeStyles to createWebApp (so the SSR head links CSS)", () => {
    const src = generateServerEntry({ target: "bun", adapterImport: "../framework.ts" })
    expect(src).toContain(
      'import { clientEntry, cssLoading, manifest, styles, routeStyles } from "./server-manifest"',
    )
    expect(src).toContain("  styles,")
    expect(src).toContain("  routeStyles,")
    expect(src).toContain("  cssLoading,")
  })
})

describe("generateServerEntry - app `use` middleware passthrough", () => {
  const serverTargets = BUILD_TARGETS.filter((t) => t !== "static")

  test("useImport → every server target imports `use` and passes it to createWebApp", () => {
    for (const target of serverTargets) {
      const src = generateServerEntry({
        target,
        adapterImport: "../framework.ts",
        useImport: "../framework.ts",
      })
      expect(src).toContain('import { use } from "../framework.ts"')
      expect(src).toContain("  use,")
    }
  })

  test("no useImport → no `use` import and no `use` option, on every server target", () => {
    for (const target of serverTargets) {
      const src = generateServerEntry({ target, adapterImport: "../framework.ts" })
      expect(src).not.toContain("import { use }")
      expect(src).not.toContain("  use,")
    }
  })

  test("static still throws even with useImport", () => {
    expect(() =>
      generateServerEntry({
        target: "static",
        adapterImport: "../framework.ts",
        useImport: "../framework.ts",
      }),
    ).toThrow(/static/)
  })
})

describe("generateServerManifest - bakes styles for createWebApp", () => {
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
    expect(src).toContain('export const cssLoading = "blocking"')
  })

  test("bakes the deferred stylesheet activation mode", () => {
    const src = generateServerManifest(EMPTY, {
      resolve: (f) => `./routes/${f}`,
      clientEntry: "/assets/x.js",
      cssLoading: "deferred",
    })
    expect(src).toContain('export const cssLoading = "deferred"')
  })

  test("defaults to empty exports when the app imports no CSS (so consumers can always import them)", () => {
    const src = generateServerManifest(EMPTY, {
      resolve: (f) => `./routes/${f}`,
      clientEntry: "/assets/x.js",
    })
    expect(src).toContain("export const styles = []")
    expect(src).toContain("export const routeStyles = {}")
    expect(src).toContain('export const cssLoading = "blocking"')
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

describe("generateServerEntry - cloudflare static fallback", () => {
  test("serves an allowlisted public path through ASSETS instead of 404ing in the router", () => {
    // `_routes.json` cannot always name every public file, so a static request CAN reach the worker.
    // Correctness must not depend on how much of that list fit.
    const src = generateServerEntry({
      target: "cloudflare",
      adapterImport: "../framework.ts",
      publicFiles: ["/robots.txt"],
    })
    expect(src).toContain('new Set(["/robots.txt"])')
    expect(src).toContain("env.ASSETS.fetch(request)")
    // Confined to the build's own outputs - never an arbitrary path.
    expect(src).toContain('pathname.startsWith("/assets/") || PUBLIC_FILES.has(pathname)')
  })
})

// `nifra sync-manifest` regenerates a COMMITTED server-manifest after a route add or rename. It must
// carry the baked asset URLs across: they come from a real build, and the resync has no build to ask.
// Dropping them silently would ship a page with no stylesheet links and no client entry - a blank-looking
// deploy from a command whose whole purpose is to avoid a rebuild.
describe("server-manifest resync preserves what it cannot recompute", () => {
  const BUILT = [
    'import { buildManifest } from "@nifrajs/web"',
    'import * as m0 from "./routes/index.tsx"',
    "const modules = { }",
    'export const clientEntry = "/assets/_nifra-deadbeef.js"',
    'export const styles = ["/assets/app-1.css", "/assets/app-2.css"]',
    'export const routeStyles = { "index": ["/assets/index-9.css"], "about": [] }',
    "export const manifest = buildManifest(Object.keys(modules), (f) => () => Promise.resolve(modules[f]))",
  ].join("\n")

  test("reads the baked styles and per-route styles", () => {
    expect(parseManifestStyles(BUILT)).toEqual(["/assets/app-1.css", "/assets/app-2.css"])
    expect(parseManifestRouteStyles(BUILT)).toEqual({
      index: ["/assets/index-9.css"],
      about: [],
    })
  })

  test("a formatter's trailing comma does not lose the styles", () => {
    // biome/prettier add one when wrapping a multi-line literal, and strict JSON.parse rejects it.
    // Failing to parse here is silent: the resync would emit an empty list and the CSS links vanish.
    const wrapped = BUILT.replace(
      'export const styles = ["/assets/app-1.css", "/assets/app-2.css"]',
      'export const styles = [\n  "/assets/app-1.css",\n  "/assets/app-2.css",\n]',
    )
    expect(parseManifestStyles(wrapped)).toEqual(["/assets/app-1.css", "/assets/app-2.css"])
  })

  test("absent or unparseable declarations degrade to empty, never throw", () => {
    // A hand-edited or older manifest must not crash the command.
    expect(parseManifestStyles("const x = 1")).toEqual([])
    expect(parseManifestRouteStyles("const x = 1")).toEqual({})
    expect(parseManifestStyles("export const styles = [oops")).toEqual([])
    expect(parseManifestRouteStyles("export const routeStyles = {oops")).toEqual({})
    // A declaration of the wrong SHAPE is ignored rather than passed through as-is.
    expect(parseManifestStyles('export const styles = {"not": "an array"}')).toEqual([])
    expect(parseManifestRouteStyles('export const routeStyles = ["not an object"]')).toEqual({})
  })

  test("resync rewrites the route list while carrying the built assets forward", () => {
    const next = resyncServerManifestSource(
      BUILT,
      {
        routes: [
          {
            id: "index",
            pattern: "/",
            layoutIds: [],
            file: "index.tsx",
            load: async () => ({ default: () => null }),
          },
        ],
        layouts: {},
      },
      "./routes/",
    )
    // The asset URLs survive - they cannot be recomputed without a build.
    expect(next).toContain("/assets/_nifra-deadbeef.js")
    expect(next).toContain("/assets/app-1.css")
    expect(next).toContain("/assets/index-9.css")
    // The route is re-emitted with its extensionless import specifier and its `.tsx` map key.
    expect(next).toContain('import * as m0 from "./routes/index"')
    expect(next).toContain('"index.tsx": m0,')
  })

  test("resync keeps the manifest's existing eager/lazy shape", () => {
    // Switching a committed manifest from lazy to eager (or back) changes the app's chunking, which a
    // command that only re-lists routes has no business doing.
    // The REAL lazy emit annotates the declaration (`const loaders: Record<...> = {`); the `:` between
    // the name and `=` is exactly what defeated the old substring detector, so the fixture must carry it.
    const lazySource = BUILT.replace(
      "const modules = { }",
      "const loaders: Record<string, () => Promise<object>> = { }",
    )
    const manifest = {
      routes: [
        {
          id: "index",
          pattern: "/",
          layoutIds: [],
          file: "index.tsx",
          load: async () => ({ default: () => null }),
        },
      ],
      layouts: {},
    }
    expect(resyncServerManifestSource(lazySource, manifest, "./routes/")).toContain("const loaders")
    expect(resyncServerManifestSource(BUILT, manifest, "./routes/")).not.toContain("const loaders")
  })
})

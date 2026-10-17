import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { open, realpath, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { Readable } from "node:stream"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseByteRange } from "@nifrajs/core/range"
import * as staticFile from "@nifrajs/core/static-file"
import {
  aggregateSizeReport,
  BUILD_TARGETS,
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
} from "../src/build.ts"
import { generateServerManifest, servePublicDir } from "../src/index.ts"

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

/** The slice of Deno's file API the generated Deno entry uses, over `node:fs`. */
const denoFiles = {
  SeekMode: { Start: 0 },
  realPath: (path: URL | string) => realpath(path instanceof URL ? fileURLToPath(path) : path),
  stat: async (path: string) => {
    const named = await stat(path)
    return { dev: named.dev, ino: named.ino }
  },
  async open(path: string) {
    const handle = await open(path, "r")
    let position = 0
    return {
      stat: async () => {
        const opened = await handle.stat()
        return {
          isFile: opened.isFile(),
          size: opened.size,
          mtime: opened.mtime,
          ctime: opened.ctime,
          dev: opened.dev,
          ino: opened.ino,
        }
      },
      seek: async (offset: number) => {
        position = offset
      },
      read: async (into: Uint8Array) => {
        const { bytesRead } = await handle.read(into, 0, into.length, position)
        position += bytesRead
        return bytesRead === 0 ? null : bytesRead
      },
      get readable() {
        return Readable.toWeb(handle.createReadStream({ start: position }))
      },
      close: () => {
        handle.close().catch(() => {})
      },
    }
  },
}

interface StaticHandler {
  staticPath(pathname: string): string | undefined
  staticResponse(request: Request, file?: string, pathname?: string): Promise<Response>
}

/**
 * Evaluate a generated entry's static gate and handler themselves, rooted at `dir` instead of the
 * entry's own folder, rather than pattern-match their text. Deno's runs on the `deno` file API shim.
 */
async function staticHandler(src: string, dir: string, deno = denoFiles): Promise<StaticHandler> {
  const start = src.indexOf("const STATIC_ROOT")
  const end = Math.max(
    src.indexOf("const server = Bun.serve"),
    src.indexOf("await serve("),
    src.indexOf("Deno.serve("),
  )
  const section = src.slice(start, end).replace('new URL("./", import.meta.url)', "ROOT_URL")
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: an async function's constructor is AsyncFunction, which TS does not name.
  const AsyncFunction = (async () => {}).constructor as new (
    ...source: string[]
  ) => (...args: unknown[]) => Promise<unknown>
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the evaluated section is the generated entry's static handler, which declares these two functions.
  return (await new AsyncFunction(
    "servePublicDir",
    "fileURLToPath",
    "parseByteRange",
    "createHash",
    "Deno",
    "ROOT_URL",
    ...Object.keys(staticFile),
    `${new Bun.Transpiler({ loader: "ts" }).transformSync(section)}; return { staticPath, staticResponse }`,
  )(
    servePublicDir,
    fileURLToPath,
    parseByteRange,
    createHash,
    deno,
    pathToFileURL(`${dir}/`),
    ...Object.values(staticFile),
  )) as StaticHandler
}

/** The options a generated Node entry passes to `serve`, evaluated with its folder at `dir`. */
async function nodeServeOptions(src: string, dir: string): Promise<Record<string, unknown>> {
  const start = src.indexOf("const STATIC_ROOT")
  const section = src
    .slice(start)
    .replace('new URL("./", import.meta.url)', "ROOT_URL")
    .replace('new URL("./assets/", import.meta.url)', 'new URL("./assets/", ROOT_URL)')
    .replace("await serve(app,", "return capture(")
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: an async function's constructor is AsyncFunction, which TS does not name.
  const AsyncFunction = (async () => {}).constructor as new (
    ...source: string[]
  ) => (...args: unknown[]) => Promise<unknown>
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the evaluated section returns the options object it passed to the capture stub.
  return (await new AsyncFunction(
    "fileURLToPath",
    "ROOT_URL",
    "capture",
    new Bun.Transpiler({ loader: "ts" }).transformSync(section),
  )(fileURLToPath, pathToFileURL(dir), (options: unknown) => options)) as Record<string, unknown>
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

  test("bun → self-hosting Bun.serve that serves /assets/* from disk", () => {
    const src = generateServerEntry({ target: "bun", adapterImport: "../framework.ts" })
    expect(src).toContain("Bun.serve(")
    expect(src).toContain('pathname.startsWith("/assets/")')
    // The socket peer reaches the app (rateLimit keys on it), and Bun's own framing is trusted.
    expect(src).toContain("server.requestIP(req)?.address")
    expect(src).toContain('Symbol.for("nifra.body.trustedFraming")')
    // Frontend-only (no backend) → no inProcessClient/api line.
    expect(src).not.toContain("inProcessClient")
    expect(src).not.toContain("api:")
  })

  // The Node entry hands these files to @nifrajs/node's reader; internal/invariants/test/static-files.test.ts
  // runs the same tree through it and through this handler and requires the same answers.
  test("the Bun and Deno entries serve static files as dev does: type, cache, HEAD, ranges, no escaping link", async () => {
    const root = mkdtempSync(join(tmpdir(), "nifra-static-entry-"))
    const dir = join(root, "static")
    mkdirSync(join(dir, "assets"), { recursive: true })
    mkdirSync(join(dir, ".well-known/acme-challenge"), { recursive: true })
    writeFileSync(join(dir, "robots.txt"), "User-agent: *")
    writeFileSync(join(dir, "logo.SVG"), "<svg/>")
    writeFileSync(join(dir, ".well-known/acme-challenge/token"), "token")
    writeFileSync(join(dir, "assets/page-1a2b3c.js"), "x".repeat(100))
    writeFileSync(join(root, "server-secret.txt"), "secret")
    // A link planted in the deployed tree, pointing outside it.
    symlinkSync(join(root, "server-secret.txt"), join(dir, "assets/leak.js"))
    // A visible name linking to a hidden file inside it, and a hidden directory under /assets/.
    writeFileSync(join(dir, ".env"), "SECRET=1")
    symlinkSync(join(dir, ".env"), join(dir, "assets/env.js"))
    mkdirSync(join(dir, "assets/.cache"))
    writeFileSync(join(dir, "assets/.cache/x.js"), "cached")
    try {
      for (const target of ["bun", "deno"] as const) {
        const src = generateServerEntry({
          target,
          adapterImport: "../framework.ts",
          publicFiles: ["/robots.txt", "/logo.SVG", "/.well-known/acme-challenge/token"],
        })
        const { staticPath, staticResponse } = await staticHandler(src, dir)
        const get = (path: string, init?: RequestInit) => {
          const file = staticPath(path)
          expect(file).toBeDefined()
          return staticResponse(new Request(`http://app.test${path}`, init), file, path)
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
        expect(staticPath("/about")).toBeUndefined()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("the Deno entry refuses a file reached through a directory swapped for a link after its check", async () => {
    const root = mkdtempSync(join(tmpdir(), "nifra-static-swap-"))
    const dir = join(root, "static")
    mkdirSync(join(dir, "assets/chunks"), { recursive: true })
    writeFileSync(join(dir, "assets/chunks/app.js"), "app")
    mkdirSync(join(root, "outside"))
    writeFileSync(join(root, "outside/app.js"), "secret")
    let swap = false
    // Deno.open follows links: `chunks` becomes one to a directory outside the root after the
    // containment check passed and before the file is opened.
    const racing = {
      ...denoFiles,
      open(path: string) {
        if (swap) {
          swap = false
          renameSync(join(dir, "assets/chunks"), join(dir, "assets/chunks-old"))
          symlinkSync(join(root, "outside"), join(dir, "assets/chunks"))
        }
        return denoFiles.open(path)
      },
    }
    try {
      const src = generateServerEntry({ target: "deno", adapterImport: "../framework.ts" })
      const { staticPath, staticResponse } = await staticHandler(src, dir, racing)
      const path = "/assets/chunks/app.js"
      const get = () =>
        staticResponse(new Request(`http://app.test${path}`), staticPath(path), path)
      expect(await (await get()).text()).toBe("app")
      swap = true
      const swapped = await get()
      expect(swapped.status).toBe(404)
      expect(await swapped.text()).toBe("not found")
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
    expect(src).toContain('import { serve } from "@nifrajs/node"')
    expect(src).toContain('import { createWebApp } from "@nifrajs/web"')
    // A `{ fetch }` wrapper around app.fetch would hide the node-direct lane from the adapter.
    expect(src).toContain("await serve(app, {")
    expect(src).not.toContain("app.fetch(")
    expect(src).not.toContain("servePublicDir")
    const root = "/srv/app/"
    const options = await nodeServeOptions(src, root)
    expect(options.port).toBe(3000)
    // The entry resolves its dirs as the platform does: `D:\srv\app\` on Windows.
    const rootDir = resolve(root) + sep
    expect(options.static).toEqual([
      {
        dir: join(rootDir, "assets") + sep,
        prefix: "/assets",
        hashedFiles: new Set(["/assets/page-1a2b3c.js"]),
        cacheControl: "public, max-age=86400",
      },
      {
        dir: rootDir,
        prefix: "/",
        // The root mount also holds server.js: only the build's listed files are served from it.
        files: new Set(["/robots.txt", "/.well-known/acme-challenge/token"]),
        immutable: false,
        cacheControl: "public, max-age=86400",
      },
    ])
    // No manifest list: every /assets/ file is content-hashed output, as servePublicDir assumes.
    const unlisted = await nodeServeOptions(
      generateServerEntry({ target: "node", adapterImport: "../framework.ts" }),
      root,
    )
    expect((unlisted.static as Record<string, unknown>[])[0]).not.toHaveProperty("hashedFiles")
  })

  test("deno → Deno.serve passing the peer address", () => {
    const src = generateServerEntry({ target: "deno", adapterImport: "../framework.ts" })
    expect(src).toContain("Deno.serve(")
    expect(src).toContain("app.fetch(req, { clientIp: info.remoteAddr.hostname })")
    expect(src).toContain('Symbol.for("nifra.body.trustedFraming")')
    expect(src).not.toContain("toFetchHandler")
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

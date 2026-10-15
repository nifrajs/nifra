import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildTarget, generateServerEntry } from "../src/build.ts"
import { discoverRoutes } from "../src/fs.ts"
import type { RenderAdapter } from "../src/index.ts"
import { createWebApp } from "../src/index.ts"

// #5 end-to-end: `nifra build --target <t>` packages buildClient + buildServer (+ prerender) into one
// dist/. The CLI is a thin wrapper over `buildTarget`; this exercises the engine directly on a tiny app.
// To keep the engine framework-agnostic (the web package can't depend on web-react), the fixture ships
// a STUB adapter + a STUB client module - same approach as render.test.ts. The temp app lives INSIDE the
// workspace so the generated entry's `@nifrajs/web` import resolves via node_modules hoisting.

const WORKSPACE_TMP_BASE = `${import.meta.dir}/.tmp-build-target-`
let projectRoot: string
let routesDir: string

// A one-chunk byte stream - the minimal `renderToStream` an adapter returns (mirrors render.test.ts).
const streamOf = (s: string): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(s)
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
}
const stubAdapter: RenderAdapter = {
  renderToStream: (chain, props) =>
    streamOf(`<p>nifra chain=${chain.length}:${JSON.stringify(props.data)}</p>`),
  hydrationHead: () => "<!--hydration-head-->",
}

beforeEach(() => {
  projectRoot = mkdtempSync(WORKSPACE_TMP_BASE)
  routesDir = join(projectRoot, "routes")
  mkdirSync(routesDir, { recursive: true })
  // A minimal home route (no JSX → no framework runtime needed), opted into prerendering.
  writeFileSync(join(routesDir, "index.tsx"), "export default function Home() { return null }\n")
  writeFileSync(join(routesDir, "index.backend.ts"), "export const prerender = true\n")
  // The app's framework wiring - exports a stub adapter the generated server entry imports. It emits a
  // fixed marker ("nifra") so the prerendered HTML is assertable without a real UI framework.
  mkdirSync(join(projectRoot, "backend"), { recursive: true })
  writeFileSync(
    join(projectRoot, "backend/framework.ts"),
    "import { streamOf } from './stub-adapter.ts'\n" +
      "export const adapter = {\n" +
      '  renderToStream: () => streamOf("<p>nifra</p>"),\n' +
      "  hydrationHead: () => '<!--hydration-head-->',\n" +
      "}\n",
  )
  writeFileSync(
    join(projectRoot, "backend/stub-adapter.ts"),
    "export const streamOf = (s) => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(s)); c.close() } })\n",
  )
  // The stub client runtime the client bundle imports (exports `mountRouter`).
  mkdirSync(join(projectRoot, "frontend"), { recursive: true })
  writeFileSync(join(projectRoot, "frontend/client-stub.ts"), "export function mountRouter() {}\n")
})
afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true })
})

test("--target cloudflare → _worker.js + _routes.json + /assets bundle", async () => {
  const outDir = join(projectRoot, "dist")
  mkdirSync(join(projectRoot, "public", ".well-known", "acme-challenge"), { recursive: true })
  writeFileSync(join(projectRoot, "public", "robots.txt"), "User-agent: *")
  writeFileSync(join(projectRoot, "public", ".well-known", "acme-challenge", "token"), "challenge")
  const result = await buildTarget("cloudflare", {
    routesDir,
    outDir,
    workDir: join(projectRoot, ".work"),
    clientModule: join(projectRoot, "frontend/client-stub.ts"),
    adapterImport: join(projectRoot, "backend/framework.ts"),
  })

  expect(result.target).toBe("cloudflare")
  // The three artifacts the Cloudflare Pages deploy needs.
  expect(existsSync(join(outDir, "_worker.js"))).toBe(true)
  expect(existsSync(join(outDir, "_routes.json"))).toBe(true)
  expect(existsSync(join(outDir, "assets"))).toBe(true)
  expect(readFileSync(join(outDir, "robots.txt"), "utf8")).toBe("User-agent: *")
  expect(readFileSync(join(outDir, ".well-known", "acme-challenge", "token"), "utf8")).toBe(
    "challenge",
  )
  expect(existsSync(join(outDir, "assets", "robots.txt"))).toBe(false)
  // The client entry from the manifest lands under /assets/*.
  expect(result.client.entry).toMatch(/^\/assets\/.*\.js$/)
  const entryFile = join(outDir, "assets", result.client.entry.slice("/assets/".length))
  expect(existsSync(entryFile)).toBe(true)

  // _routes.json excludes the static asset bundle from the worker.
  const routes = JSON.parse(readFileSync(join(outDir, "_routes.json"), "utf8")) as {
    exclude: string[]
  }
  expect(routes.exclude).toContain("/assets/*")
  expect(routes.exclude).toContain("/robots.txt")
  expect(routes.exclude).toContain("/.well-known/acme-challenge/token")

  // The scratch work dir is cleaned up.
  expect(existsSync(join(projectRoot, ".work"))).toBe(false)

  // A size report was computed over the client + worker outputs.
  expect(result.size.chunks.length).toBeGreaterThan(0)
  expect(result.size.totalGzip).toBeGreaterThan(0)
}, 60_000)

test("--target vercel → Build Output API v3 (config.json, static/, functions/index.func)", async () => {
  const outDir = join(projectRoot, ".vercel/output")
  mkdirSync(join(projectRoot, "public"), { recursive: true })
  writeFileSync(join(projectRoot, "public", "robots.txt"), "User-agent: *")
  const result = await buildTarget("vercel", {
    routesDir,
    outDir,
    workDir: join(projectRoot, ".work-vercel"),
    clientModule: join(projectRoot, "frontend/client-stub.ts"),
    adapterImport: join(projectRoot, "backend/framework.ts"),
  })
  expect(JSON.parse(readFileSync(join(outDir, "config.json"), "utf8"))).toEqual({
    version: 3,
    routes: [{ handle: "filesystem" }, { src: "/(.*)", dest: "/index" }],
  })
  const fn = join(outDir, "functions/index.func")
  expect(JSON.parse(readFileSync(join(fn, ".vc-config.json"), "utf8"))).toEqual({
    runtime: "edge",
    entrypoint: "index.js",
  })
  expect(readFileSync(join(fn, "index.js"), "utf8")).toContain("export")
  // Static files sit where the filesystem route serves them: the hashed bundle and public/.
  expect(existsSync(join(outDir, "static", result.client.entry.replace(/^\//, "")))).toBe(true)
  expect(readFileSync(join(outDir, "static/robots.txt"), "utf8")).toBe("User-agent: *")
  expect(existsSync(join(outDir, "assets"))).toBe(false)
  expect(result.run).toContain("vercel deploy --prebuilt")
}, 60_000)

test("--target static → prerenders opted-in routes to index.html", async () => {
  const outDir = join(projectRoot, "dist-static")
  const manifest = discoverRoutes(routesDir)
  // prerenderApp is a FACTORY given the client build's manifest, so the hydration <script> uses the REAL
  // content-hashed entry that was emitted (not a placeholder that would 404 → no hydration).
  const app = (client: { entry: string }) =>
    createWebApp({ adapter: stubAdapter, manifest, clientEntry: client.entry })

  const result = await buildTarget("static", {
    routesDir,
    outDir,
    workDir: join(projectRoot, ".work-static"),
    clientModule: join(projectRoot, "frontend/client-stub.ts"),
    adapterImport: join(projectRoot, "backend/framework.ts"),
    prerenderApp: app,
  })

  expect(result.target).toBe("static")
  expect(existsSync(join(outDir, "index.html"))).toBe(true)
  const html = readFileSync(join(outDir, "index.html"), "utf8")
  expect(html).toContain("nifra")
  // The client bundle is still emitted under /assets for hydration.
  expect(existsSync(join(outDir, "assets"))).toBe(true)
  // Regression guard (static hydration): the emitted HTML must reference the REAL content-hashed client
  // entry, and that file must actually exist under /assets - a placeholder 404s → the page never hydrates.
  expect(result.client.entry).toMatch(/\/_nifra-entry-[A-Za-z0-9]+\.js$/)
  expect(html).toContain(`"${result.client.entry}"`)
  expect(existsSync(join(outDir, result.client.entry.replace(/^\//, "")))).toBe(true)
  // The generated client-entry SOURCE must NOT ship: only the hashed .js belongs in the deploy dir.
  expect(existsSync(join(outDir, "assets", "_nifra-entry.ts"))).toBe(false)
}, 60_000)

test("--target bun persists the CSS loading policy in the client manifest", async () => {
  const outDir = join(projectRoot, "dist-bun-css")
  const result = await buildTarget("bun", {
    routesDir,
    outDir,
    workDir: join(projectRoot, ".work-bun-css"),
    clientModule: join(projectRoot, "frontend/client-stub.ts"),
    adapterImport: join(projectRoot, "backend/framework.ts"),
    cssLoading: "deferred",
  })

  expect(result.client.cssLoading).toBe("deferred")
  const diskManifest = JSON.parse(
    readFileSync(join(outDir, "assets", "manifest.json"), "utf8"),
  ) as { cssLoading?: string }
  expect(diskManifest.cssLoading).toBe("deferred")
}, 60_000)

test("--target static with no prerenderable route throws a clear error", async () => {
  // Replace the opted-in route with one that doesn't opt in.
  writeFileSync(join(routesDir, "index.tsx"), "export default function Home() { return null }\n")
  rmSync(join(routesDir, "index.backend.ts"))
  const manifest = discoverRoutes(routesDir)
  const app = (client: { entry: string }) =>
    createWebApp({ adapter: stubAdapter, manifest, clientEntry: client.entry })
  const promise = buildTarget("static", {
    routesDir,
    outDir: join(projectRoot, "dist-empty"),
    workDir: join(projectRoot, ".work-empty"),
    clientModule: join(projectRoot, "frontend/client-stub.ts"),
    adapterImport: join(projectRoot, "backend/framework.ts"),
    prerenderApp: app,
  })
  await expect(promise).rejects.toThrow(/no routes were prerendered/)
}, 60_000)

test("a public file that shares the server bundle's path is refused, not served as the bundle", async () => {
  mkdirSync(join(projectRoot, "public"), { recursive: true })
  writeFileSync(join(projectRoot, "public", "Server.js"), "console.log('a public script')\n")
  const promise = buildTarget("bun", {
    routesDir,
    outDir: join(projectRoot, "dist-public-clash"),
    workDir: join(projectRoot, ".work-public-clash"),
    clientModule: join(projectRoot, "frontend/client-stub.ts"),
    adapterImport: join(projectRoot, "backend/framework.ts"),
  })
  await expect(promise).rejects.toThrow(
    /public file\(s\) \/Server\.js would be overwritten by the bun/,
  )
}, 60_000)

test("cloudflare refuses a public _routes.json, which the build writes itself", async () => {
  mkdirSync(join(projectRoot, "public"), { recursive: true })
  writeFileSync(join(projectRoot, "public", "_routes.json"), "{}")
  const promise = buildTarget("cloudflare", {
    routesDir,
    outDir: join(projectRoot, "dist-cf-clash"),
    workDir: join(projectRoot, ".work-cf-clash"),
    clientModule: join(projectRoot, "frontend/client-stub.ts"),
    adapterImport: join(projectRoot, "backend/framework.ts"),
  })
  await expect(promise).rejects.toThrow(/\/_routes\.json would be overwritten by the cloudflare/)
}, 60_000)

// The built Bun server's URL, read from its startup line rather than polled.
async function listening(stdout: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let seen = ""
  for await (const chunk of stdout) {
    seen += decoder.decode(chunk, { stream: true })
    const port = /localhost:(\d+)/.exec(seen)?.[1]
    if (port !== undefined) return `http://127.0.0.1:${port}`
  }
  throw new Error(`the built server exited before listening:\n${seen}`)
}

test("--target bun caches only the build's content-hashed files as immutable", async () => {
  mkdirSync(join(projectRoot, "public", "assets"), { recursive: true })
  writeFileSync(join(projectRoot, "public", "assets", "logo.png"), "png")
  writeFileSync(join(projectRoot, "public", "robots.txt"), "User-agent: *\n")
  const outDir = join(projectRoot, "dist-bun-hashed")
  const result = await buildTarget("bun", {
    routesDir,
    outDir,
    workDir: join(projectRoot, ".work-bun-hashed"),
    clientModule: join(projectRoot, "frontend/client-stub.ts"),
    adapterImport: join(projectRoot, "backend/framework.ts"),
  })
  const proc = Bun.spawn([process.execPath, join(outDir, "server.js")], {
    env: { ...process.env, PORT: "0" },
    stdout: "pipe",
    stderr: "ignore",
  })
  try {
    const base = await listening(proc.stdout)
    const cacheOf = async (path: string) => {
      const res = await fetch(`${base}${path}`)
      expect(res.status).toBe(200)
      await res.arrayBuffer()
      return res.headers.get("cache-control")
    }
    expect(await cacheOf(result.client.entry)).toBe("public, max-age=31536000, immutable")
    // A public file copied under /assets/ keeps its name across deploys, so it must revalidate.
    expect(await cacheOf("/assets/logo.png")).toBe("public, max-age=86400")
    expect(await cacheOf("/assets/manifest.json")).toBe("public, max-age=86400")
    expect(await cacheOf("/robots.txt")).toBe("public, max-age=86400")
  } finally {
    proc.kill()
    await proc.exited
  }
}, 60_000)

const prerenderingApp = (client: { entry: string }) =>
  createWebApp({
    adapter: stubAdapter,
    manifest: discoverRoutes(routesDir),
    clientEntry: client.entry,
  })

test("--target bun answers a prerendered page from its file and renders the rest on demand", async () => {
  const outDir = join(projectRoot, "dist-bun-prerendered")
  await buildTarget("bun", {
    routesDir,
    outDir,
    workDir: join(projectRoot, ".work-bun-prerendered"),
    clientModule: join(projectRoot, "frontend/client-stub.ts"),
    adapterImport: join(projectRoot, "backend/framework.ts"),
    prerenderApp: prerenderingApp,
  })
  const file = join(outDir, "_prerendered", "index.html")
  // Marked after the build, so a response carrying the mark came from the file and not a render.
  writeFileSync(file, readFileSync(file, "utf8").replace("<p>nifra", "<p>from-file nifra"))
  const proc = Bun.spawn([process.execPath, join(outDir, "server.js")], {
    env: { ...process.env, PORT: "0" },
    stdout: "pipe",
    stderr: "ignore",
  })
  try {
    const base = await listening(proc.stdout)
    const page = await fetch(`${base}/`)
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(await page.text()).toContain("<p>from-file nifra")
    const onDemand = await (await fetch(`${base}/?tab=1`)).text()
    expect(onDemand).toContain("<p>nifra</p>")
    expect(onDemand).not.toContain("from-file")
    // The page files are not public files.
    expect((await fetch(`${base}/_prerendered/index.html`)).status).toBe(404)
  } finally {
    proc.kill()
    await proc.exited
  }
}, 60_000)

test("a route that cannot load at build time costs the bun build its prerender, not the build", async () => {
  writeFileSync(join(routesDir, "broken.tsx"), 'throw new Error("needs a production database")\n')
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  try {
    const outDir = join(projectRoot, "dist-bun-broken")
    await buildTarget("bun", {
      routesDir,
      outDir,
      workDir: join(projectRoot, ".work-bun-broken"),
      clientModule: join(projectRoot, "frontend/client-stub.ts"),
      adapterImport: join(projectRoot, "backend/framework.ts"),
      prerenderApp: prerenderingApp,
    })
    expect(existsSync(join(outDir, "_prerendered"))).toBe(false)
    expect(readFileSync(join(outDir, "server.js"), "utf8")).not.toContain("_prerendered")
    expect(String(warn.mock.calls[0]?.[0])).toContain("needs a production database")
  } finally {
    warn.mockRestore()
  }
}, 60_000)

test("a secret in a page a bun build prerenders still fails the build", async () => {
  const name = "NIFRA_BUILD_TARGET_TEST_TOKEN"
  const value = "Zq8mW2vX9pLr4TbN7yKc3HdF"
  process.env[name] = value
  try {
    const failure = await buildTarget("bun", {
      routesDir,
      outDir: join(projectRoot, "dist-bun-secret"),
      workDir: join(projectRoot, ".work-bun-secret"),
      clientModule: join(projectRoot, "frontend/client-stub.ts"),
      adapterImport: join(projectRoot, "backend/framework.ts"),
      prerenderApp: () => ({
        fetch: () => new Response(`<p>${value}</p>`, { headers: { "content-type": "text/html" } }),
      }),
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(String(failure)).toContain(`value of ${name}`)
  } finally {
    delete process.env[name]
  }
}, 60_000)

test("a public file under _prerendered/ is refused by a prerendering bun build", async () => {
  mkdirSync(join(projectRoot, "public", "_prerendered"), { recursive: true })
  writeFileSync(join(projectRoot, "public", "_prerendered", "index.html"), "<p>public</p>")
  const failure = await buildTarget("bun", {
    routesDir,
    outDir: join(projectRoot, "dist-bun-clash"),
    workDir: join(projectRoot, ".work-bun-clash"),
    clientModule: join(projectRoot, "frontend/client-stub.ts"),
    adapterImport: join(projectRoot, "backend/framework.ts"),
    prerenderApp: prerenderingApp,
  }).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(String(failure)).toContain("/_prerendered/index.html sit under /_prerendered/")
}, 60_000)

test("the node entry reads prerendered pages; the edge and deno entries refuse them", () => {
  const prerenderedPages = {
    "/": { file: "index.html", headers: { "content-language": "en" } },
  }
  const node = generateServerEntry({
    target: "node",
    adapterImport: "./framework.ts",
    prerenderedPages,
  })
  expect(node).toContain(
    'import { createWebApp, prerenderedPageReader, servePublicDir } from "@nifrajs/web"',
  )
  expect(node).toContain('pages: {"/":{"content-language":"en"}},')
  expect(node).toContain('files: {"/":"index.html"},')
  expect(node).toContain("  prerenderedPages,")
  expect(generateServerEntry({ target: "node", adapterImport: "./framework.ts" })).not.toContain(
    "prerendered",
  )
  for (const target of ["deno", "cloudflare", "vercel"] as const) {
    expect(() =>
      generateServerEntry({ target, adapterImport: "./framework.ts", prerenderedPages }),
    ).toThrow(`served by the bun and node targets, not ${target}`)
  }
})

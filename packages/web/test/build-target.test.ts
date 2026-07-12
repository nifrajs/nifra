import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildTarget } from "../src/build.ts"
import { discoverRoutes } from "../src/fs.ts"
import type { RenderAdapter } from "../src/index.ts"
import { createWebApp } from "../src/index.ts"

// #5 end-to-end: `nifra build --target <t>` packages buildClient + buildServer (+ prerender) into one
// dist/. The CLI is a thin wrapper over `buildTarget`; this exercises the engine directly on a tiny app.
// To keep the engine framework-agnostic (the web package can't depend on web-react), the fixture ships
// a STUB adapter + a STUB client module — same approach as render.test.ts. The temp app lives INSIDE the
// workspace so the generated entry's `@nifrajs/web` import resolves via node_modules hoisting.

const WORKSPACE_TMP_BASE = `${import.meta.dir}/.tmp-build-target-`
let projectRoot: string
let routesDir: string

// A one-chunk byte stream — the minimal `renderToStream` an adapter returns (mirrors render.test.ts).
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
  writeFileSync(
    join(routesDir, "index.tsx"),
    "export const prerender = true\nexport default function Home() { return null }\n",
  )
  // The app's framework wiring — exports a stub adapter the generated server entry imports. It emits a
  // fixed marker ("nifra") so the prerendered HTML is assertable without a real UI framework.
  writeFileSync(
    join(projectRoot, "framework.ts"),
    "import { streamOf } from './stub-adapter.ts'\n" +
      "export const adapter = {\n" +
      '  renderToStream: () => streamOf("<p>nifra</p>"),\n' +
      "  hydrationHead: () => '<!--hydration-head-->',\n" +
      "}\n",
  )
  writeFileSync(
    join(projectRoot, "stub-adapter.ts"),
    "export const streamOf = (s) => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(s)); c.close() } })\n",
  )
  // The stub client runtime the client bundle imports (exports `mountRouter`).
  writeFileSync(join(projectRoot, "client-stub.ts"), "export function mountRouter() {}\n")
})
afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true })
})

test("--target cf-pages → _worker.js + _routes.json + /assets bundle [#5]", async () => {
  const outDir = join(projectRoot, "dist")
  const result = await buildTarget("cf-pages", {
    routesDir,
    outDir,
    workDir: join(projectRoot, ".work"),
    clientModule: join(projectRoot, "client-stub.ts"),
    adapterImport: join(projectRoot, "framework.ts"),
  })

  expect(result.target).toBe("cf-pages")
  // The three artifacts the Cloudflare Pages deploy needs.
  expect(existsSync(join(outDir, "_worker.js"))).toBe(true)
  expect(existsSync(join(outDir, "_routes.json"))).toBe(true)
  expect(existsSync(join(outDir, "assets"))).toBe(true)
  // The client entry from the manifest lands under /assets/*.
  expect(result.client.entry).toMatch(/^\/assets\/.*\.js$/)
  const entryFile = join(outDir, "assets", result.client.entry.slice("/assets/".length))
  expect(existsSync(entryFile)).toBe(true)

  // _routes.json excludes the static asset bundle from the worker.
  const routes = JSON.parse(readFileSync(join(outDir, "_routes.json"), "utf8")) as {
    exclude: string[]
  }
  expect(routes.exclude).toContain("/assets/*")

  // The scratch work dir is cleaned up.
  expect(existsSync(join(projectRoot, ".work"))).toBe(false)

  // A size report was computed over the client + worker outputs.
  expect(result.size.chunks.length).toBeGreaterThan(0)
  expect(result.size.totalGzip).toBeGreaterThan(0)
}, 60_000)

test("--target static → prerenders opted-in routes to index.html [#5]", async () => {
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
    clientModule: join(projectRoot, "client-stub.ts"),
    adapterImport: join(projectRoot, "framework.ts"),
    prerenderApp: app,
  })

  expect(result.target).toBe("static")
  expect(existsSync(join(outDir, "index.html"))).toBe(true)
  const html = readFileSync(join(outDir, "index.html"), "utf8")
  expect(html).toContain("nifra")
  // The client bundle is still emitted under /assets for hydration.
  expect(existsSync(join(outDir, "assets"))).toBe(true)
  // Regression guard (static hydration): the emitted HTML must reference the REAL content-hashed client
  // entry, and that file must actually exist under /assets — a placeholder 404s → the page never hydrates.
  expect(result.client.entry).toMatch(/\/_nifra-entry-[A-Za-z0-9]+\.js$/)
  expect(html).toContain(`"${result.client.entry}"`)
  expect(existsSync(join(outDir, result.client.entry.replace(/^\//, "")))).toBe(true)
  // The generated client-entry SOURCE must NOT ship: only the hashed .js belongs in the deploy dir.
  expect(existsSync(join(outDir, "assets", "_nifra-entry.ts"))).toBe(false)
}, 60_000)

test("--target static with no prerenderable route throws a clear error [#5]", async () => {
  // Replace the opted-in route with one that doesn't opt in.
  writeFileSync(join(routesDir, "index.tsx"), "export default function Home() { return null }\n")
  const manifest = discoverRoutes(routesDir)
  const app = (client: { entry: string }) =>
    createWebApp({ adapter: stubAdapter, manifest, clientEntry: client.entry })
  const promise = buildTarget("static", {
    routesDir,
    outDir: join(projectRoot, "dist-empty"),
    workDir: join(projectRoot, ".work-empty"),
    clientModule: join(projectRoot, "client-stub.ts"),
    adapterImport: join(projectRoot, "framework.ts"),
    prerenderApp: app,
  })
  await expect(promise).rejects.toThrow(/no routes were prerendered/)
}, 60_000)

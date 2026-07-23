import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildTargetVite } from "../src/build-vite.ts"

// End-to-end: buildTargetVite assembles a full deploy dir through the SAME orchestrator as the Bun
// buildTarget, only the bundler differs. The `node` target is the cleanest proof - it self-hosts and
// serves its own assets - so the test BUILDS it, RUNS the server, and curls real SSR HTML.

const TMP_BASE = `${import.meta.dir}/.tmp-vite-target-`
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** A minimal but real nifra app: a vanilla adapter (no framework needed to prove the pipeline). */
function scaffoldApp(): { root: string; routesDir: string; outDir: string; workDir: string } {
  const root = mkdtempSync(TMP_BASE)
  dirs.push(root)
  const w = (rel: string, content: string) => {
    const p = join(root, rel)
    mkdirSync(join(p, ".."), { recursive: true })
    writeFileSync(p, content)
  }
  // A tiny hand-rolled adapter that renders a string — enough to exercise SSR end to end without pulling
  // a framework's SSR build into the test.
  w(
    "framework.ts",
    `export const adapter = {
       hydrationHead: () => "",
       renderToStream(chain, props) {
         const html = "<h1 id=page>vite-prod-ssr</h1><p>" + JSON.stringify(props.data ?? null) + "</p>"
         return new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(html)); c.close() } })
       },
     }\n`,
  )
  w(
    "routes/index.tsx",
    `export function loader() { return { hello: "from-loader" } }
     export default function Index() { return null }\n`,
  )
  w("client-stub.ts", "export function mountRouter() {}\n")
  return {
    root,
    routesDir: join(root, "routes"),
    outDir: join(root, "deploy"),
    workDir: join(root, ".work"),
  }
}

test("buildTargetVite('node') emits a runnable deploy dir that SSRs", async () => {
  const { root, routesDir, outDir, workDir } = scaffoldApp()
  const result = await buildTargetVite("node", {
    routesDir,
    outDir,
    workDir,
    clientModule: join(root, "client-stub.ts"),
    adapterImport: join(root, "framework.ts"),
    title: "Vite Prod",
  })

  // Same BuildTargetResult shape as the Bun path.
  expect(result.target).toBe("node")
  expect(result.client.entry).toMatch(/^\/assets\/.*\.js$/)
  expect(result.run).toContain("server.js")

  // The deploy dir has the self-hosting server + the client assets next to it.
  expect(existsSync(join(outDir, "server.js"))).toBe(true)
  expect(existsSync(join(outDir, "assets"))).toBe(true)
  // workDir is cleaned up.
  expect(existsSync(workDir)).toBe(false)

  // RUN it: the generated node server serves the client asset AND SSRs the page.
  const port = 3477
  const proc = Bun.spawn(["bun", join(outDir, "server.js")], {
    env: { ...process.env, PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    let up = false
    for (let i = 0; i < 60; i++) {
      await Bun.sleep(250)
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`)
        if (res.ok) {
          up = true
          const html = await res.text()
          // SSR ran: the adapter's markup + the loader data are both in the document.
          expect(html).toContain("id=page")
          expect(html).toContain("from-loader")
          // The page points at the real hashed client entry.
          expect(html).toContain(result.client.entry)
          break
        }
      } catch {
        // not up yet
      }
    }
    expect(up, "the built node server never came up").toBe(true)

    // The referenced client asset is actually served from disk.
    const assetRes = await fetch(`http://127.0.0.1:${port}${result.client.entry}`)
    expect(assetRes.status).toBe(200)
    expect(assetRes.headers.get("content-type")).toContain("javascript")
  } finally {
    proc.kill()
    await proc.exited
  }
}, 120_000)

test("buildTargetVite('cf-pages') emits _worker.js + _routes.json (edge deploy shape)", async () => {
  const { root, routesDir, outDir, workDir } = scaffoldApp()
  const result = await buildTargetVite("cf-pages", {
    routesDir,
    outDir,
    workDir,
    clientModule: join(root, "client-stub.ts"),
    adapterImport: join(root, "framework.ts"),
  })
  expect(result.target).toBe("cf-pages")
  expect(existsSync(join(outDir, "_worker.js"))).toBe(true)
  expect(existsSync(join(outDir, "_routes.json"))).toBe(true)
  expect(existsSync(join(outDir, "assets"))).toBe(true)
  const routes = JSON.parse(require("node:fs").readFileSync(join(outDir, "_routes.json"), "utf8"))
  // The CDN serves /assets/* directly; everything else falls through to the worker (SSR).
  expect(routes.exclude).toContain("/assets/*")
}, 120_000)

test("buildTargetVite('static') prerenders opted-in routes with no server", async () => {
  const { root, routesDir, outDir, workDir } = scaffoldApp()
  // Opt the index route into prerendering.
  writeFileSync(
    join(routesDir, "index.tsx"),
    `export const prerender = true
     export function loader() { return { hello: "from-loader" } }
     export default function Index() { return null }\n`,
  )
  const { createWebApp } = await import("../src/index.ts")
  const { discoverRoutes } = await import("../src/fs.ts")
  const framework = (await import(join(root, "framework.ts"))) as { adapter: unknown }
  const result = await buildTargetVite("static", {
    routesDir,
    outDir,
    workDir,
    clientModule: join(root, "client-stub.ts"),
    adapterImport: join(root, "framework.ts"),
    prerenderApp: (client) =>
      createWebApp({
        // biome-ignore lint/suspicious/noExplicitAny: test adapter is structurally sufficient
        adapter: framework.adapter as any,
        manifest: discoverRoutes(routesDir),
        clientEntry: client.entry,
      }),
  })
  expect(result.target).toBe("static")
  // The index route prerendered to a static index.html; no server was emitted.
  expect(existsSync(join(outDir, "index.html"))).toBe(true)
  expect(existsSync(join(outDir, "server.js"))).toBe(false)
}, 120_000)

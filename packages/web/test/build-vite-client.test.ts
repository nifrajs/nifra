import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildClientVite } from "../src/build-vite.ts"

// Real `vite build`s. buildClientVite must emit the SAME BuildManifest shape as the Bun buildClient, so
// the shared orchestrator and createWebApp consume it unchanged. Fixtures live inside the workspace so
// `@nifrajs/web/client` resolves via node_modules hoisting.

const TMP_BASE = `${import.meta.dir}/.tmp-vite-client-`
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function scaffold(files: Record<string, string>): { root: string; routesDir: string } {
  const root = mkdtempSync(TMP_BASE)
  dirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel)
    mkdirSync(join(p, ".."), { recursive: true })
    writeFileSync(p, content)
  }
  writeFileSync(join(root, "client-stub.ts"), "export function mountRouter() {}\n")
  return { root, routesDir: join(root, "routes") }
}

const build = (root: string, routesDir: string) =>
  buildClientVite({
    root,
    routesDir,
    outDir: join(root, "dist", "assets"),
    clientModule: join(root, "client-stub.ts"),
    minify: false,
  })

test("emits entry + per-route chunks + CSS, all under the /assets/ public path", async () => {
  const { root, routesDir } = scaffold({
    "routes/_layout.tsx": "export default function Layout() { return null }\n",
    "routes/index.tsx": 'import "../app.css"\nexport default function Index() { return null }\n',
    "routes/about.tsx": "export default function About() { return null }\n",
    "app.css": "body { color: rebeccapurple }\n",
  })
  const manifest = await build(root, routesDir)

  // entry is the bootstrap chunk, content-hashed, under /assets/.
  expect(manifest.entry).toMatch(/^\/assets\/.*\.js$/)
  expect(manifest.assets.length).toBeGreaterThan(0)
  for (const asset of manifest.assets) expect(asset.startsWith("/assets/")).toBe(true)

  // Every route id present, each mapping to at least its own chunk.
  expect(Object.keys(manifest.routes).sort()).toEqual(["about", "index"])
  for (const [id, chunks] of Object.entries(manifest.routes)) {
    expect(chunks.length, `route ${id} has no chunks`).toBeGreaterThan(0)
    for (const c of chunks) expect(c).toMatch(/^\/assets\/.*\.js$/)
  }

  // The CSS the index route imports is in the aggregate AND attributed to the index route.
  expect((manifest.css ?? []).some((u) => u.endsWith(".css"))).toBe(true)
  expect((manifest.routeStyles?.index ?? []).some((u) => u.endsWith(".css"))).toBe(true)
  // about imports no CSS → no styles for it.
  expect(manifest.routeStyles?.about ?? []).toEqual([])
}, 60_000)

test("writes manifest.json to outDir and the real chunk files exist on disk", async () => {
  const { root, routesDir } = scaffold({
    "routes/index.tsx": "export default function Index() { return null }\n",
  })
  const outDir = join(root, "dist", "assets")
  await buildClientVite({
    root,
    routesDir,
    outDir,
    clientModule: join(root, "client-stub.ts"),
    minify: false,
  })
  expect(existsSync(join(outDir, "manifest.json"))).toBe(true)
  // The entry URL maps back to a real emitted file (strip the /assets/ prefix → outDir-relative path).
  const entry = JSON.parse(require("node:fs").readFileSync(join(outDir, "manifest.json"), "utf8"))
    .entry as string
  expect(existsSync(join(outDir, entry.slice("/assets/".length)))).toBe(true)
}, 60_000)

test("a node: builtin in a route fails the Vite client build with the shared guard message", async () => {
  const { root, routesDir } = scaffold({
    "routes/index.tsx":
      'import { randomUUID } from "node:crypto"\nexport const id = randomUUID()\nexport default function Index() { return null }\n',
  })
  const promise = build(root, routesDir)
  await expect(promise).rejects.toThrow(/node:crypto reached the client bundle/)
}, 60_000)

test("same-basename routes get distinct chunks (index.tsx + blog/index.tsx)", async () => {
  const { root, routesDir } = scaffold({
    "routes/index.tsx": "export default function Index() { return null }\n",
    "routes/blog/index.tsx": "export default function BlogIndex() { return null }\n",
  })
  const manifest = await build(root, routesDir)
  const ids = Object.keys(manifest.routes)
  expect(ids.length).toBe(2)
  // The two routes must not collapse onto one chunk — the collision the manifest-key mapping prevents.
  const chunks = ids.map((id) => manifest.routes[id]?.[0])
  expect(new Set(chunks).size).toBe(2)
}, 60_000)

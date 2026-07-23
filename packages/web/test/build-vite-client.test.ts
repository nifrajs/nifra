import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
  expect(existsSync(join(outDir, ".vite"))).toBe(false)
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

test("bakes in PUBLIC_* values without exposing unprefixed secrets", async () => {
  const publicName = "PUBLIC_NIFRA_VITE_VISIBLE"
  const secretName = "NIFRA_VITE_PRIVATE_SECRET"
  const previousPublic = process.env[publicName]
  const previousSecret = process.env[secretName]
  process.env[publicName] = "vite-public-value"
  process.env[secretName] = "vite-private-value"
  try {
    const { root, routesDir } = scaffold({
      "routes/index.tsx": `export const visible = process.env.${publicName}
        export const hidden = process.env.${secretName}
        export default function Index() { return null }\n`,
    })
    const outDir = join(root, "dist", "assets")
    await buildClientVite({
      root,
      routesDir,
      outDir,
      clientModule: join(root, "client-stub.ts"),
      minify: false,
    })
    const js = [...new Bun.Glob("*.js").scanSync({ cwd: outDir })]
      .map((file) => readFileSync(join(outDir, file), "utf8"))
      .join("\n")
    expect(js).toContain("vite-public-value")
    expect(js).not.toContain("vite-private-value")
  } finally {
    if (previousPublic === undefined) delete process.env[publicName]
    else process.env[publicName] = previousPublic
    if (previousSecret === undefined) delete process.env[secretName]
    else process.env[secretName] = previousSecret
  }
}, 60_000)

test("concurrent production and development builds observe their own NODE_ENV", async () => {
  const ambient = process.env.NODE_ENV
  const production = scaffold({
    "routes/index.tsx": "export default function Index() { return null }\n",
  })
  const development = scaffold({
    "routes/index.tsx": "export default function Index() { return null }\n",
  })
  const seen: string[] = []
  const observer = (label: string) => ({
    name: `nifra:test-node-env-${label}`,
    configResolved() {
      seen.push(`${label}:${process.env.NODE_ENV}`)
    },
  })

  await Promise.all([
    buildClientVite({
      root: production.root,
      routesDir: production.routesDir,
      outDir: join(production.root, "dist", "assets"),
      clientModule: join(production.root, "client-stub.ts"),
      vitePlugins: [observer("production")],
    }),
    buildClientVite({
      root: development.root,
      routesDir: development.routesDir,
      outDir: join(development.root, "dist", "assets"),
      clientModule: join(development.root, "client-stub.ts"),
      vitePlugins: [observer("development")],
      minify: false,
    }),
  ])

  expect(seen.sort()).toEqual(["development:development", "production:production"])
  expect(process.env.NODE_ENV).toBe(ambient)
}, 120_000)

import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { discoverRoutes } from "../src/fs.ts"
import { createViteDevServer, type ViteDevServer } from "../src/vite.ts"

const TMP_BASE = `${import.meta.dir}/.tmp-vite-dev-routes-`
let root: string
let routesDir: string
let server: ViteDevServer | undefined

beforeEach(() => {
  root = mkdtempSync(TMP_BASE)
  routesDir = join(root, "routes")
  mkdirSync(routesDir)
  writeFileSync(join(routesDir, "index.tsx"), "export default function Index() { return null }\n")
  writeFileSync(join(root, "client.ts"), "export function mountRouter() {}\n")
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  rmSync(root, { recursive: true, force: true })
})

const page = async (): Promise<string> =>
  (await fetch(`http://127.0.0.1:${server?.port ?? 0}/`)).text()

test("Vite route add and unlink events refresh both manifests without restart", async () => {
  server = await createViteDevServer({
    root,
    routesDir,
    clientModule: join(root, "client.ts"),
    port: 0,
    createApp: () => {
      const ids = discoverRoutes(routesDir)
        .routes.map((route) => route.id)
        .sort()
      return { fetch: () => new Response(ids.join(",")) }
    },
  })
  expect(await page()).toBe("index")

  const about = join(routesDir, "about.tsx")
  writeFileSync(about, "export default function About() { return null }\n")
  for (let i = 0; i < 80 && !(await page()).includes("about"); i++) await Bun.sleep(50)
  expect(await page()).toContain("about")

  rmSync(about)
  for (let i = 0; i < 80 && (await page()).includes("about"); i++) await Bun.sleep(50)
  expect(await page()).not.toContain("about")
}, 60_000)

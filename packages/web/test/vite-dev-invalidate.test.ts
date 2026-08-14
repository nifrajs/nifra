import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createViteDevServer, type ViteDevServer } from "../src/vite.ts"

const TMP_BASE = `${import.meta.dir}/.tmp-vite-dev-invalidate-`
let root: string
let routesDir: string
let sharedFile: string
let server: ViteDevServer | undefined

beforeEach(() => {
  root = mkdtempSync(TMP_BASE)
  routesDir = join(root, "routes")
  mkdirSync(routesDir)
  sharedFile = join(root, "shared.ts")
  // The route imports a shared module and re-exports a value derived from it at module-eval time. A
  // stale SSR graph would keep serving the OLD value after `shared.ts` changes, because the route file
  // itself never changed - which is the transitive-importer staleness this test pins.
  writeFileSync(sharedFile, 'export const MESSAGE = "v1"\n')
  writeFileSync(
    join(routesDir, "index.tsx"),
    'import { MESSAGE } from "../shared.ts"\nexport const marker = MESSAGE\nexport default function Index() { return null }\n',
  )
  writeFileSync(join(root, "client.ts"), "export function mountRouter() {}\n")
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  rmSync(root, { recursive: true, force: true })
})

const page = async (): Promise<string> =>
  (await fetch(`http://127.0.0.1:${server?.port ?? 0}/`)).text()

test("editing a module a route imports refreshes SSR output without touching the route", async () => {
  server = await createViteDevServer({
    root,
    routesDir,
    clientModule: join(root, "client.ts"),
    port: 0,
    createApp: async (_entry, load) => {
      const mod = (await load(join(routesDir, "index.tsx"))) as { marker: string }
      return { fetch: () => new Response(mod.marker) }
    },
  })
  expect(await page()).toBe("v1")

  writeFileSync(sharedFile, 'export const MESSAGE = "v2"\n')
  for (let i = 0; i < 80 && (await page()) !== "v2"; i++) await Bun.sleep(50)
  expect(await page()).toBe("v2")
}, 60_000)

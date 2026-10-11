import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createViteDevServer, type ViteDevServer } from "../src/vite.ts"

// Vite pre-bundles what it finds crawling `index.html`; a nifra dev app has none, so without entries
// every dependency is discovered mid-session and each discovery reloads the page. The dev server
// points the crawl at its generated client entry, which imports every route's frontend module.

let root: string | undefined
let server: ViteDevServer | undefined

afterEach(async () => {
  await server?.stop()
  server = undefined
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

test("the dependency crawl starts at the client entry, which reaches every route", async () => {
  root = mkdtempSync(`${import.meta.dir}/.tmp-vite-dev-optimize-`)
  const routesDir = join(root, "routes")
  mkdirSync(join(routesDir, "users"), { recursive: true })
  writeFileSync(join(routesDir, "index.tsx"), "export default function Index() { return null }\n")
  writeFileSync(
    join(routesDir, "users/[id].tsx"),
    "export default function User() { return null }\n",
  )
  mkdirSync(join(root, "frontend"))
  writeFileSync(join(root, "frontend/client.ts"), "export function mountRouter() {}\n")

  let entries: unknown
  server = await createViteDevServer({
    root,
    routesDir,
    clientModule: join(root, "frontend/client.ts"),
    port: 0,
    plugins: [
      {
        name: "capture-optimize-deps",
        configResolved(config: { optimizeDeps: { entries?: unknown } }) {
          entries = config.optimizeDeps.entries
        },
      },
    ],
    createApp: () => ({ fetch: () => new Response("app") }),
  })

  expect(entries).toEqual([".nifra-vite-entry.tsx"])
  const entry = readFileSync(join(root, ".nifra-vite-entry.tsx"), "utf8")
  expect(entry).toContain("/routes/index.tsx")
  expect(entry).toContain("/routes/users/[id].tsx")
}, 30_000)

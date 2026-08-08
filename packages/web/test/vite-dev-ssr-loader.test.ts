import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ssrModuleLoader } from "../src/index.ts"
import { createViteDevServer, type ViteDevServer } from "../src/vite.ts"

/**
 * The SSR module loader the Vite dev server publishes for ADAPTERS.
 *
 * Route modules already load through Vite's graph; an adapter that has to load a compiled asset of
 * its own on the server (`@nifrajs/web-svelte` and its `Chain.svelte`) has no way to reach that graph
 * without this slot, and the alternatives both fail: a plain `import` hits a runtime with no compiler
 * for the file, and registering a second compiler in the runtime puts two copies of the framework in
 * one component tree. Neither failure is visible until a Svelte app is actually served, which is why
 * the seam itself is covered here.
 */

const TMP_BASE = `${import.meta.dir}/.tmp-vite-ssr-loader-`
let root: string
let routesDir: string
let server: ViteDevServer | undefined

beforeEach(() => {
  root = mkdtempSync(TMP_BASE)
  routesDir = join(root, "routes")
  mkdirSync(routesDir)
  writeFileSync(join(routesDir, "index.tsx"), "export default function Index() { return null }\n")
  writeFileSync(join(root, "client.ts"), "export function mountRouter() {}\n")
  writeFileSync(join(root, "asset.ts"), "export const marker = 'from-vite-graph'\n")
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  rmSync(root, { recursive: true, force: true })
})

test("the dev server publishes its SSR loader, and it is the one route modules use", async () => {
  // No assertion on the slot's state before `start`: it is process-global, and every other dev-server
  // test in this run shares the process. What matters is what the RUNNING server published, which is
  // what the rest of this test pins down; the clearing half is its own test below.
  //
  // Captured from inside `createApp`, which is where an adapter would first reach for it: the app is
  // constructed after the server owns SSR resolution, so the slot has to be set by then, not later.
  let duringCreate: unknown
  let routeLoad: unknown
  server = await createViteDevServer({
    root,
    routesDir,
    clientModule: join(root, "client.ts"),
    port: 0,
    createApp: (_entry, load) => {
      duringCreate = ssrModuleLoader()
      routeLoad = load
      return { fetch: () => new Response("ok") }
    },
  })

  // Identity, not just presence. An adapter loading through a DIFFERENT loader than the routes use is
  // the exact failure this exists to prevent - two graphs, two copies of the framework runtime.
  expect(duringCreate).toBe(routeLoad as typeof duringCreate)

  const loaded = (await ssrModuleLoader()?.(join(root, "asset.ts"))) as { marker: string }
  expect(loaded.marker).toBe("from-vite-graph")
})

test("stopping the server clears the slot", async () => {
  // The slot is process-global, so a stopped server that left its loader behind would hand the next
  // server's adapter a closed graph. Several dev servers in one process is the normal case in tests.
  server = await createViteDevServer({
    root,
    routesDir,
    clientModule: join(root, "client.ts"),
    port: 0,
    createApp: () => ({ fetch: () => new Response("ok") }),
  })
  expect(ssrModuleLoader()).toBeInstanceOf(Function)

  await server.stop()
  server = undefined
  expect(ssrModuleLoader()).toBeUndefined()
})

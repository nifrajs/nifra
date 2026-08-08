import { afterEach, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { svelteBunPlugin } from "../src/plugin.ts"

/**
 * Which `.svelte` compiles carry hot-patching, and which must not.
 *
 * Two separate gates, both easy to get wrong in the direction that only shows up later:
 *
 *   - Phase. HMR wiring belongs to a dev server and must never reach a production bundle.
 *     `if (import.meta.hot)` does not take care of it - `Bun.build` keeps the branch - and it cannot be
 *     a plugin constructor argument either, since an app builds `clientPlugins` once and the same
 *     objects serve both phases. The dev server sets `NIFRA_DEV_HMR`; the compiler reads it per compile.
 *   - Boundary. Svelte's wrapper survives hydration only on the app's own view components. On a route
 *     module or a dependency - the chain members `Chain` enters dynamically or through a snippet - it
 *     desyncs the hydration cursor and the page silently re-renders from scratch. That failure leaves
 *     no error behind, so it is asserted here rather than trusted to review.
 */

type LoadResult = { contents: string; loader: string }
type LoadCb = (args: { path: string }) => Promise<LoadResult> | LoadResult

const ROOT = "/app"
const ROUTES = "/app/routes"

const compile = async (path: string, generate: "dom" | "ssr"): Promise<string> => {
  let load: LoadCb | undefined
  svelteBunPlugin(generate).setup({
    onLoad: (opts: { namespace?: string }, cb: LoadCb) => {
      if (opts.namespace === undefined) load = cb
    },
    onResolve: () => undefined,
  } as never)
  return (await (load as LoadCb)({ path })).contents
}

/**
 * The compiler reads real files, so each case needs one on disk - under a throwaway root, because the
 * boundary being tested is a path predicate and one of the cases is a `node_modules/` file.
 */
const dir = mkdtempSync(join(tmpdir(), "nifra-svelte-hmr-"))

const write = async (relative: string, source: string): Promise<string> => {
  const path = join(dir, relative)
  await Bun.write(path, source)
  return path
}
const SOURCE = `<script>let count = $state(0)</script><button onclick={() => count++}>{count}</button>`

// `$.hmr(` is the wrapper itself; the accept callback is what makes the module self-accepting.
const HMR_MARKERS = ["$.hmr(", "import.meta.hot"]

afterEach(() => {
  delete process.env.NIFRA_DEV_HMR
  delete process.env.NIFRA_DEV_ROOT
  delete process.env.NIFRA_DEV_ROUTES
})

const devServer = (): void => {
  process.env.NIFRA_DEV_HMR = "1"
  process.env.NIFRA_DEV_ROOT = ROOT
  process.env.NIFRA_DEV_ROUTES = ROUTES
}

test("a production client compile emits no HMR wiring", async () => {
  const path = await write("prod.svelte", SOURCE)
  process.env.NIFRA_DEV_ROOT = dir // the boundary alone must not be enough - the phase gate decides
  const code = await compile(path, "dom")
  for (const marker of HMR_MARKERS) expect(code).not.toContain(marker)
})

test("a dev-server client compile of an app view emits the HMR wiring", async () => {
  const path = await write("view.svelte", SOURCE)
  devServer()
  process.env.NIFRA_DEV_ROOT = dir
  const code = await compile(path, "dom")
  for (const marker of HMR_MARKERS) expect(code).toContain(marker)
})

test("the SSR compile never emits HMR wiring, dev server or not", async () => {
  const path = await write("server.svelte", SOURCE)
  devServer()
  process.env.NIFRA_DEV_ROOT = dir
  const code = await compile(path, "ssr")
  for (const marker of HMR_MARKERS) expect(code).not.toContain(marker)
})

test("a route module is not a hot-patch boundary - it reloads instead", async () => {
  const path = await write("routes/index.svelte", SOURCE)
  devServer()
  process.env.NIFRA_DEV_ROOT = dir
  process.env.NIFRA_DEV_ROUTES = `${dir}/routes`
  const code = await compile(path, "dom")
  for (const marker of HMR_MARKERS) expect(code).not.toContain(marker)
})

test("a dependency's own components are never wrapped", async () => {
  const path = await write("node_modules/dep/Chain.svelte", SOURCE)
  devServer()
  process.env.NIFRA_DEV_ROOT = dir
  const code = await compile(path, "dom")
  for (const marker of HMR_MARKERS) expect(code).not.toContain(marker)
})

test("a file outside the app root is never wrapped", async () => {
  const path = await write("view.svelte", SOURCE)
  devServer() // root points elsewhere, so this file is somebody else's
  const code = await compile(path, "dom")
  for (const marker of HMR_MARKERS) expect(code).not.toContain(marker)
})

test("dev mode itself follows the phase, on both halves", async () => {
  const path = await write("dev-shape.svelte", SOURCE)
  // Svelte's dev output carries source locations on the client and calls `push_element` on the
  // server - runtime bookkeeping that only a dev runtime records. Both halves have to agree on the
  // shape, or SSR throws on the first element it renders.
  expect(await compile(path, "dom")).not.toContain("$.add_locations")
  expect(await compile(path, "ssr")).not.toContain("push_element")
  devServer()
  expect(await compile(path, "dom")).toContain("$.add_locations")
  expect(await compile(path, "ssr")).toContain("push_element")
})

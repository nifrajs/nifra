import { afterEach, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { solidBunPlugin } from "../src/index.ts"

/**
 * Hot-patching wiring belongs to a dev server and must never reach a production bundle.
 *
 * `if (import.meta.hot)` does not take care of it: `Bun.build` keeps the branch, so a guarded
 * `solid-refresh` call and its registry ship in production chunks. The phase cannot be a plugin
 * constructor argument either - an app builds `clientPlugins` once in `nifra.config.ts` and the same
 * objects serve both `nifra dev` and `nifra build` - so the dev server sets `NIFRA_DEV_HMR` and the
 * compiler reads it per compile.
 *
 * Solid's registry wraps components where they are DEFINED, so unlike Svelte's, it is not sensitive to
 * how the layout chain reaches them - a route module is as patchable as a view, and both are gated on
 * the phase alone.
 */

type LoadResult = { contents: string }
type LoadCb = (args: { path: string }) => Promise<LoadResult>

const dir = mkdtempSync(join(tmpdir(), "nifra-solid-hmr-"))

const SOURCE = `
import { createSignal } from "solid-js"
export default function Counter() {
  const [n, setN] = createSignal(0)
  return <button onClick={() => setN(n() + 1)}>{n()}</button>
}
`

// The bridge import and the call it feeds are the whole of the emitted wiring.
const REFRESH_MARKERS = ["nifra:solid-hot", "import.meta.hot"]

const compile = async (path: string, generate: "dom" | "ssr"): Promise<string> => {
  let load: LoadCb | undefined
  solidBunPlugin(generate).setup({
    onLoad: (_opts: unknown, cb: LoadCb) => {
      load = cb
    },
    onResolve: () => undefined,
  } as never)
  return (await (load as LoadCb)({ path })).contents
}

const write = async (relative: string, source: string): Promise<string> => {
  const path = join(dir, relative)
  await Bun.write(path, source)
  return path
}

afterEach(() => {
  delete process.env.NIFRA_DEV_HMR
})

test("a production client compile emits no refresh wiring", async () => {
  const path = await write("prod.tsx", SOURCE)
  const code = await compile(path, "dom")
  for (const marker of REFRESH_MARKERS) expect(code).not.toContain(marker)
})

test("a dev-server client compile emits the refresh wiring", async () => {
  const path = await write("dev.tsx", SOURCE)
  process.env.NIFRA_DEV_HMR = "1"
  const code = await compile(path, "dom")
  for (const marker of REFRESH_MARKERS) expect(code).toContain(marker)
  // Rewritten into Bun's dialect: `import.meta.hot` reached only through member expressions the
  // bundler can see, never handed to `solid-refresh` as a value (Bun substitutes a throwing proxy).
  expect(code).toContain("import.meta.hot.accept(")
  expect(code).not.toMatch(/\(\s*"esm"\s*,\s*import\.meta\.hot\s*,/)
})

test("the SSR compile never emits refresh wiring, dev server or not", async () => {
  const path = await write("ssr.tsx", SOURCE)
  process.env.NIFRA_DEV_HMR = "1"
  const code = await compile(path, "ssr")
  for (const marker of REFRESH_MARKERS) expect(code).not.toContain(marker)
})

test("both refresh runtimes resolve from this package, not from the app", async () => {
  // The transform emits `solid-refresh` and `nifra:solid-hot` INTO the app's own files, where a bare
  // specifier resolves against the app - which depends on neither. The plugin pins both, so what the
  // resolvers hand back has to be an absolute path inside this install, not the specifier again.
  process.env.NIFRA_DEV_HMR = "1"
  const resolvers: Array<{ filter: RegExp; cb: () => { path: string } }> = []
  solidBunPlugin("dom").setup({
    onLoad: () => undefined,
    onResolve: (opts: { filter: RegExp }, cb: () => { path: string }) =>
      resolvers.push({ filter: opts.filter, cb }),
  } as never)

  const resolve = (specifier: string): string | undefined =>
    resolvers.find((r) => r.filter.test(specifier))?.cb().path

  const refresh = resolve("solid-refresh")
  expect(refresh).toBeDefined()
  expect(isAbsolute(refresh as string)).toBe(true)
  expect(refresh).toContain("solid-refresh")

  const bridge = resolve("nifra:solid-hot")
  expect(bridge).toBeDefined()
  expect(bridge).toContain("refresh-hot")
  expect(await Bun.file(bridge as string).exists()).toBe(true)
})

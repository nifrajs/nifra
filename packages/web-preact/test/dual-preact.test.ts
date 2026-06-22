import { afterAll, beforeAll, expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { load } from "../src/preact-render.ts"

/**
 * Regression test for the dual-Preact SSR crash (the Preact analogue of the React one): under Bun runtime
 * SSR (`nifra dev` / `nifra start` / `nifra_render`), a STATIC `import "preact-render-to-string"` in the
 * @nifrajs/web-preact adapter binds the `preact` copy nested under the renderer's own node_modules — a
 * DIFFERENT physical `preact` than the consumer app's route components import. `preact-render-to-string`
 * mutates `preact`'s shared `options` global, and `preact/hooks` writes the SAME global; two `preact`
 * copies → two `options` → the renderer walks one while hooks wrote the other → `undefined is not an
 * object (evaluating '…__H')` (the vnode's hook-state list was never set up). The fix
 * (src/preact-render.ts) resolves the renderer from the CONSUMER APP ROOT so it shares the components'
 * `preact`.
 *
 * We prove BOTH directions in a real two-copy install fixture, driving the SSR in a SUBPROCESS whose `cwd`
 * is the fixture app (faithful to runtime SSR — an in-process render shares this test runner's module
 * cache, which masks the bug):
 *   - OLD/static path (control): the renderer's nested `preact` (copy A) against a component using the
 *     app's `preact` (copy B) → the hook-state crash. Documents the bug.
 *   - FIXED path: the REAL `preactAdapter`, which resolves the renderer from the app root so it binds the
 *     app's `preact` (copy B) → matches the component → renders cleanly.
 */

const STORE = join(import.meta.dir, "../../../node_modules/.bun")
const STORE_PREACT = join(STORE, "preact@10.29.2/node_modules/preact") // copy A (what the static import binds)
const STORE_RTS = join(
  STORE,
  "preact-render-to-string@6.7.0+30fcf260fcd9e417/node_modules/preact-render-to-string",
)

// `.tmp-nifra-*` is excluded from the per-file coverage gate (bunfig `**/.tmp-nifra-*/**`).
const TMP_BASE = join(import.meta.dir, ".tmp-nifra-dual-preact-")
let appRoot: string

beforeAll(() => {
  appRoot = mkdtempSync(TMP_BASE)
  const appModules = join(appRoot, "node_modules")
  mkdirSync(appModules, { recursive: true })

  // Copy B: a SECOND PHYSICAL `preact` for the app — a deep copy so its module identity differs from the
  // store copy (copy A) the static import binds. (Symlinking would collapse them back to one identity.)
  const appPreact = join(appModules, "preact")
  cpSync(STORE_PREACT, appPreact, { recursive: true, dereference: true })

  // The app's own `preact-render-to-string`, with its nested `preact` pointed at the app's copy B — this
  // is what the FIX resolves from the app root, so the renderer binds copy B (matching the components).
  const appRts = join(appModules, "preact-render-to-string")
  cpSync(STORE_RTS, appRts, { recursive: true, dereference: true })
  const appRtsModules = join(appRts, "node_modules")
  mkdirSync(appRtsModules, { recursive: true })
  symlinkSync(appPreact, join(appRtsModules, "preact"))
})

afterAll(() => {
  rmSync(appRoot, { recursive: true, force: true })
})

/** Spawn `bun <driver>` with cwd=app fixture, capture stdout+stderr. Mirrors runtime SSR's process isolation. */
async function runDriver(source: string, cwd: string): Promise<string> {
  const file = join(cwd, `driver-${Math.random().toString(36).slice(2)}.tsx`)
  writeFileSync(file, source)
  const proc = Bun.spawn(["bun", file], { cwd, stdout: "pipe", stderr: "pipe" })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return `${out}\n${err}`
}

test("convergence: Bun.resolveSync('preact-render-to-string', appRoot) is the app's copy, binding the app's preact", () => {
  const rts = Bun.resolveSync("preact-render-to-string", appRoot)
  expect(rts.startsWith(join(appRoot, "node_modules", "preact-render-to-string"))).toBe(true)
  // And its transitive `preact` is the app's copy B — the whole point of re-rooting (matches components).
  const preactFromRts = Bun.resolveSync(
    "preact",
    join(appRoot, "node_modules", "preact-render-to-string"),
  )
  expect(preactFromRts.startsWith(join(appRoot, "node_modules", "preact"))).toBe(true)
})

test("OLD static path crashes: store renderer (preact copy A) + app preact copy B component → hook crash", async () => {
  // Control: simulate the pre-fix adapter — render with the STORE's preact-render-to-string (its nested
  // preact = copy A) against a component using the app's preact (copy B, resolved from cwd). The exact
  // mismatch the static import produced. Absolute paths keep the driver deterministic.
  const storeRtsEntry = join(STORE_RTS, "dist/index.mjs")
  const source = `
import { h } from "preact" // app's preact (copy B, resolved from cwd)
import { useState } from "preact/hooks" // copy B's hooks
import { renderToString } from ${JSON.stringify(storeRtsEntry)} // store renderer (binds preact copy A)
function Counter() {
  const [n] = useState(7)
  return h("p", null, "count:" + n)
}
try {
  const html = renderToString(h(Counter, null))
  console.log("RESULT_OK:" + html)
} catch (e) {
  console.log("RESULT_ERR:" + (e instanceof Error ? e.message : String(e)))
}
`
  const output = await runDriver(source, appRoot)
  expect(output).toContain("RESULT_ERR:")
  // The hook-state crash (vnode has no `__H` list because hooks wrote a different preact's options global).
  expect(/__H|undefined is not an object|Cannot read prop/i.test(output)).toBe(true)
})

test("FIXED adapter renders: preactAdapter resolves the renderer from the app root → single preact core", async () => {
  // Drive the REAL `preactAdapter` (src/index.ts → src/preact-render.ts). Its renderToString resolves
  // preact-render-to-string from process.cwd() (the app root), which binds the app's preact (copy B),
  // matching the component. Reverting the fix to the static import would bind copy A → RED (hook crash).
  const adapterEntry = join(import.meta.dir, "../src/index.ts")
  const source = `
import { h } from "preact" // app's preact (copy B, resolved from cwd)
import { useState } from "preact/hooks" // copy B's hooks
import { preactAdapter } from ${JSON.stringify(adapterEntry)}
function Counter() {
  const [n] = useState(7)
  return h("p", null, "count:" + n)
}
try {
  const html = await preactAdapter.renderToString([Counter], { data: null })
  console.log("RESULT_OK:" + html)
} catch (e) {
  console.log("RESULT_ERR:" + (e instanceof Error ? e.message : String(e)))
}
`
  const output = await runDriver(source, appRoot)
  expect(output).toContain("RESULT_OK:")
  expect(output).toContain("count:7")
  expect(/__H|undefined is not an object/i.test(output)).toBe(false)
})

test("load re-roots the renderer via the injected resolver (the Bun-runtime branch)", async () => {
  // Inject a resolver returning the store renderer's absolute entry; `load` must import THAT module,
  // proving the re-root mechanism in-process and deterministically (no machine-layout dependence).
  let askedSpec: string | undefined
  const resolve = (spec: string): string => {
    askedSpec = spec
    return join(STORE_RTS, "dist/index.mjs")
  }
  const mod = await load<{ renderToString: unknown }>("preact-render-to-string", resolve)
  expect(askedSpec).toBe("preact-render-to-string")
  expect(typeof mod.renderToString).toBe("function")
})

test("load falls back to the bundled renderer when the resolver throws (no hard failure)", async () => {
  // A throwing resolver (renderer not at the app root) must NOT crash — it falls through to the static
  // import. Exercised for BOTH subpaths so the stream branch of the fallback is covered too.
  const throwing = (): string => {
    throw new Error("not resolvable from app root")
  }
  const sync = await load<{ renderToString: unknown }>("preact-render-to-string", throwing)
  expect(typeof sync.renderToString).toBe("function")
  const stream = await load<{ renderToReadableStream: unknown }>(
    "preact-render-to-string/stream",
    throwing,
  )
  expect(typeof stream.renderToReadableStream).toBe("function")
})

test("load uses the bundled renderer on a non-Bun host (resolver undefined)", async () => {
  // `resolve === undefined` models Node/Deno/edge: the static import is the only (bundled) path.
  const stream = await load<{ renderToReadableStream: unknown }>(
    "preact-render-to-string/stream",
    undefined,
  )
  expect(typeof stream.renderToReadableStream).toBe("function")
})

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadReactDomServer } from "../src/react-dom-server.ts"

/**
 * Regression test for the dual-React SSR crash: under Bun runtime SSR (`nifra dev` / `nifra start` /
 * `nifra_render`), a STATIC `import "react-dom/server"` in the @nifrajs/web-react adapter is resolved from
 * the ADAPTER's own node_modules — a DIFFERENT physical `react` than the consumer app's route components
 * resolve. Two React cores → two hook dispatchers → "Invalid hook call: mismatching versions of React and
 * the renderer" (or a null `resolveDispatcher().useState`). The fix (src/react-dom-server.ts) resolves
 * `react-dom/server` from the CONSUMER APP ROOT so react-dom shares the components' React.
 *
 * We prove BOTH directions in a real two-copy install fixture, driving the SSR in a SUBPROCESS whose `cwd`
 * is the fixture app (faithful to runtime SSR — an in-process render shares this test runner's module
 * cache, which masks the bug; see packages/cli/test/mcp-render.test.ts:67):
 *   - OLD/static path (control): render-to-string resolved from the ADAPTER side (react-dom@B) against a
 *     component using the app's react@A → the dispatcher-mismatch crash. Documents the bug.
 *   - FIXED path: the REAL `reactAdapter`, which resolves react-dom/server from the app root (react-dom@A)
 *     → matches the component's react@A → renders cleanly.
 */

// Two DISTINCT React copies in the repo store — the dual-install the bug needs (mirror of the manual
// fixture that proved the fix). The app uses copy `B` (19.2.6); the adapter's STATIC `import
// "react-dom/server"` (from packages/web-react/src) resolves to the hoisted copy `A` (19.2.7) — so the
// pre-fix static path mismatches the app on purpose, making the FIXED test genuinely RED if the fix is
// reverted to the static import. The FIXED adapter re-roots react-dom to the app (copy B) → it matches.
const STORE = join(import.meta.dir, "../../../node_modules/.bun")
const APP_REACT = join(STORE, "react@19.2.6/node_modules/react")
const APP_REACT_DOM = join(STORE, "react-dom@19.2.6+d86b59289c1a13ae/node_modules/react-dom")
// Copy A (hoisted at the monorepo root) — what the adapter's bundled/static import resolves to.
const STATIC_REACT_DOM = join(STORE, "react-dom@19.2.7+e14d3f224186685e/node_modules/react-dom")

// `.tmp-nifra-*` is excluded from the per-file coverage gate (bunfig `**/.tmp-nifra-*/**`) — the fixture's
// stub component is rendered, never product code.
const TMP_BASE = join(import.meta.dir, ".tmp-nifra-dual-react-")
let appRoot: string

beforeAll(() => {
  appRoot = mkdtempSync(TMP_BASE)
  // The app root owns react + react-dom copy B (what a real consumer install hoists for THIS app).
  // Symlinks (not copies) keep it cheap; module identity is the linked store path, which differs from the
  // copy the adapter's static import resolves (copy A at the monorepo root).
  const appModules = join(appRoot, "node_modules")
  mkdirSync(appModules, { recursive: true })
  symlinkSync(APP_REACT, join(appModules, "react"))
  symlinkSync(APP_REACT_DOM, join(appModules, "react-dom"))
})

afterAll(() => {
  rmSync(appRoot, { recursive: true, force: true })
})

/** Spawn `bun <driver>` with cwd=app fixture, capture stdout. Mirrors runtime SSR's process isolation. */
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

test("convergence: Bun.resolveSync('react-dom/server', appRoot) is the app's copy (B), not the static copy (A)", () => {
  const resolved = Bun.resolveSync("react-dom/server", appRoot)
  expect(resolved.startsWith(APP_REACT_DOM)).toBe(true)
  expect(resolved.startsWith(STATIC_REACT_DOM)).toBe(false)
})

test("OLD static path crashes: static react-dom (copy A) + app react (copy B) component → hook dispatcher mismatch", async () => {
  // Control: simulate the pre-fix adapter — render with react-dom resolved the way the STATIC import does
  // (copy A, the hoisted monorepo copy) against a component that uses the app's react (copy B, resolved
  // from cwd). This is the exact mismatch the static import produced. We import react-dom/server from copy
  // A's ABSOLUTE path so this driver is deterministic regardless of the test runner's own react.
  const source = `
import { createElement, useState } from "react" // app's react (copy B, resolved from cwd)
import { renderToString } from ${JSON.stringify(join(STATIC_REACT_DOM, "server.bun.js"))} // static react-dom (copy A)
function Counter() {
  const [n] = useState(7)
  return createElement("p", null, "count:" + n)
}
try {
  const html = renderToString(createElement(Counter))
  console.log("RESULT_OK:" + html)
} catch (e) {
  console.log("RESULT_ERR:" + (e instanceof Error ? e.message : String(e)))
}
`
  const output = await runDriver(source, appRoot)
  expect(output).toContain("RESULT_ERR:")
  // The canonical React mismatch message (or its null-dispatcher variant). Either proves two cores.
  expect(/Invalid hook call|mismatching versions|H\.useState|resolveDispatcher/i.test(output)).toBe(
    true,
  )
})

test("FIXED adapter renders: reactAdapter resolves react-dom from the app root → single React core", async () => {
  // Drive the REAL `reactAdapter` (src/index.ts → src/react-dom-server.ts). Its renderToStream resolves
  // react-dom/server from process.cwd() (the app root = react-dom copy B), matching the component's react
  // (copy B). Reverting the fix to the static import would resolve copy A here → RED (mismatch crash).
  const adapterEntry = join(import.meta.dir, "../src/index.ts")
  const source = `
import { createElement, useState } from "react" // app's react (copy B, resolved from cwd)
import { reactAdapter } from ${JSON.stringify(adapterEntry)}
function Counter() {
  const [n] = useState(7)
  return createElement("p", null, "count:" + n)
}
try {
  const stream = await reactAdapter.renderToStream([Counter], { data: null })
  const html = await new Response(stream).text()
  console.log("RESULT_OK:" + html)
} catch (e) {
  console.log("RESULT_ERR:" + (e instanceof Error ? e.message : String(e)))
}
`
  const output = await runDriver(source, appRoot)
  expect(output).toContain("RESULT_OK:")
  expect(output).toContain("count:7")
  expect(/Invalid hook call|mismatching versions/i.test(output)).toBe(false)
})

test("loadReactDomServer re-roots via the injected resolver (the Bun-runtime branch)", async () => {
  // Inject a resolver that returns the app-root copy A's absolute server entry. loadReactDomServer must
  // import THAT module (re-rooting), proving the fix's mechanism in-process and deterministically.
  let askedSpec: string | undefined
  const resolve = (spec: string): string => {
    askedSpec = spec
    return join(STATIC_REACT_DOM, "server.bun.js")
  }
  const mod = await loadReactDomServer(resolve)
  expect(askedSpec).toBe("react-dom/server")
  expect(typeof mod.renderToString).toBe("function")
  expect(typeof mod.renderToReadableStream).toBe("function")
})

test("loadReactDomServer falls back to the bundled copy when the resolver throws (no hard failure)", async () => {
  // A resolver that throws (react-dom not at the app root / unusual layout) must NOT crash — it falls
  // through to the static `import "react-dom/server"`. Covers the catch + fallback branch.
  const throwing = (): string => {
    throw new Error("not resolvable from app root")
  }
  const mod = await loadReactDomServer(throwing)
  expect(typeof mod.renderToString).toBe("function")
  expect(typeof mod.renderToReadableStream).toBe("function")
})

test("loadReactDomServer uses the bundled copy on a non-Bun host (resolver undefined)", async () => {
  // `resolve === undefined` models Node/Deno/edge where there's no Bun.resolveSync: the static import is
  // the only (and correct, bundled+deduped) path.
  const mod = await loadReactDomServer(undefined)
  expect(typeof mod.renderToString).toBe("function")
})

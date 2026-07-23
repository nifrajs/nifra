import { afterAll, beforeAll, expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  assertSingleReactCore,
  bunResolverFn,
  loadReactDomServer,
} from "../src/react-dom-server.ts"

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

// The dual-install the bug needs = TWO DISTINCT React module instances. We make them by COPYING the one
// installed react/react-dom into two separate node_modules trees (`app/` and `static/`): same version,
// different physical paths → Bun loads each as its own core (its own hook dispatcher). This is portable —
// it depends only on the single hoisted copy, not on two versions happening to sit in the store (a clean
// CI install hoists exactly one, so the old "symlink to react@19.2.6 vs @19.2.7" fixture ENOENT'd there).
// The app uses the `app/` copy; the pre-fix adapter's STATIC `react-dom/server` is simulated by importing
// the `static/` copy — a different instance → the mismatch crash. The FIXED adapter re-roots react-dom to
// the app root (the `app/` copy) → it matches → renders. Reverting the fix to a static import → RED.
const SRC_REACT = dirname(Bun.resolveSync("react/package.json", import.meta.dir))
const SRC_REACT_DOM = dirname(Bun.resolveSync("react-dom/package.json", import.meta.dir))

// `.tmp-nifra-*` is excluded from the per-file coverage gate (bunfig `**/.tmp-nifra-*/**`).
const TMP_BASE = join(import.meta.dir, ".tmp-nifra-dual-react-")
let base: string
let appRoot: string
let APP_REACT_DOM: string
let STATIC_REACT_DOM: string

beforeAll(() => {
  base = mkdtempSync(TMP_BASE)
  appRoot = join(base, "app")
  const staticRoot = join(base, "static")
  for (const root of [appRoot, staticRoot]) {
    const nm = join(root, "node_modules")
    mkdirSync(nm, { recursive: true })
    // `dereference` copies through the store symlink to the real files, so each tree is a standalone copy.
    cpSync(SRC_REACT, join(nm, "react"), { recursive: true, dereference: true })
    cpSync(SRC_REACT_DOM, join(nm, "react-dom"), { recursive: true, dereference: true })
  }
  APP_REACT_DOM = join(appRoot, "node_modules", "react-dom")
  STATIC_REACT_DOM = join(staticRoot, "node_modules", "react-dom")
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
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
  // The resolver is also asked for `react` twice by the post-import single-core assertion; returning one
  // stable path for `react` makes both sides equal → the assertion is silent, isolating this test to the
  // re-root behaviour it is about.
  const askedSpecs: string[] = []
  const resolve = (spec: string): string => {
    askedSpecs.push(spec)
    return spec === "react"
      ? join(STATIC_REACT_DOM, "..", "react", "index.js")
      : join(STATIC_REACT_DOM, "server.bun.js")
  }
  const mod = await loadReactDomServer(resolve)
  expect(askedSpecs).toContain("react-dom/server") // it re-rooted react-dom/server, which is the point
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

// --- Fix 2: the dev-boot assertion, proven against a REAL nested-duplicate install ------------------

test("assertSingleReactCore is SILENT on the healthy fixture (react-dom re-rooted, one react)", () => {
  // The re-rooted happy path: react-dom resolved from the app root shares the app's react (siblings under
  // one node_modules). Real Bun.resolveSync, real realpath — no throw.
  const serverPath = Bun.resolveSync("react-dom/server", appRoot)
  const resolve = (spec: string, from: string): string => Bun.resolveSync(spec, from)
  // componentsReact is resolved from process.cwd() inside the function; the runner's cwd is the repo,
  // whose react is the fixture's SOURCE copy. Point react-dom's side at that same copy so they agree.
  const sameReact = (spec: string, from: string): string =>
    spec === "react" ? Bun.resolveSync("react", process.cwd()) : resolve(spec, from)
  expect(() => assertSingleReactCore(serverPath, sameReact)).not.toThrow()
})

test("assertSingleReactCore THROWS with both paths when react-dom nests a different react", () => {
  // The residual duplicate the re-root cannot fix: react-dom is at the app root but carries its OWN nested
  // react, distinct from the one the components import. This is a real install shape (a mis-hoist), built
  // here as actual directories and resolved with the real Bun resolver.
  const dupApp = mkdtempSync(join(import.meta.dir, ".tmp-nifra-nested-react-"))
  try {
    const nm = join(dupApp, "node_modules")
    mkdirSync(nm, { recursive: true })
    cpSync(SRC_REACT, join(nm, "react"), { recursive: true, dereference: true }) // components' react
    cpSync(SRC_REACT_DOM, join(nm, "react-dom"), { recursive: true, dereference: true })
    // react-dom's OWN nested react — a second physical copy, same version, different path.
    cpSync(SRC_REACT, join(nm, "react-dom", "node_modules", "react"), {
      recursive: true,
      dereference: true,
    })

    const serverPath = Bun.resolveSync("react-dom/server", dupApp)
    // Real resolver, but pin the components' side to the app's top-level react (the function reads it from
    // process.cwd(); the fixture is elsewhere, so this stands in for "resolved from the app root").
    const resolve = (spec: string, from: string): string =>
      spec === "react" && !from.includes("react-dom")
        ? Bun.resolveSync("react", dupApp)
        : Bun.resolveSync(spec, from)

    let message = ""
    try {
      assertSingleReactCore(serverPath, resolve)
      throw new Error("expected a duplicate-React throw")
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain("two copies of React")
    expect(message).toContain(join(nm, "react-dom", "node_modules", "react"))
    expect(message).toContain(join(nm, "react"))
  } finally {
    rmSync(dupApp, { recursive: true, force: true })
  }
})

test("NIFRA_SSR_BUNDLED marker disables re-root even when Bun.resolveSync exists (the bun-target bundle fix)", () => {
  // Regression for the `target:"bun"` bundle crash: a Bun bundle keeps `Bun.resolveSync`, so the resolver
  // test alone (this runner IS Bun) would re-root to a DISK react-dom — a 2nd React core → `…H.useRef of
  // null` at SSR. buildServer tags every bundle with this marker; the default resolver must then be
  // `undefined` (→ the static, bundled+deduped import). Without the marker the Bun runtime still re-roots.
  expect(typeof bunResolverFn()).toBe("function") // unbundled Bun runtime: re-root resolver present
  process.env.NIFRA_SSR_BUNDLED = "1"
  try {
    expect(bunResolverFn()).toBeUndefined() // bundle: no re-root → static import path
  } finally {
    delete process.env.NIFRA_SSR_BUNDLED // never leak the marker into sibling tests
  }
  expect(typeof bunResolverFn()).toBe("function") // restored
})

import { expect, test } from "bun:test"
import { assertSingleReactCore } from "../src/react-dom-server.ts"

/**
 * Fix 2 of the module-identity plan: catch the dual-React duplicate on the RESOLVED graph, in dev, loudly.
 *
 * `nifra doctor` sees what is installed; this sees what SSR actually resolved, which is the only thing
 * that can catch a duplicate the two dev pipelines introduce rather than the install. The failure it
 * replaces is `resolveDispatcher().useState is null` thrown from inside react-dom-server - a React
 * internal that names nothing about the two directories that caused it.
 *
 * Pure: both `resolve` and `realpath` are injected, so these run without depending on the machine's
 * node_modules layout. The heavier real-two-copy-install proof lives in dual-react.test.ts.
 */

// A resolver that maps (specifier, from) → path, driven by a table keyed on the `from` directory. Real
// `Bun.resolveSync` resolves `react` differently depending on WHERE it is resolved from, which is the
// whole mechanism; the stub reproduces exactly that.
const resolverFrom = (table: Record<string, string>) => (specifier: string, from: string) => {
  const key = `${specifier}@${from}`
  const hit = table[key]
  if (hit === undefined) throw new Error(`cannot resolve ${key}`)
  return hit
}
const identityRealpath = (p: string): string => p

test("silent when react-dom's react and the components' react are the same copy", () => {
  const resolve = resolverFrom({
    // react-dom/server lives at /app/node_modules/react-dom/server.js → dirname is .../react-dom
    "react@/app/node_modules/react-dom": "/app/node_modules/react/index.js",
    // components resolve react from the app root (process.cwd())
    [`react@${process.cwd()}`]: "/app/node_modules/react/index.js",
  })
  expect(() =>
    assertSingleReactCore("/app/node_modules/react-dom/server.js", resolve, identityRealpath),
  ).not.toThrow()
})

test("throws naming BOTH paths when the two reacts differ", () => {
  const resolve = resolverFrom({
    "react@/app/node_modules/react-dom": "/app/node_modules/react-dom/node_modules/react/index.js",
    [`react@${process.cwd()}`]: "/app/node_modules/react/index.js",
  })
  let message = ""
  try {
    assertSingleReactCore("/app/node_modules/react-dom/server.js", resolve, identityRealpath)
    throw new Error("expected assertSingleReactCore to throw")
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }
  // Both physical paths must be present — they ARE the diagnosis; a message without them is the useless
  // React-internal error this fix exists to replace.
  expect(message).toContain("/app/node_modules/react-dom/node_modules/react/index.js")
  expect(message).toContain("/app/node_modules/react/index.js")
  expect(message).toContain("two copies of React")
  // It says the thing that actually fixes it, and warns off the thing that looks like it should.
  expect(message).toContain("nifra doctor")
  expect(message).toContain("dedupe")
})

test("realpath is applied before comparing (two symlinks to one real copy are NOT a duplicate)", () => {
  // A hoisted install is often reached through a symlink. Comparing the symlink paths would false-positive
  // on every symlinked layout; comparing realpaths is the whole point.
  const resolve = resolverFrom({
    "react@/app/node_modules/react-dom": "/app/node_modules/react/index.js",
    [`react@${process.cwd()}`]: "/store/react@19/index.js",
  })
  const realpath = (p: string): string =>
    p === "/app/node_modules/react/index.js" || p === "/store/react@19/index.js"
      ? "/store/react@19/REAL/index.js"
      : p
  expect(() =>
    assertSingleReactCore("/app/node_modules/react-dom/server.js", resolve, realpath),
  ).not.toThrow()
})

test("never manufactures a failure when a side cannot be resolved", () => {
  // A resolver that cannot answer is not evidence of a duplicate — throwing here would break SSR on a
  // layout that was actually fine.
  const resolve = resolverFrom({
    // only the components' side resolves; the react-dom side is missing
    [`react@${process.cwd()}`]: "/app/node_modules/react/index.js",
  })
  expect(() =>
    assertSingleReactCore("/app/node_modules/react-dom/server.js", resolve, identityRealpath),
  ).not.toThrow()
})

import { expect, test } from "bun:test"
import type { BunPlugin } from "bun"
import { preactDedupePlugin, reactDedupePlugin } from "../src/build.ts"

/** Drive a dedupe plugin's `onResolve` registrations through a minimal stub builder, returning a lookup
 * from specifier → pinned path (or undefined when no handler matches). Shared by the react/preact cases. */
function collectPins(plugin: BunPlugin): {
  pinned: (spec: string) => string | undefined
  matches: (spec: string) => boolean
} {
  const handlers: Array<{ filter: RegExp; cb: () => { path: string } }> = []
  const buildStub = {
    onResolve: (opts: { filter: RegExp }, cb: () => { path: string }) => {
      handlers.push({ filter: opts.filter, cb })
    },
  }
  // setup's real param is Bun's PluginBuilder; this unit only exercises onResolve, so a minimal stub is
  // enough — the cast is scoped to the stub's known shape.
  ;(plugin.setup as unknown as (b: typeof buildStub) => unknown)(buildStub)
  return {
    pinned: (spec) => handlers.find((h) => h.filter.test(spec))?.cb().path,
    matches: (spec) => handlers.some((h) => h.filter.test(spec)),
  }
}

// A `file:`-linked package can ship its own `react`, so the bundle gets two React cores → SSR
// `null is not an object (… useState)` (the second dispatcher is null). reactDedupePlugin must pin
// react + its JSX runtimes to ONE resolved copy, and must NOT touch same-prefix specifiers.
test("reactDedupePlugin pins react + jsx runtimes to one copy, leaves react-dom/react-* alone", () => {
  const plugin: BunPlugin = reactDedupePlugin(process.cwd())
  const { pinned, matches } = collectPins(plugin)

  // react core (where the dispatcher lives) pins to the single resolved path
  expect(pinned("react")).toBe(Bun.resolveSync("react", process.cwd()))
  // JSX runtimes pin too, so the transform's React is the same copy
  expect(pinned("react/jsx-runtime")).toBe(Bun.resolveSync("react/jsx-runtime", process.cwd()))

  // exact-match only — same-prefix specifiers must NOT be pinned (react-dom keeps its own conditions;
  // a third-party react-router must resolve normally)
  expect(matches("react-dom")).toBe(false)
  expect(matches("react-dom/server")).toBe(false)
  expect(matches("react-router")).toBe(false)
})

// `examples/web-preact` is the nearest dir where `preact` resolves inside the nifra tree (it isn't a dep
// of @nifrajs/web itself). The plugin pins to whatever `from` resolves — so we assert against the same.
const PREACT_FROM = `${import.meta.dir}/../../../examples/web-preact`

test("preactDedupePlugin pins preact + hooks/compat/jsx to one copy, leaves preact-render-to-string alone", () => {
  const plugin: BunPlugin = preactDedupePlugin(PREACT_FROM)
  const { pinned, matches } = collectPins(plugin)

  // preact core (where the `options` global the renderer + hooks share lives) pins to one resolved path
  expect(pinned("preact")).toBe(Bun.resolveSync("preact", PREACT_FROM))
  // hooks must be the SAME copy — they register onto preact core's `options`; a split copy is the bug
  expect(pinned("preact/hooks")).toBe(Bun.resolveSync("preact/hooks", PREACT_FROM))
  expect(pinned("preact/compat")).toBe(Bun.resolveSync("preact/compat", PREACT_FROM))

  // exact-match only — the renderer keeps its own resolution (it transitively binds the pinned `preact`),
  // and same-prefix third-party packages must resolve normally
  expect(matches("preact-render-to-string")).toBe(false)
  expect(matches("preact-render-to-string/stream")).toBe(false)
  expect(matches("preact-iso")).toBe(false)
})

test("preactDedupePlugin is a no-op when preact is not resolvable (skips, never throws)", () => {
  // A dir with no preact in any ancestor node_modules: every spec resolution throws → no handlers pinned.
  const plugin: BunPlugin = preactDedupePlugin("/")
  const { matches } = collectPins(plugin)
  expect(matches("preact")).toBe(false)
})

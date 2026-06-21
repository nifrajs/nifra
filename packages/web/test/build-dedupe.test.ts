import { expect, test } from "bun:test"
import type { BunPlugin } from "bun"
import { reactDedupePlugin } from "../src/build.ts"

// A `file:`-linked package can ship its own `react`, so the bundle gets two React cores → SSR
// `null is not an object (… useState)` (the second dispatcher is null). reactDedupePlugin must pin
// react + its JSX runtimes to ONE resolved copy, and must NOT touch same-prefix specifiers.
test("reactDedupePlugin pins react + jsx runtimes to one copy, leaves react-dom/react-* alone", () => {
  const handlers: Array<{ filter: RegExp; cb: () => { path: string } }> = []
  const buildStub = {
    onResolve: (opts: { filter: RegExp }, cb: () => { path: string }) => {
      handlers.push({ filter: opts.filter, cb })
    },
  }
  const plugin: BunPlugin = reactDedupePlugin(process.cwd())
  // setup's real param is Bun's PluginBuilder; this unit only exercises onResolve, so a minimal stub
  // is enough — the cast is scoped to the stub's known shape.
  ;(plugin.setup as unknown as (b: typeof buildStub) => unknown)(buildStub)

  const pinned = (spec: string): string | undefined =>
    handlers.find((h) => h.filter.test(spec))?.cb().path

  // react core (where the dispatcher lives) pins to the single resolved path
  expect(pinned("react")).toBe(Bun.resolveSync("react", process.cwd()))
  // JSX runtimes pin too, so the transform's React is the same copy
  expect(pinned("react/jsx-runtime")).toBe(Bun.resolveSync("react/jsx-runtime", process.cwd()))

  // exact-match only — same-prefix specifiers must NOT be pinned (react-dom keeps its own conditions;
  // a third-party react-router must resolve normally)
  expect(handlers.some((h) => h.filter.test("react-dom"))).toBe(false)
  expect(handlers.some((h) => h.filter.test("react-dom/server"))).toBe(false)
  expect(handlers.some((h) => h.filter.test("react-router"))).toBe(false)
})

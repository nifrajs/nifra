import { expect, test } from "bun:test"
import { generateClientEntry, type Manifest } from "../src/index.ts"

const manifest = (): Manifest => ({
  routes: [
    {
      id: "index",
      pattern: "/",
      layoutIds: [],
      file: "index.tsx",
      load: async () => ({ default: "x" }),
    },
  ],
  layouts: {},
})

test("the bootstrap refuses a clientModule that does not export mountRouter", () => {
  const src = generateClientEntry(manifest(), {
    clientModule: "some-ui-kit/entry",
    resolve: (f) => `./${f}`,
  })
  // A specifier is resolved by the bundler, not the type system, so nothing upstream can check this.
  expect(src).toContain('typeof mountRouter !== "function"')
  // The message must name the module and the missing export — the failure it replaces was
  // "mountRouter is not a function" from inside a bundled chunk, naming neither.
  expect(src).toContain("some-ui-kit/entry")
  expect(src).toContain("mountRouter")
  // And it must name the actual trap, since a self-executing entry builds cleanly and silently no-ops.
  expect(src).toContain("self-executing entry")
})

test("the guard runs before the router is mounted, not after", () => {
  const src = generateClientEntry(manifest(), {
    clientModule: "@nifrajs/web-react/client",
    resolve: (f) => `./${f}`,
  })
  expect(src.indexOf('typeof mountRouter !== "function"')).toBeLessThan(
    src.indexOf("mountRouter({"),
  )
})

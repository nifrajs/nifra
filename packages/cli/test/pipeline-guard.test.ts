import { expect, test } from "bun:test"
import { checkPipelineSeparation, checkPipelineSlot } from "../src/pipeline-guard.ts"

const vitePlugin = (name: string) => ({ name, transform: () => null })
const rollupResolver = (name: string) => ({ name, resolveId: () => null })
const bunPlugin = (name: string) => ({ name, setup: () => {} })

test("a Vite plugin in a Bun slot is caught", () => {
  // The silent failure this exists for: Bun.build has no `transform` hook, so it accepts the plugin
  // and simply never calls it. The build succeeds and the transform never runs.
  const found = checkPipelineSlot("clientPlugins", [bunPlugin("vue"), vitePlugin("svgr")])
  expect(found).toHaveLength(1)
  expect(found[0]?.plugin).toBe("svgr")
  expect(found[0]?.actual).toBe("vite")
  expect(found[0]?.expected).toBe("bun")
  expect(found[0]?.fix).toContain("silently does not run")
  expect(found[0]?.fix).toContain("vitePlugins")
})

test("a Bun plugin in the Vite slot is caught", () => {
  const found = checkPipelineSlot("vitePlugins", [bunPlugin("scss")])
  expect(found).toHaveLength(1)
  expect(found[0]?.actual).toBe("bun")
  expect(found[0]?.fix).toContain("clientPlugins")
})

test("correctly placed plugins produce nothing", () => {
  expect(
    checkPipelineSeparation({
      vitePlugins: [vitePlugin("react"), rollupResolver("alias")],
      clientPlugins: [bunPlugin("vue-dom")],
      serverPlugins: [bunPlugin("vue-ssr")],
    }),
  ).toEqual([])
})

test("a plugin whose shape says nothing is left alone", () => {
  // A guard that fires on correct config is a guard people turn off. Anything not clearly one shape
  // or the other is not guessed at.
  expect(checkPipelineSlot("clientPlugins", [{ name: "opaque" }, {}, null, "string"])).toEqual([])
})

test("setup wins when a plugin carries both shapes", () => {
  // Bun dispatches on `setup` and nothing else, so its presence is decisive — a plugin exposing both
  // is a Bun plugin that happens to have a `transform` helper, not a Vite plugin.
  expect(
    checkPipelineSlot("clientPlugins", [
      { name: "hybrid", setup: () => {}, transform: () => null },
    ]),
  ).toEqual([])
  const inVite = checkPipelineSlot("vitePlugins", [
    { name: "hybrid", setup: () => {}, transform: () => null },
  ])
  expect(inVite).toHaveLength(1)
  expect(inVite[0]?.actual).toBe("bun")
})

test("an unnamed plugin is identified by slot and position", () => {
  const found = checkPipelineSlot("serverPlugins", [{ transform: () => null }])
  expect(found[0]?.plugin).toBe("serverPlugins[0]")
})

test("every Rollup hook shape is recognised", () => {
  for (const hook of ["resolveId", "load", "transform", "config", "transformIndexHtml"]) {
    const found = checkPipelineSlot("clientPlugins", [{ name: hook, [hook]: () => null }])
    expect(found).toHaveLength(1)
  }
})

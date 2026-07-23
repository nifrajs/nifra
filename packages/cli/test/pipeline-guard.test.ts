import { expect, test } from "bun:test"
import {
  checkPipelineSeparation,
  checkPipelineSlot,
  chooseBuildPipeline,
} from "../src/pipeline-guard.ts"

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

// ---------------------------------------------------------------------------------------------------
// chooseBuildPipeline — the PHASE-crossing half of the same problem.
//
// The slot guard above catches a plugin in the wrong slot. It cannot catch a plugin in the right slot
// whose pipeline never runs: `nifra dev` is Vite, `nifra build` defaults to Bun, and the Bun build reads
// clientPlugins/serverPlugins only. So an app whose transforms are all `vitePlugins` gets them in dev and
// silently loses them in production - a build that succeeds with the work omitted, which is exactly the
// outcome the slot guard refuses to allow.
// ---------------------------------------------------------------------------------------------------

test("an app with no plugins keeps the fast Bun default", () => {
  const decision = chooseBuildPipeline({})
  expect(decision.pipeline).toBe("bun")
  // Nothing was overridden, so nothing is announced.
  expect(decision.reason).toBeUndefined()
})

test("an app whose only transforms are vitePlugins builds with Vite, and says why", () => {
  const decision = chooseBuildPipeline({ vitePlugins: [vitePlugin("svgr")] })
  expect(decision.pipeline).toBe("vite")
  expect(decision.reason).toContain("svgr")
  expect(decision.reason).toContain("vitePlugins")
})

test("an app declaring BOTH pipelines keeps the Bun default", () => {
  // Declaring Bun plugins alongside is the author supplying the production equivalent on purpose:
  // nothing is dropped, so there is no reason to give up the faster default.
  const decision = chooseBuildPipeline({
    vitePlugins: [vitePlugin("svgr")],
    clientPlugins: [bunPlugin("svgr-bun")],
  })
  expect(decision.pipeline).toBe("bun")
  expect(decision.reason).toBeUndefined()
})

test("--vite forces Vite even with nothing to transform", () => {
  expect(chooseBuildPipeline({}, "vite").pipeline).toBe("vite")
})

test("--bun is refused when it would drop the app's only transforms", () => {
  expect(() => chooseBuildPipeline({ vitePlugins: [vitePlugin("svgr")] }, "bun")).toThrow(
    /would silently drop this app's only transforms/,
  )
  // The message names the plugins, so the fix does not require guessing which ones.
  expect(() => chooseBuildPipeline({ vitePlugins: [vitePlugin("svgr")] }, "bun")).toThrow(/svgr/)
})

test("--bun is allowed when the app supplied Bun equivalents", () => {
  expect(
    chooseBuildPipeline(
      { vitePlugins: [vitePlugin("svgr")], serverPlugins: [bunPlugin("svgr-bun")] },
      "bun",
    ).pipeline,
  ).toBe("bun")
})

test("an unnamed vite plugin still produces an actionable message", () => {
  const decision = chooseBuildPipeline({ vitePlugins: [{ transform: () => null }] })
  expect(decision.reason).toContain("vitePlugins[0]")
})

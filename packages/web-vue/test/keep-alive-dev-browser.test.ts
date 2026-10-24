import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { dirname, join, resolve } from "node:path"
import { installedEngines, keepListTwo, openPage } from "../../web/test/keep-alive-browser.ts"
import { type DevApp, keptPages, serveDev } from "../../web/test/keep-alive-dev.ts"

const chromium = (await installedEngines()).find((engine) => engine.name === "chromium")
// Vite and its Vue plugin are devDependencies of @nifrajs/web, which this fixture does not resolve through.
const web = resolve(import.meta.dir, "../../web")
const vuePlugin = Bun.resolveSync("@vitejs/plugin-vue", web)
const vite = dirname(Bun.resolveSync("vite/package.json", web))
const CONFIG = [
  'import { vueBunPlugin } from "@nifrajs/web-vue/plugin"',
  `import vue from ${JSON.stringify(vuePlugin)}`,
  'import { vueAdapter } from "@nifrajs/web-vue"',
  "export const adapter = vueAdapter",
  'export const clientModule = "@nifrajs/web-vue/client"',
  "export const vitePlugins = [vue()]",
  'export const clientPlugins = [vueBunPlugin("dom")]',
  'export const serverPlugins = [vueBunPlugin("ssr")]',
  "export const define = {",
  '  __VUE_OPTIONS_API__: "true",',
  '  __VUE_PROD_DEVTOOLS__: "false",',
  '  __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",',
  "}",
].join("\n")

for (const pipeline of ["vite", "bun"] as const) {
  describe(`keep-alive in Vue under nifra dev (${pipeline})`, () => {
    let app: DevApp | undefined
    beforeAll(async () => {
      if (chromium === undefined) return
      app = await serveDev({
        fixture: join(import.meta.dir, "fixtures/keep-alive"),
        under: import.meta.dir,
        config: CONFIG,
        pipeline,
        links: { vite },
      })
    }, 90_000)
    afterAll(async () => {
      await app?.stop()
    })

    test.skipIf(chromium === undefined)(
      "lists kept pages for devtools, with the elements each renders",
      async () => {
        if (chromium === undefined || app === undefined) throw new Error("[test] no server")
        const browser = await chromium.launch()
        try {
          const { page, problems } = await openPage(browser)
          await keepListTwo(page, app.origin)
          expect(await keptPages(page)).toEqual([
            expect.objectContaining({ path: "/list/2", nodes: expect.any(Number) }),
          ])
          expect(problems.filter((problem) => !problem.includes("NIFRA_KEEPALIVE"))).toEqual([])
          await page.close()
        } finally {
          await browser.close()
        }
      },
      60_000,
    )
  })
}

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
  assertDirectChildCssDiagnostic,
  installedEngines,
  openPage,
} from "../../web/test/keep-alive-browser.ts"
import { type DevApp, keptPages, serveDev } from "../../web/test/keep-alive-dev.ts"

const chromium = (await installedEngines()).find((engine) => engine.name === "chromium")
const CONFIG = [
  'import { reactAdapter } from "@nifrajs/web-react"',
  "export const adapter = reactAdapter",
  'export const clientModule = "@nifrajs/web-react/client"',
].join("\n")

for (const pipeline of ["vite", "bun"] as const) {
  describe(`keep-alive in React under nifra dev (${pipeline})`, () => {
    let app: DevApp | undefined
    beforeAll(async () => {
      if (chromium === undefined) return
      app = await serveDev({
        fixture: join(import.meta.dir, "fixtures/keep-alive"),
        under: import.meta.dir,
        config: CONFIG,
        pipeline,
      })
    }, 90_000)
    afterAll(async () => {
      await app?.stop()
    })

    test.skipIf(chromium === undefined)(
      "lists kept pages for devtools and reports a direct-child selector",
      async () => {
        if (chromium === undefined || app === undefined) throw new Error("[test] no server")
        const browser = await chromium.launch()
        try {
          const { page, problems } = await openPage(browser)
          await assertDirectChildCssDiagnostic(page, problems, app.origin)
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

import { afterAll, beforeAll, describe, test } from "bun:test"
import { join } from "node:path"
import { serveApp } from "../../web/test/keep-alive-app.ts"
import {
  assertBranchLayouts,
  assertDirectChildCssDiagnostic,
  assertIdentityDrops,
  assertKeepAliveMatrix,
  assertRestoreBeforeData,
  assertUnkeptPageHydrates,
  installedEngines,
  openPage,
} from "../../web/test/keep-alive-browser.ts"
import { reactAdapter } from "../src/index.ts"

const appDir = join(import.meta.dir, "fixtures/keep-alive")
const engines = await installedEngines()
let production: Awaited<ReturnType<typeof serveApp>> | undefined
let development: Awaited<ReturnType<typeof serveApp>> | undefined
beforeAll(async () => {
  if (engines.length === 0) return
  const options = { appDir, adapter: reactAdapter, clientModule: "@nifrajs/web-react/client" }
  production = await serveApp(options)
  development = await serveApp({ ...options, mode: "development" })
}, 60_000)
afterAll(() => {
  production?.stop()
  development?.stop()
})

const app = (served: typeof production): NonNullable<typeof production> => {
  if (served === undefined) throw new Error("[test] no app")
  return served
}

for (const engine of engines) {
  describe(`keep-alive in React, ${engine.name}`, () => {
    let browser: Awaited<ReturnType<typeof engine.launch>> | undefined
    beforeAll(async () => {
      browser = await engine.launch()
    }, 60_000)
    afterAll(async () => {
      await browser?.close()
    }, 30_000)
    const open = async () => {
      if (browser === undefined) throw new Error("[test] no browser")
      return openPage(browser)
    }

    test("a kept page comes back with its state, the element the server rendered", async () => {
      const { page, problems } = await open()
      await assertKeepAliveMatrix(page, problems, app(production).url)
      await page.close()
    }, 30_000)

    test("a development build hydrates the kept page without a mismatch", async () => {
      const { page, problems } = await open()
      await assertKeepAliveMatrix(page, problems, app(development).url)
      await page.close()
    }, 30_000)

    test("a page that does not keep alive hydrates in a keep-alive app", async () => {
      const { page, problems } = await open()
      await assertUnkeptPageHydrates(page, problems, app(development).url)
      await page.close()
    }, 30_000)

    test("a restore shows the kept page before its data revalidates", async () => {
      const { page, problems } = await open()
      await assertRestoreBeforeData(page, problems, app(production))
      await page.close()
    }, 30_000)

    test("a page keeps the state of a layout the next page does not have", async () => {
      const { page, problems } = await open()
      await assertBranchLayouts(page, problems, app(production).url)
      await page.close()
    }, 30_000)

    test("a sign-in or sign-out drops kept pages, in this tab and the others", async () => {
      if (browser === undefined) throw new Error("[test] no browser")
      await assertIdentityDrops(browser, app(production).url)
    }, 30_000)

    test("a development build reports CSS the slot wrappers stop matching", async () => {
      const { page, problems } = await open()
      await assertDirectChildCssDiagnostic(page, problems, app(development).url)
      await page.close()
    }, 30_000)
  })
}

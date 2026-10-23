import { afterAll, beforeAll, describe, test } from "bun:test"
import { join } from "node:path"
import { HOLD_PATH, RELEASE_PATH } from "../../web/test/keep-alive-app.ts"
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

const engines = await installedEngines()

interface Served {
  readonly url: string
  readonly holdData: () => Promise<() => Promise<Response>>
  readonly stop: () => void
}
const serve = async (mode: "production" | "development"): Promise<Served> => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "keep-alive-server.ts"), mode], {
    stdout: "pipe",
    stderr: "inherit",
  })
  const reader = child.stdout.getReader()
  let text = ""
  while (!text.includes("\n")) {
    const { value, done } = await reader.read()
    if (done) throw new Error(`[test] the keep-alive server exited: ${text}`)
    text += new TextDecoder().decode(value)
  }
  reader.releaseLock()
  const { url } = JSON.parse(text.slice(0, text.indexOf("\n"))) as { url: string }
  return {
    url,
    holdData: async () => {
      await fetch(`${url}${HOLD_PATH}`)
      return () => fetch(`${url}${RELEASE_PATH}`)
    },
    stop: () => child.kill(),
  }
}

let production: Served | undefined
let development: Served | undefined
beforeAll(async () => {
  if (engines.length === 0) return
  ;[production, development] = await Promise.all([serve("production"), serve("development")])
}, 60_000)
afterAll(() => {
  production?.stop()
  development?.stop()
})

const app = (served: Served | undefined): Served => {
  if (served === undefined) throw new Error("[test] no app")
  return served
}

for (const engine of engines) {
  describe(`keep-alive in Svelte, ${engine.name}`, () => {
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

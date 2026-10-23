import { afterAll, beforeAll, expect, test } from "bun:test"
import { join } from "node:path"
import {
  CHROME_LAUNCH_TIMEOUT_MS,
  type ChromePage,
  findChrome,
  launchChrome,
} from "../../cli/test/headless-chrome.ts"
import { serveFixture } from "../../web/test/share-browser.ts"
import { preactAdapter } from "../src/index.ts"
import { Layout, Nested, Page } from "./fixtures/clone-chain.ts"

const chrome = findChrome()
if (chrome === undefined && process.env.CI !== undefined)
  throw new Error("clone-browser needs Chrome")
let page: ChromePage | undefined
beforeAll(async () => {
  if (chrome !== undefined) page = await launchChrome(chrome)
}, CHROME_LAUNCH_TIMEOUT_MS)
afterAll(async () => page?.close(), 30_000)

for (const nested of [false, true]) {
  test.skipIf(chrome === undefined)(
    `layout cloneElement overrides survive ${nested ? "nested layouts" : "hydration"}`,
    async () => {
      if (page === undefined) throw new Error("[test] no browser")
      const text = nested ? "from-layout/nested" : "from-layout"
      const markup = await preactAdapter.renderToString?.(
        nested ? [Layout, Nested, Page] : [Layout, Page],
        { data: null, params: {}, path: "/page", search: {}, pending: false },
      )
      expect(markup).toContain(text)
      const fixture = await serveFixture({
        entry: join(import.meta.dir, "fixtures/clone-client.ts"),
        markup: markup ?? "",
      })
      try {
        const errorAt = page.errors.length
        await page.goto(`${fixture.url}${nested ? "?nested" : ""}`)
        await page.evaluate("new Promise(resolve => setTimeout(resolve, 100))")
        expect(await page.evaluate("document.getElementById('result').textContent")).toBe(text)
        await page.evaluate("fixture.invalidate()")
        await page.evaluate("new Promise(resolve => setTimeout(resolve, 100))")
        expect(await page.evaluate("document.getElementById('result').textContent")).toBe(text)
        expect(page.errors.slice(errorAt)).toEqual([])
      } finally {
        fixture.stop()
      }
    },
    30_000,
  )
}

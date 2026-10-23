import { afterAll, beforeAll, expect, test } from "bun:test"
import { join } from "node:path"
import {
  CHROME_LAUNCH_TIMEOUT_MS,
  type ChromePage,
  findChrome,
  launchChrome,
} from "../../cli/test/headless-chrome.ts"
import { serveFixture } from "../../web/test/share-browser.ts"
import { svelteBunPlugin } from "../src/plugin.ts"

/**
 * A reload of a Svelte page in a real browser: the router shares the reloaded data and the Router
 * derives `data` with an identity check, so an effect on `data`, or on a row the reload did not change,
 * does not re-run. Skipped without a Chrome locally; CI must have one.
 */
const chrome = findChrome()
if (chrome === undefined && process.env.CI !== undefined) {
  throw new Error("share-browser needs Chrome in CI: set NIFRA_TEST_CHROME to its binary")
}

let page: ChromePage | undefined
let fixture: Awaited<ReturnType<typeof serveFixture>> | undefined
beforeAll(async () => {
  if (chrome === undefined) return
  fixture = await serveFixture({
    entry: join(import.meta.dir, "fixtures/share-list.ts"),
    plugins: [svelteBunPlugin("dom")],
  })
  page = await launchChrome(chrome)
}, CHROME_LAUNCH_TIMEOUT_MS)
afterAll(async () => {
  fixture?.stop()
  await page?.close()
}, 30_000)

const open = async (query = ""): Promise<ChromePage> => {
  if (page === undefined || fixture === undefined) throw new Error("[test] no browser")
  await page.goto(`${fixture.url}${query}`)
  await page.waitFor("window.fixture?.ready && document.querySelectorAll('li').length === 20")
  return page
}
// Effects run after a microtask flush; a macrotask is past it.
const settled = "new Promise((resolve) => setTimeout(resolve))"

test.skipIf(chrome === undefined)(
  "an unchanged reload re-runs no effect on data or on a row",
  async () => {
    const p = await open()
    await p.evaluate(settled)
    expect(await p.evaluate("({ ...fixture.counts })")).toEqual({ rows: 20, effects: 1 })
    await p.evaluate("fixture.invalidate()")
    await p.evaluate(settled)
    expect(await p.evaluate("({ ...fixture.counts })")).toEqual({ rows: 20, effects: 1 })

    await p.evaluate(`fixture.relabel({ 5: "changed" }); fixture.invalidate()`)
    await p.evaluate(settled)
    expect(await p.evaluate("({ ...fixture.counts })")).toEqual({ rows: 21, effects: 2 })
    expect(await p.evaluate<string>(`document.querySelector('li[data-id="5"]').textContent`)).toBe(
      "changed",
    )
    expect(p.errors).toEqual([])
  },
  30_000,
)

test.skipIf(chrome === undefined)(
  "a route that opts out with shareData = false re-runs every row's effect",
  async () => {
    const p = await open("?share=0")
    await p.evaluate(settled)
    await p.evaluate("fixture.invalidate()")
    await p.evaluate(settled)
    expect(await p.evaluate("({ ...fixture.counts })")).toEqual({ rows: 40, effects: 2 })
    expect(p.errors).toEqual([])
  },
  30_000,
)

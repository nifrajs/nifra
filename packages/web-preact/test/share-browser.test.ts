import { afterAll, beforeAll, expect, test } from "bun:test"
import { join } from "node:path"
import {
  CHROME_LAUNCH_TIMEOUT_MS,
  type ChromePage,
  findChrome,
  launchChrome,
} from "../../cli/test/headless-chrome.ts"
import { listData, serveFixture } from "../../web/test/share-browser.ts"
import { preactAdapter } from "../src/index.ts"
import { Layout, Page } from "./fixtures/share-chain.ts"

/**
 * A reload of a server-rendered Preact page in a real browser: the router shares the reloaded data and
 * `mountRouter` renders each level of the chain memoized on its own props, so an unchanged reload
 * re-renders neither the layout nor a row, only the page for its `pending` flag. Skipped without a
 * Chrome locally; CI must have one.
 */
const chrome = findChrome()
if (chrome === undefined && process.env.CI !== undefined) {
  throw new Error("share-browser needs Chrome in CI: set NIFRA_TEST_CHROME to its binary")
}

let page: ChromePage | undefined
let fixture: Awaited<ReturnType<typeof serveFixture>> | undefined
beforeAll(async () => {
  if (chrome === undefined) return
  const markup = await preactAdapter.renderToString?.([Layout, Page], {
    data: listData(),
    layoutData: [{ nav: "main" }],
    pending: false,
    params: {},
    path: "/list",
    search: {},
  })
  fixture = await serveFixture({
    entry: join(import.meta.dir, "fixtures/share-list.ts"),
    markup: markup ?? "",
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
  await page.waitFor("window.fixture?.ready() && window.fixture.counts.page > 0")
  return page
}
// Renders flush before a macrotask runs.
const settled = "new Promise((resolve) => setTimeout(resolve))"

test.skipIf(chrome === undefined)(
  "an unchanged reload re-renders neither the layout nor a row",
  async () => {
    const p = await open()
    await p.evaluate(settled)
    expect(await p.evaluate("({ ...fixture.counts })")).toEqual({ layout: 1, page: 1, rows: 20 })
    await p.evaluate("fixture.invalidate()")
    await p.evaluate(settled)
    // The page reads `pending`, which the reload set and cleared.
    expect(await p.evaluate("({ ...fixture.counts })")).toEqual({ layout: 1, page: 3, rows: 20 })

    await p.evaluate(`fixture.relabel({ 5: "changed" }); fixture.invalidate()`)
    await p.evaluate(settled)
    expect(await p.evaluate("({ ...fixture.counts })")).toEqual({ layout: 1, page: 5, rows: 21 })
    expect(await p.evaluate<string>(`document.querySelector('li[data-id="5"]').textContent`)).toBe(
      "changed",
    )
    expect(p.errors).toEqual([])
  },
  30_000,
)

test.skipIf(chrome === undefined)(
  "a route that opts out with shareData = false re-renders the layout and every row",
  async () => {
    const p = await open("?share=0")
    await p.evaluate(settled)
    await p.evaluate("fixture.invalidate()")
    await p.evaluate(settled)
    expect(await p.evaluate("({ ...fixture.counts })")).toEqual({ layout: 2, page: 3, rows: 40 })
    expect(p.errors).toEqual([])
  },
  30_000,
)

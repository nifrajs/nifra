import { afterAll, beforeAll, expect, test } from "bun:test"
import { join } from "node:path"
import {
  CHROME_LAUNCH_TIMEOUT_MS,
  type ChromePage,
  findChrome,
  launchChrome,
} from "../../cli/test/headless-chrome.ts"
import { serveFixture } from "../../web/test/share-browser.ts"

/**
 * An action's revalidation of a Solid page in a real browser: the router shares the reloaded data, so
 * `<For>` keeps every unchanged row - its element and its DOM state - and an effect on `data` does not
 * re-run for data that did not change. Skipped without a Chrome locally; CI must have one.
 */
const chrome = findChrome()
if (chrome === undefined && process.env.CI !== undefined) {
  throw new Error("share-browser needs Chrome in CI: set NIFRA_TEST_CHROME to its binary")
}

let page: ChromePage | undefined
let fixture: Awaited<ReturnType<typeof serveFixture>> | undefined
beforeAll(async () => {
  if (chrome === undefined) return
  fixture = await serveFixture({ entry: join(import.meta.dir, "fixtures/share-list.ts") })
  page = await launchChrome(chrome)
}, CHROME_LAUNCH_TIMEOUT_MS)
afterAll(async () => {
  fixture?.stop()
  await page?.close()
}, 30_000)

const open = async (query = ""): Promise<ChromePage> => {
  if (page === undefined || fixture === undefined) throw new Error("[test] no browser")
  await page.goto(`${fixture.url}${query}`)
  await page.waitFor("window.fixture?.ready")
  return page
}

test.skipIf(chrome === undefined)(
  "an action's revalidation keeps <For> rows and a ticked checkbox",
  async () => {
    const p = await open()
    await p.evaluate("fixture.tick(3); fixture.hold()")
    const before = await p.evaluate<{ rows: number; effects: number }>("({ ...fixture.counts })")
    expect(before.rows).toBe(20)

    await p.evaluate("fixture.submit()")
    expect(await p.evaluate<number[]>("fixture.replaced()")).toEqual([])
    expect(await p.evaluate<boolean>("fixture.ticked(3)")).toBe(true)
    expect(await p.evaluate("({ ...fixture.counts })")).toEqual(before)

    // One changed row is rebuilt; the rest, the ticked one included, stay as they are.
    await p.evaluate(`fixture.relabel({ 5: "changed" }); fixture.submit()`)
    expect(await p.evaluate<number[]>("fixture.replaced()")).toEqual([5])
    expect(await p.evaluate<string>("fixture.label(5)")).toBe("changed")
    expect(await p.evaluate<boolean>("fixture.ticked(3)")).toBe(true)
    expect(await p.evaluate("({ ...fixture.counts })")).toEqual({ rows: 21, effects: 2 })
    expect(p.errors).toEqual([])
  },
  30_000,
)

test.skipIf(chrome === undefined)(
  "a route that opts out with shareData = false rebuilds every row",
  async () => {
    const p = await open("?share=0")
    await p.evaluate("fixture.tick(3); fixture.hold()")
    await p.evaluate("fixture.submit()")
    expect(await p.evaluate<number[]>("fixture.replaced()")).toHaveLength(20)
    expect(await p.evaluate<boolean>("fixture.ticked(3)")).toBe(false)
    expect(p.errors).toEqual([])
  },
  30_000,
)

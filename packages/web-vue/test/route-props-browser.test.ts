import { afterAll, beforeAll, expect, test } from "bun:test"
import { join } from "node:path"
import {
  CHROME_LAUNCH_TIMEOUT_MS,
  type ChromePage,
  findChrome,
  launchChrome,
} from "../../cli/test/headless-chrome.ts"
import { serveFixture } from "../../web/test/share-browser.ts"
import { vueAdapter } from "../src/index.ts"
import { ROUTE_PROP_NAMES } from "./fixtures/route-props.ts"
import { A, Layout, SERVER_PROPS } from "./fixtures/route-props-chain.ts"

const chrome = findChrome()
if (chrome === undefined && process.env.CI !== undefined)
  throw new Error("route-props-browser needs Chrome")
let page: ChromePage | undefined
beforeAll(async () => {
  if (chrome !== undefined) page = await launchChrome(chrome)
}, CHROME_LAUNCH_TIMEOUT_MS)
afterAll(async () => page?.close(), 30_000)
const settled = "new Promise(resolve => setTimeout(resolve, 50))"

// Each element's attributes that are named after a route prop. HTML lowercases attribute names.
const strays = `[...document.querySelectorAll("#root *")].flatMap((element) =>
  element.getAttributeNames()
    .filter((name) => ${JSON.stringify(ROUTE_PROP_NAMES.map((name) => name.toLowerCase()))}.includes(name))
    .map((name) => element.id + " " + name + "=" + element.getAttribute(name)))`

test.skipIf(chrome === undefined)(
  "a mounted Router puts no route prop on the elements of a page or layout that does not declare it",
  async () => {
    if (page === undefined) throw new Error("[test] no browser")
    const markup = (await vueAdapter.renderToString?.([Layout, A], SERVER_PROPS)) ?? ""
    const fixture = await serveFixture({
      entry: join(import.meta.dir, "fixtures/route-props-client.ts"),
      markup,
    })
    try {
      const errorAt = page.errors.length
      await page.goto(fixture.url)
      await page.evaluate(settled)
      const seen: Record<string, unknown> = {
        hydrated: await page.evaluate(strays),
        markup: await page.evaluate("document.getElementById('root').innerHTML"),
      }
      // A navigation in flight re-renders the page with `pending`.
      await page.evaluate("fixture.hold(); void fixture.go('b')")
      await page.evaluate(settled)
      seen.pending = await page.evaluate(strays)
      await page.evaluate("fixture.release()")
      await page.waitFor("document.getElementById('b') !== null")
      seen.mounted = await page.evaluate(strays)
      await page.evaluate("fixture.go('a')")
      await page.waitFor("document.getElementById('a') !== null")
      seen.back = await page.evaluate(strays)
      expect(seen).toEqual({ hydrated: [], markup, pending: [], mounted: [], back: [] })
      expect(page.errors.slice(errorAt)).toEqual([])
    } finally {
      fixture.stop()
    }
  },
  30_000,
)

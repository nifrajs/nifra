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
import { A, KeepAliveLayout, RepeatedLayout, TransitionLayout } from "./fixtures/slot-chain.ts"

const chrome = findChrome()
if (chrome === undefined && process.env.CI !== undefined)
  throw new Error("slot-browser needs Chrome")
let page: ChromePage | undefined
beforeAll(async () => {
  if (chrome !== undefined) page = await launchChrome(chrome)
}, CHROME_LAUNCH_TIMEOUT_MS)
afterAll(async () => page?.close(), 30_000)
const settled = "new Promise(resolve => setTimeout(resolve, 50))"

test.skipIf(chrome === undefined)(
  "KeepAlive restores the named page's local state",
  async () => {
    if (page === undefined) throw new Error("[test] no browser")
    const markup = await vueAdapter.renderToString?.([KeepAliveLayout, A], {
      data: null,
      pending: false,
      params: {},
      path: "/a",
      search: {},
    })
    const fixture = await serveFixture({
      entry: join(import.meta.dir, "fixtures/slot-client.ts"),
      markup: markup ?? "",
    })
    try {
      const errorAt = page.errors.length
      await page.goto(fixture.url)
      await page.evaluate(settled)
      await page.evaluate("document.getElementById('counter').click()")
      await page.evaluate(settled)
      expect(await page.evaluate("document.getElementById('counter').textContent")).toBe("A:1")
      await page.evaluate("fixture.go('b')")
      await page.evaluate(settled)
      expect(await page.evaluate("document.getElementById('counter').textContent")).toBe("B:0")
      await page.evaluate("fixture.go('a')")
      await page.evaluate(settled)
      expect(await page.evaluate("document.getElementById('counter').textContent")).toBe("A:1")
      // An active cached page may receive new props without re-rendering its layout. Reactivation
      // must still compare against those latest props, not its first cached vnode's props.
      await page.evaluate("fixture.setData('updated'); fixture.invalidate()")
      await page.evaluate(settled)
      expect(await page.evaluate("document.getElementById('counter').textContent")).toBe(
        "A:1:updated",
      )
      await page.evaluate("fixture.go('b')")
      await page.evaluate(settled)
      await page.evaluate("fixture.setData(null); fixture.go('a')")
      await page.evaluate(settled)
      expect(await page.evaluate("document.getElementById('counter').textContent")).toBe("A:1")
      expect(page.errors.slice(errorAt)).toEqual([])
    } finally {
      fixture.stop()
    }
  },
  30_000,
)

test.skipIf(chrome === undefined)(
  "out-in Transition waits for the held page leave",
  async () => {
    if (page === undefined) throw new Error("[test] no browser")
    const markup = await vueAdapter.renderToString?.([TransitionLayout, A], {
      data: null,
      pending: false,
      params: {},
      path: "/a",
      search: {},
    })
    const fixture = await serveFixture({
      entry: join(import.meta.dir, "fixtures/slot-client.ts"),
      markup: markup ?? "",
    })
    try {
      const errorAt = page.errors.length
      await page.goto(`${fixture.url}?transition`)
      await page.evaluate(settled)
      expect(await page.evaluate("document.getElementById('counter').textContent")).toBe("A:0")
      await page.evaluate("fixture.go('b')")
      await page.evaluate(settled)
      expect(await page.evaluate("document.getElementById('root').textContent")).toBe("A:0")
      expect(await page.evaluate("typeof window.leaveDone")).toBe("function")
      await page.evaluate("window.leaveDone()")
      await page.evaluate(settled)
      expect(await page.evaluate("document.getElementById('counter').textContent")).toBe("B:0")
      expect(page.errors.slice(errorAt)).toEqual([])
    } finally {
      fixture.stop()
    }
  },
  30_000,
)

test.skipIf(chrome === undefined)(
  "a repeated default slot updates every page instance",
  async () => {
    if (page === undefined) throw new Error("[test] no browser")
    const markup = await vueAdapter.renderToString?.([RepeatedLayout, A], {
      data: null,
      pending: false,
      params: {},
      path: "/a",
      search: {},
    })
    const fixture = await serveFixture({
      entry: join(import.meta.dir, "fixtures/slot-client.ts"),
      markup: markup ?? "",
    })
    try {
      const errorAt = page.errors.length
      await page.goto(`${fixture.url}?repeated`)
      await page.evaluate(settled)
      await page.evaluate("fixture.setData('updated'); fixture.invalidate()")
      await page.evaluate(settled)
      expect(
        await page.evaluate(
          "Array.from(document.querySelectorAll('button'), el => el.textContent)",
        ),
      ).toEqual(["A:0:updated", "A:0:updated"])
      expect(page.errors.slice(errorAt)).toEqual([])
    } finally {
      fixture.stop()
    }
  },
  30_000,
)

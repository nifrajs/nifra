import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { HOLD_PATH, RELEASE_PATH } from "../../web/test/keep-alive-app.ts"
import {
  assertBranchLayouts,
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
const serve = async (
  mode: "production" | "development",
  fixture = "keep-alive",
): Promise<Served> => {
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "keep-alive-server.ts"), mode, fixture],
    { stdout: "pipe", stderr: "inherit" },
  )
  const reader = child.stdout.getReader()
  let text = ""
  while (!text.includes("\n")) {
    const { value, done } = await reader.read()
    if (done) throw new Error(`[test] the keep-alive server exited: ${text}`)
    text += new TextDecoder().decode(value)
  }
  reader.releaseLock()
  const { url }: { url: string } = JSON.parse(text.slice(0, text.indexOf("\n")))
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
// A kept branch whose inner layout is not wrapped, around kept pages of its own.
let nested: Served | undefined
beforeAll(async () => {
  if (engines.length === 0) return
  ;[production, development, nested] = await Promise.all([
    serve("production"),
    serve("development"),
    serve("production", "keep-alive-nested"),
  ])
}, 60_000)
afterAll(() => {
  production?.stop()
  development?.stop()
  nested?.stop()
})

const app = (served: Served | undefined): Served => {
  if (served === undefined) throw new Error("[test] no app")
  return served
}

for (const engine of engines) {
  describe(`keep-alive in Vue, ${engine.name}`, () => {
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
      // The fixture's list page counts its mounted instances: a Vue page renders no slot wrappers.
      await assertIdentityDrops(
        browser,
        app(production).url,
        () => Reflect.get(window, "__mounted")?.size ?? 0,
      )
    }, 30_000)

    test("a kept page renders no slot wrappers, so a direct-child selector still matches it", async () => {
      const { page, problems } = await open()
      const url = app(development).url
      await page.goto(`${url}/list/1`)
      await page.waitForFunction(() => document.documentElement.hasAttribute("data-nifra-hydrated"))
      await page.click('nav a[href="/list/2"]')
      await page.waitForFunction(
        () => document.getElementById("list-title")?.textContent === "List 2",
      )
      await page.goBack()
      await page.waitForFunction(
        () => document.getElementById("list-title")?.textContent === "List 1",
      )
      expect(
        await page.evaluate(() => ({
          wrappers: document.querySelectorAll("[data-nifra-entry], [data-nifra-page]").length,
          outline: getComputedStyle(document.querySelector(".list-page") ?? document.body)
            .outlineStyle,
        })),
      ).toEqual({ wrappers: 0, outline: "solid" })
      expect(problems).toEqual([])
      await page.close()
    }, 30_000)

    // What the fixture's layouts and pages heard, once the frame after a navigation has run.
    const heard = (page: Awaited<ReturnType<typeof open>>["page"]): Promise<string[]> =>
      page.evaluate(
        () =>
          new Promise<string[]>((resolve) =>
            requestAnimationFrame(() => resolve([...(Reflect.get(window, "__heard") ?? [])])),
          ),
      )
    // The title each fixture page shows; a navigation waits for it before the next one starts.
    const titled = (page: Awaited<ReturnType<typeof open>>["page"], title: string) =>
      page.waitForFunction(
        (text) => document.querySelector("#list-title, #item-title, .detail")?.textContent === text,
        title,
      )
    const go = async (
      page: Awaited<ReturnType<typeof open>>["page"],
      href: string,
      title: string,
    ): Promise<void> => {
      await page.evaluate((target) => {
        document.querySelector<HTMLAnchorElement>(`nav a[href="${target}"]`)?.click()
      }, href)
      await titled(page, title)
    }

    test("a layout inside a kept branch hides and shows with the branch", async () => {
      const { page, problems } = await open()
      await page.goto(`${app(nested).url}/shop/inner/1`)
      await page.waitForFunction(() => document.documentElement.hasAttribute("data-nifra-hydrated"))
      await go(page, "/detail/1", "Detail 1")
      expect((await heard(page)).sort()).toEqual(
        ["inner:false", "inner:hide", "page:false", "page:hide", "shop:false", "shop:hide"].sort(),
      )
      expect(problems).toEqual([])
      await page.close()
    }, 30_000)

    test("a page the router drops inside a hidden branch unmounts while the branch stays", async () => {
      const { page, problems } = await open()
      await page.goto(`${app(nested).url}/shop/inner/1`)
      await page.waitForFunction(() => document.documentElement.hasAttribute("data-nifra-hydrated"))
      // Kept: item 1, then item 2 with its branch, then list 1 and list 2; the fourth drops item 1.
      await go(page, "/shop/inner/2", "Item 2")
      for (const n of [1, 2, 3]) await go(page, `/list/${n}`, `List ${n}`)
      const unmounted = (await heard(page)).filter((entry) => entry.startsWith("page:unmounted"))
      expect(unmounted).toEqual(["page:unmounted:1"])
      await page.evaluate(() => history.go(-3))
      await titled(page, "Item 2")
      expect(problems).toEqual([])
      await page.close()
    }, 30_000)
  })
}

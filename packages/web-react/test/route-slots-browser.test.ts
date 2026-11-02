import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { withRouteSlots } from "@nifrajs/web/client"
import { serveApp } from "../../web/test/keep-alive-app.ts"
import { installedEngines, openPage } from "../../web/test/keep-alive-browser.ts"
import { reactAdapter } from "../src/index.ts"

const appDir = join(import.meta.dir, "fixtures/route-slots")
const engines = await installedEngines()
let served: Awaited<ReturnType<typeof serveApp>> | undefined

beforeAll(async () => {
  if (engines.length === 0) return
  served = await serveApp({
    appDir,
    adapter: reactAdapter,
    clientModule: "@nifrajs/web-react/client",
  })
}, 60_000)

afterAll(() => served?.stop())

const app = (): NonNullable<typeof served> => {
  if (served === undefined) throw new Error("[test] no route-slot app")
  return served
}

const preparePage = async (browser: Parameters<typeof openPage>[0]) => {
  const { page, problems } = await openPage(browser)
  await page.addInitScript(() => {
    // biome-ignore lint/suspicious/noDocumentCookie: browser fixture starts as Alice.
    document.cookie = "fixture-subject=alice; Path=/; SameSite=Lax"
    Reflect.set(window, "__nifraRouteSlotRequests", [])
    const originalFetch = window.fetch.bind(window)
    const trackedFetch: typeof fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
        const requestHeaders = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        )
        if (requestHeaders.has("x-nifra-data")) {
          const requests = Reflect.get(window, "__nifraRouteSlotRequests")
          if (Array.isArray(requests)) requests.push(String(input))
        }
        return originalFetch(input, init)
      },
      { preconnect: originalFetch.preconnect },
    )
    window.fetch = trackedFetch
  })
  return { page, problems }
}

const waitForHydration = (page: Awaited<ReturnType<typeof preparePage>>["page"]) =>
  page.waitForFunction(() => document.documentElement.hasAttribute("data-nifra-hydrated"))

const waitForSlotRequests = (
  page: Awaited<ReturnType<typeof preparePage>>["page"],
  count: number,
) =>
  page.waitForFunction((expected) => {
    const requests = Reflect.get(window, "__nifraRouteSlotRequests")
    return Array.isArray(requests) && requests.length >= expected
  }, count)

for (const engine of engines) {
  describe(`independent route slots in React, ${engine.name}`, () => {
    let browser: Awaited<ReturnType<typeof engine.launch>> | undefined

    beforeAll(async () => {
      browser = await engine.launch()
    }, 60_000)

    afterAll(async () => browser?.close(), 30_000)

    const open = async () => {
      if (browser === undefined) throw new Error("[test] no browser")
      return preparePage(browser)
    }

    test("direct URL and reload load two nested slots concurrently", async () => {
      const { page, problems } = await open()
      const release = app().holdData()
      try {
        const directPath = withRouteSlots("/dashboard", {
          activity: "/activity",
          inspector: "/users/7",
        })
        await page.goto(`${app().url}${directPath}`)
        await waitForHydration(page)
        await waitForSlotRequests(page, 2)
        await page.waitForFunction(
          () =>
            document.querySelector("#activity-fallback") !== null &&
            document.querySelector("#inspector-fallback") !== null,
        )

        release()
        await page.waitForFunction(
          () =>
            document.querySelector("#activity")?.getAttribute("data-viewer") === "alice" &&
            document.querySelector("#inspector-user")?.getAttribute("data-viewer") === "alice" &&
            document.querySelector("#user-layout") !== null,
        )
        expect(problems).toEqual([])

        await page.goto(page.url())
        await page.waitForFunction(
          () =>
            document.querySelector("#activity")?.getAttribute("data-viewer") === "alice" &&
            document.querySelector("#inspector-user")?.getAttribute("data-viewer") === "alice" &&
            document.querySelector("#user-layout") !== null,
        )
        expect(problems).toEqual([])
      } finally {
        release()
        await page.close()
      }
    }, 30_000)

    test("sibling navigation and Back/Forward preserve committed sibling identity", async () => {
      const { page, problems } = await open()
      try {
        await page.goto(`${app().url}/dashboard`)
        await waitForHydration(page)
        await page.click("#open-activity")
        await page.waitForFunction(() => document.querySelector("#activity") !== null)
        await page.evaluate(() => {
          const node = document.querySelector("#activity")
          Reflect.set(window, "__activityBeforeSiblingNavigation", node)
        })
        await page.click("#activity-count")
        await page.waitForFunction(
          () => document.querySelector("#activity-count")?.textContent === "activity count 1",
        )
        const activityLoads = await page.evaluate(() =>
          document.querySelector("#activity")?.getAttribute("data-loads"),
        )

        await page.click("#open-inspector-7")
        await page.waitForFunction(() => document.querySelector("#inspector-user") !== null)
        expect(
          await page.evaluate(
            () =>
              Reflect.get(window, "__activityBeforeSiblingNavigation") ===
              document.querySelector("#activity"),
          ),
        ).toBe(true)
        expect(
          await page.evaluate(() =>
            document.querySelector("#activity")?.getAttribute("data-loads"),
          ),
        ).toBe(activityLoads)
        expect(
          await page.evaluate(() => document.querySelector("#activity-count")?.textContent),
        ).toBe("activity count 1")

        await page.evaluate(() => history.back())
        await page.waitForFunction(() => {
          return !new URL(location.href).searchParams.has("slot.inspector")
        })
        expect(
          await page.evaluate(
            () =>
              Reflect.get(window, "__activityBeforeSiblingNavigation") ===
              document.querySelector("#activity"),
          ),
        ).toBe(true)
        expect(
          await page.evaluate(() => document.querySelector("#activity-count")?.textContent),
        ).toBe("activity count 1")

        await page.evaluate(() => history.forward())
        await page.waitForFunction(() => document.querySelector("#inspector-user") !== null)
        expect(problems).toEqual([])
      } finally {
        await page.close()
      }
    }, 30_000)

    test("slot-only navigation preserves raw query bytes and skips the page fetch", async () => {
      const { page, problems } = await open()
      try {
        const rawSearch = "q=a%20b&tag[]=1&semi=a=b;c&tilde=~&quote='"
        const path = withRouteSlots(`/dashboard?${rawSearch}`, { activity: "/activity" })
        await page.goto(`${app().url}${path}`)
        await waitForHydration(page)
        await waitForSlotRequests(page, 1)
        await page.waitForFunction(() => document.querySelector("#activity") !== null)
        await page.evaluate(() => {
          Reflect.set(
            window,
            "__activityBeforeRawQueryNavigation",
            document.querySelector("#activity"),
          )
        })

        await page.click("#open-inspector-7")
        await page.waitForFunction(() => document.querySelector("#inspector-user") !== null)
        await waitForSlotRequests(page, 2)

        expect(await page.evaluate(() => location.search)).toContain(
          "q=a%20b&tag[]=1&semi=a=b;c&tilde=~&quote=%27",
        )
        expect(
          await page.evaluate(
            () =>
              Reflect.get(window, "__activityBeforeRawQueryNavigation") ===
              document.querySelector("#activity"),
          ),
        ).toBe(true)
        expect(
          await page.evaluate(() => {
            const requests = Reflect.get(window, "__nifraRouteSlotRequests")
            return Array.isArray(requests) ? requests.length : -1
          }),
        ).toBe(2)
        expect(problems).toEqual([])
      } finally {
        await page.close()
      }
    }, 30_000)

    test("a pending slot stays isolated while a sibling starts loading", async () => {
      const { page, problems } = await open()
      const release = app().holdData()
      try {
        await page.goto(`${app().url}/dashboard`)
        await waitForHydration(page)
        await page.click("#open-activity")
        await page.waitForFunction(() => document.querySelector("#activity-fallback") !== null)
        await waitForSlotRequests(page, 1)

        await page.click("#open-inspector-7")
        await page.waitForFunction(() => document.querySelector("#inspector-fallback") !== null)
        await waitForSlotRequests(page, 2)

        release()
        await page.waitForFunction(
          () =>
            document.querySelector("#activity")?.getAttribute("data-viewer") === "alice" &&
            document.querySelector("#inspector-user")?.getAttribute("data-viewer") === "alice",
        )
        expect(problems).toEqual([])
      } finally {
        release()
        await page.close()
      }
    }, 30_000)

    test("identity change clears old slot data and reauthorizes each target", async () => {
      const { page, problems } = await open()
      let release = app().holdData()
      try {
        const directPath = withRouteSlots("/dashboard", {
          activity: "/activity",
          inspector: "/users/7",
        })
        release()
        await page.goto(`${app().url}${directPath}`)
        await waitForHydration(page)
        await page.waitForFunction(
          () =>
            document.querySelector("#activity")?.getAttribute("data-viewer") === "alice" &&
            document.querySelector("#inspector-user")?.getAttribute("data-viewer") === "alice",
        )

        release = app().holdData()
        await page.click("#switch-identity")
        await page.waitForFunction(
          () =>
            document.querySelector("#activity-fallback") !== null &&
            document.querySelector("#inspector-fallback") !== null &&
            document.querySelector("#inspector-user") === null,
        )
        release()

        await page.waitForFunction(
          () =>
            document.querySelector("#activity")?.getAttribute("data-viewer") === "bob" &&
            document.querySelector("#inspector-error")?.textContent ===
              "Inspector error: forbidden" &&
            document.querySelector("#inspector-user") === null,
        )
        expect(
          problems.filter(
            (message) =>
              !/^error: Failed to load resource: the server responded with a status of 403(?: \(Forbidden\))?$/.test(
                message,
              ),
          ),
        ).toEqual([])
      } finally {
        release()
        await page.close()
      }
    }, 30_000)
  })
}

import { expect } from "bun:test"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { findChrome } from "../../cli/test/headless-chrome.ts"
import { LOGIN_PATH, LOGOUT_PATH } from "./keep-alive-app.ts"

/**
 * The keep-alive browser matrix, shared by every adapter's fixture app. Each fixture renders the same
 * markup (a list page that keeps alive, a detail page that does not, a shop layout only its pages pass
 * through), so one script asserts the same behaviour against all of them, in every engine installed.
 */

export type EngineName = "chromium" | "webkit" | "firefox"

export interface BrowserPage {
  goto(url: string): Promise<unknown>
  goBack(): Promise<unknown>
  click(selector: string): Promise<void>
  evaluate<T, A = undefined>(fn: (arg: A) => T | Promise<T>, arg?: A): Promise<T>
  waitForFunction<A = undefined>(
    fn: ((arg: A) => unknown) | string,
    arg?: A,
    options?: { readonly timeout?: number },
  ): Promise<unknown>
  waitForResponse(predicate: (response: { url(): string }) => boolean): Promise<unknown>
  addInitScript(fn: () => void): Promise<void>
  on(event: "console", listener: (message: { type(): string; text(): string }) => void): void
  on(event: "pageerror", listener: (error: Error) => void): void
  url(): string
  close(): Promise<void>
}

interface PageOpener {
  newPage(options?: { readonly viewport?: { width: number; height: number } }): Promise<BrowserPage>
}
interface Browser extends PageOpener {
  newContext(options?: {
    readonly viewport?: { width: number; height: number }
  }): Promise<PageOpener & { close(): Promise<void> }>
  close(): Promise<void>
}

interface Launcher {
  executablePath(): string
  launch(options: { headless: boolean; executablePath?: string }): Promise<Browser>
}

const ENGINES: readonly EngineName[] = ["chromium", "webkit", "firefox"]

// `playwright` is a devDependency of `@nifrajs/web`.
const playwright = async (): Promise<Record<EngineName, Launcher>> =>
  import(createRequire(join(import.meta.dir, "../package.json")).resolve("playwright"))

/**
 * The engines this machine can run: each one playwright has installed, and Chromium from a system
 * Chrome when playwright's is missing. CI must have at least Chromium.
 */
export async function installedEngines(): Promise<
  readonly { readonly name: EngineName; readonly launch: () => Promise<Browser> }[]
> {
  const launchers = await playwright()
  const found: { name: EngineName; launch: () => Promise<Browser> }[] = []
  for (const name of ENGINES) {
    const launcher = launchers[name]
    let path: string | undefined
    try {
      path = launcher.executablePath()
    } catch {
      path = undefined
    }
    if (path !== undefined && existsSync(path)) {
      found.push({ name, launch: () => launcher.launch({ headless: true }) })
      continue
    }
    const chrome = name === "chromium" ? findChrome() : undefined
    if (chrome !== undefined) {
      found.push({
        name,
        launch: () => launcher.launch({ headless: true, executablePath: chrome }),
      })
    }
  }
  if (!found.some((engine) => engine.name === "chromium") && process.env.CI !== undefined) {
    throw new Error("the keep-alive browser tests need Chromium in CI: set NIFRA_TEST_CHROME")
  }
  return found
}

/** A page that records every console error and warning, and every uncaught error. */
export async function openPage(browser: PageOpener): Promise<{
  readonly page: BrowserPage
  readonly problems: string[]
}> {
  const page = await browser.newPage({ viewport: { width: 800, height: 400 } })
  const problems: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      problems.push(`${message.type()}: ${message.text()}`)
  })
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`))
  // The node the server rendered, before the client hydrates it.
  await page.addInitScript(() => {
    document.addEventListener("readystatechange", () => {
      if (document.readyState === "interactive")
        Reflect.set(window, "__ssrPage", document.querySelector(".list-page"))
    })
  })
  return { page, problems }
}

const hydrated = (page: BrowserPage): Promise<unknown> =>
  page.waitForFunction(() => document.documentElement.hasAttribute("data-nifra-hydrated"))

const showing = (page: BrowserPage, title: string): Promise<unknown> =>
  page.waitForFunction((text) => document.getElementById("list-title")?.textContent === text, title)

// Follows a link the way a script does, so focus stays where the test put it.
const follow = async (page: BrowserPage, href: string): Promise<void> => {
  await page.evaluate((target) => {
    const link = document.querySelector(`nav a[href="${target}"]`)
    if (!(link instanceof HTMLAnchorElement)) throw new Error(`no link to ${target}`)
    link.click()
  }, href)
}

interface Restored {
  readonly sameElement: boolean
  readonly hydratedElement: boolean
  readonly draft: string
  readonly checked: boolean
  readonly open: boolean
  readonly innerScroll: number
  readonly count: string
  readonly windowScroll: number
  readonly focused: boolean
  readonly titles: number
  readonly visible: string | null
  readonly param: string | null
}

/**
 * The 7.2 matrix: leave a server-rendered, hydrated list page with state, keep two more, come back
 * with back. The page comes back as the same element - the one the server rendered - with all of its
 * state, and while hidden it is out of the document, reads its own params and runs no interval. Run
 * it against a development build too: only there does a framework report a hydration mismatch.
 */
export async function assertKeepAliveMatrix(
  page: BrowserPage,
  problems: readonly string[],
  url: string,
): Promise<void> {
  await page.goto(`${url}/list/1`)
  await hydrated(page)
  await page.evaluate(() => {
    const list = document.querySelector(".list-page")
    if (list === null) throw new Error("no list page")
    Reflect.set(window, "__kept", list)
    const draft = list.querySelector<HTMLInputElement>(".draft")
    if (draft === null) throw new Error("no draft")
    draft.value = "draft!"
    list.querySelector<HTMLInputElement>("li input")?.click()
    const details = list.querySelector("details")
    if (details !== null) details.open = true
    const inner = list.querySelector(".inner-scroll")
    if (inner !== null) inner.scrollTop = 120
    for (let i = 0; i < 3; i++) list.querySelector<HTMLButtonElement>(".count")?.click()
    draft.focus({ preventScroll: true })
    window.scrollTo(0, 200)
  })
  await page.waitForFunction(() => document.querySelector(".count")?.textContent === "count 3")

  await follow(page, "/list/2")
  await showing(page, "List 2")
  const hidden = await page.evaluate(() => {
    const kept: Element = Reflect.get(window, "__kept")
    return {
      connected: kept.isConnected,
      param: kept.getAttribute("data-param"),
      visible: kept.getAttribute("data-visible"),
      titles: document.querySelectorAll("#list-title").length,
      instance: kept.getAttribute("data-instance") ?? "",
      active: document.querySelector(".list-page")?.getAttribute("data-instance") ?? "",
    }
  })
  expect(hidden).toMatchObject({ connected: false, param: "1", visible: "false", titles: 1 })
  // The hidden page's interval stays still while the page on screen ticks ten times.
  const ticks = (instance: string): Promise<number> =>
    page.evaluate((id) => Number(Reflect.get(window, "__ticks")?.[id] ?? 0), instance)
  const hiddenTicks = await ticks(hidden.instance)
  const activeTicks = await ticks(hidden.active)
  await page.waitForFunction(
    ([id, from]) => Number(Reflect.get(window, "__ticks")?.[id] ?? 0) >= from + 10,
    [hidden.active, activeTicks] as const,
  )
  expect(await ticks(hidden.instance)).toBe(hiddenTicks)

  await follow(page, "/list/3")
  await showing(page, "List 3")
  await follow(page, "/detail/1")
  await page.waitForFunction(() => document.querySelector(".detail") !== null)
  expect(await page.evaluate(() => document.querySelectorAll(".list-page").length)).toBe(0)
  await page.goBack()
  await showing(page, "List 3")
  await page.goBack()
  await showing(page, "List 2")
  await page.goBack()
  await showing(page, "List 1")
  await page.waitForFunction(() => window.scrollY > 0)

  const restored = await page.evaluate((): Restored => {
    const list = document.querySelector(".list-page")
    const draft = list?.querySelector<HTMLInputElement>(".draft")
    return {
      sameElement: list === Reflect.get(window, "__kept"),
      hydratedElement: list === Reflect.get(window, "__ssrPage"),
      draft: draft?.value ?? "",
      checked: list?.querySelector<HTMLInputElement>("li input")?.checked ?? false,
      open: list?.querySelector("details")?.open ?? false,
      innerScroll: list?.querySelector(".inner-scroll")?.scrollTop ?? 0,
      count: list?.querySelector(".count")?.textContent ?? "",
      windowScroll: Math.round(window.scrollY),
      focused: draft !== undefined && document.activeElement === draft,
      titles: document.querySelectorAll("#list-title").length,
      visible: list?.getAttribute("data-visible") ?? null,
      param: list?.getAttribute("data-param") ?? null,
    }
  })
  expect(restored).toEqual({
    sameElement: true,
    hydratedElement: true,
    draft: "draft!",
    checked: true,
    open: true,
    innerScroll: 120,
    count: "count 3",
    windowScroll: 200,
    focused: true,
    titles: 1,
    visible: "true",
    param: "1",
  })
  // The restored page's interval runs again.
  const restoredTicks = await ticks(hidden.instance)
  await page.waitForFunction(
    ([id, from]) => Number(Reflect.get(window, "__ticks")?.[id] ?? 0) > from,
    [hidden.instance, restoredTicks] as const,
  )
  // A development build also reports the fixture's direct-child rule (D10), asserted on its own.
  expect(
    problems.filter((problem) => !problem.includes("NIFRA_KEEPALIVE_DIRECT_CHILD_CSS")),
  ).toEqual([])
}

/**
 * A restore shows the kept page while its data revalidates: with the data request held, the page is
 * already on screen with its state; the response then lands without remounting it.
 */
export async function assertRestoreBeforeData(
  page: BrowserPage,
  problems: readonly string[],
  app: {
    readonly url: string
    readonly holdData: () => (() => unknown) | Promise<() => unknown>
  },
): Promise<void> {
  await page.goto(`${app.url}/list/1`)
  await hydrated(page)
  await page.evaluate(() => {
    const list = document.querySelector(".list-page")
    Reflect.set(window, "__kept", list)
    list?.querySelector<HTMLButtonElement>(".count")?.click()
  })
  await page.waitForFunction(() => document.querySelector(".count")?.textContent === "count 1")
  await follow(page, "/detail/1")
  await page.waitForFunction(() => document.querySelector(".detail") !== null)

  const release = await app.holdData()
  const revalidated = page.waitForResponse((response) => response.url().includes("/list/1"))
  await page.goBack()
  await showing(page, "List 1")
  expect(
    await page.evaluate(
      () => document.querySelector(".list-page") === Reflect.get(window, "__kept"),
    ),
  ).toBe(true)
  await release()
  await revalidated
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)))
  expect(
    await page.evaluate(() => ({
      same: document.querySelector(".list-page") === Reflect.get(window, "__kept"),
      count: document.querySelector(".count")?.textContent,
    })),
  ).toEqual({ same: true, count: "count 1" })
  expect(problems).toEqual([])
}

/**
 * Layouts that differ (5.3): a page under the shop layout keeps that layout's state as well as its
 * own when the next page has no shop layout; between two shop pages the layout is shared, as it is
 * without keep-alive.
 */
export async function assertBranchLayouts(
  page: BrowserPage,
  problems: readonly string[],
  url: string,
): Promise<void> {
  await page.goto(`${url}/shop/a`)
  await hydrated(page)
  const counts = (): Promise<{ shop: string; item: string; title: string }> =>
    page.evaluate(() => ({
      shop: document.querySelector(".shop-count")?.textContent ?? "",
      item: document.querySelector(".item-count")?.textContent ?? "",
      title: document.querySelector(".item h1")?.textContent ?? "",
    }))
  await page.evaluate(() => {
    for (let i = 0; i < 2; i++) document.querySelector<HTMLButtonElement>(".shop-count")?.click()
    document.querySelector<HTMLButtonElement>(".item-count")?.click()
  })
  await page.waitForFunction(() => document.querySelector(".item-count")?.textContent === "item 1")
  expect(await counts()).toEqual({ shop: "shop 2", item: "item 1", title: "Item a" })

  await follow(page, "/list/1")
  await showing(page, "List 1")
  expect(await page.evaluate(() => document.querySelectorAll(".shop").length)).toBe(0)
  await page.goBack()
  await page.waitForFunction(() => document.querySelector(".item h1")?.textContent === "Item a")
  expect(await counts()).toEqual({ shop: "shop 2", item: "item 1", title: "Item a" })

  await follow(page, "/shop/b")
  await page.waitForFunction(() => document.querySelector(".item h1")?.textContent === "Item b")
  expect(await counts()).toEqual({ shop: "shop 2", item: "item 0", title: "Item b" })
  expect(await page.evaluate(() => document.querySelectorAll(".item").length)).toBe(1)
  await page.goBack()
  await page.waitForFunction(() => document.querySelector(".item h1")?.textContent === "Item a")
  expect(await counts()).toEqual({ shop: "shop 2", item: "item 1", title: "Item a" })
  expect(problems).toEqual([])
}

/**
 * The D10 diagnostic in a development build: the fixture's `#main > .list-page` rule no longer matches
 * once the page sits inside its slot wrappers, and the dev client says so once.
 */
export async function assertDirectChildCssDiagnostic(
  page: BrowserPage,
  problems: readonly string[],
  url: string,
): Promise<void> {
  await page.goto(`${url}/list/1`)
  await hydrated(page)
  await follow(page, "/list/2")
  await showing(page, "List 2")
  await page.goBack()
  await showing(page, "List 1")
  const reports = problems.filter((problem) => problem.includes("NIFRA_KEEPALIVE_DIRECT_CHILD_CSS"))
  expect(reports).toHaveLength(1)
  expect(reports[0]).toContain("#main > .list-page")
}

// The kept pages in the document's tab: each one's outer slot wrapper stays where the page goes back.
const slotWrappers = (): number => document.querySelectorAll("[data-nifra-entry]").length

/**
 * K3: a sign-in rotates the identity epoch, and a restore that reads a new epoch shows a fresh page;
 * a sign-out in another tab drops this tab's kept pages at once, over `BroadcastChannel`. `keptPages`
 * counts them in the page, for an adapter that renders no slot wrappers.
 */
export async function assertIdentityDrops(
  browser: Browser,
  url: string,
  keptPages: () => number = slotWrappers,
): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 800, height: 400 } })
  try {
    const first = await openPage(context)
    const { page } = first
    const keepList = async (): Promise<void> => {
      await page.goto(`${url}/list/1`)
      await hydrated(page)
      await page.evaluate(() => {
        Reflect.set(window, "__kept", document.querySelector(".list-page"))
        document.querySelector<HTMLButtonElement>(".count")?.click()
      })
      await page.waitForFunction(() => document.querySelector(".count")?.textContent === "count 1")
      await follow(page, "/detail/1")
      await page.waitForFunction(() => document.querySelector(".detail") !== null)
      expect(await page.evaluate(keptPages)).toBe(1)
    }

    await keepList()
    await page.evaluate((path) => fetch(path), LOGIN_PATH)
    await page.goBack()
    await showing(page, "List 1")
    expect(
      await page.evaluate(() => ({
        same: document.querySelector(".list-page") === Reflect.get(window, "__kept"),
        count: document.querySelector(".count")?.textContent,
      })),
    ).toEqual({ same: false, count: "count 0" })

    await keepList()
    const second = await openPage(context)
    await second.page.goto(`${url}/list/2`)
    await hydrated(second.page)
    await second.page.evaluate((path) => fetch(path), LOGOUT_PATH)
    // The second tab notices the new epoch when its next navigation settles, and tells the others.
    await follow(second.page, "/detail/1")
    await second.page.waitForFunction(() => document.querySelector(".detail") !== null)
    // An expression, which the browser compiles outside the page's content security policy.
    await page.waitForFunction(`(${String(keptPages)})() === 0`)
    expect([...first.problems, ...second.problems]).toEqual([])
  } finally {
    await context.close()
  }
}

/**
 * A page that does not keep alive, rendered by the server and hydrated first, in a development build
 * (which reports a mismatch): the keep-alive root renders it on both sides alike.
 */
export async function assertUnkeptPageHydrates(
  page: BrowserPage,
  problems: readonly string[],
  url: string,
): Promise<void> {
  await page.goto(`${url}/detail/1`)
  await hydrated(page)
  await follow(page, "/list/1")
  await showing(page, "List 1")
  await page.goBack()
  await page.waitForFunction(() => document.querySelector(".detail")?.textContent === "Detail 1")
  expect(
    problems.filter((problem) => !problem.includes("NIFRA_KEEPALIVE_DIRECT_CHILD_CSS")),
  ).toEqual([])
}

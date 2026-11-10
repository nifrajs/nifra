import {
  E2EError,
  type ElementAction,
  type ElementState,
  type Engine,
  type EngineFactory,
  type HydrationMode,
  type Selector,
} from "./engine.ts"

/** The slice of Playwright this engine calls, so the package carries no Playwright types and tests can stand in for it. */
export interface PwFinder {
  getByRole(role: string, options?: { name?: string; exact?: boolean }): PwLocator
  getByLabel(text: string, options?: { exact?: boolean }): PwLocator
  getByText(text: string, options?: { exact?: boolean }): PwLocator
  getByTestId(id: string): PwLocator
}

export interface PwLocator extends PwFinder {
  filter(options: { hasText: string }): PwLocator
  nth(index: number): PwLocator
  evaluateAll<R>(pageFunction: (elements: readonly unknown[]) => R): Promise<R>
  click(options: { timeout: number }): Promise<void>
  fill(value: string, options: { timeout: number }): Promise<void>
  press(key: string, options: { timeout: number }): Promise<void>
}

export interface PwPage extends PwFinder {
  locator(selector: string): { ariaSnapshot(): Promise<string> }
  goto(url: string, options: { waitUntil: "load" }): Promise<unknown>
  url(): string
  evaluate<R>(expression: string): Promise<R>
  waitForSelector(
    selector: string,
    options: { state: "attached"; timeout: number },
  ): Promise<unknown>
  waitForLoadState(state: "domcontentloaded"): Promise<void>
}

export interface PwContext {
  addCookies(cookies: { name: string; value: string; url: string }[]): Promise<void>
  newPage(): Promise<PwPage>
  close(): Promise<void>
}

export interface PwBrowser {
  newContext(): Promise<PwContext>
  close(): Promise<void>
}

export interface PlaywrightEngineOptions {
  readonly browser?: "chromium" | "firefox" | "webkit"
  readonly headless?: boolean
  /** ms to wait for `data-nifra-hydrated` before `HYDRATION_TIMEOUT`. Default 5000. */
  readonly hydrationTimeout?: number
  /** Replaces the Playwright launch; used by tests. */
  readonly launch?: () => Promise<PwBrowser>
  /** Replaces the dynamic `import()` of `playwright`; used by tests. */
  readonly load?: (specifier: string) => Promise<unknown>
}

const HYDRATION_PROBE =
  "document.documentElement.hasAttribute('data-nifra-hydrated') ? 'ready' : " +
  "document.querySelector('script[type=module][src]') ? 'pending' : 'none'"

function toLocator(page: PwPage, selector: Selector): PwLocator {
  let located: PwLocator | undefined
  for (const step of selector) {
    const scope: PwFinder = located ?? page
    switch (step.kind) {
      case "role": {
        const options: { name?: string; exact?: boolean } = {}
        if (step.name !== undefined) options.name = step.name
        if (step.exact !== undefined) options.exact = step.exact
        located = scope.getByRole(step.role, options)
        break
      }
      case "label":
        located = scope.getByLabel(
          step.text,
          step.exact === undefined ? undefined : { exact: step.exact },
        )
        break
      case "text":
        located = scope.getByText(
          step.text,
          step.exact === undefined ? undefined : { exact: step.exact },
        )
        break
      case "testId":
        located = scope.getByTestId(step.id)
        break
      case "hasText":
        if (located === undefined) {
          throw new E2EError("LOCATOR_NOT_FOUND", "a text filter needs a locator to narrow")
        }
        located = located.filter({ hasText: step.text })
        break
      case "nth":
        if (located === undefined) {
          throw new E2EError("LOCATOR_NOT_FOUND", "nth needs a locator to pick from")
        }
        located = located.nth(step.index)
        break
    }
  }
  if (located === undefined) {
    throw new E2EError("LOCATOR_NOT_FOUND", "an empty locator has nothing to find")
  }
  return located
}

// Runs in the page, so it carries no imports and no DOM lib types.
function readElements(elements: readonly unknown[]): ElementState[] {
  return elements.map((node) => {
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: evaluateAll hands over the DOM elements a locator matched; this is the only shape read from them.
    const el = node as {
      innerText?: string
      textContent?: string | null
      value?: unknown
      getBoundingClientRect(): { width: number; height: number }
      checkVisibility?(options: object): boolean
    }
    const box = el.getBoundingClientRect()
    const shown =
      el.checkVisibility === undefined ||
      el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true })
    const value = typeof el.value === "string" ? el.value : undefined
    const visible = box.width > 0 && box.height > 0 && shown
    const text = el.innerText ?? el.textContent ?? ""
    return value === undefined ? { visible, text } : { visible, text, value }
  })
}

function translate(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes("strict mode violation")) return new E2EError("LOCATOR_AMBIGUOUS", message)
  if (error instanceof Error && error.name === "TimeoutError")
    return new E2EError("LOCATOR_NOT_FOUND", message)
  return error
}

async function loadBrowser(options: PlaywrightEngineOptions): Promise<PwBrowser> {
  if (options.launch !== undefined) return options.launch()
  const load = options.load ?? ((specifier: string) => import(specifier))
  let loaded: Record<
    string,
    { launch(options: { headless: boolean }): Promise<PwBrowser> } | undefined
  >
  try {
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the module's exports are read only as browser types with a launch(); a missing one is refused just below.
    loaded = (await load("playwright")) as typeof loaded
  } catch (cause) {
    throw new E2EError(
      "ENGINE_MISSING",
      "@nifrajs/e2e/playwright needs the playwright package - add it to devDependencies",
      { cause },
    )
  }
  const type = loaded[options.browser ?? "chromium"]
  if (type === undefined)
    throw new E2EError("ENGINE_MISSING", `playwright has no browser "${options.browser}"`)
  return type.launch({ headless: options.headless ?? true })
}

async function settle(page: PwPage, mode: HydrationMode, timeout: number): Promise<void> {
  if (mode === "off") return
  let state: string
  try {
    state = await page.evaluate<string>(HYDRATION_PROBE)
  } catch {
    await page.waitForLoadState("domcontentloaded")
    state = await page.evaluate<string>(HYDRATION_PROBE)
  }
  if (state !== "pending") return
  try {
    await page.waitForSelector("html[data-nifra-hydrated]", { state: "attached", timeout })
  } catch {
    throw new E2EError(
      "HYDRATION_TIMEOUT",
      `the page did not set data-nifra-hydrated within ${timeout} ms; pass hydration: "off" if it is not a hydrated nifra page`,
    )
  }
}

/** A browser engine over Playwright (`playwright` is an optional peer, loaded on first use). */
export function playwrightEngine(options: PlaywrightEngineOptions = {}): EngineFactory {
  return async (init) => {
    const browser = await loadBrowser(options)
    const context = await browser.newContext()
    const hydrationTimeout = options.hydrationTimeout ?? 5000
    let page: PwPage
    try {
      if (init.cookies.length > 0) {
        await context.addCookies(init.cookies.map((cookie) => ({ ...cookie, url: init.baseUrl })))
      }
      page = await context.newPage()
    } catch (error) {
      await browser.close()
      throw error
    }
    const engine: Engine = {
      async goto(url) {
        await page.goto(url, { waitUntil: "load" })
        await settle(page, init.hydration, hydrationTimeout)
      },
      async url() {
        return page.url()
      },
      async resolve(selector) {
        return toLocator(page, selector).evaluateAll(readElements)
      },
      async snapshot() {
        await settle(page, init.hydration, hydrationTimeout)
        return page.locator("body").ariaSnapshot()
      },
      async act(selector, action: ElementAction, timeout) {
        await settle(page, init.hydration, hydrationTimeout)
        const locator = toLocator(page, selector)
        try {
          if (action.kind === "tap") await locator.click({ timeout })
          else if (action.kind === "fill") await locator.fill(action.value, { timeout })
          else await locator.press(action.key, { timeout })
        } catch (error) {
          throw translate(error)
        }
      },
      async close() {
        await context.close()
        await browser.close()
      },
    }
    return engine
  }
}

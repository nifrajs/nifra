import { describe, expect, test } from "bun:test"
import { E2EError } from "../src/index.ts"
import { type PwBrowser, type PwLocator, type PwPage, playwrightEngine } from "../src/playwright.ts"

interface Call {
  readonly op: string
  readonly args: readonly unknown[]
}

interface Rig {
  readonly calls: Call[]
  readonly closed: string[]
  browser: PwBrowser
  probe: () => string | Error
  waitFails: boolean
  elements: readonly unknown[]
  actionError: unknown
  cookieError: Error | undefined
  contextError: Error | undefined
  currentUrl: string
}

function rig(): Rig {
  const calls: Call[] = []
  const closed: string[] = []
  const state: Rig = {
    calls,
    closed,
    probe: () => "none",
    waitFails: false,
    elements: [],
    actionError: undefined,
    cookieError: undefined,
    contextError: undefined,
    currentUrl: "about:blank",
    browser: {
      newContext: async () => {
        throw new Error("rig browser not wired")
      },
      close: async () => {},
    },
  }
  const record = (op: string, args: readonly unknown[] = []): void => {
    calls.push({ op, args })
  }
  const locator = (path: string): PwLocator => {
    const next = (op: string, args: readonly unknown[]): PwLocator => {
      record(op, args)
      return locator(`${path}.${op}`)
    }
    const act = async (op: string, args: readonly unknown[]): Promise<void> => {
      record(op, args)
      if (state.actionError !== undefined) throw state.actionError
    }
    return {
      getByRole: (...args) => next("getByRole", args),
      getByLabel: (...args) => next("getByLabel", args),
      getByText: (...args) => next("getByText", args),
      getByTestId: (...args) => next("getByTestId", args),
      filter: (...args) => next("filter", args),
      nth: (...args) => next("nth", args),
      evaluateAll: async (fn) => fn(state.elements),
      click: (options) => act("click", [options]),
      fill: (...args) => act("fill", args),
      press: (...args) => act("press", args),
    }
  }
  const page: PwPage = {
    ...locator("page"),
    locator: (selector) => {
      record("locator", [selector])
      return { ariaSnapshot: async () => '- main:\n  - button "Go"' }
    },
    goto: async (...args) => {
      record("goto", args)
      state.currentUrl = args[0]
    },
    url: () => state.currentUrl,
    evaluate: async <R>(): Promise<R> => {
      const result = state.probe()
      if (result instanceof Error) throw result
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the rig's probe answers a plain string, which is every R this engine asks for.
      return result as R
    },
    waitForSelector: async (...args) => {
      record("waitForSelector", args)
      if (state.waitFails) throw new Error("timeout")
    },
    waitForLoadState: async (...args) => {
      record("waitForLoadState", args)
      state.probe = () => "none"
    },
  }
  state.browser = {
    newContext: async () => {
      if (state.contextError !== undefined) throw state.contextError
      return {
        addCookies: async (cookies) => {
          record("addCookies", [cookies])
          if (state.cookieError !== undefined) throw state.cookieError
        },
        newPage: async () => page,
        close: async () => {
          closed.push("context")
        },
      }
    },
    close: async () => {
      closed.push("browser")
    },
  }
  return state
}

const init = { baseUrl: "http://127.0.0.1:1", cookies: [], hydration: "auto" } as const

describe("playwright engine", () => {
  test("translates every step kind into the matching Playwright call", async () => {
    const r = rig()
    const engine = await playwrightEngine({ launch: async () => r.browser })(init)
    await engine.resolve([
      { kind: "role", role: "button", name: "Go", exact: true },
      { kind: "label", text: "L", exact: false },
      { kind: "text", text: "T" },
      { kind: "testId", id: "i" },
      { kind: "hasText", text: "H" },
      { kind: "role", role: "link" },
      { kind: "nth", index: 2 },
    ])
    expect(r.calls).toEqual([
      { op: "getByRole", args: ["button", { name: "Go", exact: true }] },
      { op: "getByLabel", args: ["L", { exact: false }] },
      { op: "getByText", args: ["T", undefined] },
      { op: "getByTestId", args: ["i"] },
      { op: "filter", args: [{ hasText: "H" }] },
      { op: "getByRole", args: ["link", {}] },
      { op: "nth", args: [2] },
    ])
  })

  test("a text filter with nothing to narrow is refused", async () => {
    const r = rig()
    const engine = await playwrightEngine({ launch: async () => r.browser })(init)
    await expect(engine.resolve([{ kind: "hasText", text: "x" }])).rejects.toMatchObject({
      code: "LOCATOR_NOT_FOUND",
    })
  })

  test("nth with nothing to pick from is refused", async () => {
    const r = rig()
    const engine = await playwrightEngine({ launch: async () => r.browser })(init)
    await expect(engine.resolve([{ kind: "nth", index: 0 }])).rejects.toMatchObject({
      code: "LOCATOR_NOT_FOUND",
    })
  })

  test("snapshot is the body's accessibility outline, taken after hydration settles", async () => {
    const r = rig()
    r.probe = () => "pending"
    const engine = await playwrightEngine({ launch: async () => r.browser })(init)
    expect(await engine.snapshot()).toBe('- main:\n  - button "Go"')
    expect(r.calls.map((call) => call.op)).toEqual(["waitForSelector", "locator"])
    const off = await playwrightEngine({ launch: async () => r.browser })({
      ...init,
      hydration: "off",
    })
    r.calls.length = 0
    await off.snapshot()
    expect(r.calls.map((call) => call.op)).toEqual(["locator"])
  })

  test("an empty selector is refused", async () => {
    const r = rig()
    const engine = await playwrightEngine({ launch: async () => r.browser })(init)
    await expect(engine.resolve([])).rejects.toMatchObject({ code: "LOCATOR_NOT_FOUND" })
  })

  test("resolve reads visibility, text and value in the page", async () => {
    const r = rig()
    const box = (width: number, height: number) => ({
      getBoundingClientRect: () => ({ width, height }),
    })
    r.elements = [
      { ...box(10, 10), innerText: "Hi", value: "v", checkVisibility: () => true },
      { ...box(0, 10), innerText: "Zero" },
      { ...box(10, 10), textContent: "Fallback", checkVisibility: () => false },
      { ...box(10, 10), textContent: null },
    ]
    const engine = await playwrightEngine({ launch: async () => r.browser })(init)
    expect(await engine.resolve([{ kind: "testId", id: "x" }])).toEqual([
      { visible: true, text: "Hi", value: "v" },
      { visible: false, text: "Zero" },
      { visible: false, text: "Fallback" },
      { visible: true, text: "" },
    ])
  })

  test("act maps each action to its Playwright call with the timeout", async () => {
    const r = rig()
    const engine = await playwrightEngine({ launch: async () => r.browser })({
      ...init,
      hydration: "off",
    })
    const target = [{ kind: "testId", id: "t" }] as const
    await engine.act(target, { kind: "tap" }, 11)
    await engine.act(target, { kind: "fill", value: "v" }, 12)
    await engine.act(target, { kind: "press", key: "Enter" }, 13)
    expect(r.calls.filter((call) => ["click", "fill", "press"].includes(call.op))).toEqual([
      { op: "click", args: [{ timeout: 11 }] },
      { op: "fill", args: ["v", { timeout: 12 }] },
      { op: "press", args: ["Enter", { timeout: 13 }] },
    ])
  })

  test("act errors become codes; unknown errors pass through", async () => {
    const r = rig()
    const engine = await playwrightEngine({ launch: async () => r.browser })({
      ...init,
      hydration: "off",
    })
    const target = [{ kind: "testId", id: "t" }] as const
    r.actionError = new Error(
      "locator.click: Error: strict mode violation: getByTestId resolved to 2 elements",
    )
    await expect(engine.act(target, { kind: "tap" }, 1)).rejects.toMatchObject({
      code: "LOCATOR_AMBIGUOUS",
    })
    r.actionError = Object.assign(new Error("Timeout 1ms exceeded"), { name: "TimeoutError" })
    await expect(engine.act(target, { kind: "tap" }, 1)).rejects.toMatchObject({
      code: "LOCATOR_NOT_FOUND",
    })
    r.actionError = new Error("boom")
    await expect(engine.act(target, { kind: "tap" }, 1)).rejects.toThrow("boom")
    r.actionError = "odd"
    await expect(engine.act(target, { kind: "tap" }, 1)).rejects.toBe("odd")
  })

  test("goto waits for the hydration marker only on a page that loads a module script", async () => {
    const r = rig()
    const engine = await playwrightEngine({ launch: async () => r.browser })(init)
    r.probe = () => "none"
    await engine.goto("http://x/a")
    r.probe = () => "ready"
    await engine.goto("http://x/b")
    expect(r.calls.filter((call) => call.op === "waitForSelector")).toEqual([])
    r.probe = () => "pending"
    await engine.goto("http://x/c")
    expect(r.calls.filter((call) => call.op === "waitForSelector")).toEqual([
      {
        op: "waitForSelector",
        args: ["html[data-nifra-hydrated]", { state: "attached", timeout: 5000 }],
      },
    ])
    expect(await engine.url()).toBe("http://x/c")
  })

  test("a page that never hydrates is HYDRATION_TIMEOUT with the way out in the message", async () => {
    const r = rig()
    r.probe = () => "pending"
    r.waitFails = true
    const engine = await playwrightEngine({ launch: async () => r.browser, hydrationTimeout: 7 })(
      init,
    )
    const failure = await engine.goto("http://x/").catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(E2EError)
    expect(failure).toMatchObject({
      code: "HYDRATION_TIMEOUT",
      message: expect.stringContaining('within 7 ms; pass hydration: "off"'),
    })
  })

  test("hydration off never probes, and a probe lost to a navigation is retried after load", async () => {
    const r = rig()
    r.probe = () => new Error("Execution context was destroyed")
    const off = await playwrightEngine({ launch: async () => r.browser })({
      ...init,
      hydration: "off",
    })
    await off.goto("http://x/")
    expect(r.calls.map((call) => call.op)).toEqual(["goto"])

    const auto = await playwrightEngine({ launch: async () => r.browser })(init)
    await auto.act([{ kind: "testId", id: "t" }], { kind: "tap" }, 1)
    expect(r.calls.map((call) => call.op)).toContain("waitForLoadState")
  })

  test("cookies are scoped to the app origin; close releases context then browser", async () => {
    const r = rig()
    const engine = await playwrightEngine({ launch: async () => r.browser })({
      ...init,
      cookies: [{ name: "sid", value: "abc" }],
    })
    expect(r.calls[0]).toEqual({
      op: "addCookies",
      args: [[{ name: "sid", value: "abc", url: "http://127.0.0.1:1" }]],
    })
    await engine.close()
    expect(r.closed).toEqual(["context", "browser"])
  })

  test("a browser that cannot make a context is closed", async () => {
    const r = rig()
    r.contextError = new Error("no context")
    await expect(playwrightEngine({ launch: async () => r.browser })(init)).rejects.toThrow(
      "no context",
    )
    expect(r.closed).toEqual(["browser"])
  })

  test("a failure while preparing the page closes the browser and rethrows", async () => {
    const r = rig()
    r.cookieError = new Error("bad cookie")
    await expect(
      playwrightEngine({ launch: async () => r.browser })({
        ...init,
        cookies: [{ name: "a", value: "b" }],
      }),
    ).rejects.toThrow("bad cookie")
    expect(r.closed).toEqual(["browser"])
  })
})

describe("playwright loading", () => {
  test("a missing playwright package is ENGINE_MISSING", async () => {
    const load = async (): Promise<unknown> => {
      throw new Error("Cannot find package 'playwright'")
    }
    await expect(playwrightEngine({ load })(init)).rejects.toMatchObject({ code: "ENGINE_MISSING" })
  })

  test("launches the chosen browser type, headless by default", async () => {
    const r = rig()
    const launched: unknown[] = []
    const launcher = (name: string) => async (options: unknown) => {
      launched.push([name, options])
      return r.browser
    }
    const load = async () => ({
      chromium: { launch: launcher("chromium") },
      firefox: { launch: launcher("firefox") },
    })
    await playwrightEngine({ load })(init)
    await playwrightEngine({ load, browser: "firefox", headless: false })(init)
    expect(launched).toEqual([
      ["chromium", { headless: true }],
      ["firefox", { headless: false }],
    ])
  })

  test("a browser type the module lacks is ENGINE_MISSING", async () => {
    await expect(
      playwrightEngine({ load: async () => ({}), browser: "webkit" })(init),
    ).rejects.toMatchObject({
      code: "ENGINE_MISSING",
    })
  })
})

import { describe, expect, test } from "bun:test"
import { realClock } from "../src/engine.ts"
import { type FakeNode, fakeEngine } from "../src/fake.ts"
import {
  type Clock,
  E2EError,
  type Engine,
  expect as e2eExpect,
  Locator,
  type LocatorContext,
  Screen,
} from "../src/index.ts"

function virtualClock(
  onSleep?: (elapsed: number) => void,
): Clock & { readonly elapsed: () => number } {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms
      onSleep?.(t)
    },
    elapsed: () => t,
  }
}

const nodes: FakeNode[] = [
  { role: "heading", name: "Billing", text: "Billing" },
  {
    role: "list",
    children: [
      {
        role: "listitem",
        testId: "row",
        children: [{ text: "Design review" }, { role: "button", name: "Archive", text: "Archive" }],
      },
      {
        role: "listitem",
        testId: "row",
        children: [{ text: "Standup" }, { role: "button", name: "Archive", text: "Archive" }],
      },
    ],
  },
  { role: "textbox", name: "Email", label: "Email address", value: "" },
  { role: "button", name: "Sign in", text: "Sign in" },
  { role: "status", name: "Notice", text: "  Pro   plan  ", hidden: true },
  { role: "button", name: "Sign in again", text: "Sign in again" },
]

async function screenOver(
  pages: Record<string, FakeNode[]>,
  overrides: Partial<LocatorContext> = {},
): Promise<{ screen: Screen; context: LocatorContext; log: ReturnType<typeof fakeEngine>["log"] }> {
  const { factory, log } = fakeEngine({ pages })
  const engine = await factory({ baseUrl: "http://x", cookies: [], hydration: "off" })
  await engine.goto("http://x/")
  const context: LocatorContext = {
    engine,
    clock: virtualClock(),
    actionTimeout: 1000,
    assertionTimeout: 1000,
    pollInterval: 100,
    ...overrides,
  }
  return { screen: new Screen(context), context, log }
}

describe("locators over the fake engine", () => {
  test("role + name is a case-insensitive substring unless exact", async () => {
    const { screen } = await screenOver({ "/": nodes })
    expect(await screen.getByRole("button", "sign in").count()).toBe(2)
    expect(await screen.getByRole("button", { name: "Sign in", exact: true }).count()).toBe(1)
    expect(await screen.getByRole("button").count()).toBe(4)
  })

  test("label, text and testId finders", async () => {
    const { screen } = await screenOver({ "/": nodes })
    expect(await screen.getByLabel("email").count()).toBe(1)
    expect(await screen.getByLabel("Email address", { exact: true }).count()).toBe(1)
    expect(await screen.getByText("billing").count()).toBe(1)
    expect(await screen.getByTestId("row").count()).toBe(2)
  })

  test("filter and chaining scope into a row", async () => {
    const { screen } = await screenOver({ "/": nodes })
    const row = screen.getByTestId("row").filter({ hasText: "Design review" })
    expect(await row.count()).toBe(1)
    expect(await row.getByRole("button", "Archive").count()).toBe(1)
    expect(await screen.getByRole("list").getByRole("button", "Archive").count()).toBe(2)
  })

  test("nth picks one of several matches", async () => {
    const { screen } = await screenOver({ "/": nodes })
    const archive = screen.getByRole("list").getByRole("button", "Archive")
    expect(await archive.count()).toBe(2)
    expect(await archive.nth(1).count()).toBe(1)
    expect(await archive.nth(5).count()).toBe(0)
    await archive.nth(0).tap()
  })

  test("snapshot outlines visible nodes with role, name and text", async () => {
    const { context } = await screenOver({
      "/": [
        { role: "heading", name: "Billing", text: "Billing" },
        { text: "loose text" },
        { children: [{ role: "button", name: "Go" }] },
        { role: "dialog", hidden: true, children: [{ role: "button", name: "Close" }] },
      ],
    })
    expect(await context.engine.snapshot()).toBe(
      ['- heading "Billing": Billing', "- text: loose text", '- button "Go"'].join("\n"),
    )
  })

  test("a node matched through two ancestors is counted once", async () => {
    const { screen } = await screenOver({
      "/": [
        {
          role: "group",
          children: [{ role: "group", children: [{ role: "button", name: "Go" }] }],
        },
      ],
    })
    expect(await screen.getByRole("group").getByRole("button").count()).toBe(1)
  })

  test("hidden state propagates to descendants and reaches states()", async () => {
    const { screen } = await screenOver({
      "/": [{ role: "dialog", hidden: true, children: [{ role: "button", name: "Close" }] }],
    })
    expect(await screen.getByRole("button", "Close").states()).toEqual([
      { visible: false, text: "" },
    ])
  })

  test("describe() renders every step kind", async () => {
    const { screen } = await screenOver({ "/": nodes })
    const locator = screen
      .getByRole("list")
      .getByRole("listitem", "x")
      .getByLabel("l")
      .getByText("t")
      .getByTestId("id")
      .filter({ hasText: "h" })
      .nth(1)
    expect(locator.describe()).toBe(
      'role=list >> role=listitem[name="x"] >> label="l" >> text="t" >> testId="id" >> hasText="h" >> nth=1',
    )
  })

  test("tap, fill and press act on exactly one visible element", async () => {
    const { screen, log } = await screenOver({ "/": nodes })
    await screen.getByLabel("Email").fill("ada@example.test")
    await screen.getByRole("button", { name: "Sign in", exact: true }).tap()
    await screen.getByLabel("Email").press("Enter")
    expect(log.map((entry) => `${entry.kind}:${entry.detail}`)).toEqual([
      "goto:/",
      "fill:ada@example.test",
      "tap:",
      "press:Enter",
    ])
    expect(await screen.getByLabel("Email").states()).toEqual([
      { visible: true, text: "", value: "ada@example.test" },
    ])
  })

  test("act refuses ambiguity and absence with a code", async () => {
    const { screen } = await screenOver({ "/": nodes })
    await expect(screen.getByRole("button", "Sign in").tap()).rejects.toMatchObject({
      code: "LOCATOR_AMBIGUOUS",
    })
    await expect(screen.getByRole("button", "Nope").tap()).rejects.toMatchObject({
      code: "LOCATOR_NOT_FOUND",
    })
    await expect(screen.getByRole("status").tap()).rejects.toMatchObject({
      code: "LOCATOR_NOT_FOUND",
    })
  })

  test("a tap can navigate through onAct, and a missing page is NAVIGATION_FAILED", async () => {
    const { factory } = fakeEngine({
      pages: {
        "/": [{ role: "link", name: "Next" }],
        "/next": [{ role: "heading", name: "Done" }],
      },
      onAct: (node) => (node.name === "Next" ? "/next" : "/missing"),
    })
    const engine = await factory({ baseUrl: "http://x", cookies: [], hydration: "off" })
    await engine.goto("http://x/")
    await engine.act([{ kind: "role", role: "link" }], { kind: "tap" }, 10)
    expect(new URL(await engine.url()).pathname).toBe("/next")
    await expect(
      engine.act([{ kind: "role", role: "heading" }], { kind: "tap" }, 10),
    ).rejects.toMatchObject({
      code: "NAVIGATION_FAILED",
    })
    await expect(engine.goto("http://x/nope")).rejects.toBeInstanceOf(E2EError)
  })
})

describe("realClock", () => {
  test("reads the wall clock and sleep resolves", async () => {
    expect(typeof realClock.now()).toBe("number")
    await realClock.sleep(0)
  })
})

describe("expect", () => {
  test("passes at once without sleeping", async () => {
    const clock = virtualClock()
    const { screen } = await screenOver({ "/": nodes }, { clock })
    await e2eExpect(screen.getByRole("heading")).toBeVisible()
    await e2eExpect(screen.getByRole("heading")).toHaveText("billing".replace("b", "B"))
    await e2eExpect(screen.getByRole("heading")).toContainText(/ill/)
    await e2eExpect(screen.getByRole("heading")).toContainText("ill")
    await e2eExpect(screen.getByTestId("row")).toHaveCount(2)
    await e2eExpect(screen.getByRole("status")).toBeHidden()
    await e2eExpect(screen.getByRole("status")).toHaveText("Pro plan")
    await e2eExpect(screen.getByLabel("Email")).toHaveValue("")
    await e2eExpect(screen.getByLabel("Email")).toHaveValue(/^$/)
    expect(clock.elapsed()).toBe(0)
  })

  test("retries on the clock until the page settles", async () => {
    let ready = false
    const clock = virtualClock((elapsed) => {
      ready = elapsed >= 300
    })
    const engine: Engine = {
      goto: async () => {},
      url: async () => "http://x/",
      resolve: async () => (ready ? [{ visible: true, text: "Pro" }] : []),
      snapshot: async () => "",
      act: async () => {},
      close: async () => {},
    }
    const screen = new Screen({
      engine,
      clock,
      actionTimeout: 1,
      assertionTimeout: 1000,
      pollInterval: 100,
    })
    await e2eExpect(screen.getByRole("status")).toHaveText("Pro")
    expect(clock.elapsed()).toBe(300)
  })

  test("fails with the received value once the timeout passes", async () => {
    const clock = virtualClock()
    const { screen } = await screenOver({ "/": nodes }, { clock, assertionTimeout: 250 })
    const failure = await e2eExpect(screen.getByRole("heading"))
      .toHaveText("Pricing")
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(E2EError)
    expect(failure).toMatchObject({
      code: "EXPECT_FAILED",
      message: 'expected role=heading to have text Pricing, received "Billing" (after 250 ms)',
    })
    expect(clock.elapsed()).toBe(250)
  })

  test("per-assertion timeout overrides the session's", async () => {
    const clock = virtualClock()
    const { screen } = await screenOver({ "/": nodes }, { clock, assertionTimeout: 5000 })
    await expect(
      e2eExpect(screen.getByRole("heading")).toBeHidden({ timeout: 30 }),
    ).rejects.toThrow("after 30 ms")
    expect(clock.elapsed()).toBe(30)
  })

  test("not inverts a definite answer", async () => {
    const { screen } = await screenOver({ "/": nodes })
    await e2eExpect(screen.getByRole("heading")).not.toHaveText("Pricing")
    await e2eExpect(screen.getByRole("nothing")).not.toBeVisible()
    await e2eExpect(screen.getByRole("status")).not.toBeVisible()
    await expect(
      e2eExpect(screen.getByRole("heading")).not.toBeVisible({ timeout: 1 }),
    ).rejects.toThrow("expected not role=heading to be visible")
  })

  test("several elements are indeterminate for single-element matchers, even negated", async () => {
    const { screen } = await screenOver({ "/": nodes }, { assertionTimeout: 100 })
    const buttons = screen.getByRole("button")
    await expect(e2eExpect(buttons).toBeVisible()).rejects.toThrow("4 elements, expected one")
    await expect(e2eExpect(buttons).not.toBeVisible()).rejects.toThrow("4 elements, expected one")
    await expect(e2eExpect(buttons).toContainText("Sign")).rejects.toThrow("expected role=button")
    await e2eExpect(buttons).toHaveCount(4)
  })

  test("absent elements fail single-element matchers with 'no element'", async () => {
    const { screen } = await screenOver({ "/": nodes }, { assertionTimeout: 10 })
    await expect(e2eExpect(screen.getByRole("nothing")).toHaveValue("x")).rejects.toThrow(
      "received no element",
    )
  })

  test("toHaveURL compares a full URL, a path, or a pattern", async () => {
    const { context } = await screenOver({ "/": nodes })
    const source = {
      context: { ...context, assertionTimeout: 10 },
      url: async () => "http://x/a?b=1",
      path: async () => "/a?b=1",
    }
    await e2eExpect(source).toHaveURL("http://x/a?b=1")
    await e2eExpect(source).toHaveURL("/a?b=1")
    await e2eExpect(source).toHaveURL(/b=1$/)
    await e2eExpect(source).not.toHaveURL("/other")
    await expect(e2eExpect(source).toHaveURL("/other")).rejects.toThrow(
      "URL to be /other, received /a?b=1",
    )
  })

  test("a Locator built by hand works the same as one from the screen", async () => {
    const { context } = await screenOver({ "/": nodes })
    const locator = new Locator(context, [{ kind: "testId", id: "row" }])
    await e2eExpect(locator).toHaveCount(2)
  })
})

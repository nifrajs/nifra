/**
 * Partial prerendering's browser checks on the real router, in Chromium, Firefox and WebKit under
 * a hash-only CSP: a PPR page fills and hydrates its holes; leaving it, by hard-loaded beacon or by a
 * soft navigation's NDJSON abort, stops its pending hole loader on the server (latency measured); an
 * unrelated fetch survives; an unchecked shell renders blocking. Each hole is filled once whether it
 * arrives before or after hydration; a tampered invoker is blocked; fills work under enforced Trusted
 * Types; the router keeps the holes through a param change and back. Chromium also checks the heap and
 * listener count stay flat over 1000 soft navigations. Run: `bun packages/web/test/fixtures/ppr/app-browser.ts`, with
 * `FRAMEWORK=svelte` for the Svelte twin of the app.
 */
import assert from "node:assert/strict"
import { type Browser, type BrowserContext, chromium, firefox, type Page, webkit } from "playwright"
import { probe, releaseHeld } from "./app/lib/probe.ts"
import type { PprApp } from "./app/server.ts"

declare global {
  interface Window {
    __violations: string[]
    __fills: Record<string, number>
    __rewrites: Record<string, number>
    __subscribed: string[]
    __tampered?: number
  }
}

const NAVS = Number(process.env.NAVS ?? "1000")
const ENGINES = (process.env.ENGINES ?? "chromium,firefox,webkit").split(",")
const app: PprApp =
  process.env.FRAMEWORK === "svelte"
    ? await (await import("../../../../web-svelte/test/fixtures/ppr-app/server.ts")).startPprApp()
    : await (await import("./app/server.ts")).startPprApp()
const { origin } = app

assert.deepEqual(
  app.shellFailures.map(([routeId]) => routeId),
  ["leaky/[id]"],
  "only the leaky route fails its shell check",
)

/**
 * Records CSP violations; per hole, how often its host was marked filled and how often its children
 * changed after that; and which holes a hole component subscribed to, which it does only when it
 * mounts before its fill.
 */
const instrument = (context: BrowserContext) =>
  context.addInitScript(() => {
    window.__violations = []
    window.__fills = {}
    window.__rewrites = {}
    window.__subscribed = []
    document.addEventListener("securitypolicyviolation", (event) =>
      window.__violations.push(`${event.violatedDirective} ${event.blockedURI}`),
    )
    const bump = (counts: Record<string, number>, name: string) => {
      counts[name] = (counts[name] ?? 0) + 1
    }
    // Records arrive in order, and a fill writes the host's children before it marks it. A hole root
    // unmounting from a host the page has left is teardown, not a second fill.
    new MutationObserver((records) => {
      for (const record of records) {
        if (!(record.target instanceof Element)) continue
        const name = record.target.getAttribute("data-nifra-hole")
        if (name === null) continue
        if (record.type === "attributes") bump(window.__fills, name)
        else if (window.__fills[name] !== undefined && record.target.isConnected)
          bump(window.__rewrites, name)
      }
    }).observe(document, {
      subtree: true,
      childList: true,
      attributeFilter: ["data-nifra-filled"],
    })
    let runtime: unknown
    Object.defineProperty(window, "__nifraPpr", {
      configurable: true,
      get: () => runtime,
      set: (value: { subscribe: (name: string, callback: unknown) => unknown }) => {
        const subscribe = value.subscribe
        value.subscribe = (name, callback) => {
          window.__subscribed.push(name)
          return subscribe(name, callback)
        }
        runtime = value
      },
    })
  })

const hydrated = (page: Page) =>
  page.waitForFunction(() => document.documentElement.hasAttribute("data-nifra-hydrated"))

// The router owns link clicks once it has stamped the history entry. `data-nifra-hydrated` waits for an
// animation frame, and headless WebKit runs none until a streamed document ends.
const routed = (page: Page) =>
  page.waitForFunction(() => {
    const state: unknown = history.state
    return typeof state === "object" && state !== null && "nifraIndex" in state
  })

const filled = (page: Page, hole: string) =>
  page.waitForFunction(
    (name) =>
      document.querySelector(`[data-nifra-hole="${name}"]`)?.hasAttribute("data-nifra-filled"),
    hole,
  )

/**
 * A DOM click on a link. Playwright's own click hovers first, which starts the router's prefetch (no
 * abort signal: a finding of its own), and waits for two stable animation frames, which headless
 * WebKit does not run until a streamed document ends.
 */
const go = (page: Page, selector: string) =>
  page.evaluate((target) => document.querySelector<HTMLAnchorElement>(target)?.click(), selector)

/** Wall time from `before` until the server aborts its next slow loader. Same process, same clock. */
async function abortLatency(before: number, aborted: number): Promise<number> {
  const deadline = performance.now() + 5000
  while (probe.slowAborted === aborted) {
    if (performance.now() > deadline)
      throw new Error(`the slow loader was never aborted (${JSON.stringify(probe)})`)
    await Bun.sleep(1)
  }
  return (probe.abortedAt.at(-1) ?? Number.NaN) - before
}

async function checkEngine(name: string, browser: Browser): Promise<Record<string, unknown>> {
  const context = await browser.newContext()
  await context.addCookies([{ name: "name", value: "ada", url: origin }])
  await instrument(context)
  const page = await context.newPage()
  const errors: string[] = []
  let step = "A"
  page.on("pageerror", (error) => errors.push(`${step}: ${error.message}`))
  page.on("console", (message) => {
    if (message.type() === "error")
      errors.push(`${step}: ${message.text()} @ ${JSON.stringify(message.location())}`)
  })
  const report: Record<string, unknown> = { engine: name }

  // A: the shared shell, its holes filled, the interactive one hydrated as its own root.
  await page.goto(`${origin}/p/1`, { waitUntil: "commit" })
  await hydrated(page)
  for (const hole of ["greeting", "cart", "slow"]) await filled(page, hole)
  assert.equal(await page.textContent("#title"), "Product 1")
  assert.equal(await page.textContent("#greeting"), "hello ada", `${name}: the visitor's hole`)
  assert.equal(await page.textContent("#slow"), "slow 50")
  await page.waitForFunction(() => document.querySelector("#cart")?.textContent === "cart 2")
  await page.click("#cart")
  await page.waitForFunction(() => document.querySelector("#cart")?.textContent === "cart 3")
  report.hardLoad = "filled + interactive hole hydrated"

  step = "B"
  // B: leaving a hard-loaded PPR page with a hole pending sends the beacon; the server aborts it.
  await page.goto(`${origin}/p/1?slow=5000`, { waitUntil: "commit" })
  await routed(page)
  await filled(page, "greeting")
  let aborted = probe.slowAborted
  let before = performance.now()
  await go(page, "#to-other")
  report.beaconAbortMs = Math.round(await abortLatency(before, aborted))
  assert.equal(probe.cancels > 0, true, `${name}: the abort came through the cancel beacon`)
  await page.waitForSelector("#other")

  step = "C"
  // C: a soft navigation into the PPR route streams its holes as NDJSON; leaving it aborts the
  // data request, which aborts the loader through the request signal.
  await go(page, "#to-p2")
  await page.waitForFunction(() => document.querySelector("#greeting")?.textContent === "hello ada")
  await go(page, "#to-other")
  await page.waitForSelector("#other")
  aborted = probe.slowAborted
  await go(page, "#to-p2-slow")
  await page.waitForSelector("#title")
  await page.waitForFunction(() => document.querySelector("#greeting")?.textContent === "hello ada")
  before = performance.now()
  await go(page, "#to-other")
  report.ndjsonAbortMs = Math.round(await abortLatency(before, aborted))
  await page.waitForSelector("#other")

  step = "D"
  // D: an unrelated fetch in flight when the page leaves its PPR document still completes.
  await page.goto(`${origin}/p/1?slow=5000`, { waitUntil: "commit" })
  await routed(page)
  const unrelated = page.evaluate(() => fetch("/__unrelated").then((r) => r.text()))
  await go(page, "#to-other")
  assert.equal(await unrelated, "unrelated ok", `${name}: an unrelated fetch survives leaving`)
  report.unrelatedFetch = "survived"

  step = "E"
  // E: an unchecked shell renders blocking: no runtime, no frames, the page whole.
  const leaky = await (await page.request.get(`${origin}/leaky/1`)).text()
  assert.equal(leaky.includes("__nifraPpr"), false, `${name}: no shared shell without a check`)
  assert.equal(leaky.includes('id="leaky"'), true)

  const violations = await page.evaluate(() => window.__violations)
  assert.deepEqual(violations, [], `${name}: no CSP violations`)
  assert.deepEqual(errors, [], `${name}: no page or console errors`)
  await context.close()
  return report
}

/**
 * The paths that never stream holes: a listed bot gets the page whole, a browser without scripts
 * keeps each hole's fallback, and hovering a link prefetches no hole.
 */
async function checkWholePaths(name: string, browser: Browser): Promise<Record<string, unknown>> {
  const bot = await browser.newContext({ userAgent: "Slackbot-LinkExpanding 1.0" })
  await bot.addCookies([{ name: "name", value: "ada", url: origin }])
  await instrument(bot)
  const page = await bot.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(`${origin}/p/3?slow=40`)
  const whole = await page.evaluate(() => ({
    runtime: typeof Reflect.get(window, "__nifraPpr") === "function",
    greeting: document.querySelector("#greeting")?.textContent ?? null,
    slow: document.querySelector("#slow") !== null,
    fallbacks: document.querySelectorAll("[id$='-fallback']").length,
  }))
  assert.deepEqual(
    whole,
    { runtime: false, greeting: "hello ada", slow: true, fallbacks: 0 },
    `${name}: a bot gets every hole inline and no PPR runtime`,
  )
  await hydrated(page)
  await page.evaluate(() => document.querySelector<HTMLButtonElement>("#cart")?.click())
  await page.waitForFunction(() => document.querySelector("#cart")?.textContent === "cart 3")
  assert.deepEqual(await page.evaluate(() => window.__violations), [], `${name}: bot page CSP`)
  assert.deepEqual(errors, [], `${name}: bot page errors`)
  await bot.close()

  const noScript = await browser.newContext({ javaScriptEnabled: false })
  const plain = await noScript.newPage()
  await plain.goto(`${origin}/p/4?slow=40`)
  const placeholders = await plain.evaluate(() => ({
    fallback: document.querySelector("#slow-fallback") !== null,
    filled: document.querySelector("#slow") !== null,
  }))
  assert.deepEqual(
    placeholders,
    { fallback: true, filled: false },
    `${name}: no scripts, fallbacks stay`,
  )
  await noScript.close()

  const hover = await browser.newContext()
  const linked = await hover.newPage()
  await linked.goto(`${origin}/other`)
  await hydrated(linked)
  const started = probe.slowStarted
  const prefetched = linked.waitForRequest((request) => request.url().includes("/p/2?slow=5000"))
  await linked.hover("#to-p2-slow")
  await (await prefetched).response()
  assert.equal(probe.slowStarted, started, `${name}: a hover prefetch starts no hole`)
  await hover.close()
  return { engine: name, bot: "whole, hydrated", noScript: "fallbacks", prefetch: "no hole" }
}

/** A context with the visitor's cookie, the instrumentation and a list of page and console errors. */
async function visit(
  browser: Browser,
): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext()
  await context.addCookies([{ name: "name", value: "ada", url: origin }])
  await instrument(context)
  const page = await context.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  return { context, page, errors }
}

const ALL_HOLES = ["greeting", "cart", "slow"]

/** The policy the UI framework creates for its own templates; React creates none. */
const TRUSTED_TYPES_POLICY = process.env.FRAMEWORK === "svelte" ? "svelte-trusted-html" : ""
const once = Object.fromEntries(ALL_HOLES.map((hole) => [hole, 1]))

/** Every hole filled once and its children left alone after, with no CSP violation or error. */
async function assertFilledOnce(page: Page, errors: string[], label: string): Promise<void> {
  const seen = await page.evaluate(() => ({
    fills: window.__fills,
    rewrites: window.__rewrites,
    violations: window.__violations,
  }))
  assert.deepEqual(seen, { fills: once, rewrites: {}, violations: [] }, label)
  assert.deepEqual(errors, [], `${label}: no page or console errors`)
}

/** Each hole is filled once, and an interactive one hydrates, whether it arrives before or after hydration. */
async function checkHoleOrders(name: string, browser: Browser): Promise<Record<string, unknown>> {
  // Before: the app's scripts wait until every hole is filled, so each hole component mounts on a fill.
  const before = await visit(browser)
  let openScripts = (): void => {}
  const scriptsHeld = new Promise<void>((resolve) => {
    openScripts = resolve
  })
  await before.page.route(
    (url) => url.pathname.startsWith("/assets/") && url.pathname.endsWith(".js"),
    async (route) => {
      await scriptsHeld
      await route.continue()
    },
  )
  await before.page.goto(`${origin}/p/6`, { waitUntil: "commit" })
  for (const hole of ALL_HOLES) await filled(before.page, hole)
  assert.equal(
    await before.page.evaluate(() => document.documentElement.hasAttribute("data-nifra-hydrated")),
    false,
    `${name}: every hole filled before hydration`,
  )
  openScripts()
  await hydrated(before.page)
  await before.page.click("#cart")
  await before.page.waitForFunction(() => document.querySelector("#cart")?.textContent === "cart 3")
  assert.deepEqual(
    await before.page.evaluate(() => window.__subscribed),
    [],
    `${name}: no hole waited`,
  )
  await assertFilledOnce(before.page, before.errors, `${name}: holes filled before hydration`)
  await before.context.close()

  // After: the cart hole's loader waits until its component has mounted and subscribed.
  const after = await visit(browser)
  await after.page.goto(`${origin}/p/7?hold`, { waitUntil: "commit" })
  await after.page.waitForFunction(() => window.__subscribed.includes("cart"))
  assert.equal(
    await after.page.evaluate(() =>
      document.querySelector("[data-nifra-hole=cart]")?.hasAttribute("data-nifra-filled"),
    ),
    false,
  )
  assert.equal(releaseHeld(), 1, `${name}: one held cart loader`)
  await filled(after.page, "cart")
  await after.page.waitForFunction(() => document.querySelector("#cart")?.textContent === "cart 2")
  await after.page.click("#cart")
  await after.page.waitForFunction(() => document.querySelector("#cart")?.textContent === "cart 3")
  await filled(after.page, "slow")
  await assertFilledOnce(after.page, after.errors, `${name}: cart filled after hydration`)
  await after.context.close()
  return { engine: name, holeOrders: "filled once, hydrated, both orders" }
}

/**
 * An invoker whose text differs from the one listed by hash does not run, and enforced Trusted Types
 * still let the runtime fill holes while a raw HTML string is refused.
 */
async function checkScriptPolicy(name: string, browser: Browser): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = { engine: name }
  const tampered = await visit(browser)
  const invoker = '<script>__nifraPpr("greeting")</script>'
  let replaced = false
  await tampered.page.route(`${origin}/p/8`, async (route) => {
    const response = await route.fetch()
    const html = await response.text()
    replaced = html.includes(invoker)
    const body = html.replace(
      invoker,
      '<script>__nifraPpr("greeting");window.__tampered=1</script>',
    )
    await route.fulfill({ response, body })
  })
  await tampered.page.goto(`${origin}/p/8`)
  assert.equal(replaced, true, `${name}: the document carried the greeting invoker`)
  for (const hole of ["cart", "slow"]) await filled(tampered.page, hole)
  await tampered.page.waitForFunction(() => window.__violations.length > 0)
  const blocked = await tampered.page.evaluate(() => ({
    ran: window.__tampered !== undefined,
    greeting: document
      .querySelector("[data-nifra-hole=greeting]")
      ?.hasAttribute("data-nifra-filled"),
    violations: window.__violations.map((violation) => violation.split(" ")[0]),
  }))
  assert.deepEqual(
    { ran: blocked.ran, greeting: blocked.greeting },
    { ran: false, greeting: false },
    `${name}: a tampered invoker does not run`,
  )
  assert.ok(
    blocked.violations.every((directive) => directive?.startsWith("script-src")),
    `${name}: ${blocked.violations.join(", ")}`,
  )
  report.tamperedInvoker = `blocked (${blocked.violations.join(", ")})`
  await tampered.context.close()

  const typed = await visit(browser)
  await typed.page.route(`${origin}/p/9`, async (route) => {
    const response = await route.fetch()
    const headers = response.headers()
    headers["content-security-policy"] =
      `${headers["content-security-policy"]}; require-trusted-types-for 'script'; trusted-types nifra-ppr ${TRUSTED_TYPES_POLICY}`
    await route.fulfill({ response, headers })
  })
  await typed.page.goto(`${origin}/p/9`, { waitUntil: "commit" })
  if (!(await typed.page.evaluate(() => "trustedTypes" in window))) {
    report.trustedTypes = "not supported by this engine"
    await typed.context.close()
    return report
  }
  await hydrated(typed.page)
  for (const hole of ALL_HOLES) await filled(typed.page, hole)
  await typed.page.click("#cart")
  await typed.page.waitForFunction(() => document.querySelector("#cart")?.textContent === "cart 3")
  await assertFilledOnce(typed.page, typed.errors, `${name}: fills under Trusted Types`)
  await go(typed.page, "#to-other")
  await typed.page.waitForSelector("#other")
  await go(typed.page, "#to-p2")
  await typed.page.waitForFunction(
    () => document.querySelector("#greeting")?.textContent === "hello ada",
  )
  assert.deepEqual(
    await typed.page.evaluate(() => window.__violations),
    [],
    `${name}: soft navigations under Trusted Types`,
  )
  assert.deepEqual(typed.errors, [], `${name}: soft navigation errors under Trusted Types`)
  await typed.page.evaluate(() => {
    try {
      document.createElement("div").innerHTML = "<i>raw</i>"
    } catch {}
  })
  await typed.page.waitForFunction(() => window.__violations.length > 0)
  assert.deepEqual(
    await typed.page.evaluate(() =>
      window.__violations.map((violation) => violation.split(" ")[0]),
    ),
    ["require-trusted-types-for"],
    `${name}: a raw HTML string is refused and reported`,
  )
  report.trustedTypes = "fills work, raw HTML reported"
  await typed.context.close()
  return report
}

/** The router keeps a PPR page's holes through a param change and through going away and back. */
async function checkRouter(name: string, browser: Browser): Promise<Record<string, unknown>> {
  const { context, page, errors } = await visit(browser)
  const shows = (title: string) =>
    page.waitForFunction(
      (expected) =>
        document.querySelector("#title")?.textContent === expected &&
        document.querySelector("#greeting")?.textContent === "hello ada" &&
        document.querySelector("#cart")?.textContent === "cart 2" &&
        document.querySelector("#slow")?.textContent === "slow 50",
      title,
    )
  await page.goto(`${origin}/p/1`, { waitUntil: "commit" })
  await hydrated(page)
  await shows("Product 1")
  await go(page, "#to-p2")
  await shows("Product 2")
  await page.click("#cart")
  await page.waitForFunction(() => document.querySelector("#cart")?.textContent === "cart 3")
  await go(page, "#to-other")
  await page.waitForSelector("#other")
  await page.evaluate(() => history.back())
  await shows("Product 2")
  await page.evaluate(() => history.back())
  await shows("Product 1")
  await page.evaluate(() => history.forward())
  await shows("Product 2")
  assert.deepEqual(await page.evaluate(() => window.__violations), [], `${name}: router CSP`)
  assert.deepEqual(errors, [], `${name}: router errors`)
  await context.close()
  return { engine: name, router: "param change, back, back, forward" }
}

/** Soft navigations between the PPR route and another page; the heap after a forced GC must stay flat. */
async function checkHeap(browser: Browser): Promise<Record<string, unknown>> {
  const context = await browser.newContext()
  await context.addCookies([{ name: "name", value: "ada", url: origin }])
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await page.goto(`${origin}/p/1`, { waitUntil: "commit" })
  await hydrated(page)
  for (const hole of ["greeting", "cart", "slow"]) await filled(page, hole)
  const navigate = (count: number) =>
    page.evaluate(async (n) => {
      const until = (test: () => boolean) =>
        new Promise<void>((resolve) => {
          const tick = () => (test() ? resolve() : requestAnimationFrame(tick))
          tick()
        })
      for (let i = 0; i < n; i++) {
        document.querySelector<HTMLAnchorElement>("#to-other")?.click()
        await until(() => document.querySelector("#other") !== null)
        document.querySelector<HTMLAnchorElement>(i % 2 === 0 ? "#to-p1" : "#to-p2")?.click()
        await until(() => document.querySelector("#slow") !== null)
      }
    }, count)
  const heap = async (): Promise<number> => {
    await cdp.send("HeapProfiler.collectGarbage")
    await cdp.send("HeapProfiler.collectGarbage")
    const { usedSize } = await cdp.send("Runtime.getHeapUsage")
    return usedSize
  }
  await navigate(100)
  const warm = await heap()
  const warmCounters = await cdp.send("Memory.getDOMCounters")
  const started = performance.now()
  await navigate(NAVS / 2)
  const after = await heap()
  const afterCounters = await cdp.send("Memory.getDOMCounters")
  const growth = after - warm
  const budget = Math.max(warm * 0.05, 2 * 1024 * 1024)
  assert.ok(
    growth <= budget,
    `heap grew ${growth} B over ${NAVS} soft navigations (budget ${budget})`,
  )
  // Every listener and node of a page left behind is gone once it is collected.
  assert.ok(
    afterCounters.jsEventListeners - warmCounters.jsEventListeners <= 5 &&
      afterCounters.nodes - warmCounters.nodes <= 50,
    `listeners ${warmCounters.jsEventListeners} -> ${afterCounters.jsEventListeners}, nodes ${warmCounters.nodes} -> ${afterCounters.nodes}`,
  )
  await context.close()
  return {
    softNavs: NAVS,
    heapWarmKB: Math.round(warm / 1024),
    heapAfterKB: Math.round(after / 1024),
    growthKB: Math.round(growth / 1024),
    msPerNav: Number(((performance.now() - started) / NAVS).toFixed(2)),
    listeners: [warmCounters.jsEventListeners, afterCounters.jsEventListeners],
    nodes: [warmCounters.nodes, afterCounters.nodes],
    documents: [warmCounters.documents, afterCounters.documents],
  }
}

try {
  for (const [name, type] of [
    ["chromium", chromium],
    ["firefox", firefox],
    ["webkit", webkit],
  ] as const) {
    if (!ENGINES.includes(name)) continue
    const browser = await type.launch({ headless: true })
    try {
      console.log(JSON.stringify(await checkEngine(name, browser)))
      console.log(JSON.stringify(await checkWholePaths(name, browser)))
      console.log(JSON.stringify(await checkHoleOrders(name, browser)))
      console.log(JSON.stringify(await checkScriptPolicy(name, browser)))
      console.log(JSON.stringify(await checkRouter(name, browser)))
      if (name === "chromium") console.log(JSON.stringify(await checkHeap(browser)))
    } finally {
      await browser.close()
    }
  }
  assert.deepEqual(
    app.warnings.filter((w) => w.includes("leaky")).length,
    1,
    "one warning per route",
  )
} finally {
  await app.stop()
}

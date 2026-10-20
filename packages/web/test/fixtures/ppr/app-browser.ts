/**
 * G6 Phase 1a exit checks on the real router (plan section 16), in Chromium, Firefox and WebKit under
 * a hash-only CSP: a PPR page fills and hydrates its holes; leaving it, by hard-loaded beacon or by a
 * soft navigation's NDJSON abort, stops its pending hole loader on the server (latency measured); an
 * unrelated fetch survives; an unchecked shell renders blocking. Chromium also checks the heap stays
 * flat over 1000 soft navigations. Run: `bun packages/web/test/fixtures/ppr/app-browser.ts`.
 */
import assert from "node:assert/strict"
import { type Browser, chromium, firefox, type Page, webkit } from "playwright"
import { probe } from "./app/lib/probe.ts"
import { startPprApp } from "./app/server.ts"

declare global {
  interface Window {
    __violations: string[]
  }
}

const NAVS = Number(process.env.NAVS ?? "1000")
const ENGINES = (process.env.ENGINES ?? "chromium,firefox,webkit").split(",")
const app = await startPprApp()
const { origin } = app

assert.deepEqual(
  app.shellFailures.map(([routeId]) => routeId),
  ["leaky/[id]"],
  "only the leaky route fails its shell check",
)

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
  await context.addInitScript(() => {
    window.__violations = []
    document.addEventListener("securitypolicyviolation", (event) =>
      window.__violations.push(`${event.violatedDirective} ${event.blockedURI}`),
    )
  })
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
 * keeps each hole's fallback, and hovering a link prefetches no hole (13.2).
 */
async function checkWholePaths(name: string, browser: Browser): Promise<Record<string, unknown>> {
  const bot = await browser.newContext({ userAgent: "Slackbot-LinkExpanding 1.0" })
  await bot.addCookies([{ name: "name", value: "ada", url: origin }])
  await bot.addInitScript(() => {
    window.__violations = []
    document.addEventListener("securitypolicyviolation", (event) =>
      window.__violations.push(`${event.violatedDirective} ${event.blockedURI}`),
    )
  })
  const page = await bot.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(`${origin}/p/3?slow=40`)
  const whole = await page.evaluate(() => ({
    runtime: "__nifraPpr" in window,
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
  const started = performance.now()
  await navigate(NAVS / 2)
  const after = await heap()
  const growth = after - warm
  const budget = Math.max(warm * 0.05, 2 * 1024 * 1024)
  assert.ok(
    growth <= budget,
    `heap grew ${growth} B over ${NAVS} soft navigations (budget ${budget})`,
  )
  await context.close()
  return {
    softNavs: NAVS,
    heapWarmKB: Math.round(warm / 1024),
    heapAfterKB: Math.round(after / 1024),
    growthKB: Math.round(growth / 1024),
    msPerNav: Number(((performance.now() - started) / NAVS).toFixed(2)),
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

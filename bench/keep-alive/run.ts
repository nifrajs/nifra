/**
 * Keep-alive against a page that does not keep alive, React and Svelte, 1,000 rows (~7,000 nodes), in
 * Chromium. Exits 1 when a result misses its bound.
 *
 *   bun bench/keep-alive/run.ts                     restore, latency and memory
 *   bun bench/keep-alive/run.ts restore|latency|memory
 *
 * - restore: from `popstate` to the kept page shown with style and layout done, against the same page
 *   re-rendered from its data once that data has arrived (the fetch is left out, so the re-render is
 *   its best case). 3 warm-up and 15 timed cycles, three interleaved runs; bound 1.1x in every run.
 * - latency: the same back navigation with 100 ms on every data response: time to the page's content,
 *   kept (revalidating) against not kept. Bound 0.25x.
 * - memory: three pages left behind, then a light page, after three forced GCs; V8 plus Blink heap,
 *   median of 3, (kept - not kept) / 3, scaled to a 6,200-node page. Bound 3.5 MiB (React), 2 MiB
 *   (Svelte).
 *
 * View transitions are off, as each one holds a page swap for a frame first. Absolute times move with
 * machine load; the ratios are paired within a run.
 */
import { join } from "node:path"
import { type Browser, chromium, type Page } from "playwright"
import { findChrome } from "../../packages/cli/test/headless-chrome.ts"
import { LATENCY_PATH } from "../../packages/web/test/keep-alive-app.ts"

type Renderer = "react" | "svelte"
const RENDERERS: readonly Renderer[] = ["react", "svelte"]
const MEMORY_BOUND_MIB: Record<Renderer, number> = { react: 3.5, svelte: 2 }
const BOUND_NODES = 6200
const RESTORE_BOUND = 1.1
const LATENCY_BOUND = 0.25
const WARMUP = 3
const CYCLES = 15
const LATENCY_CYCLES = 10
const RUNS = 3
const HIDDEN_MS = 300
const TITLE = "h1#title"

interface Settled {
  readonly ms: number
  readonly at: number
}
interface Bench {
  go(path: string, selector: string, text: string): Promise<Settled>
  back(selector: string, text: string): Promise<Settled>
  dataEnd(path: string): number | null
}

// Runs in the page before the app's own scripts, so its `popstate` listener fires before the router's.
const instrument = (): void => {
  // A navigation's page swap runs inside a view transition where the browser has them, and its callback
  // waits for a frame that captures the old page: that frame is not the restore or the render timed.
  Object.defineProperty(document, "startViewTransition", { value: undefined })
  let popped = 0
  addEventListener("popstate", () => {
    popped = performance.now()
  })
  const shows = (selector: string, text: string): boolean => {
    for (const element of document.querySelectorAll(selector))
      if (element.textContent === text && element.checkVisibility()) return true
    return false
  }
  // Resolves once the element shows, its style and layout done. A mutation record is delivered in the
  // task that made the change, before the browser can render a frame, so no paint is ever timed.
  const settle = (selector: string, text: string, since: () => number): Promise<Settled> =>
    new Promise((resolve, reject) => {
      const finish = (): void => {
        const t0 = since()
        if (t0 === 0 || !shows(selector, text)) return
        observer.disconnect()
        clearTimeout(timeout)
        void document.body.getBoundingClientRect().height
        const at = performance.now()
        resolve({ ms: at - t0, at })
      }
      const observer = new MutationObserver(finish)
      observer.observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      })
      const timeout = setTimeout(() => {
        observer.disconnect()
        reject(new Error(`never showed ${text}`))
      }, 10_000)
    })
  const bench: Bench = {
    go: (path, selector, text) => {
      const link = document.createElement("a")
      link.href = path
      document.body.append(link)
      let t0 = 0
      const settled = settle(selector, text, () => t0)
      t0 = performance.now()
      link.click()
      link.remove()
      return settled
    },
    back: (selector, text) => {
      const before = popped
      const settled = settle(selector, text, () => (popped === before ? 0 : popped))
      history.back()
      return settled
    },
    dataEnd: (path) => {
      const entries = performance
        .getEntriesByType("resource")
        .filter(
          (entry): entry is PerformanceResourceTiming =>
            entry instanceof PerformanceResourceTiming && new URL(entry.name).pathname === path,
        )
      performance.clearResourceTimings()
      return entries.at(-1)?.responseEnd ?? null
    },
  }
  Object.assign(window, { __bench: bench })
}

const call = <K extends keyof Bench>(
  page: Page,
  method: K,
  ...args: Parameters<Bench[K]>
): Promise<Awaited<ReturnType<Bench[K]>>> =>
  page.evaluate(
    ({ name, rest }) =>
      Reflect.apply(Reflect.get(Reflect.get(window, "__bench"), name), undefined, rest),
    { name: method, rest: args },
  )

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  const at = (index: number): number => sorted[index] ?? Number.NaN
  return sorted.length % 2 === 1 ? at(middle) : (at(middle - 1) + at(middle)) / 2
}

async function serve(renderer: Renderer): Promise<{ url: string; stop(): void }> {
  const child = Bun.spawn(["bun", join(import.meta.dir, "serve.ts"), renderer], {
    stdout: "pipe",
    stderr: "inherit",
  })
  const reader = child.stdout.getReader()
  let text = ""
  while (!text.includes("\n")) {
    const { value, done } = await reader.read()
    if (done) throw new Error(`the ${renderer} bench app exited before listening`)
    text += new TextDecoder().decode(value)
  }
  reader.releaseLock()
  const { url }: { url: string } = JSON.parse(text.slice(0, text.indexOf("\n")))
  return { url, stop: () => child.kill() }
}

async function launch(): Promise<Browser> {
  const chrome = findChrome()
  try {
    return await chromium.launch({ headless: true })
  } catch (error) {
    if (chrome === undefined) throw error
    return chromium.launch({ headless: true, executablePath: chrome })
  }
}

async function open(browser: Browser, url: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } })
  await context.addInitScript(instrument)
  const page = await context.newPage()
  page.on("pageerror", (error) => console.error("pageerror", error.message))
  await page.goto(`${url}/away`)
  // A client navigation has to work before anything is timed.
  await page.waitForFunction(() => document.documentElement.hasAttribute("data-nifra-hydrated"))
  return page
}

/** Show `route` page `i`, leave it, come back: the back navigation's times. */
async function cycle(
  page: Page,
  route: string,
  i: number,
): Promise<{ total: number; render: number | null }> {
  const path = `/${route}/${i}`
  await call(page, "go", path, TITLE, `List ${i}`)
  await call(page, "go", "/away", ".away", "away")
  await page.waitForTimeout(HIDDEN_MS)
  await call(page, "dataEnd", path)
  const shown = await call(page, "back", TITLE, `List ${i}`)
  const end = await call(page, "dataEnd", path)
  return { total: shown.ms, render: end === null ? null : shown.at - end }
}

interface Row {
  readonly label: string
  readonly value: string
  readonly pass: boolean
}

async function restore(browser: Browser, urls: Record<Renderer, string>): Promise<Row[]> {
  const rows: Row[] = []
  const combos = RENDERERS.flatMap((renderer) =>
    ["list", "plain"].map((route) => ({ renderer, route })),
  )
  const results = new Map<string, { kept: number; render: number; total: number }[]>()
  for (let run = 0; run < RUNS; run++) {
    const order = [...combos.slice(run), ...combos.slice(0, run)]
    const medians: Record<string, { total: number; render: number }> = {}
    for (const { renderer, route } of order) {
      const page = await open(browser, urls[renderer])
      const total: number[] = []
      const render: number[] = []
      for (let i = 1; i <= WARMUP + CYCLES; i++) {
        const times = await cycle(page, route, i)
        if (i <= WARMUP) continue
        total.push(times.total)
        if (times.render !== null) render.push(times.render)
      }
      await page.context().close()
      if (route === "plain" && render.length < CYCLES)
        throw new Error(`${renderer}: ${CYCLES - render.length} re-renders had no data response`)
      medians[`${renderer}/${route}`] = { total: median(total), render: median(render) }
    }
    for (const renderer of RENDERERS) {
      const kept = medians[`${renderer}/list`]?.total ?? Number.NaN
      const plain = medians[`${renderer}/plain`] ?? { render: Number.NaN, total: Number.NaN }
      const list = results.get(renderer) ?? []
      list.push({ kept, render: plain.render, total: plain.total })
      results.set(renderer, list)
    }
  }
  for (const renderer of RENDERERS) {
    const runs = results.get(renderer) ?? []
    const ratios = runs.map((r) => r.kept / r.render)
    rows.push({
      label: `restore ${renderer}`,
      value: runs
        .map(
          (r, i) =>
            `run ${i + 1}: kept ${r.kept.toFixed(1)} ms, re-render ${r.render.toFixed(1)} ms (with fetch ${r.total.toFixed(1)}), ${(ratios[i] ?? 0).toFixed(2)}x`,
        )
        .join("; "),
      pass: ratios.every((ratio) => ratio <= RESTORE_BOUND),
    })
  }
  return rows
}

async function latency(browser: Browser, urls: Record<Renderer, string>): Promise<Row[]> {
  const rows: Row[] = []
  for (const renderer of RENDERERS) {
    await fetch(`${urls[renderer]}${LATENCY_PATH}?ms=100`)
    const medians: Record<string, number> = {}
    for (const route of ["fresh", "plain"]) {
      const page = await open(browser, urls[renderer])
      const times: number[] = []
      for (let i = 1; i <= WARMUP + LATENCY_CYCLES; i++) {
        const { total } = await cycle(page, route, i)
        // The kept page's revalidation lands before the next cycle starts.
        await page.waitForTimeout(250)
        if (i > WARMUP) times.push(total)
      }
      await page.context().close()
      medians[route] = median(times)
    }
    await fetch(`${urls[renderer]}${LATENCY_PATH}?ms=0`)
    const kept = medians.fresh ?? Number.NaN
    const plain = medians.plain ?? Number.NaN
    rows.push({
      label: `latency ${renderer}`,
      value: `kept ${kept.toFixed(1)} ms, not kept ${plain.toFixed(1)} ms, ${(kept / plain).toFixed(2)}x`,
      pass: kept / plain <= LATENCY_BOUND,
    })
  }
  return rows
}

async function memory(browser: Browser, urls: Record<Renderer, string>): Promise<Row[]> {
  const rows: Row[] = []
  for (const renderer of RENDERERS) {
    const samples: Record<string, { heap: number; nodes: number }[]> = { list: [], plain: [] }
    for (let run = 0; run < 3; run++)
      for (const route of run % 2 === 0 ? ["list", "plain"] : ["plain", "list"]) {
        const page = await open(browser, urls[renderer])
        for (const i of [1, 2, 3]) await call(page, "go", `/${route}/${i}`, TITLE, `List ${i}`)
        await call(page, "go", "/light", ".light", "light")
        await page.waitForTimeout(100)
        const cdp = await page.context().newCDPSession(page)
        for (let i = 0; i < 3; i++) await cdp.send("HeapProfiler.collectGarbage")
        const heap = await cdp.send("Runtime.getHeapUsage")
        const dom = await cdp.send("Memory.getDOMCounters")
        samples[route]?.push({
          heap: heap.usedSize + (heap.backingStorageSize ?? 0) + (heap.embedderHeapUsedSize ?? 0),
          nodes: dom.nodes,
        })
        await page.context().close()
      }
    const med = (route: string, key: "heap" | "nodes") =>
      median((samples[route] ?? []).map((sample) => sample[key]))
    const perPage = (med("list", "heap") - med("plain", "heap")) / 3 / 2 ** 20
    const nodes = (med("list", "nodes") - med("plain", "nodes")) / 3
    // The bounds are for a 6,200-node page; the cost is per node, so it scales to that size.
    const scaled = (perPage * BOUND_NODES) / nodes
    rows.push({
      label: `memory ${renderer}`,
      value: `${perPage.toFixed(2)} MiB per kept page of ${nodes.toFixed(0)} nodes, ${scaled.toFixed(2)} MiB at ${BOUND_NODES}, bound ${MEMORY_BOUND_MIB[renderer]} MiB`,
      pass: scaled <= MEMORY_BOUND_MIB[renderer],
    })
  }
  return rows
}

const only = process.argv[2]
const servers = await Promise.all(RENDERERS.map(serve))
const urls = { react: servers[0]?.url ?? "", svelte: servers[1]?.url ?? "" }
const browser = await launch()
const rows: Row[] = []
try {
  if (only === undefined || only === "restore") rows.push(...(await restore(browser, urls)))
  if (only === undefined || only === "latency") rows.push(...(await latency(browser, urls)))
  if (only === undefined || only === "memory") rows.push(...(await memory(browser, urls)))
} finally {
  await browser.close()
  for (const server of servers) server.stop()
}
for (const row of rows) console.log(`${row.pass ? "pass" : "FAIL"} | ${row.label} | ${row.value}`)
if (rows.some((row) => !row.pass)) process.exit(1)

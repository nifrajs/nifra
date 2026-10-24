/**
 * What structural sharing costs a reload of the page on screen (D11), per payload size: today's parse
 * (`parsePageData`, with `t.date()` revival) against the sharing path the router now takes (the same
 * response text again reuses the data on screen; any other text is parsed, then shared). Rounds
 * alternate the two, and each cell is the median of its rounds.
 *
 *   bun bench/share/cost.ts
 *   node bench/share/cost.ts
 *   bun bench/share/cost.ts --browsers     (chromium, webkit and firefox, through playwright)
 */
import { parsePageData } from "../../packages/web/src/internal/revive-dates.ts"
import { shareData } from "../../packages/web/src/internal/share-data.ts"

type Kind = "unchanged" | "one row" | "every row" | "prepend" | "rotating ids"
const KINDS: readonly Kind[] = ["unchanged", "one row", "every row", "prepend", "rotating ids"]

// A list page's response text, as the server writes it: rows with a nested owner and a dated field.
const page = (rows: number, kind: Kind | "base" | "small"): string => {
  // Minimal rows make indexing overhead visible instead of hiding it behind Date revival.
  if (kind === "small" || kind === "rotating ids")
    return JSON.stringify({
      v: 1,
      data: {
        items: Array.from({ length: rows }, (_, i) => ({
          id: i + (kind === "rotating ids" ? rows : 0),
          label: `row ${i}`,
        })),
      },
    })
  const items = []
  const start = kind === "prepend" ? -1 : 0
  for (let i = start; i < rows + start; i++)
    items.push({
      id: i,
      label: `Item ${i}${kind === "one row" && i === 3 ? " (changed)" : ""}${kind === "every row" ? " r2" : ""}`,
      price: (i * 1.37).toFixed(2),
      tags: ["a", "b"],
      owner: { id: i % 17, name: `user ${i % 17}` },
      at: { __nifra_date: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString() },
    })
  return JSON.stringify({ v: 1, data: { title: "List", items }, layoutData: [{ nav: ["home"] }] })
}

// Microseconds per call, timing at least `budgetMs` of calls.
const time = (fn: () => unknown, budgetMs: number): number => {
  for (let i = 0; i < 3; i++) fn()
  let n = 0
  const start = performance.now()
  let now = start
  while (now - start < budgetMs || n < 5) {
    fn()
    n++
    now = performance.now()
  }
  return ((now - start) / n) * 1000
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN
}

const itemsOf = (payload: unknown): unknown[] => {
  const items: unknown = Reflect.get(Object(Reflect.get(Object(payload), "data")), "items")
  return Array.isArray(items) ? items : []
}

const kept = (prev: unknown, next: unknown): string => {
  const before = new Set(itemsOf(prev))
  const after = itemsOf(next)
  return `${Math.round((after.filter((item) => before.has(item)).length / after.length) * 100)}%`
}

export function runCost(log: (line: string) => void, rounds = 7): void {
  log("rows (KiB) | reload | today ms | sharing ms | sharing / today | rows kept")
  for (const rows of [1000, 5000, 50000]) {
    const budget = rows >= 50000 ? 150 : 60
    for (const kind of KINDS) {
      const shownText = page(rows, kind === "rotating ids" ? "small" : "base")
      const shown = parsePageData(shownText)
      // A new string with the same content, as a second response is.
      const text = kind === "unchanged" ? `${page(rows, "base")} `.trimEnd() : page(rows, kind)
      const sharing = (): unknown =>
        text === shownText ? shown : shareData(shown, parsePageData(text), true)
      const today: number[] = []
      const now: number[] = []
      for (let round = 0; round < rounds; round++) {
        // Alternate which runs first, so neither always gets the warmer cache.
        if (round % 2 === 0) {
          today.push(time(() => parsePageData(text), budget))
          now.push(time(sharing, budget))
        } else {
          now.push(time(sharing, budget))
          today.push(time(() => parsePageData(text), budget))
        }
      }
      const t = median(today)
      const s = median(now)
      log(
        [
          `${rows} (${Math.round(text.length / 1024)})`,
          kind,
          (t / 1000).toFixed(3),
          (s / 1000).toFixed(3),
          `${((s / t) * 100).toFixed(1)}%`,
          kept(shown, sharing()),
        ].join(" | "),
      )
    }
  }
}

// The part of Playwright's API this bench drives; the root tsconfig cannot resolve its types.
type Launcher = {
  launch(options: { headless: boolean }): Promise<{
    newPage(): Promise<{
      setContent(html: string): Promise<void>
      addScriptTag(tag: { content: string; type: string }): Promise<unknown>
      waitForFunction(
        test: () => unknown,
        arg: undefined,
        options: { timeout: number },
      ): Promise<unknown>
      evaluate(read: () => unknown): Promise<unknown>
    }>
    version(): string
    close(): Promise<void>
  }>
}

const runtime =
  typeof Bun !== "undefined"
    ? `bun ${Bun.version}`
    : typeof process === "undefined"
      ? "browser"
      : `node ${process.version}`

if (typeof document === "undefined" && !process.argv.includes("--browsers")) {
  console.log(runtime)
  runCost(console.log)
} else if (typeof document === "undefined") {
  const built = await Bun.build({
    entrypoints: [new URL(import.meta.url).pathname],
    target: "browser",
    minify: true,
  })
  const script = await built.outputs[0]?.text()
  // `playwright` is a devDependency of `@nifrajs/web`, the package whose router this measures.
  const { createRequire } = await import("node:module")
  const fromWeb = createRequire(new URL("../../packages/web/package.json", import.meta.url))
  const playwright: Record<"chromium" | "webkit" | "firefox", Launcher> = await import(
    fromWeb.resolve("playwright")
  )
  for (const name of ["chromium", "webkit", "firefox"] as const) {
    const browser = await playwright[name].launch({ headless: true })
    const tab = await browser.newPage()
    await tab.setContent("<!doctype html><title>share cost</title>")
    await tab.addScriptTag({ content: script ?? "", type: "module" })
    await tab.waitForFunction(() => Reflect.get(globalThis, "shareCost"), undefined, {
      timeout: 600_000,
    })
    console.log(`${name} ${browser.version()}`)
    console.log(String(await tab.evaluate(() => Reflect.get(globalThis, "shareCost"))))
    await browser.close()
  }
} else {
  const lines: string[] = []
  runCost((line) => lines.push(line))
  Reflect.set(globalThis, "shareCost", lines.join("\n"))
}

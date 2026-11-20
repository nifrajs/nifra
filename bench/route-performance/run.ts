/**
 * Cold document and first client-side navigation under Chromium network and CPU throttling.
 * Uses production assets, a fresh browser context per sample, and browser-clock measurements.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { buildTarget } from "@nifrajs/web/build"
import { buildTargetVite } from "@nifrajs/web/build-vite"
import { type Browser, chromium } from "playwright"
import { findChrome } from "../../packages/cli/test/headless-chrome.ts"
import { median } from "../rounds.ts"

const NETWORK = { latency: 150, downloadThroughput: 200_000, uploadThroughput: 90_000 }
const CPU = 4
const DETAIL = "/products/detail"

async function sample(browser: Browser, origin: string) {
  const context = await browser.newContext({ serviceWorkers: "block" })
  try {
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    await cdp.send("Network.emulateNetworkConditionsByRule", {
      offline: false,
      matchedNetworkConditions: [{ urlPattern: "", ...NETWORK }],
    })
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU })
    const failures: string[] = []
    page.on("pageerror", (error) => failures.push(error.message))
    page.on("response", (response) => {
      if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`)
    })
    await page.addInitScript((detail) => {
      const observer = new MutationObserver(() => {
        const button = document.querySelector("button")
        if (button === null || button.disabled) return
        observer.disconnect()
        requestAnimationFrame(() => {
          requestAnimationFrame(() => performance.mark("bench-catalog-usable"))
        })
      })
      observer.observe(document, { subtree: true, childList: true, attributes: true })
      addEventListener(
        "click",
        (event) => {
          if (event.target instanceof Element && event.target.closest(`a[href="${detail}"]`)) {
            performance.mark("bench-detail-click")
          }
        },
        true,
      )
    }, DETAIL)
    await page.goto(origin, { waitUntil: "commit" })
    await page.waitForFunction(
      () => performance.getEntriesByName("bench-catalog-usable").length > 0,
    )
    const initial = await page.evaluate(() => {
      const ttfb = performance
        .getEntriesByType("navigation")
        .find(
          (entry): entry is PerformanceNavigationTiming =>
            entry instanceof PerformanceNavigationTiming,
        )?.responseStart
      const usable = performance.getEntriesByName("bench-catalog-usable")[0]?.startTime
      if (ttfb === undefined || usable === undefined) throw new Error("Missing document timing")
      const scripts = performance
        .getEntriesByType("resource")
        .filter(
          (entry): entry is PerformanceResourceTiming =>
            entry instanceof PerformanceResourceTiming &&
            new URL(entry.name).pathname.startsWith("/assets/") &&
            /\.[cm]?js$/.test(new URL(entry.name).pathname),
        )
      return {
        ttfb,
        usable,
        js: [...new Set(scripts.map((script) => new URL(script.name).pathname))].sort(),
        jsTransferBytes: scripts.reduce((sum, script) => sum + script.transferSize, 0),
      }
    })
    await page.getByRole("button", { name: "Show filters" }).click()
    await page.getByText("Filters open").waitFor({ state: "visible" })
    await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === DETAIL &&
          response.request().headers()["x-nifra-data"] === "1",
      ),
      page.getByRole("link", { name: "Product details" }).click(),
    ])
    await page.getByRole("heading", { name: "PRODUCT DETAILS" }).waitFor({ state: "visible" })
    await page.waitForFunction(
      () => performance.getEntriesByName("bench-detail-painted").length > 0,
    )
    const navigation = await page.evaluate(() => {
      const click = performance.getEntriesByName("bench-detail-click")[0]?.startTime
      const painted = performance.getEntriesByName("bench-detail-painted")[0]?.startTime
      if (click === undefined || painted === undefined)
        throw new Error("Missing soft navigation timing")
      return painted - click
    })
    if (failures.length > 0) throw new Error(failures.join("\n"))
    return { ...initial, navigation }
  } finally {
    await context.close()
  }
}

async function ready(proc: Bun.Subprocess<"ignore", "pipe", "inherit">): Promise<string> {
  const reader = proc.stdout.getReader()
  const timeout = setTimeout(() => proc.kill(), 10_000)
  try {
    const decoder = new TextDecoder()
    let output = ""
    for (;;) {
      const { value, done } = await reader.read()
      if (done) throw new Error(`Benchmark server exited before listening: ${output}`)
      output += decoder.decode(value, { stream: true })
      const listening = /http:\/\/localhost:(\d+)\n/.exec(output)
      if (listening !== null) return `http://127.0.0.1:${listening[1]}`
    }
  } finally {
    clearTimeout(timeout)
    reader.releaseLock()
  }
}

const pipeline = process.argv.includes("--vite") ? "vite" : "bun"
const count = Number(process.env.BENCH_BROWSER_SAMPLES ?? 10)
if (!Number.isInteger(count) || count < 1)
  throw new Error("BENCH_BROWSER_SAMPLES must be a positive integer")
const chrome = findChrome()
if (chrome === undefined) {
  throw new Error("Install Chromium with bun bench/node_modules/playwright/cli.js install chromium")
}
const root = mkdtempSync(join(import.meta.dir, ".build-"))
const appDir = join(import.meta.dir, "app")
try {
  const build = pipeline === "vite" ? buildTargetVite : buildTarget
  const result = await build("bun", {
    routesDir: join(appDir, "routes"),
    adapterImport: join(appDir, "backend/framework.ts"),
    clientModule: "@nifrajs/web-preact/client",
    outDir: join(root, "dist"),
    workDir: join(root, "work"),
    reportRouteAssets: true,
  })
  const catalog = result.size.routes?.find((route) => route.pattern === "/")
  if (catalog === undefined) throw new Error("Build report omitted the catalog route")
  const server = Bun.spawn(["bun", join(result.outDir, "server.js")], {
    env: { ...process.env, PORT: "0" },
    stdout: "pipe",
    stderr: "inherit",
    stdin: "ignore",
  })
  try {
    const url = await ready(server)
    const browser = await chromium.launch({ executablePath: chrome })
    try {
      const samples: Awaited<ReturnType<typeof sample>>[] = []
      for (let i = 0; i <= count; i++) {
        const measured = await sample(browser, url)
        const reported = [...catalog.javascript].sort()
        if (measured.js.join() !== reported.join()) {
          throw new Error(
            `Build report JS differs from browser requests.\n  Report: ${reported.join(" ")}\n  Browser: ${measured.js.join(" ")}`,
          )
        }
        if (i !== 0) samples.push(measured)
      }
      console.log(
        JSON.stringify(
          {
            pipeline,
            chrome: browser.version(),
            samples: count,
            network: NETWORK,
            cpuSlowdown: CPU,
            medianMs: {
              ttfb: median(samples.map((run) => run.ttfb)),
              usable: median(samples.map((run) => run.usable)),
              navigation: median(samples.map((run) => run.navigation)),
            },
            initialJavaScript: {
              files: catalog.javascript,
              gzipBytes: catalog.javascriptGzip,
              medianTransferBytes: median(samples.map((run) => run.jsTransferBytes)),
            },
          },
          null,
          2,
        ),
      )
    } finally {
      await browser.close()
    }
  } finally {
    server.kill()
    await server.exited
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

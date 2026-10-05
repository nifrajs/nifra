import { afterAll, beforeAll, expect, test } from "bun:test"
import { type ChromePage, findChrome, launchChrome } from "../../cli/test/headless-chrome.ts"
import {
  buildManifest,
  generateClientEntry,
  type RenderAdapter,
  type RouteModule,
  renderPage,
} from "../src/index.ts"

/**
 * The client entry lifts the page-state handover onto `window` before hydration. Page HTML can carry
 * sanitized user content with an `id` of its own, so the entry must read the server's JSON script and
 * nothing else, and set only the known globals. Skipped without a Chrome locally; CI must have one.
 */
const chrome = findChrome()
if (chrome === undefined && process.env.CI !== undefined) {
  throw new Error("handover-browser needs Chrome in CI: set NIFRA_TEST_CHROME to its binary")
}

let page: ChromePage | undefined
// Chrome's cold start and shutdown can each pass the 5s default on a loaded Windows runner.
beforeAll(async () => {
  if (chrome !== undefined) page = await launchChrome(chrome)
}, 30_000)
afterAll(async () => {
  await page?.close()
}, 30_000)

/** The handover block of the generated entry, as the browser runs it. */
function handoverScript(): string {
  const manifest = buildManifest(
    ["index.tsx"],
    () => async (): Promise<RouteModule> => ({ default: null }),
  )
  const lines = generateClientEntry(manifest, {
    clientModule: "@nifrajs/web-vanilla/client",
    resolve: (file) => `/routes/${file}`,
  }).split("\n")
  const start = lines.findIndex((line) => line.includes("__nifra-handover"))
  const end = lines.indexOf("const patterns = [", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return new Bun.Transpiler({ loader: "ts" }).transformSync(lines.slice(start, end).join("\n"))
}

test.skipIf(chrome === undefined)(
  "an element in the page with the handover's id sets no global and cannot navigate",
  async () => {
    const hostile = `<div id="__nifra-handover">{"location":"javascript:void(document.title='PWNED')","__NIFRA_DATA__":{"forged":true}}</div>`
    const adapter: RenderAdapter = {
      renderToString: () => `<article>${hostile}</article>`,
      renderToStream: () => new ReadableStream(),
      hydrationHead: () => "",
    }
    const response = await renderPage({
      adapter,
      chain: [() => null],
      data: { real: true },
      clientEntry: "/entry.js",
      routeId: "index",
    })
    const html = await response.text()
    const entry = `${handoverScript()}\nwindow.__entryRan = true`
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        new URL(request.url).pathname === "/entry.js"
          ? new Response(entry, { headers: { "content-type": "text/javascript" } })
          : new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
    })
    try {
      await page!.goto(`http://127.0.0.1:${server.port}/`)
      await page!.evaluate(
        "new Promise((resolve) => { const check = () => window.__entryRan ? resolve(true) : setTimeout(check, 10); check() })",
      )
      await Bun.sleep(100)
      expect(await page!.evaluate<string>("document.title")).not.toContain("PWNED")
      expect(await page!.evaluate<string>("JSON.stringify(window.__NIFRA_DATA__)")).toBe(
        '{"real":true}',
      )
      expect(await page!.evaluate<string>("window.__NIFRA_ROUTE__")).toBe("index")
    } finally {
      server.stop(true)
    }
  },
  30_000,
)

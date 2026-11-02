/**
 * A partially prerendered page reloading its holes in place, in Chromium, Firefox and WebKit under a
 * hash-only CSP, on an app with `live`: after a form posts its action, and after a write another
 * process publishes, each hole shows the new count, an interactive hole's root keeps the clicks it
 * counted, and no fallback shows on the way. Run: `bun packages/web/test/fixtures/ppr/refresh-browser.ts`.
 */
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { reactAdapter } from "@nifrajs/web-react"
import { type Browser, chromium, firefox, webkit } from "playwright"
import { buildClient } from "../../../src/build.ts"
import { createCspPolicy } from "../../../src/csp.ts"
import { discoverRoutes } from "../../../src/fs.ts"
import { compileShells } from "../../../src/internal/ppr/compile-shell.ts"
import { createWebApp } from "../../../src/internal/web-app.ts"
import { live } from "../../../src/live.ts"
import { partialPrerendering } from "../../../src/ppr.ts"
import { add } from "./refresh-app/lib/counts.backend.ts"

declare global {
  interface Window {
    __refresh: { violations: string[]; fallbacks: number }
  }
}

const ENGINES = (process.env.ENGINES ?? "chromium,firefox,webkit").split(",")
const routesDir = `${import.meta.dir}/refresh-app/routes`
const outDir = mkdtempSync(join(tmpdir(), "nifra-ppr-refresh-"))
const assets = await buildClient({
  routesDir,
  outDir,
  clientModule: "@nifrajs/web-react/client",
  conditions: ["bun", "browser"],
  define: { "process.env.NODE_ENV": '"production"' },
  live: {},
})
const shellFailures: string[] = []
const shellChecks = await compileShells({
  routesDir,
  manifest: discoverRoutes(routesDir),
  deployment: assets.entry,
  requestScoped: () => false,
  onFailure: (routeId, error) =>
    shellFailures.push(`${routeId}: ${error instanceof Error ? error.message : String(error)}`),
})
assert.deepEqual(shellFailures, [], "every shell passes its check")
const runtime = live({ secret: "ppr-refresh-fixture-secret-0123456789", subject: () => null })
const app = createWebApp({
  adapter: reactAdapter,
  manifest: discoverRoutes(routesDir),
  clientEntry: assets.entry,
  routePreload: assets.routes,
  styles: assets.css ?? [],
  csp: createCspPolicy({
    header: ({ sources }) =>
      `default-src 'self'; script-src 'self' ${sources}; style-src 'self'; object-src 'none'; base-uri 'none'`,
  }),
  live: runtime,
  ppr: partialPrerendering({ shellChecks }),
})
app.get("/assets/*", async (c) => {
  const name = new URL(c.req.url).pathname.slice("/assets/".length)
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return new Response("Bad Request", { status: 400 })
  const bytes = await readFile(`${outDir}/${name}`).catch(() => undefined)
  if (bytes === undefined) return new Response("Not Found", { status: 404 })
  const type = name.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8"
  return new Response(bytes, { headers: { "content-type": type } })
})
const running = app.listen(0, { hostname: "127.0.0.1" })
const origin = `http://127.0.0.1:${running.port}`

/** A write from elsewhere: the count changes, and its key is published to every watching page. */
const write = async (id: string): Promise<void> => {
  add(id)
  await runtime.publish(`cart:${id}`)
}

async function checkRefresh(name: string, browser: Browser): Promise<Record<string, unknown>> {
  const id = { chromium: "1", firefox: "2", webkit: "3" }[name] ?? "9"
  const context = await browser.newContext()
  await context.addInitScript(() => {
    const seen: Window["__refresh"] = { violations: [], fallbacks: 0 }
    window.__refresh = seen
    document.addEventListener("securitypolicyviolation", (event) =>
      seen.violations.push(`${event.violatedDirective} ${event.blockedURI}`),
    )
    // A fallback appearing after the holes first filled is a hole that unmounted mid-refresh.
    new MutationObserver(() => {
      if (document.querySelector("#basket-fallback, #note-fallback") !== null) seen.fallbacks++
    }).observe(document, { subtree: true, childList: true })
  })
  const page = await context.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const shows = (basket: string, note: string) =>
    page.waitForFunction(
      ([b, n]) =>
        document.querySelector("#basket")?.textContent === b &&
        document.querySelector("#note")?.textContent === n,
      [basket, note] as const,
    )
  await page.goto(`${origin}/c/${id}`, { waitUntil: "commit" })
  await page.waitForFunction(() => document.documentElement.hasAttribute("data-nifra-hydrated"))
  await shows("basket 0 clicked 0", "note 0")
  // The live client's first load brings the grant; once it has, the socket watches the holes' key.
  await page.waitForFunction(() =>
    performance
      .getEntriesByType("resource")
      .some((entry) => entry.name.endsWith("/_nifra/live/load")),
  )
  const fallbacksBefore = await page.evaluate(() => window.__refresh.fallbacks)
  await page.evaluate(() => document.querySelector<HTMLButtonElement>("#basket")?.click())
  await shows("basket 0 clicked 1", "note 0")

  await page.evaluate(() => document.querySelector<HTMLButtonElement>("#add")?.click())
  await shows("basket 1 clicked 1", "note 1")

  // The socket may still be joining; a write it misses is found by the load its `ready` triggers.
  await write(id)
  await shows("basket 2 clicked 1", "note 2")

  const seen = await page.evaluate(() => window.__refresh)
  assert.deepEqual(seen.violations, [], `${name}: CSP violations`)
  assert.equal(seen.fallbacks, fallbacksBefore, `${name}: a fallback showed during a refresh`)
  assert.deepEqual(errors, [], `${name}: page errors`)
  await context.close()
  return { engine: name, refresh: "action, then a published write; root state kept, no fallback" }
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
      console.log(JSON.stringify(await checkRefresh(name, browser)))
    } finally {
      await browser.close()
    }
  }
} finally {
  await running.stop(true)
  rmSync(outDir, { recursive: true, force: true })
}

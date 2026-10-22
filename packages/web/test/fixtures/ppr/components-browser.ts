/**
 * A partially prerendered page whose hole shows a server component, built by the coordinated
 * compiler for Vue (`components/`) or React (`ADAPTER=react`, web-react's `ppr-components/`) and served
 * in Chromium, Firefox and WebKit under a hash-only CSP. No client file holds the
 * component's view; the client island inside the hole hydrates; a form's action reloads the hole,
 * which disposes that island and mounts the new one; a client navigation from a page with no PPR
 * runtime mounts the hole from its fill; a crawler gets the component's HTML in the host. Run:
 * `bun packages/web/test/fixtures/ppr/components-browser.ts`.
 */
import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Browser, chromium, firefox, webkit } from "playwright"
import { discoverRoutes } from "../../../src/fs.ts"
import { generateClientEntry } from "../../../src/internal/codegen.ts"
import { compileShells } from "../../../src/internal/ppr/compile-shell.ts"
import { buildManifest } from "../../../src/manifest.ts"
import { buildServerComponents } from "../../../src/server-components/build.ts"

const ENGINES = (process.env.ENGINES ?? "chromium,firefox,webkit").split(",")
const react = process.env.ADAPTER === "react"
const root = react
  ? `${import.meta.dir}/../../../../web-react/test/fixtures/ppr-components`
  : `${import.meta.dir}/components`
const boot = `${root}/boot.gen.frontend.ts`
const outDir = mkdtempSync(join(tmpdir(), "nifra-ppr-components-"))

// What `nifra build` writes from the routes directory: the router's lazy route table.
writeFileSync(
  boot,
  generateClientEntry(
    buildManifest(["index.tsx", "p/[id].tsx", "p/[id].backend.ts"], () => async () => ({
      default: null,
    })),
    {
      clientModule: react ? "@nifrajs/web-react/client" : "@nifrajs/web-vue/client",
      resolve: (file) => `./routes/${file}`,
    },
  ),
)

async function checkPage(name: string, browser: Browser, origin: string) {
  const context = await browser.newContext()
  await context.addInitScript(() => {
    const violations: string[] = []
    Reflect.set(window, "__violations", violations)
    document.addEventListener("securitypolicyviolation", (event) =>
      violations.push(`${event.violatedDirective} ${event.blockedURI}`),
    )
  })
  const page = await context.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const id = { chromium: "1", firefox: "4", webkit: "7" }[name] ?? "9"
  const title = (text: string) =>
    page.waitForFunction(
      (expected) => document.querySelector("#summary-title")?.textContent === expected,
      text,
    )
  const island = (text: string) =>
    page.waitForFunction(
      (expected) => document.querySelector("#island")?.textContent === expected,
      text,
    )
  const click = () =>
    page.evaluate(() => document.querySelector<HTMLButtonElement>("#island")?.click())

  await page.goto(`${origin}/p/${id}`)
  await page.waitForFunction(() => document.documentElement.hasAttribute("data-nifra-hydrated"))
  await title(`basket ${id}: 0`)
  await click()
  await island("clicked 1")

  // The action reloads the hole: new HTML, and a new island, mounted fresh.
  await page.evaluate(() => document.querySelector<HTMLButtonElement>("#add")?.click())
  await title(`basket ${id}: 1`)
  await island("clicked 0")
  await click()
  await island("clicked 1")

  // From a page with no PPR runtime, the hole arrives as a fill and mounts in the browser.
  await page.goto(`${origin}/`)
  await page.waitForFunction(() => document.documentElement.hasAttribute("data-nifra-hydrated"))
  await page.evaluate(() => document.querySelector<HTMLAnchorElement>("#to-product")?.click())
  await title("basket 2: 0")
  await click()
  await island("clicked 1")

  const violations = await page.evaluate(() => Reflect.get(window, "__violations"))
  assert.deepEqual(violations, [], `${name}: CSP violations`)
  assert.deepEqual(errors, [], `${name}: page errors`)
  await context.close()
  return {
    engine: name,
    adapter: react ? "react" : "vue",
    hole: "server component hydrated, reloaded and navigated to; hash-only CSP",
  }
}

try {
  const result = await buildServerComponents({
    root,
    ...(react
      ? {
          adapter: "react" as const,
          entries: {
            client: "entry.client.ts",
            ssr: "entry-ssr.backend.ts",
            rsc: "entry-rsc.backend.tsx",
          },
        }
      : {
          adapter: "vue" as const,
          entries: { client: "entry.client.ts", ssr: "entry.backend.ts" },
        }),
    target: "bun",
    outDir,
  })
  // The browser gets the island's code, never the hole's view or what its loader kept private.
  const client = readdirSync(`${outDir}/assets`)
    .filter((file) => file.endsWith(".js"))
    .map((file) => readFileSync(`${outDir}/assets/${file}`, "utf8"))
    .join("\n")
  assert.equal(client.includes("server-only basket view 5c1f"), false, "the view shipped")
  assert.equal(client.includes("PRIVATE_FIELD_31"), false, "the loader's private field shipped")
  assert.equal(client.includes("clicked "), true, "the island did not ship")
  console.log(JSON.stringify({ clientBytes: client.length, entry: result.entry }))

  const shellFailures: string[] = []
  const shellChecks = await compileShells({
    routesDir: `${root}/routes`,
    manifest: discoverRoutes(`${root}/routes`),
    deployment: result.entry,
    requestScoped: () => false,
    onFailure: (routeId, error) =>
      shellFailures.push(`${routeId}: ${error instanceof Error ? error.message : String(error)}`),
  })
  assert.deepEqual(shellFailures, [], "every shell passes its check")
  type App = { fetch(request: Request): Promise<Response> }
  const server: { createApp(entry: string, assets: object, checks: object): App | Promise<App> } =
    await import(`${outDir}/${react ? "ssr" : "server"}/index.js`)
  const app = await server.createApp(
    result.entry,
    { styles: result.styles, assets: result.assets },
    shellChecks,
  )
  const running = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path.startsWith("/assets/") && /^\/assets\/[\w.-]+$/.test(path)) {
        const type = path.endsWith(".css") ? "text/css" : "text/javascript"
        return new Response(Bun.file(`${outDir}${path}`), { headers: { "content-type": type } })
      }
      return app.fetch(request)
    },
  })
  const origin = `http://127.0.0.1:${running.port}`
  try {
    // A crawler gets the page whole: the component's HTML is in the host, with no script to run.
    const whole = await (
      await fetch(`${origin}/p/5`, { headers: { "user-agent": "Twitterbot/1.0" } })
    ).text()
    assert.match(whole, /<div data-nifra-hole="summary"[^>]*><section id="summary"/)
    assert.equal(whole.includes("PRIVATE_FIELD_31"), false)
    if (react) assert.match(whole, /<img id="summary-image"[^>]*srcSet="\/basket\.png 1x/)
    for (const [name, type] of [
      ["chromium", chromium],
      ["firefox", firefox],
      ["webkit", webkit],
    ] as const) {
      if (!ENGINES.includes(name)) continue
      const browser = await type.launch({ headless: true })
      try {
        console.log(JSON.stringify(await checkPage(name, browser, origin)))
      } finally {
        await browser.close()
      }
    }
  } finally {
    await running.stop(true)
  }
} finally {
  rmSync(boot, { force: true })
  rmSync(outDir, { recursive: true, force: true })
}

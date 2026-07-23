import { afterAll, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { parseDevEntry } from "../src/bun-dev-entry.ts"
import { devHtml, injectStyles, styleTags, writeDevFiles } from "../src/dev.ts"

// THE drift detector. The sibling test file pins a CAPTURED page, which by construction keeps passing
// after Bun changes its output. This one runs a real `Bun.serve` dev server and asserts the PRECISE
// signal still fires — so a Bun upgrade that renames or drops `data-bun-dev-server-script` fails here,
// loudly, instead of silently demoting the adapter to its fallback (or to nothing).

const dir = `${import.meta.dir}/.tmp-bun-dev-live`
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test("Bun's dev server still marks its bundled entry the way the adapter expects", async () => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/app.css`, "body{color:rebeccapurple}\n")
  writeFileSync(`${dir}/entry.ts`, 'import "./app.css"\ndocument.title = "live"\n')
  writeFileSync(`${dir}/entry.html`, devHtml("./entry.ts"))

  const html = (await import(`${dir}/entry.html`)) as { default: unknown }
  const serve = (
    globalThis as { Bun: { serve: (o: unknown) => { port: number; stop(f?: boolean): void } } }
  ).Bun.serve
  const server = serve({
    port: 0,
    development: { hmr: true },
    routes: { "/__probe": html.default },
    fetch: () => new Response("ssr"),
  })
  try {
    const page = await (await fetch(`http://127.0.0.1:${server.port}/__probe`)).text()
    const match = parseDevEntry(page)
    expect(match).toBeDefined()
    // `via: "marker"` is the assertion that matters. Falling back to "single-bun-script" would still
    // work today but means the precise signal is gone — that is exactly the drift worth failing on.
    expect(match?.via).toBe("marker")
    expect(match?.src).toStartWith("/_bun/")
    // And the CSS import must still surface as a stylesheet link, or every dev page renders unstyled.
    expect(match?.styles).toHaveLength(1)
    expect(match?.styles[0]).toEndWith(".css")
  } finally {
    server.stop(true)
  }
})

test("writeDevFiles emits an entry whose route specifiers are relative to the entry file", () => {
  const root = `${dir}-gen`
  const routesDir = `${root}/routes`
  mkdirSync(routesDir, { recursive: true })
  writeFileSync(`${routesDir}/index.tsx`, "export default function Index() { return null }\n")
  try {
    writeDevFiles({
      routesDir,
      clientModule: "@nifrajs/web-react/client",
      entryPath: `${root}/.nifra-bun/entry.tsx`,
      htmlPath: `${root}/.nifra-bun/entry.html`,
    })
    const entry = require("node:fs").readFileSync(`${root}/.nifra-bun/entry.tsx`, "utf8") as string
    // Relative, not root-relative: Bun's bundler resolves imports the way the runtime does, so a leading
    // slash would mean the FILESYSTEM root. (Vite's path writes `/routes/index.tsx` and is correct there.)
    expect(entry).toContain('"../routes/index.tsx"')
    expect(entry).not.toContain('"/routes/index.tsx"')
    const page = require("node:fs").readFileSync(`${root}/.nifra-bun/entry.html`, "utf8") as string
    expect(page).toContain('src="./entry.tsx"')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("injectStyles puts the links inside <head>, before first paint", () => {
  const html = "<!doctype html><html><head><title>x</title></head><body>hi</body></html>"
  const out = injectStyles(html, ["/_bun/asset/a.css"])
  expect(out).toContain('<link rel="stylesheet" href="/_bun/asset/a.css"></head>')
  // A stylesheet appended after </body> still applies, but only AFTER first paint — the page flashes
  // unstyled and dev stops resembling production.
  expect(out.indexOf("a.css")).toBeLessThan(out.indexOf("<body>"))
})

test("injectStyles falls back to prepending when there is no <head>", () => {
  expect(injectStyles("<div>fragment</div>", ["/a.css"])).toBe(
    '<link rel="stylesheet" href="/a.css"><div>fragment</div>',
  )
})

test("injectStyles is a no-op with no styles (never rewrites the body needlessly)", () => {
  const html = "<html><head></head><body>x</body></html>"
  expect(injectStyles(html, [])).toBe(html)
})

test("styleTags escapes a quote in an href", () => {
  expect(styleTags(['/a".css'])).toBe('<link rel="stylesheet" href="/a&quot;.css">')
})

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type BuildManifest, buildClient } from "../src/build.ts"
import { discoverRoutes } from "../src/fs.ts"
import { cssModulesBunPlugin, transformCssModule } from "../src/plugins/css-modules.ts"
import { createViteDevServer, type ViteDevServer } from "../src/vite.ts"

/**
 * The dev/prod parity gate.
 *
 * nifra runs two pipelines and each is internally coherent: dev is Vite end to end, production is Bun end
 * to end. That split is the design, not an accident. What is unacceptable is the two regimes disagreeing
 * about a fact an app depends on - because that failure always presents the same way, as "it worked
 * locally", discovered after a deploy.
 *
 * None of these facts are hypothetical. Each is a bug that already shipped or the mechanism behind one:
 *
 *  1. **The served `public/` set.** Dev inherited static serving from Vite implicitly while production had
 *     no equivalent, so a file resolved locally and 404'd only once deployed. This gate exists because of
 *     that bug.
 *  2. **One copy of a shared module.** Two React cores in one process means a second hook dispatcher and
 *     `resolveDispatcher().useState` of null - reported against the component, never against the
 *     resolution that caused it. This is the dual-React class, generalized to any module with state.
 *  3. **CSS Modules coverage.** Two independent implementations: Vite's in dev, nifra's plugin in prod.
 *     Scoped names are deliberately NOT compared. A scoped name never crosses the regime boundary - each
 *     regime compiles both of its own halves - so requiring equal hashes would forbid either side from
 *     ever changing its scheme while proving nothing. What must match is the CONTRACT: the same exported
 *     class keys, every one of them actually scoped, and `:global` left alone by both.
 *  4. **The route manifest.** Dev scans the filesystem; production bakes static imports. A route present
 *     in one and missing from the other is a page that 404s only in production.
 */

// Inside the workspace so the fixture's `@nifrajs/web/client` import resolves via node_modules hoisting,
// exactly as a real app's would.
const TMP_BASE = `${import.meta.dir}/.tmp-parity-`
/** A string that appears in exactly one fixture source file — used to count copies in the bundle. */
const SHARED_MARKER = "nifra-parity-shared-singleton"

let root: string
let routesDir: string
let distDir: string
let prod: BuildManifest
let dev: ViteDevServer
let devOrigin: string

const write = (rel: string, content: string): void => {
  const path = join(root, rel)
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, content)
}

beforeAll(async () => {
  root = mkdtempSync(TMP_BASE)
  routesDir = join(root, "routes")
  distDir = join(root, "dist")

  // One fixture exercising every fact: routes under a layout, two routes importing a single shared
  // module, a CSS module with a keyframe and a `:global` escape hatch, and a nested `public/` tree.
  write("routes/_layout.tsx", "export default function Layout() { return null }\n")
  write(
    "routes/index.tsx",
    'import styles from "../styles.module.css"\n' +
      'import { token } from "../shared.ts"\n' +
      "export const usedClass = styles.box\n" +
      "export const shared = token\n" +
      "export default function Index() { return null }\n",
  )
  write(
    "routes/about.tsx",
    'import { token } from "../shared.ts"\n' +
      "export const shared = token\n" +
      "export default function About() { return null }\n",
  )
  write("shared.ts", `export const token = { id: "${SHARED_MARKER}" }\n`)
  write(
    "styles.module.css",
    ".box { padding: 1rem; animation: spin 1s }\n" +
      ".title { font-weight: 700 }\n" +
      "@keyframes spin { from { opacity: 0 } to { opacity: 1 } }\n" +
      ":global(.untouched) { color: red }\n",
  )
  write("public/robots.txt", "User-agent: *\n")
  write("public/nested/note.txt", "nested\n")
  write("client-stub.ts", "export function mountRouter() {}\n")

  prod = await buildClient({
    routesDir,
    outDir: distDir,
    clientModule: join(root, "client-stub.ts"),
    minify: false,
    publicDir: join(root, "public"),
    plugins: [cssModulesBunPlugin("dom")],
  })

  dev = await createViteDevServer({
    root,
    routesDir,
    clientModule: join(root, "client-stub.ts"),
    port: 0,
    // Deliberately NOT a catch-all: it answers `/` and 404s everything else. A stub that returned 200 for
    // any path would make the "absent in both regimes" check pass no matter what the static layer did.
    createApp: () => ({
      fetch: (request: Request) =>
        new URL(request.url).pathname === "/"
          ? new Response("<!doctype html><html></html>", {
              headers: { "content-type": "text/html" },
            })
          : new Response("Not Found", { status: 404 }),
    }),
  })
  devOrigin = `http://127.0.0.1:${dev.port}`
}, 120_000)

afterAll(async () => {
  await dev?.stop()
  rmSync(root, { recursive: true, force: true })
})

// --- 1. The served `public/` set -------------------------------------------------------------------

test("both regimes serve the same set of public/ paths", async () => {
  // A set comparison, not a spot check: the shipped bug was one regime serving a path the other did not,
  // and a spot check on the file you happen to think of is exactly what missed it.
  const declared = [...(prod.publicFiles ?? [])].sort()
  expect(declared).toEqual(["/nested/note.txt", "/robots.txt"])

  const servedInDev: string[] = []
  for (const path of declared) {
    if ((await fetch(`${devOrigin}${path}`)).ok) servedInDev.push(path)
  }
  expect(servedInDev).toEqual(declared)
})

test("public/ files are byte-identical in both regimes", async () => {
  // Serving the same PATH from different bytes is the subtler half of the same bug (a stale copy in
  // `dist/`, say). The production copy is read off disk where the build put it.
  for (const path of prod.publicFiles ?? []) {
    const devBody = await (await fetch(`${devOrigin}${path}`)).text()
    const prodBody = readFileSync(join(distDir, path.slice(1)), "utf8")
    expect(devBody, `public${path} differs between dev and prod`).toBe(prodBody)
  }
})

test("a path absent from public/ is absent in BOTH regimes", async () => {
  expect(prod.publicFiles ?? []).not.toContain("/ghost.txt")
  expect((await fetch(`${devOrigin}/ghost.txt`)).status).not.toBe(200)
})

// --- 2. One copy of a shared module ----------------------------------------------------------------

test("dev SSR gives two importers the SAME module instance", async () => {
  // The dual-React mechanism, reduced to its essence. Two routes import one module; if the pipeline
  // resolves it twice, each route gets its own copy of that module's state. For React that second copy
  // is a second hook dispatcher, and the resulting error names the component rather than the resolution.
  const manifest = discoverRoutes(routesDir, {
    load: (absolutePath) => import(absolutePath) as Promise<unknown>,
  })
  const load = (file: string): Promise<{ shared: unknown }> => {
    const route = manifest.routes.find((r) => r.file === file)
    if (route === undefined) throw new Error(`fixture route missing: ${file}`)
    return route.load() as unknown as Promise<{ shared: unknown }>
  }
  const [a, b] = await Promise.all([load("index.tsx"), load("about.tsx")])
  expect(a.shared).toBe(b.shared)
})

test("the production bundle contains ONE copy of the shared module", () => {
  // The same fact on the emitted bytes. A module reachable from two routes must be bundled once; two
  // copies means two module states at runtime, which is the shipped form of the same bug.
  const emitted = readdirSync(distDir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(join(distDir, f), "utf8"))
    .join("\n")
  expect(emitted.length).toBeGreaterThan(0)
  expect(emitted.split(SHARED_MARKER).length - 1).toBe(1)
})

// --- 3. CSS Modules: the contract, not the hash -----------------------------------------------------

/** Vite serves a `.module.css` as a JS module of `export const <local> = "<scoped>"`. */
const parseViteClassMap = (moduleSource: string): Record<string, string> => {
  const map: Record<string, string> = {}
  for (const m of moduleSource.matchAll(/^export const ([A-Za-z_$][\w$]*) = "([^"]+)";?$/gm)) {
    map[m[1] as string] = m[2] as string
  }
  return map
}

test("both regimes export the same class keys", async () => {
  const devMap = parseViteClassMap(await (await fetch(`${devOrigin}/styles.module.css`)).text())
  const prodMap = transformCssModule(
    readFileSync(join(root, "styles.module.css"), "utf8"),
    "styles.module.css",
  ).exports

  // `spin` is the `@keyframes` name: part of the CSS Modules export namespace, not just the classes.
  // This assertion is what caught production omitting it while dev exported it.
  expect(Object.keys(devMap).sort()).toEqual(["box", "spin", "title"])
  // The keys are the contract; the values are each regime's private business.
  expect(Object.keys(prodMap).sort()).toEqual(Object.keys(devMap).sort())
})

test("both regimes actually SCOPE every class (a passthrough would collide across files)", async () => {
  const devMap = parseViteClassMap(await (await fetch(`${devOrigin}/styles.module.css`)).text())
  const prodMap = transformCssModule(
    readFileSync(join(root, "styles.module.css"), "utf8"),
    "styles.module.css",
  ).exports
  for (const [local, scoped] of Object.entries(devMap)) {
    expect(scoped, `dev left .${local} unscoped`).not.toBe(local)
  }
  for (const [local, scoped] of Object.entries(prodMap)) {
    expect(scoped, `prod left .${local} unscoped`).not.toBe(local)
  }
})

test("both regimes leave :global alone (the documented escape hatch)", async () => {
  // If one regime scopes `:global(.untouched)`, a hand-written or third-party selector matches locally
  // and stops matching in production — with no error anywhere.
  const devCss = await (await fetch(`${devOrigin}/styles.module.css?direct`)).text()
  const prodCss = transformCssModule(
    readFileSync(join(root, "styles.module.css"), "utf8"),
    "styles.module.css",
  ).css
  expect(devCss).toContain(".untouched {")
  expect(prodCss).toContain(".untouched {")
  expect(devCss).not.toContain(":global")
  expect(prodCss).not.toContain(":global")
})

// --- 4. The route manifest -------------------------------------------------------------------------

test("dev's scanned manifest and production's built manifest cover the same routes", () => {
  // Dev derives routes from a filesystem scan, production bakes static imports at build time. A route in
  // one and not the other is a page that exists locally and 404s in production.
  const devRoutes = discoverRoutes(routesDir)
    .routes.map((r) => r.id)
    .sort()
  const prodRoutes = Object.keys(prod.routes).sort()
  expect(devRoutes.length).toBeGreaterThan(0)
  expect(prodRoutes).toEqual(devRoutes)
})

test("every production route has a non-empty chunk set", () => {
  for (const [routeId, chunks] of Object.entries(prod.routes)) {
    expect(chunks.length, `route ${routeId} has no chunks`).toBeGreaterThan(0)
  }
})

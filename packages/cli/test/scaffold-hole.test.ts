import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { discoverRoutes } from "@nifrajs/web/fs"
import ts from "typescript"
import { copyPprApp } from "../../web/test/fixtures/ppr/copy-app.ts"
import { holeRouteFiles, routeTypeScript, scaffoldHole } from "../src/scaffold-hole.ts"

let root: string

beforeEach(() => {
  root = copyPprApp("scaffold-hole-")
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const read = (file: string): string => readFileSync(join(root, file), "utf8")
const snapshot = (): Record<string, string> =>
  Object.fromEntries(
    readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.(tsx?|vue)$/.test(file))
      .map((file) => [file, read(file)]),
  )

/** The shell check's failures for the route the tests scaffold; the fixture's `leaky` route fails it
 * on purpose. */
async function shellFailures(): Promise<string[]> {
  const { compileShells } = await import("@nifrajs/web/ppr")
  const routesDir = join(root, "routes")
  const failures: string[] = []
  await compileShells({
    routesDir,
    manifest: discoverRoutes(routesDir),
    deployment: "scaffold-test",
    requestScoped: (id) => id.endsWith("/lib/session.ts"),
    onFailure: (routeId, error) => {
      if (routeId === "s/[id]")
        failures.push(`${routeId}: ${error instanceof Error ? error.message : String(error)}`)
    },
  })
  return failures
}

/** `tsc` over the copied app, as the fixture's own project checks it. */
async function typeErrors(): Promise<string> {
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      extends: "../../../../examples/tsconfig.react.json",
      compilerOptions: { types: ["bun", "react"] },
      // The scaffolded route; another fixture route imports the package source by a path this copy moves.
      include: ["routes/_layout.tsx", "routes/s/*", "components/**/*.tsx", "lib/**/*.ts"],
    }),
  )
  const proc = Bun.spawn([process.execPath, "x", "tsc", "-p", join(root, "tsconfig.json")], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = await new Response(proc.stdout).text()
  return (await proc.exited) === 0 ? "" : out
}

test("a dynamic, a shared and an interactive hole land in the page and its backend half, and render", async () => {
  const dynamic = await scaffoldHole(root, "/s/:id", "note", "react", {}, ts)
  expect(dynamic).toMatchObject({
    ok: true,
    changed: ["routes/s/[id].tsx", "routes/s/[id].backend.ts"],
  })
  expect(
    (
      await scaffoldHole(
        root,
        "routes/s/[id].tsx",
        "stock-level",
        "react",
        { shared: true, timeout: 2000 },
        ts,
      )
    ).ok,
  ).toBe(true)
  expect((await scaffoldHole(root, "/s/:id", "cart", "react", { interactive: true }, ts)).ok).toBe(
    true,
  )

  const page = read("routes/s/[id].tsx")
  expect(page).toContain("export const boundaries = [price, greeting, note, stockLevel, cart]")
  expect(page).toContain('<Hole of={stockLevel} state={props.boundaries?.["stock-level"]} />')
  expect(page).toContain("timeout: 2000,")
  const backend = read("routes/s/[id].backend.ts")
  expect(backend).toContain('"stock-level": {')
  expect(backend).toContain("revalidate: 60,")
  expect(backend).toContain('import type { BoundaryRequestCtx, SharedHoleCtx } from "@nifrajs/web"')

  expect(await shellFailures()).toEqual([])
  expect(await typeErrors()).toBe("")

  const { createWebApp } = await import("@nifrajs/web")
  const { partialPrerendering } = await import("@nifrajs/web/ppr")
  const { reactAdapter } = await import("@nifrajs/web-react")
  const app = createWebApp({
    adapter: reactAdapter,
    manifest: discoverRoutes(join(root, "routes")),
    clientEntry: "/c.js",
    experimental: { ppr: partialPrerendering({ shellChecks: "unchecked-development" }) },
  })
  const html = await (await app.fetch(new Request("http://shop.test/s/3"))).text()
  for (const name of ["note", "stock-level", "cart"])
    expect(html).toContain(`id="nifra-ppr:${name}"`)
  expect(html).toContain('id="nifra-ppr:note">{"v":1,"html":"<p>TODO<\\/p>"}')
}, 120_000)

test("a server component hole writes the component and wires serverHole, and the checks stay green", async () => {
  const result = await scaffoldHole(root, "/s/:id", "basket", "react", { server: true }, ts)
  expect(result).toMatchObject({
    ok: true,
    changed: [
      "routes/s/[id].tsx",
      "routes/s/[id].backend.ts",
      "components/Basket.component.server.tsx",
    ],
  })
  expect(read("routes/s/[id].tsx")).toContain("render: serverHole(Basket),")
  expect(read("routes/s/[id].tsx")).toContain(
    'import { Basket } from "../../components/Basket.component.server.tsx"',
  )
  expect(result.next[0]).toContain(
    'createServerComponents({ holes: { "s/[id]": { components: [Basket] } } })',
  )
  expect(await shellFailures()).toEqual([])
  expect(await typeErrors()).toBe("")
}, 120_000)

test("a route without a shell, a name in use, a bad name or option, and a vanilla app change nothing", async () => {
  const before = snapshot()
  const refusals = [
    await scaffoldHole(root, "/", "note", "react", {}, ts),
    await scaffoldHole(root, "/other", "note", "react", {}, ts),
    await scaffoldHole(root, "/s/:id", "price", "react", {}, ts),
    await scaffoldHole(root, "/s/:id", "Note_1", "react", {}, ts),
    await scaffoldHole(root, "/s/:id", "note", "react", { timeout: 0 }, ts),
    await scaffoldHole(root, "/s/:id", "note", "react", { server: true, shared: true }, ts),
    await scaffoldHole(root, "/s/:id", "note", "preact", { server: true }, ts),
    await scaffoldHole(root, "/s/:id", "note", "vanilla", {}, ts),
  ]
  expect(refusals.map((refusal) => refusal.ok)).toEqual(refusals.map(() => false))
  expect(refusals[0]?.reason).toContain("no backend half")
  expect(refusals[2]?.reason).toContain('already has a loader for "price"')
  expect(snapshot()).toEqual(before)
})

test("without write, the result previews each file and nothing changes", async () => {
  const before = snapshot()
  const result = await scaffoldHole(root, "/s/:id", "note", "react", {}, ts, false)
  expect(result.ok).toBe(true)
  expect(result.preview?.map((entry) => entry.file)).toEqual([
    "routes/s/[id].tsx",
    "routes/s/[id].backend.ts",
  ])
  expect(snapshot()).toEqual(before)
})

test("a Vue page gets the snippet to paste, and its backend half gets the loader", async () => {
  writeFileSync(join(root, "routes/v.vue"), "<template><main /></template>\n")
  writeFileSync(
    join(root, "routes/v.backend.ts"),
    'export const shellLoader = () => ({ title: "v" })\n',
  )
  const result = await scaffoldHole(root, "/v", "note", "vue", {}, ts)
  expect(result).toMatchObject({ ok: true, changed: ["routes/v.backend.ts"] })
  expect(result.snippets[0]?.file).toBe("routes/v.vue")
  expect(result.snippets[0]?.code).toContain('<Hole :of="note" :state="props.boundaries?.note" />')
  expect(read("routes/v.backend.ts")).toContain(
    "export const boundaryLoaders = {\n  note: {\n    // Runs for each visitor",
  )
  expect(read("routes/v.vue")).toBe("<template><main /></template>\n")
})

test("on a project TypeScript 7 install, the hole lands the same way", async () => {
  const typescript7 = Bun.resolveSync("typescript7/package.json", import.meta.dir)
  mkdirSync(join(root, "node_modules"))
  symlinkSync(dirname(typescript7), join(root, "node_modules", "typescript"))
  const { page, backend } = holeRouteFiles("/s/:id", "react")
  const loaded = await routeTypeScript(root, [page, backend])
  try {
    if (loaded.compiler === undefined) throw new Error("no TypeScript 7 compiler")
    expect(
      (await scaffoldHole(root, "/s/:id", "note", "react", { timeout: 500 }, loaded.compiler)).ok,
    ).toBe(true)
  } finally {
    await loaded.session?.close()
  }
  expect(read(page)).toContain("<Hole of={note} state={props.boundaries?.note} />")
  expect(read(backend)).toContain("note: {\n    // Runs for each visitor")
}, 120_000)

test("the imports stay above the definition when the default export follows them", async () => {
  writeFileSync(
    join(root, "routes/w.tsx"),
    'import "./w.css"\n\nexport default function W(props: { readonly data: unknown }) {\n  return <main>{String(props.data)}</main>\n}\n',
  )
  writeFileSync(join(root, "routes/w.backend.ts"), "export const shellLoader = () => ({})\n")
  expect((await scaffoldHole(root, "/w", "note", "react", {}, ts)).ok).toBe(true)
  expect(read("routes/w.tsx")).toStartWith(
    'import "./w.css"\nimport type { BoundaryStates } from "@nifrajs/web"\nimport { Hole } from "@nifrajs/web-react/ppr"\n\nconst note = {',
  )
})

import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { discoverRoutes } from "@nifrajs/web/fs"
import ts from "typescript"
import { copyPprApp } from "../../web/test/fixtures/ppr/copy-app.ts"
import { getFixRecipe } from "../src/fix-recipes.ts"
import { moveReadToHole } from "../src/ppr-read-fix.ts"
import { runRuleRegistry } from "../src/rules/index.ts"
import { pprRules } from "../src/rules/ppr.ts"
import { routeTypeScript } from "../src/scaffold-hole.ts"
import { projectFacts } from "./rule-facts.ts"

const PAGE = "routes/v/[id].tsx"
let root: string

const page = (lines: readonly string[]): string =>
  [
    'import { tryGetContext } from "@nifrajs/middleware/context-storage"',
    "",
    "function Badge(props: { readonly who: { readonly visitor: string } }) {",
    "  return <b>{props.who.visitor}</b>",
    "}",
    "",
    "export default function Visit(props: { readonly data: { readonly title: string } }) {",
    ...lines,
    "}",
    "",
  ].join("\n")

const WELCOME = [
  '  const visitor = tryGetContext()?.request.headers.get("x-visitor") ?? "guest"',
  "  return (",
  "    <main>",
  '      <h1 id="title">{props.data.title}</h1>',
  '      <section id="welcome">',
  "        <p title={visitor}>Welcome back, {visitor}</p>",
  "        <Badge who={{ visitor }} />",
  "      </section>",
  "    </main>",
  "  )",
]

beforeEach(() => {
  root = copyPprApp("ppr-read-fix-")
  mkdirSync(join(root, "routes/v"))
  writeFileSync(join(root, PAGE), page(WELCOME))
  writeFileSync(
    join(root, "routes/v/[id].backend.ts"),
    [
      'import { t } from "@nifrajs/schema"',
      "",
      "export const shellLoader = (ctx: { readonly params: Readonly<Record<string, string>> }) => ({",
      `  title: \`Visit \${ctx.params.id}\`,`,
      "})",
      "export const shellOutput = t.object({ title: t.string() })",
      "",
    ].join("\n"),
  )
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      extends: "../../../../examples/tsconfig.react.json",
      compilerOptions: { types: ["bun", "react"] },
      // The changed route; another fixture route imports the package source by a path this copy moves.
      include: ["routes/_layout.tsx", "routes/v/*", "lib/**/*.ts"],
    }),
  )
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const read = (file: string): string => readFileSync(join(root, file), "utf8")
const snapshot = (): Record<string, string> =>
  Object.fromEntries(
    readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.tsx?$/.test(file))
      .map((file) => [file, read(file)]),
  )

async function findings() {
  const facts = projectFacts(PAGE, read(PAGE), [])
  return runRuleRegistry({ root, sources: facts.source, project: facts }, pprRules)
}

/** The shell check's failures for the route under test; the fixture's `leaky` route fails on purpose. */
async function shellFailures(): Promise<string[]> {
  const { compileShells } = await import("@nifrajs/web/ppr")
  const routesDir = join(root, "routes")
  const failures: string[] = []
  await compileShells({
    routesDir,
    manifest: discoverRoutes(routesDir),
    deployment: "read-fix-test",
    requestScoped: (id) => id.endsWith("/lib/session.ts"),
    onFailure: (routeId, error) => {
      if (routeId === "v/[id]")
        failures.push(error instanceof Error ? error.message : String(error))
    },
  })
  return failures
}

async function typeErrors(): Promise<string> {
  const proc = Bun.spawn([process.execPath, "x", "tsc", "-p", join(root, "tsconfig.json")], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = await new Response(proc.stdout).text()
  return (await proc.exited) === 0 ? "" : out
}

test("the check finds the read, and the fix moves it and its markup into a hole both checks pass", async () => {
  const [finding, ...rest] = await findings()
  expect(rest).toEqual([])
  expect(finding).toMatchObject({
    code: "NF-C053",
    file: PAGE,
    line: 8,
    fix: { recipe: "ppr.read-to-hole", command: "nifra fix --code NF-C053" },
  })
  expect(getFixRecipe("ppr.read-to-hole")?.onlyWhenNamed).toBe(true)
  expect((await shellFailures()).join("\n")).toContain("context-storage")

  expect(await moveReadToHole(root, PAGE, finding?.line, "react", ts)).toEqual([
    PAGE,
    "routes/v/[id].backend.ts",
  ])
  const fixed = read(PAGE)
  expect(fixed).not.toContain("tryGetContext")
  expect(fixed).not.toContain("context-storage")
  expect(fixed).toContain(
    [
      "const visitorHole = {",
      '  name: "visitor",',
      '  mode: "dynamic",',
      "  render: (data: { readonly visitor: string }) => (",
      '    <section id="welcome">',
      "      <p title={data.visitor}>Welcome back, {data.visitor}</p>",
      "      <Badge who={{ visitor: data.visitor }} />",
      "    </section>",
      "  ),",
      "  fallback: <p>Loading</p>,",
      "} as const",
      "export const boundaries = [visitorHole]",
    ].join("\n"),
  )
  expect(fixed).toContain("<Hole of={visitorHole} state={props.boundaries?.visitor} />")
  const backend = read("routes/v/[id].backend.ts")
  expect(backend).toContain(
    'load: () => ({ visitor: tryGetContext()?.request.headers.get("x-visitor") ?? "guest" }),',
  )
  expect(backend).toContain("output: t.object({\n      visitor: t.string(),\n    }),")
  expect(backend).toContain('import { tryGetContext } from "@nifrajs/middleware/context-storage"')

  expect(await findings()).toEqual([])
  expect(await shellFailures()).toEqual([])
  expect(await typeErrors()).toBe("")

  const { createWebApp } = await import("@nifrajs/web")
  const { partialPrerendering } = await import("@nifrajs/web/ppr")
  const { reactAdapter } = await import("@nifrajs/web-react")
  const app = createWebApp({
    adapter: reactAdapter,
    manifest: discoverRoutes(join(root, "routes")),
    clientEntry: "/c.js",
    ppr: partialPrerendering({ shellChecks: "unchecked-development" }),
  })
  const html = await (await app.fetch(new Request("http://shop.test/v/3"))).text()
  expect(html).toContain('<h1 id="title">Visit 3</h1>')
  expect(html).toContain('id="nifra-ppr:visitor"')
  expect(html).toContain(
    '<p title=\\"guest\\">Welcome back, <\\u0021-- -->guest<\\/p><b>guest<\\/b>',
  )
}, 120_000)

test("a handler in the moved markup makes the hole interactive", async () => {
  writeFileSync(
    join(root, PAGE),
    page([
      WELCOME[0] ?? "",
      "  return (",
      "    <main>",
      "      <p>{props.data.title}</p>",
      "      <section>",
      '        <button type="button" onClick={() => alert(visitor)}>hi</button>',
      "        <Badge who={{ visitor }} />",
      "      </section>",
      "    </main>",
      "  )",
    ]),
  )
  await moveReadToHole(root, PAGE, 8, "react", ts)
  expect(read(PAGE)).toContain("  interactive: true, // its event handlers hydrate with the hole\n")
  expect(await typeErrors()).toBe("")
}, 120_000)

test("a read the fix cannot move is refused with the reason, and nothing changes", async () => {
  const cases: [readonly string[], number, string][] = [
    [
      [
        WELCOME[0] ?? "",
        "  const shout = visitor.toUpperCase()",
        "  return <main><p>{shout}</p><p>{visitor}</p></main>",
      ],
      8,
      "also used outside the markup the page returns (line 9)",
    ],
    [
      [WELCOME[0] ?? "", "  return <main>{visitor}<p>{visitor}</p></main>"],
      8,
      "span the page's root element",
    ],
    [
      [WELCOME[0] ?? "", "  return <main><p>{props.data.title} {visitor}</p></main>"],
      8,
      "also uses `props`",
    ],
    [["  return <main><p>{tryGetContext()?.request.url}</p></main>"], 8, "not held in one `const"],
    [
      [
        '  const header = "x-visitor"',
        "  const visitor = tryGetContext()?.request.headers.get(header)",
        "  return <main><p>{visitor}</p></main>",
      ],
      9,
      "the read uses `header`",
    ],
    [WELCOME, 3, "no request read is at line 3"],
  ]
  for (const [lines, line, reason] of cases) {
    writeFileSync(join(root, PAGE), page(lines))
    const before = snapshot()
    await expect(moveReadToHole(root, PAGE, line, "react", ts)).rejects.toThrow(reason)
    expect(snapshot()).toEqual(before)
  }
  writeFileSync(join(root, PAGE), page(WELCOME))
  await expect(moveReadToHole(root, PAGE, 8, "vue", ts)).rejects.toThrow("renders none")
})

test("on a project TypeScript 7 install, the fix places the same edits", async () => {
  const typescript7 = Bun.resolveSync("typescript7/package.json", import.meta.dir)
  mkdirSync(join(root, "node_modules"))
  symlinkSync(dirname(typescript7), join(root, "node_modules", "typescript"))
  const loaded = await routeTypeScript(root, [PAGE, "routes/v/[id].backend.ts"])
  try {
    if (loaded.compiler === undefined) throw new Error("no TypeScript 7 compiler")
    await moveReadToHole(root, PAGE, 8, "react", loaded.compiler)
  } finally {
    await loaded.session?.close()
  }
  expect(read(PAGE)).toContain("render: (data: { readonly visitor: string }) => (")
  expect(read("routes/v/[id].backend.ts")).toContain(
    "output: t.object({\n      visitor: t.string(),",
  )
}, 120_000)

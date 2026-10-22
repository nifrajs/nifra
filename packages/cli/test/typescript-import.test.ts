import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { collectCheckResult } from "../src/check.ts"
import { scanInterpolatedSql } from "../src/check-scan.ts"
import {
  importProjectTypeScript,
  loadProjectTypeScript,
} from "../src/internal/typescript-import.ts"
import { runRuleRegistry, sourceIndex } from "../src/rules/index.ts"
import { islandRules } from "../src/rules/islands.ts"
import { securityRules } from "../src/rules/security.ts"
import { swapRules } from "../src/rules/swap.ts"
import { projectFacts } from "./rule-facts.ts"

/** Write a `node_modules/typescript` into `root` with the given entry contents. */
const installTypeScript = async (
  root: string,
  files: {
    readonly packageJson: Record<string, unknown>
    readonly entries: Record<string, string>
  },
): Promise<void> => {
  const pkg = join(root, "node_modules", "typescript")
  await mkdir(join(pkg, "lib"), { recursive: true })
  await writeFile(join(pkg, "package.json"), JSON.stringify(files.packageJson))
  for (const [name, source] of Object.entries(files.entries))
    await writeFile(join(pkg, "lib", name), source)
}

const installTypeScriptPackage = async (root: string, packageName: string): Promise<void> => {
  const packageJson = Bun.resolveSync(`${packageName}/package.json`, import.meta.dir)
  await mkdir(join(root, "node_modules"), { recursive: true })
  await symlink(dirname(packageJson), join(root, "node_modules", "typescript"))
}

const FIXTURE_COMPILER = `module.exports = {
  version: "0.0.0-fixture",
  ScriptKind: { TSX: 4 },
  createSourceFile: () => ({}),
  forEachChild: () => undefined,
}
`

test("loads a project TypeScript 7 compiler through the unstable adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "nifra-ts-stub-"))
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "app" }))
    await installTypeScriptPackage(root, "typescript7")
    const loaded = await loadProjectTypeScript(root, undefined, {
      files: [],
      read: () => undefined,
    })
    try {
      expect(loaded.unsupported).toBeUndefined()
      expect(loaded.compiler?.version).toBe("7.0.2")
      expect(loaded.compiler?.createSourceFile).toBeTypeOf("function")
    } finally {
      await loaded.session?.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("an install that lands mid-process is picked up without a restart", async () => {
  // The reported papercut: the MCP server is long-lived, so a resolver that memoizes a specifier for
  // the life of the process kept answering with the pre-install resolution - the typecheck went
  // phantom until `nifra mcp` was restarted. Resolution is a filesystem probe now, re-answered each
  // call, so the second lookup sees the compiler the first one could not.
  const root = await mkdtemp(join(tmpdir(), "nifra-ts-fresh-"))
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "app" }))
    const before = await importProjectTypeScript(root)
    expect(before?.version).not.toBe("0.0.0-fixture")

    await installTypeScript(root, {
      packageJson: {
        name: "typescript",
        version: "0.0.0-fixture",
        type: "commonjs",
        main: "./lib/typescript.js",
      },
      entries: { "typescript.js": FIXTURE_COMPILER },
    })
    const after = await importProjectTypeScript(root)
    expect(after?.version).toBe("0.0.0-fixture")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("fails closed for compiler majors outside the supported 5/6/7 matrix", async () => {
  const root = await mkdtemp(join(tmpdir(), "nifra-ts-unsupported-"))
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "app" }))
    await installTypeScript(root, {
      packageJson: {
        name: "typescript",
        version: "8.0.0",
        type: "commonjs",
        main: "./lib/typescript.js",
      },
      entries: { "typescript.js": FIXTURE_COMPILER },
    })
    const loaded = await loadProjectTypeScript(root)
    expect(loaded.compiler).toBeUndefined()
    expect(loaded.session).toBeUndefined()
    expect(loaded.unsupported?.code).toBe("NIFRA_TS_UNSUPPORTED")
    expect(loaded.unsupported?.version).toBe("8.0.0")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("keeps security, SQL, and island scanners equivalent on TypeScript 5, 6, and 7", async () => {
  const sourceFile = "routes/compiler-matrix.server.ts"
  const source = [
    "function requireAuth() { try { check() } catch { return } }",
    "const token = input.token",
    "if (token === expected) console.log(email)",
    "app.use(cors({ origin: () => true }))",
    "return redirect(target, { external: true })",
    "app.use(bodyLimit({ allowLengthless: true }))",
    'ctx.cookie("session", value, { secure: true })',
    'import { bindIsland, bindList, defineIsland, mountIslands, signal } from "@nifrajs/web/islands"',
    "const items = signal([])",
    "const off = bindList(items, document.body, { key: (item, i) => i })",
    'const counter = defineIsland((el) => { el.addEventListener("click", () => {}) })',
    'const cart = bindIsland(({ state }) => { state("count", 0); return { add: () => {} } })',
    "mountIslands({ counter, cart })",
    'const page = html`<div data-island="cart"><b data-bind-text="cuont"></b></div><p data-bind-text="count"></p>`',
    'import { slot } from "@nifrajs/web-vanilla"',
    'const list = html`<button data-swap="replace:results">x</button><a href="/x" data-swap="replace:nowhere">x</a><ul data-swap-slot="results"><h2>t</h2>$' +
      '{slot("results", [])}</ul>`',
  ].join("\n")
  // A page that swaps a slot it never renders, for NF-C052.
  const listFile = "routes/list.tsx"
  const listPage = [
    'import { html } from "@nifrajs/web-vanilla"',
    'export default () => html`<a href="/list" data-swap="replace:results">More</a>`',
  ].join("\n")
  const versions = [
    { label: "5", packageName: "typescript5" },
    { label: "6", packageName: "typescript" },
    { label: "7", packageName: "typescript7" },
  ] as const
  const results = new Map<string, { security: string[]; islands: string[]; swap: string[] }>()

  for (const version of versions) {
    const root = await mkdtemp(join(tmpdir(), `nifra-ts${version.label}-matrix-`))
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ name: `ts-${version.label}` }))
      await installTypeScriptPackage(root, version.packageName)
      const sql = "db.query(`SELECT * FROM users WHERE id = $" + "{input.id}`)"
      const contents = new Map([
        [sourceFile, source],
        ["routes/query.ts", sql],
        [listFile, listPage],
      ])
      const loaded = await loadProjectTypeScript(root, undefined, {
        files: [...contents.keys()],
        read: (file) => contents.get(file),
      })
      try {
        expect(loaded.unsupported).toBeUndefined()
        expect(loaded.compiler?.version.startsWith(`${version.label}.`)).toBe(true)
        expect(loaded.session).toBeDefined()
        if (loaded.compiler === undefined || loaded.session === undefined)
          throw new Error(`failed to load TypeScript ${version.label} test compiler`)

        const facts = {
          ...projectFacts(sourceFile, source),
          source: sourceIndex([
            { file: sourceFile, content: source },
            { file: listFile, content: listPage },
          ]),
        }
        const context = {
          root,
          sources: facts.source,
          project: facts,
          typescriptSession: loaded.session,
        }
        const security = await runRuleRegistry(context, securityRules)
        const islands = await runRuleRegistry(context, islandRules)
        const swap = await runRuleRegistry(context, swapRules)
        const codes = (findings: readonly { readonly code: string }[]) =>
          findings.map((finding) => finding.code).sort()
        results.set(version.label, {
          security: codes(security),
          islands: codes(islands),
          swap: codes(swap),
        })

        expect(scanInterpolatedSql("routes/query.ts", sql, loaded.compiler)).toHaveLength(1)
      } finally {
        await loaded.session?.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  expect(results.get("5")).toEqual(results.get("6"))
  expect(results.get("6")).toEqual(results.get("7"))
  expect(results.get("7")).toEqual({
    security: ["NF-S001", "NF-S002", "NF-S003", "NF-S004", "NF-S005", "NF-S006", "NF-S007"],
    islands: ["NF-C020", "NF-C022", "NF-C047", "NF-C048"],
    swap: ["NF-C049", "NF-C050", "NF-C051", "NF-C052"],
  })
})

test("runs the full check pipeline on a project TypeScript 7 install", async () => {
  const root = await mkdtemp(join(tmpdir(), "nifra-ts7-scanners-"))
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "app" }))
    await installTypeScriptPackage(root, "typescript7")
    await mkdir(join(root, "routes"), { recursive: true })
    await writeFile(
      join(root, "routes", "ts7.server.ts"),
      [
        "function requireAuth() { try { check() } catch { return } }",
        "const token = input.token",
        "if (token === expected) console.log(email)",
        "app.use(cors({ origin: () => true }))",
        "return redirect(target, { external: true })",
        "app.use(bodyLimit({ allowLengthless: true }))",
        'ctx.cookie("session", value, { secure: true })',
        'import { bindIsland, bindList, defineIsland, mountIslands, signal } from "@nifrajs/web/islands"',
        "const items = signal([])",
        "const off = bindList(items, document.body, { key: (item, i) => i })",
        'const counter = defineIsland((el) => { el.addEventListener("click", () => {}) })',
        'const cart = bindIsland(({ state }) => { state("count", 0); return { add: () => {} } })',
        "mountIslands({ counter, cart })",
        'const page = html`<div data-island="cart"><b data-bind-text="cuont"></b></div><p data-bind-text="count"></p>`',
        'import { slot } from "@nifrajs/web-vanilla"',
        'const list = html`<button data-swap="replace:results">x</button><a href="/x" data-swap="replace:nowhere">x</a><ul data-swap-slot="results"><h2>t</h2>$' +
          '{slot("results", [])}</ul>`',
        "db.query(`SELECT * FROM users WHERE id = $" + "{input.id}`)",
      ].join("\n"),
      "utf8",
    )
    await writeFile(
      join(root, "routes", "list.tsx"),
      'import { html } from "@nifrajs/web-vanilla"\nexport default () => html`<a href="/list" data-swap="replace:results">More</a>`\n',
      "utf8",
    )
    // A partially prerendered page that reads the request, for NF-C053.
    await writeFile(
      join(root, "routes", "shell.tsx"),
      'import { tryGetContext } from "@nifrajs/middleware/context-storage"\nexport default () => <p>{tryGetContext()?.request.url}</p>\n',
      "utf8",
    )
    await writeFile(
      join(root, "routes", "shell.backend.ts"),
      "export const shellLoader = () => ({})\n",
      "utf8",
    )

    const result = await collectCheckResult(root, { lintsOnly: true })
    const codes = new Set(result.structuredDiagnostics?.map((finding) => finding.code))
    for (const code of [
      "NF-S001",
      "NF-S002",
      "NF-S003",
      "NF-S004",
      "NF-S005",
      "NF-S006",
      "NF-S007",
      "NF-C020",
      "NF-C022",
      "NF-C047",
      "NF-C048",
      "NF-C049",
      "NF-C050",
      "NF-C051",
      "NF-C052",
      "NF-C053",
    ]) {
      expect(codes.has(code)).toBe(true)
    }
    expect(result.diagnostics.some((finding) => finding.rule === "interpolated-sql")).toBe(true)
    expect(codes.has("NF-C017")).toBe(false)
    expect(codes.has("NIFRA_TS_UNSUPPORTED")).toBe(false)
    expect(result.ok).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("checks JSX and Svelte routes and app entries on a project TypeScript 7 install", async () => {
  const root = await mkdtemp(join(tmpdir(), "nifra-ts7-components-"))
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "app" }))
    await writeFile(join(root, "nifra.config.ts"), "export const adapter = {}\n")
    await installTypeScriptPackage(root, "typescript7")
    await mkdir(join(root, "routes"), { recursive: true })
    const key = "sk_live_51HcQ2eLkdIwHu7ixA9bC0dEfGhIjKlMnOpQr"
    await writeFile(
      join(root, "routes", "index.svelte"),
      `<script lang="ts">\n  import pg from "pg"\n  const key: string = "${key}"\n</script>\n<p>{key}{pg}</p>\n`,
    )
    await writeFile(
      join(root, "routes", "about.jsx"),
      `const key = "${key}"\nexport default () => <p>{key}</p>\n`,
    )
    await writeFile(
      join(root, "routes", "notes.tsx"),
      "export async function loader() {\n  return {}\n}\nexport default () => <p />\n",
    )
    await mkdir(join(root, "backend"), { recursive: true })
    await writeFile(join(root, "backend", "app.ts"), "export const backend = server()\n")
    await writeFile(join(root, "backend", "framework.ts"), 'export const apiPrefix = "/api"\n')
    await writeFile(
      join(root, "server.ts"),
      'import { createWebApp } from "@nifrajs/web"\nexport const app = createWebApp({ api: client })\n',
    )

    const result = await collectCheckResult(root, { lintsOnly: true })
    const found = new Set(
      [...result.diagnostics, ...(result.structuredDiagnostics ?? [])].map(
        (finding) => `${finding.code} ${finding.file}:${finding.line}`,
      ),
    )
    expect([...found].filter((entry) => /NF-C0(04|17|32|35|41)/.test(entry)).sort()).toEqual([
      "NF-C004 routes/index.svelte:2",
      "NF-C032 routes/about.jsx:1",
      "NF-C032 routes/index.svelte:3",
      "NF-C035 server.ts:2",
      "NF-C041 routes/notes.tsx:1",
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("runs the project TypeScript 7 typecheck instead of the CLI compiler", async () => {
  const root = await mkdtemp(join(tmpdir(), "nifra-ts7-typecheck-"))
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "app" }))
    await installTypeScriptPackage(root, "typescript7")
    await mkdir(join(root, "routes"), { recursive: true })
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, target: "ES2022", module: "ESNext" },
        include: ["routes/**/*.ts"],
      }),
      "utf8",
    )
    await writeFile(join(root, "routes", "ok.ts"), 'export const ok: string = "ok"\n', "utf8")

    const result = await collectCheckResult(root)
    expect(result.typecheck).toBe("pass")
    expect(result.diagnostics.some((finding) => finding.code === "NIFRA_TS_UNSUPPORTED")).toBe(
      false,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the raw-Response and route-statement checks read their AST on TypeScript 7", async () => {
  const root = await mkdtemp(join(tmpdir(), "nifra-ts7-response-"))
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "app" }))
    await installTypeScriptPackage(root, "typescript7")
    await mkdir(join(root, "backend"), { recursive: true })
    await writeFile(
      join(root, "backend", "wire.ts"),
      "function send(payload: unknown) {\n  const out = Response.json(payload)\n  return out\n}\nexport { send }\n",
    )
    await writeFile(
      join(root, "backend", "app.ts"),
      [
        'import { createWebApp } from "@nifrajs/web"',
        'import { send } from "./wire"',
        "export const app = createWebApp(options)",
        '  .get("/shelves", () => send([]))',
        '  .get("/loans", (c) => c.json([]))',
        'app.post("/returns", () => ({ ok: true }))',
        "export type App = typeof app",
        "export default app",
        "",
      ].join("\n"),
    )

    const result = await collectCheckResult(root, { lintsOnly: true })
    const warns = result.diagnostics.filter((finding) => finding.rule === "response-route")
    expect(warns.map((finding) => `${finding.file}:${finding.line}`)).toEqual([
      "backend/app.ts:4",
      "backend/app.ts:5",
    ])
    const codes = result.diagnostics.map(
      (finding) => `${finding.code} ${finding.file}:${finding.line}`,
    )
    expect(codes).toContain("NF-C045 backend/app.ts:6")
    expect(codes.some((entry) => entry.startsWith("NF-C017"))).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the TypeScript 7 check follows imports into modules outside its scanned set", async () => {
  const root = await mkdtemp(join(tmpdir(), "nifra-ts7-imports-"))
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "app" }))
    await installTypeScriptPackage(root, "typescript7")
    await mkdir(join(root, "frontend"), { recursive: true })
    await mkdir(join(root, "backend"), { recursive: true })
    const files: Record<string, string> = {
      "frontend/widget.ts": 'import { help } from "./helper.js"\nexport const w = help()\n',
      "frontend/helper.js":
        'import { readFileSync } from "node:fs"\nexport const help = () => readFileSync\n',
      "backend/tables.js":
        'import { prefix } from "./prefix.js"\nexport const TABLE = `${prefix}users`\n',
      "backend/prefix.js": 'export const prefix = "app_"\n',
      "backend/db.ts":
        'import { TABLE } from "./tables.js"\nexport const all = (db: { query(sql: string): unknown }) => db.query(`SELECT * FROM ${TABLE}`)\n',
    }
    for (const [file, content] of Object.entries(files)) await writeFile(join(root, file), content)

    const result = await collectCheckResult(root, { lintsOnly: true })
    // The scanned set holds only the .ts files; the .js modules they import are read from disk.
    expect(
      result.diagnostics.some(
        (finding) => finding.rule === "server-only-import" && finding.file === "frontend/widget.ts",
      ),
    ).toBe(true)
    expect(result.diagnostics.some((finding) => finding.rule === "interpolated-sql")).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

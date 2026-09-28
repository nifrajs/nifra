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
import { runRuleRegistry } from "../src/rules/index.ts"
import { islandRules } from "../src/rules/islands.ts"
import { nanoRules } from "../src/rules/nano.ts"
import { securityRules } from "../src/rules/security.ts"
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

test("keeps security, SQL, nano, and island scanners equivalent on TypeScript 5, 6, and 7", async () => {
  const sourceFile = "routes/compiler-matrix.server.ts"
  const source = [
    "function requireAuth() { try { check() } catch { return } }",
    "const token = input.token",
    "if (token === expected) console.log(email)",
    "app.use(cors({ origin: () => true }))",
    "return redirect(target, { external: true })",
    "app.use(bodyLimit({ allowLengthless: true }))",
    'ctx.cookie("session", value, { secure: true })',
    'import { bind, bindList, computed, signal } from "@nifrajs/web/nano"',
    "const n = signal(0)",
    "bind(document.body, n, (e, v) => { e.textContent = String(v) })",
    "const items = signal([])",
    "const off = bindList(items, document.body, { key: (item, i) => i })",
    "const todos = signal([])",
    "const remaining = computed(() => todos.get().length, [])",
    'import { defineIsland } from "@nifrajs/web/islands"',
    'const counter = defineIsland((el) => { el.addEventListener("click", () => {}) })',
  ].join("\n")
  const versions = [
    { label: "5", packageName: "typescript5" },
    { label: "6", packageName: "typescript" },
    { label: "7", packageName: "typescript7" },
  ] as const
  const results = new Map<string, { security: string[]; nano: string[]; islands: string[] }>()

  for (const version of versions) {
    const root = await mkdtemp(join(tmpdir(), `nifra-ts${version.label}-matrix-`))
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ name: `ts-${version.label}` }))
      await installTypeScriptPackage(root, version.packageName)
      const sql = "db.query(`SELECT * FROM users WHERE id = $" + "{input.id}`)"
      const contents = new Map([
        [sourceFile, source],
        ["routes/query.ts", sql],
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

        const facts = projectFacts(sourceFile, source)
        const context = {
          root,
          sources: facts.source,
          project: facts,
          typescriptSession: loaded.session,
        }
        const security = await runRuleRegistry(context, securityRules)
        const nano = await runRuleRegistry(context, nanoRules)
        const islands = await runRuleRegistry(context, islandRules)
        const codes = (findings: readonly { readonly code: string }[]) =>
          findings.map((finding) => finding.code).sort()
        results.set(version.label, {
          security: codes(security),
          nano: codes(nano),
          islands: codes(islands),
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
    nano: ["NF-C021", "NF-C022", "NF-C023"],
    islands: ["NF-C020"],
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
        'import { bind, bindList, computed, signal } from "@nifrajs/web/nano"',
        "const n = signal(0)",
        "bind(document.body, n, (e, v) => { e.textContent = String(v) })",
        "const items = signal([])",
        "const off = bindList(items, document.body, { key: (item, i) => i })",
        "const todos = signal([])",
        "const remaining = computed(() => todos.get().length, [])",
        'import { defineIsland } from "@nifrajs/web/islands"',
        'const counter = defineIsland((el) => { el.addEventListener("click", () => {}) })',
        "db.query(`SELECT * FROM users WHERE id = $" + "{input.id}`)",
      ].join("\n"),
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
      "NF-C021",
      "NF-C022",
      "NF-C023",
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

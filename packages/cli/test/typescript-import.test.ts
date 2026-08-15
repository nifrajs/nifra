import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { importProjectTypeScript } from "../src/internal/typescript-import.ts"

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

const FIXTURE_COMPILER = `module.exports = {
  version: "0.0.0-fixture",
  ScriptKind: { TSX: 4 },
  createSourceFile: () => ({}),
}
`

test("a project 'typescript' that is not the compiler falls back instead of half-loading", async () => {
  // The shape a resolver's global-cache fallback can hand back: the package name resolves, the entry
  // evaluates, and the first `ts.ScriptKind.TSX` throws deep inside a scan. Rejecting it here keeps
  // that from surfacing as a Nifra crash on a project that never installed a compiler.
  const root = await mkdtemp(join(tmpdir(), "nifra-ts-stub-"))
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "app" }))
    await installTypeScript(root, {
      packageJson: { name: "typescript", version: "7.0.2", main: "./lib/version.cjs" },
      entries: { "version.cjs": 'module.exports = { version: "7.0.2" }\n' },
    })
    const ts = await importProjectTypeScript(root)
    expect(ts?.ScriptKind).toBeDefined()
    expect(ts?.createSourceFile).toBeTypeOf("function")
    expect(ts?.version).not.toBe("7.0.2")
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
      packageJson: { name: "typescript", version: "0.0.0-fixture", main: "./lib/typescript.js" },
      entries: { "typescript.js": FIXTURE_COMPILER },
    })
    const after = await importProjectTypeScript(root)
    expect(after?.version).toBe("0.0.0-fixture")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

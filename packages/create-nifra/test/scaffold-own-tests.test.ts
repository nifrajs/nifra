import { afterAll, describe, expect, test } from "bun:test"
import { readFile, symlink } from "node:fs/promises"
import { join, resolve } from "node:path"
import ts from "typescript"
import { materializeAll } from "./_scaffold-fixtures.ts"

// `bun test` is among the first things someone runs in a new app, so every scaffold's own tests run
// here against this monorepo's packages. Each import is also held to a dependency the scaffold
// declares: the monorepo install resolves any of its packages, so an undeclared one passes here and
// is missing after the user's own `bun install`.

const REPO_ROOT = resolve(import.meta.dir, "../../..")
const SOURCES = new Bun.Glob("**/*.{ts,tsx,mts,cts,js,jsx,mjs,svelte,vue}")
const TESTS = new Bun.Glob("**/*.test.{ts,tsx,js,jsx}")
const SCRIPT_BLOCK = /<script\b[^>]*>([\s\S]*?)<\/script[^>]*>/gi

const { scaffolds, cleanup } = await materializeAll()
afterAll(cleanup)

/** The package a bare specifier names, or `undefined` for a relative path or a runtime builtin. */
function packageName(specifier: string): string | undefined {
  if (/^(\.|\/|node:|bun:)/.test(specifier)) return undefined
  const parts = specifier.split("/")
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]
}

/** Every module a file names, type-only and dynamic imports included: tsc resolves both. */
async function importsOf(file: string): Promise<string[]> {
  const text = await readFile(file, "utf8")
  const code = /\.(svelte|vue)$/.test(file)
    ? [...text.matchAll(SCRIPT_BLOCK)].map((block) => block[1]).join("\n")
    : text
  return ts.preProcessFile(code, true, true).importedFiles.map((ref) => ref.fileName)
}

function sourceFiles(dir: string, glob: Bun.Glob): string[] {
  return [...glob.scanSync({ cwd: dir })].filter((file) => !file.startsWith("node_modules/"))
}

describe("scaffolds: declared dependencies", () => {
  for (const { label, dir } of scaffolds) {
    test(`${label} imports only packages its package.json declares`, async () => {
      const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }
      const declared = new Set([
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
      ])
      const undeclared: string[] = []
      for (const file of sourceFiles(dir, SOURCES)) {
        for (const specifier of await importsOf(join(dir, file))) {
          const name = packageName(specifier)
          if (name !== undefined && !declared.has(name)) undeclared.push(`${file}: ${specifier}`)
        }
      }
      expect(undeclared).toEqual([])
    })
  }
})

describe("scaffolds: their own tests pass", () => {
  const tested = scaffolds.filter(({ dir }) => sourceFiles(dir, TESTS).length > 0)

  test("the api and batteries templates ship tests", () => {
    expect(tested.map(({ label }) => label).sort()).toEqual(["template", "template-batteries"])
  })

  for (const { label, dir } of tested) {
    test(`${label}: bun test`, async () => {
      await symlink(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"), "dir")
      const proc = Bun.spawn([process.execPath, "test"], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      expect({ exitCode, output: `${stdout}${stderr}` }).toMatchObject({ exitCode: 0 })
      expect(stderr).toMatch(/\b0 fail\b/)
    }, 60_000)
  }
})

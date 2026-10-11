import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { loadTypeScript, UNSUPPORTED_TYPESCRIPT } from "../src/server-components/typescript.ts"

const root = mkdtempSync(join(tmpdir(), "nifra-components-ts-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

test("a TypeScript with no compiler API is named, not a TypeError on first use", () => {
  // TypeScript 7's root export is its version and nothing else.
  const typescript = join(root, "node_modules", "typescript")
  mkdirSync(typescript, { recursive: true })
  writeFileSync(
    join(typescript, "package.json"),
    JSON.stringify({ name: "typescript", version: "7.0.2", main: "version.cjs" }),
  )
  writeFileSync(join(typescript, "version.cjs"), 'module.exports = { version: "7.0.2" }\n')
  const from = pathToFileURL(join(root, "app.js")).href
  let thrown: unknown
  try {
    loadTypeScript(from)
  } catch (error) {
    thrown = error
  }
  expect(thrown).toMatchObject({ code: UNSUPPORTED_TYPESCRIPT, version: "7.0.2" })
  expect(String(thrown)).toContain("TypeScript 7.0.2 does not ship")
  expect(String(thrown)).toContain("bun add -d typescript@^6")
})

test("the compiler API loads where the project has one", () => {
  expect(typeof loadTypeScript().createSourceFile).toBe("function")
})

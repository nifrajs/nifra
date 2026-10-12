import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type DeclaredPackage, outputIsStale, staleDeclarations } from "./llms-corpus-check.ts"

let root: string

const file = (path: string, text: string, seconds: number): void => {
  const full = join(root, path)
  mkdirSync(join(full, ".."), { recursive: true })
  writeFileSync(full, text)
  utimesSync(full, seconds, seconds)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "llms-check-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test("a declaration older than its source, or missing, refuses the corpus", () => {
  file("fresh/src/index.ts", "export {}", 1_000)
  file("fresh/dist/index.d.ts", "export {}", 2_000)
  file("old/src/index.ts", "export {}", 3_000)
  file("old/dist/index.d.ts", "export {}", 2_000)
  file("unbuilt/src/index.ts", "export {}", 1_000)
  file("source/src/index.ts", "export {}", 9_000)
  const pkg = (name: string, types?: string): DeclaredPackage =>
    types === undefined ? { name, dir: join(root, name) } : { name, dir: join(root, name), types }
  expect(
    staleDeclarations([
      pkg("fresh", "./dist/index.d.ts"),
      pkg("old", "./dist/index.d.ts"),
      pkg("unbuilt", "./dist/index.d.ts"),
      pkg("source", "./src/index.ts"),
      pkg("data"),
    ]),
  ).toEqual(["old: ./dist/index.d.ts is older than src/", "unbuilt: missing ./dist/index.d.ts"])
})

test("a committed output that differs from the generated one, or is missing, is stale", () => {
  const path = join(root, "llms.txt")
  expect(outputIsStale(path, "generated\n")).toBe(true)
  writeFileSync(path, "generated\n")
  expect(outputIsStale(path, "generated\n")).toBe(false)
  expect(outputIsStale(path, "generated, then edited\n")).toBe(true)
})

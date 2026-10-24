import { afterEach, expect, test } from "bun:test"
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { staleArtifacts } from "./gen-node-outcome.ts"

const ROOT = join(import.meta.dir, "..")
const FILES = [
  "packages/core/src/server/node-outcome.ts",
  "packages/core/src/server/bridge-markers.ts",
  "packages/core/src/server/request-target.ts",
  "packages/core/src/static-file.ts",
  "packages/core/src/range.ts",
  "packages/core/src/server/json-text.ts",
  "packages/node/src/generated/node-outcome.ts",
  "packages/node/src/generated/bridge-markers.ts",
  "packages/node/src/generated/request-target.ts",
  "packages/node/src/generated/static-file.ts",
  "packages/node/src/generated/range.ts",
  "packages/node/src/generated/json-text.ts",
]
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "node-outcome-"))
  roots.push(root)
  for (const file of FILES) cpSync(join(ROOT, file), join(root, file))
  return root
}

test("control: the committed copies are current", () => {
  expect(staleArtifacts(fixture())).toEqual([])
})

test("a generated copy that drifts from core, or is missing, is stale", () => {
  const root = fixture()
  appendFileSync(join(root, "packages/core/src/server/request-target.ts"), "\n// drift\n")
  appendFileSync(join(root, "packages/core/src/static-file.ts"), "\n// drift\n")
  appendFileSync(join(root, "packages/core/src/range.ts"), "\n// drift\n")
  appendFileSync(join(root, "packages/core/src/server/json-text.ts"), "\n// drift\n")
  rmSync(join(root, "packages/node/src/generated/bridge-markers.ts"))
  expect(staleArtifacts(root)).toEqual([
    "packages/node/src/generated/bridge-markers.ts",
    "packages/node/src/generated/request-target.ts",
    "packages/node/src/generated/static-file.ts",
    "packages/node/src/generated/range.ts",
    "packages/node/src/generated/json-text.ts",
  ])
})

test("a copied module that gains an import is refused, not copied", () => {
  const root = fixture()
  const range = join(root, "packages/core/src/range.ts")
  writeFileSync(range, `import { x } from "./x.ts"\n${readFileSync(range, "utf8")}`)
  expect(() => staleArtifacts(root)).toThrow(
    "packages/core/src/range.ts must not import anything - @nifrajs/node runs a copy of it",
  )
})

import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { run } from "./gen-public-product-manifest.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Two public packages and one private one, under a README that states `stated` packages. */
function fixture(stated: number): string {
  const root = mkdtempSync(join(tmpdir(), "public-manifest-"))
  roots.push(root)
  const packages: Record<string, object> = {
    a: { name: "@nifrajs/a", version: "1.0.0" },
    b: { name: "@nifrajs/b", version: "1.0.0" },
    hidden: { name: "@nifrajs/hidden", private: true },
  }
  for (const [dir, manifest] of Object.entries(packages)) {
    mkdirSync(join(root, "packages", dir), { recursive: true })
    writeFileSync(join(root, "packages", dir, "package.json"), JSON.stringify(manifest))
  }
  writeFileSync(
    join(root, "README.md"),
    `# x\n\n## Batteries (${stated} packages, all typed, all optional)\n`,
  )
  return root
}

const TILE = (value: number): string =>
  `{\n  "proof": [\n    {\n      "value": "${value}",\n      "label": "typed packages, all optional"\n    }\n  ]\n}\n`

test("a stale site package tile fails the check and the generator repairs it", () => {
  const error = spyOn(console, "error").mockImplementation(() => {})
  const log = spyOn(console, "log").mockImplementation(() => {})
  try {
    const root = fixture(2)
    const tile = join(root, "site", "shared", "data", "benchmarks.json")
    mkdirSync(join(root, "site", "shared", "data"), { recursive: true })
    writeFileSync(tile, TILE(55))
    expect(run(["--check"], root)).toBe(1)
    expect(error.mock.calls.flat().join("\n")).toContain("site package-count tile is stale")
    expect(run([], root)).toBe(0)
    expect(readFileSync(tile, "utf8")).toBe(TILE(2))
    expect(run(["--check"], root)).toBe(0)
  } finally {
    error.mockRestore()
    log.mockRestore()
  }
})

test("a README count that disagrees with the published packages fails the check", () => {
  const error = spyOn(console, "error").mockImplementation(() => {})
  const log = spyOn(console, "log").mockImplementation(() => {})
  try {
    expect(run(["--check"], fixture(3))).toBe(1)
    expect(error.mock.calls.flat().join("\n")).toContain("README.md package count is stale")
    expect(run(["--check"], fixture(2))).toBe(0)
  } finally {
    error.mockRestore()
    log.mockRestore()
  }
})

import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

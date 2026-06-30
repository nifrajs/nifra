import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { VERSION } from "../src/index.ts"

const pkgVersion = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string
  }
).version

describe("@nifrajs/core", () => {
  test("exposes a semver-shaped VERSION", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  // The exported literal must track the package version. It's hand-maintained (core can't read its own
  // package.json on the edge), so this is the fast-feedback analog of the check:publish gate — it caught
  // nothing for the "0.0.0"-through-1.0.0 drift because it didn't exist yet.
  test("VERSION matches the package version", () => {
    // `pkgVersion` (string) on the left so the narrow literal `VERSION` is the expected value — flipping
    // these trips toBe's generic (string isn't assignable to the literal type of VERSION).
    expect(pkgVersion).toBe(VERSION)
  })
})

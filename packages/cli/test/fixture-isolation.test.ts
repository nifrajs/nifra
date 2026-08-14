import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

// Phase A fixture-isolation guard.
//
// The collision class this fences off: a suite that roots its scratch fixtures at a FIXED path
// (historically named `.tmp-<suite>` under the test dir) instead of a unique per-run directory.
// When the full CLI suite runs repeated or in parallel, two suites sharing one fixed path race -
// one suite's teardown `rm`s the directory another is still writing, producing flaky, order-
// dependent failures that never reproduce in isolation. Unique roots (mkdtemp, or the
// `createFixtureRoot` seam that wraps it) make every root distinct, so the race cannot exist.
//
// Every fixed fixture root in this package used the `.tmp` naming convention, so banning that
// literal from test sources is a precise, zero-false-positive fence: unique roots either go through
// `createFixtureRoot` (which takes a dot-free prefix and adds the dot itself) or call mkdtemp with a
// non-`.tmp` prefix. A reintroduced `.tmp-` constant is the exact regression, and it lights up here.
const FORBIDDEN = ".tmp"
const SELF = "fixture-isolation.test.ts"
const SEAM = "fixture-root.ts"

describe("CLI test fixtures use unique roots, never a shared fixed path", () => {
  const testFiles = readdirSync(import.meta.dir).filter(
    (name) => name.endsWith(".test.ts") && name !== SELF,
  )

  test("no suite hardcodes a fixed .tmp fixture path", () => {
    const offenders = testFiles.filter((name) =>
      readFileSync(join(import.meta.dir, name), "utf8").includes(FORBIDDEN),
    )
    expect(offenders).toEqual([])
  })

  test("the fixture-root seam still derives roots from mkdtemp", () => {
    const seam = readFileSync(join(import.meta.dir, SEAM), "utf8")
    expect(seam).toContain("mkdtempSync")
  })
})

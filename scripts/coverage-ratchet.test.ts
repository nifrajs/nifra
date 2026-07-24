import { describe, expect, test } from "bun:test"
import { findRegressions, parseLcov } from "./coverage-ratchet.ts"

/**
 * The ratchet is a gate, so it needs its own gate. Its two failure modes are silent: parsing lcov into
 * the wrong numbers, or comparing them in a way that never fails - either produces a green check that
 * means nothing, which is worse than having no check at all.
 */

const lcov = (records: string[]): string => records.join("\n")

describe("parseLcov", () => {
  test("reads function and line ratios per file", () => {
    const parsed = parseLcov(
      lcov([
        "TN:",
        "SF:packages/a/src/one.ts",
        "FNF:4",
        "FNH:3",
        "DA:1,5",
        "DA:2,0",
        "DA:3,1",
        "DA:4,0",
        "end_of_record",
        "SF:packages/a/src/two.ts",
        "FNF:2",
        "FNH:2",
        "DA:1,1",
        "end_of_record",
      ]),
    )
    expect(parsed["packages/a/src/one.ts"]).toEqual({ functions: 75, lines: 50 })
    expect(parsed["packages/a/src/two.ts"]).toEqual({ functions: 100, lines: 100 })
  })

  test("a file with no functions counts as fully covered, not as zero", () => {
    // A constants module has nothing to call. Scoring it 0 would ratchet it to a number it can never
    // regain, and every later run would report a regression that no test can fix.
    const parsed = parseLcov(lcov(["SF:packages/a/src/constants.ts", "FNF:0", "FNH:0", "DA:1,1"]))
    expect(parsed["packages/a/src/constants.ts"]?.functions).toBe(100)
  })

  test("the final record is captured without a trailing end_of_record", () => {
    // Truncated-looking input still has to parse: dropping the last file silently shrinks the gate.
    const parsed = parseLcov(lcov(["SF:packages/a/src/last.ts", "FNF:1", "FNH:1", "DA:1,1"]))
    expect(Object.keys(parsed)).toEqual(["packages/a/src/last.ts"])
  })

  test("an empty report yields nothing rather than throwing", () => {
    expect(parseLcov("")).toEqual({})
  })
})

describe("findRegressions", () => {
  const base = { "a.ts": { functions: 90, lines: 95 } }

  test("a real drop past the tolerance is reported, with both numbers", () => {
    const found = findRegressions(base, { "a.ts": { functions: 80, lines: 95 } })
    expect(found).toEqual([{ file: "a.ts", metric: "functions", was: 90, now: 80 }])
  })

  test("jitter inside the tolerance is not a regression", () => {
    // Adding covered lines to a file moves its percentage without testing anything less.
    expect(findRegressions(base, { "a.ts": { functions: 89.5, lines: 94.5 } })).toEqual([])
  })

  test("an improvement is never a regression", () => {
    expect(findRegressions(base, { "a.ts": { functions: 100, lines: 100 } })).toEqual([])
  })

  test("a deleted or renamed file is not a regression", () => {
    // Otherwise every rename becomes a two-step dance: rename, watch CI fail, update the baseline.
    expect(findRegressions(base, {})).toEqual([])
  })

  test("a brand-new file is not a regression either", () => {
    expect(findRegressions(base, { ...base, "new.ts": { functions: 0, lines: 0 } })).toEqual([])
  })

  test("both metrics are reported when both drop", () => {
    const found = findRegressions(base, { "a.ts": { functions: 10, lines: 20 } })
    expect(found.map((r) => r.metric)).toEqual(["functions", "lines"])
  })
})

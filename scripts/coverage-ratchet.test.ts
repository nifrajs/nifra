import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findRegressions, parseLcov, run } from "./coverage-ratchet.ts"

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

/**
 * The whole run, against fixture files in a temp directory. `findRegressions` being correct proves
 * nothing about the gate if the gate reports a pass whatever it returns - so what is asserted here is
 * the exit code, the thing CI actually reads.
 */
describe("run", () => {
  const report = lcov([
    "SF:packages/a/src/one.ts",
    "FNF:4",
    "FNH:3",
    "DA:1,5",
    "DA:2,0",
    "DA:3,1",
    "DA:4,0",
    "end_of_record",
  ])

  const fixture = async (files: Record<string, string>): Promise<Record<string, string>> => {
    const dir = await mkdtemp(join(tmpdir(), "ratchet-"))
    const paths: Record<string, string> = {}
    for (const [name, contents] of Object.entries(files)) {
      paths[name] = join(dir, name)
      await writeFile(paths[name], contents)
    }
    paths.dir = dir
    return paths
  }

  test("passes when nothing regressed", async () => {
    const f = await fixture({
      "lcov.info": report,
      "baseline.json": JSON.stringify({ "packages/a/src/one.ts": { functions: 75, lines: 50 } }),
    })
    const outcome = await run([], { lcov: f["lcov.info"], baseline: f["baseline.json"] })
    expect(outcome.code).toBe(0)
    expect(outcome.report.join("\n")).toContain("none below baseline")
  })

  test("fails with the file, the metric and both numbers when coverage dropped", async () => {
    const f = await fixture({
      "lcov.info": report,
      "baseline.json": JSON.stringify({ "packages/a/src/one.ts": { functions: 100, lines: 50 } }),
    })
    const outcome = await run([], { lcov: f["lcov.info"], baseline: f["baseline.json"] })
    expect(outcome.code).toBe(1)
    const text = outcome.report.join("\n")
    expect(text).toContain("packages/a/src/one.ts")
    expect(text).toContain("functions: 100.00% -> 75.00%")
  })

  test("counts files the baseline has never seen, without failing on them", async () => {
    const f = await fixture({ "lcov.info": report, "baseline.json": "{}" })
    const outcome = await run([], { lcov: f["lcov.info"], baseline: f["baseline.json"] })
    expect(outcome.code).toBe(0)
    expect(outcome.report.join("\n")).toContain("(1 new, not yet in the baseline)")
  })

  test("--update writes the current numbers, sorted, as the new baseline", async () => {
    const f = await fixture({
      "lcov.info": lcov([
        "SF:z.ts",
        "FNF:1",
        "FNH:1",
        "DA:1,1",
        "end_of_record",
        "SF:a.ts",
        "FNF:1",
        "FNH:1",
        "DA:1,1",
        "end_of_record",
      ]),
    })
    const baseline = join(f.dir as string, "written.json")
    const outcome = await run(["--update"], { lcov: f["lcov.info"], baseline })
    expect(outcome.code).toBe(0)
    const written = await readFile(baseline, "utf8")
    expect(Object.keys(JSON.parse(written))).toEqual(["a.ts", "z.ts"])
  })

  // Code 2 is "the gate could not run", which must never be confused with a pass: a missing report is
  // exactly what a broken CI step leaves behind, and returning 0 there would green-light everything.
  test("a missing lcov report is an error, not a pass", async () => {
    const f = await fixture({ "baseline.json": "{}" })
    const outcome = await run([], {
      lcov: join(f.dir as string, "absent.info"),
      baseline: f["baseline.json"],
    })
    expect(outcome.code).toBe(2)
    expect(outcome.report.join("\n")).toContain("no lcov report")
  })

  test("an lcov report listing no files is an error, not a pass", async () => {
    const f = await fixture({ "lcov.info": "", "baseline.json": "{}" })
    const outcome = await run([], { lcov: f["lcov.info"], baseline: f["baseline.json"] })
    expect(outcome.code).toBe(2)
    expect(outcome.report.join("\n")).toContain("listed no files")
  })

  test("a missing baseline is an error that names the command to create one", async () => {
    const f = await fixture({ "lcov.info": report })
    const outcome = await run([], {
      lcov: f["lcov.info"],
      baseline: join(f.dir as string, "absent.json"),
    })
    expect(outcome.code).toBe(2)
    expect(outcome.report.join("\n")).toContain("--update")
  })
})

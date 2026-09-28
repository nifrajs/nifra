import { describe, expect, test } from "bun:test"
import {
  coverageReportPath,
  parseCoverageThreshold,
  parseLcovTotals,
  summarizeTestRun,
} from "./test-coverage.ts"

describe("coverage runner", () => {
  test("parses LCOV totals and rejects malformed reports", () => {
    expect(
      parseLcovTotals(
        [
          "SF:packages/example/src/index.ts",
          "FNF:2",
          "FNH:1",
          "DA:1,3",
          "DA:2,0",
          "end_of_record",
        ].join("\n"),
      ),
    ).toEqual({ files: 1, functionsFound: 2, functionsHit: 1, linesFound: 2, linesHit: 1 })
    expect(parseLcovTotals("SF:broken.ts\nFNF:nope\n")).toBeUndefined()
    expect(parseLcovTotals("")).toBeUndefined()
  })

  test("parses a bounded coverage threshold", () => {
    expect(parseCoverageThreshold("[test]\ncoverageThreshold = 0.9\n")).toBe(0.9)
    expect(parseCoverageThreshold("coverageThreshold = 1.2\n")).toBeUndefined()
    expect(parseCoverageThreshold("coverageThreshold = nope\n")).toBeUndefined()
  })

  test("classifies only a completed zero-failure run as clean", () => {
    expect(summarizeTestRun("0 fail\nRan 10 tests across 2 files.")).toEqual({
      completed: true,
      hasFailure: false,
      hasNonZeroCount: false,
    })
    expect(summarizeTestRun("(fail) broken\n1 fail\nRan 10 tests across 2 files.").hasFailure).toBe(
      true,
    )
    expect(summarizeTestRun("0 fail")).toEqual({
      completed: false,
      hasFailure: false,
      hasNonZeroCount: false,
    })
  })

  test("resolves the default and explicit LCOV locations", () => {
    expect(coverageReportPath([], "/workspace")).toBe("/workspace/coverage/lcov.info")
    expect(coverageReportPath(["--coverage-dir=artifacts"], "/workspace")).toBe(
      "/workspace/artifacts/lcov.info",
    )
    expect(coverageReportPath(["--coverage-dir"], "/workspace")).toBeUndefined()
  })
})

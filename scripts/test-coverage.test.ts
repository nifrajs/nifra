import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  coverageReportPath,
  floorMisses,
  type LcovRecord,
  parseCoverageThreshold,
  parseLcovRecords,
  summarizeTestRun,
} from "./test-coverage.ts"

describe("coverage runner", () => {
  test("parses one LCOV record per file and rejects malformed reports", () => {
    expect(
      parseLcovRecords(
        [
          "SF:packages/example/src/index.ts",
          "FNF:2",
          "FNH:1",
          "DA:1,3",
          "DA:2,0",
          "end_of_record",
          "SF:packages/example/src/other.ts",
          "FNF:1",
          "FNH:1",
          "DA:1,1",
          "end_of_record",
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/example/src/index.ts",
        functionsFound: 2,
        functionsHit: 1,
        linesFound: 2,
        linesHit: 1,
      },
      {
        file: "packages/example/src/other.ts",
        functionsFound: 1,
        functionsHit: 1,
        linesFound: 1,
        linesHit: 1,
      },
    ])
    expect(parseLcovRecords("SF:broken.ts\nFNF:nope\n")).toBeUndefined()
    expect(parseLcovRecords("FNF:1\nFNH:1\nDA:1,1\n")).toBeUndefined()
    expect(parseLcovRecords("SF:over.ts\nFNF:1\nFNH:2\nDA:1,1\n")).toBeUndefined()
    expect(parseLcovRecords("")).toBeUndefined()
  })

  test("names a Windows path with / like the baseline", () => {
    const records = parseLcovRecords(
      ["SF:src\\small.ts", "FNF:2", "FNH:1", "DA:1,1", "end_of_record"].join("\n"),
    )
    expect(records?.map((record) => record.file)).toEqual(["src/small.ts"])
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
    const cwd = resolve("coverage-test-workspace")
    expect(coverageReportPath([], cwd)).toBe(resolve(cwd, "coverage", "lcov.info"))
    expect(coverageReportPath(["--coverage-dir=artifacts"], cwd)).toBe(
      resolve(cwd, "artifacts", "lcov.info"),
    )
    expect(coverageReportPath(["--coverage-dir"], cwd)).toBeUndefined()
  })
})

const record = (
  file: string,
  functions: [number, number],
  lines: [number, number],
): LcovRecord => ({
  file,
  functionsHit: functions[0],
  functionsFound: functions[1],
  linesHit: lines[0],
  linesFound: lines[1],
})

describe("per-file coverage floor", () => {
  test("one file under the floor misses it, however high the total is", () => {
    const records = [
      ...Array.from({ length: 10 }, (_, index) => record(`full-${index}.ts`, [2, 2], [4, 4])),
      record("small.ts", [1, 2], [2, 3]),
    ]
    const { failing, held } = floorMisses(records, 0.9, {})
    expect(failing.map((miss) => `${miss.file} ${miss.metric}`)).toEqual([
      "small.ts functions",
      "small.ts lines",
    ])
    expect(held).toEqual([])
  })

  test("a file exactly at the floor meets it", () => {
    expect(floorMisses([record("edge.ts", [9, 10], [9, 10])], 0.9, {}).failing).toEqual([])
  })

  test("a miss the baseline already records under the floor is held, not failed", () => {
    const misses = floorMisses([record("old.ts", [1, 2], [9, 10])], 0.9, {
      "old.ts": { functions: 50, lines: 95 },
    })
    expect(misses.held.map((miss) => miss.metric)).toEqual(["functions"])
    expect(misses.failing).toEqual([])
  })

  test("a baseline at or above the floor holds nothing", () => {
    const misses = floorMisses([record("slipped.ts", [17, 20], [9, 10])], 0.9, {
      "slipped.ts": { functions: 90, lines: 90 },
    })
    expect(misses.failing.map((miss) => miss.metric)).toEqual(["functions"])
    expect(misses.held).toEqual([])
  })
})

describe("coverage runner end to end", () => {
  const project = async (baseline?: Record<string, unknown>): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "coverage-floor-"))
    await mkdir(join(root, "src"))
    await mkdir(join(root, "test"))
    await writeFile(join(root, "bunfig.toml"), "[test]\ncoverageThreshold = 0.9\n")
    const imports: string[] = []
    const calls: string[] = []
    for (let index = 0; index < 10; index++) {
      await writeFile(
        join(root, "src", `full${index}.ts`),
        "export const one = (x: number) => x + 1\nexport const two = (x: number) => x + 2\n",
      )
      imports.push(`import * as full${index} from "../src/full${index}.ts"`)
      calls.push(`  expect(full${index}.one(0) + full${index}.two(0)).toBe(3)`)
    }
    await writeFile(
      join(root, "src", "small.ts"),
      "export function a(x: number) {\n  return x + 1\n}\nexport function b(x: number) {\n  return x + 2\n}\n",
    )
    await writeFile(
      join(root, "test", "floor.test.ts"),
      [
        'import { expect, test } from "bun:test"',
        'import { a } from "../src/small.ts"',
        ...imports,
        'test("floor", () => {',
        "  expect(a(0)).toBe(1)",
        ...calls,
        "})",
        "",
      ].join("\n"),
    )
    if (baseline !== undefined)
      await writeFile(join(root, "coverage-baseline.json"), JSON.stringify(baseline))
    return root
  }

  const runner = async (cwd: string): Promise<{ code: number; output: string }> => {
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "test-coverage.ts"),
        "test",
        "--coverage",
        "--coverage-reporter=lcov",
        "--coverage-dir=coverage",
      ],
      {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) => key !== "COVERAGE_BASELINE"),
        ),
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code, output: stdout + stderr }
  }

  test("a run Bun failed on one file's floor fails, though the total clears it", async () => {
    const outcome = await runner(await project())
    expect(outcome.code).toBe(1)
    expect(outcome.output).toContain("src/small.ts functions: 50.00%")
  })

  test("the same miss passes once the committed baseline records it", async () => {
    const outcome = await runner(
      await project({ "src/small.ts": { functions: 50, lines: 66.66666666666667 } }),
    )
    expect(outcome.code).toBe(0)
    expect(outcome.output).toContain("2 file metric(s) sit below the floor")
  })
})

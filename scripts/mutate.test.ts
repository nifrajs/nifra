import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, sep } from "node:path"
import {
  buildImportGraph,
  classify,
  equivalentEntry,
  formatSummary,
  generateMutants,
  importsOf,
  loadEquivalents,
  type Mutant,
  type MutantResult,
  matchEquivalents,
  onLines,
  parseChangedLines,
  parseJunit,
  selectTests,
} from "./mutate.ts"

const SCRIPT = join(import.meta.dir, "mutate.ts")
const RUN_TIMEOUT = 60_000

const ops = (mutants: readonly Mutant[]) => mutants.map((m) => `${m.line} ${m.op} ${m.from}`)

describe("generateMutants", () => {
  test("applies each operator to code and none to types, imports or bare-identifier returns", () => {
    const source = [
      'import { a } from "./a.ts"',
      "type Flag = true",
      "export function f(x: number, ok: boolean): number | undefined {",
      "  if (x >= 1 && !ok) return x + 1",
      "  x++",
      "  return x",
      "}",
    ].join("\n")
    expect(ops(generateMutants("f.ts", source))).toEqual([
      "4 condition->true x >= 1 && !ok",
      "4 condition->false x >= 1 && !ok",
      "4 binary &&->|| &&",
      "4 binary >=->> >=",
      "4 drop ! !ok",
      "4 return undefined return x + 1",
      "4 binary +->- +",
      "5 delete statement x++",
      "5 x++->x-- x++",
    ])
  })

  test("flips booleans, swaps prefix decrements and forces loop and ternary conditions", () => {
    const source = "let n = 3\nwhile (n > 0) --n\nconst s = n === 0 ? true : false\n"
    expect(ops(generateMutants("g.ts", source))).toEqual([
      "2 condition->true n > 0",
      "2 condition->false n > 0",
      "2 binary >->>= >",
      "2 delete statement --n",
      "2 --x->++x --n",
      "3 condition->true n === 0",
      "3 condition->false n === 0",
      "3 binary ===->!== ===",
      "3 flip boolean true",
      "3 flip boolean false",
    ])
  })

  test("names the enclosing function and numbers mutants that share op, function and text", () => {
    const source = [
      "class Box {",
      "  open(a: number, b: number) {",
      "    return [a === 1, b === 1]",
      "  }",
      "}",
      "const check = (a: number) => {",
      "  if (a === 1) return 2",
      "  return [() => a === 1]",
      "}",
    ].join("\n")
    const strict = generateMutants("h.ts", source).filter((m) => m.op === "binary ===->!==")
    expect(strict.map((m) => [m.line, m.fn, m.nth])).toEqual([
      [3, "Box.open", 0],
      [3, "Box.open", 1],
      [7, "check", 0],
      [8, "check", 0],
    ])
  })

  test("parses .tsx as TSX", () => {
    const source = "export const A = (p: { on: boolean }) => <b>{p.on ? 1 : 2}</b>\n"
    expect(ops(generateMutants("a.tsx", source))).toEqual([
      "1 condition->true p.on",
      "1 condition->false p.on",
    ])
  })
})

describe("parseChangedLines", () => {
  test("reads the new side of each hunk, skipping deletions and removed files", () => {
    const diff = [
      "diff --git a/packages/a/src/x.ts b/packages/a/src/x.ts",
      "--- a/packages/a/src/x.ts",
      "+++ b/packages/a/src/x.ts",
      "@@ -3 +3 @@ export const a = 1",
      "-old",
      "+new",
      "@@ -10,2 +11,3 @@",
      "@@ -20,4 +22,0 @@",
      "diff --git a/packages/a/src/gone.ts b/packages/a/src/gone.ts",
      "--- a/packages/a/src/gone.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "diff --git a/packages/b/src/only-deleted.ts b/packages/b/src/only-deleted.ts",
      "+++ b/packages/b/src/only-deleted.ts",
      "@@ -5,2 +4,0 @@",
    ].join("\n")
    const changed = parseChangedLines(diff)
    expect([...changed.keys()]).toEqual(["packages/a/src/x.ts"])
    expect([...(changed.get("packages/a/src/x.ts") ?? [])]).toEqual([3, 11, 12, 13])
  })
})

describe("onLines", () => {
  test("keeps a mutant whose replaced text touches a changed line", () => {
    const source = ["const f = (a: number) =>", "  a > 1 &&", "  a < 9", "f(2)"].join("\n")
    const mutants = generateMutants("i.ts", source)
    expect(ops(onLines(mutants, new Set([3])))).toEqual(["3 binary <-><= <"])
    expect(onLines(mutants, new Set([4])).map((m) => m.op)).toEqual(["delete statement"])
    const statement = "foo(\n  1,\n  2,\n)\n"
    expect(onLines(generateMutants("j.ts", statement), new Set([3])).map((m) => m.op)).toEqual([
      "delete statement",
    ])
  })
})

describe("equivalents", () => {
  const source = ["function f(a: number) {", "  if (a > 0) return a * 2", "  return 0", "}"].join(
    "\n",
  )
  const entry = {
    op: "binary >->>=",
    fn: "f",
    code: "if (a > 0) return a * 2",
    from: ">",
    reason: "0 * 2 is 0",
  }

  test("match by function and source text, so they hold when lines above move", () => {
    const moved = `// a new header line\n\n${source}`
    for (const text of [source, moved]) {
      const mutants = generateMutants("f.ts", text)
      const { reasons, unused } = matchEquivalents(mutants, [entry])
      const matched = mutants.filter((m) => reasons.has(m.id))
      expect(matched.map((m) => m.op)).toEqual(["binary >->>="])
      expect(unused).toEqual([])
    }
  })

  test("stop matching when the line itself changes, and are reported unused", () => {
    const edited = source.replace("a * 2", "a * 3")
    const { reasons, unused } = matchEquivalents(generateMutants("f.ts", edited), [entry])
    expect(reasons.size).toBe(0)
    expect(unused).toEqual([entry])
  })

  test("tell identical mutants on one line apart by nth", () => {
    const twice = "const g = (a: number, b: number) => a === 1 || b === 1\n"
    const mutants = generateMutants("g.ts", twice).filter((m) => m.op === "binary ===->!==")
    const [first, second] = mutants
    if (first === undefined || second === undefined) throw new Error("expected two mutants")
    const entry = { ...equivalentEntry(second), reason: "only the second" }
    expect(entry.nth).toBe(1)
    expect("nth" in equivalentEntry(first)).toBe(false)
    const { reasons } = matchEquivalents(mutants, [entry])
    expect([...reasons.keys()]).toEqual([second.id])
  })

  test("a recorded entry must give a reason", () => {
    const dir = mkdtempSync(join(tmpdir(), "mutate-eq-"))
    try {
      const path = join(dir, "eq.json")
      writeFileSync(path, JSON.stringify({ "f.ts": [{ ...entry, reason: " " }] }))
      expect(() => loadEquivalents(path)).toThrow("gives no reason")
      writeFileSync(path, JSON.stringify({ "f.ts": [{ op: "x", reason: "r" }] }))
      expect(() => loadEquivalents(path)).toThrow("lacks fn")
      writeFileSync(path, JSON.stringify({ "f.ts": [{ ...entry, nth: 0 }] }))
      expect(() => loadEquivalents(path)).toThrow("not a positive integer")
      writeFileSync(path, JSON.stringify({ "f.ts": [entry] }))
      expect(loadEquivalents(path)).toEqual({ "f.ts": [entry] })
      expect(loadEquivalents(join(dir, "missing.json"))).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("parseJunit and classify", () => {
  const xml = [
    '<testsuites name="bun test" tests="3">',
    '<testsuite name="t.test.ts" file="t.test.ts">',
    '<testcase name="keeps &quot;x&quot; &amp; y" classname="a" file="t.test.ts" line="3" />',
    '<testcase name="breaks" classname="a" file="t.test.ts" line="7"><failure type="AssertionError" /></testcase>',
    '<testcase name="was already red" classname="a" file="t.test.ts" line="9"><failure /></testcase>',
    "</testsuite></testsuites>",
  ].join("\n")
  const baseline = {
    cases: [
      { id: 't.test.ts:3 keeps "x" & y', failed: false },
      { id: "t.test.ts:7 breaks", failed: false },
      { id: "t.test.ts:9 was already red", failed: true },
      { id: "u.test.ts:1 elsewhere", failed: false },
    ],
    errors: 0,
  }
  const run = (
    cases: ReturnType<typeof parseJunit> | undefined,
    extra: { errors?: number; timedOut?: boolean } = {},
  ) => ({
    cases,
    errors: extra.errors ?? 0,
    timedOut: extra.timedOut ?? false,
    ms: 1,
  })

  test("reads each case as file:line name with its outcome", () => {
    expect(parseJunit(xml)).toEqual([
      { id: 't.test.ts:3 keeps "x" & y', failed: false },
      { id: "t.test.ts:7 breaks", failed: true },
      { id: "t.test.ts:9 was already red", failed: true },
    ])
  })

  test("only a test that passed on the baseline kills, and a vanished one counts", () => {
    expect(classify(baseline, run(parseJunit(xml)), false)).toEqual({
      status: "killed",
      killedBy: ["t.test.ts:7 breaks", "u.test.ts:1 elsewhere"],
    })
    expect(classify(baseline, run(parseJunit(xml)), true)).toEqual({
      status: "killed",
      killedBy: ["t.test.ts:7 breaks"],
    })
    const green = baseline.cases.map((c) => ({ ...c }))
    expect(classify(baseline, run(green), false)).toEqual({ status: "survived", killedBy: [] })
  })

  test("a timeout, a missing report and a new error outside a test are detections", () => {
    const green = baseline.cases.map((c) => ({ ...c }))
    expect(classify(baseline, run(green, { timedOut: true }), false).status).toBe("timeout")
    expect(classify(baseline, run(undefined), false).status).toBe("error")
    expect(classify(baseline, run([]), false).status).toBe("error")
    expect(classify(baseline, run(green, { errors: 1 }), false)).toEqual({
      status: "killed",
      killedBy: ["(error outside a test)"],
    })
    expect(classify({ ...baseline, errors: 1 }, run(green, { errors: 1 }), false).status).toBe(
      "survived",
    )
  })
})

describe("test selection", () => {
  test("reads runtime imports only", () => {
    const source = [
      'import type { A } from "./types.ts"',
      'import { type B, type C } from "./more-types.ts"',
      'import { d, type E } from "./mixed.ts"',
      'import "./side-effect.ts"',
      'export { f } from "./reexport.ts"',
      'export type { G } from "./type-reexport.ts"',
      'const lazy = () => import("./lazy.ts")',
      'const old = require("./old.cjs")',
      "const dynamic = (name: string) => import(name)",
    ].join("\n")
    expect(importsOf("x.ts", source)).toEqual([
      "./mixed.ts",
      "./side-effect.ts",
      "./reexport.ts",
      "./lazy.ts",
      "./old.cjs",
    ])
  })

  test("selects every test that reaches the file, nearest first", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "mutate-graph-")))
    try {
      const files: Record<string, string> = {
        "src/target.ts": "export const t = 1\n",
        "src/middle.ts": 'export * from "./target.ts"\n',
        "src/types.ts": 'import type { t } from "./target.ts"\nexport type T = typeof t\n',
        "test/direct.test.ts": 'import { t } from "../src/target.ts"\n',
        "test/far.test.ts": 'import { t } from "../src/middle.ts"\n',
        "test/types-only.test.ts": 'import "../src/types.ts"\n',
        "test/unrelated.test.ts": 'import { readFileSync } from "node:fs"\n',
      }
      for (const [file, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, file)), { recursive: true })
        writeFileSync(join(dir, file), text)
      }
      const tests = Object.keys(files)
        .filter((file) => file.endsWith(".test.ts"))
        .map((file) => join(dir, file))
      const graph = buildImportGraph(dir, tests)
      const selected = selectTests(graph, new Set(tests), join(dir, "src/target.ts"))
      expect(selected.map((t) => [relative(dir, t.file).split(sep).join("/"), t.depth])).toEqual([
        ["test/direct.test.ts", 1],
        ["test/far.test.ts", 2],
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("formatSummary", () => {
  test("scores without equivalents or unrun mutants and lists survivors", () => {
    const base = generateMutants(
      "p.ts",
      "export const f = (a: number) => (a > 1 || a === 0 ? true : false)\n",
    )
    const statuses = ["killed", "timeout", "survived", "equivalent", "not-run"] as const
    const mutants: MutantResult[] = base.map((m, i) => ({
      ...m,
      status: statuses[i] ?? "killed",
      killedBy: [],
    }))
    const report = {
      file: "packages/p/src/p.ts",
      tests: [{ file: "t.test.ts", depth: 1 }],
      baselineMs: undefined,
      baselineFailures: undefined,
      mutants,
      unusedEquivalents: [],
    }
    const summary = formatSummary([report], "Whole files.")
    expect(summary).toContain("| `packages/p/src/p.ts` | 7 | 4 | 1 | 1 | 1 | 80.0% |")
    expect(summary).toContain("### Surviving mutants\n")
    expect(summary).toContain(
      "| `packages/p/src/p.ts:1` | `binary \\|\\|->&&` | `export const f = (a: number) => (a > 1 \\|\\| a === 0 ? true : false)` | `f` |",
    )
    expect(formatSummary([report], "Lines changed.", true)).toContain(
      "### Surviving mutants on changed lines\n",
    )
    expect(formatSummary([], "Lines changed.")).toContain("No mutable source lines changed.")
  })

  test("a backslash in a cell is escaped too, so it cannot unescape the pipe after it", () => {
    const mutant = generateMutants(
      "q.ts",
      "export const g = (s: string) => /a\\|b/.test(s) || s === ''\n",
    ).find((m) => m.op === "binary ||->&&")
    if (mutant === undefined) throw new Error("expected a || mutant")
    const summary = formatSummary(
      [
        {
          file: "q.ts",
          tests: [{ file: "q.test.ts", depth: 1 }],
          baselineMs: undefined,
          baselineFailures: undefined,
          mutants: [{ ...mutant, status: "survived", killedBy: [] }],
          unusedEquivalents: [],
        },
      ],
      "Whole files.",
    )
    expect(summary).toContain(
      "| `q.ts:1` | `binary \\|\\|->&&` | `export const g = (s: string) => /a\\\\\\|b/.test(s) \\|\\| s === ''` | `g` |",
    )
  })

  test("names untested files, tests already red, a missing baseline and stale equivalents", () => {
    const quiet = { tests: [], mutants: [], baselineMs: undefined, unusedEquivalents: [] }
    const stale = { op: "drop !", fn: "f", code: "!a", from: "!a", reason: "r" }
    const summary = formatSummary(
      [
        { ...quiet, file: "a.ts", baselineFailures: undefined },
        {
          ...quiet,
          file: "b.ts",
          tests: [{ file: "b.test.ts", depth: 1 }],
          baselineFailures: ["x", "y"],
        },
        {
          ...quiet,
          file: "c.ts",
          tests: [{ file: "c.test.ts", depth: 1 }],
          baselineFailures: ["(no report)"],
        },
        { ...quiet, file: "d.ts", baselineFailures: undefined, unusedEquivalents: [stale] },
      ],
      "Whole files.",
    )
    expect(summary).toContain("No test imports `a.ts`, `d.ts`: every mutant there survives.")
    expect(summary).toContain("2 selected tests for `b.ts` already fail without a mutant")
    expect(summary).toContain(
      "The selected tests for `c.ts` gave no report without a mutant, so none ran.",
    )
    expect(summary).toContain(
      "1 `mutation-equivalents.json` entries for `d.ts` match no mutant any more.",
    )
  })
})

// Each case runs the script end to end against a throwaway repo, one `bun test` per mutant. The runner
// kills a test run by its POSIX process group, which Windows does not have.
describe.skipIf(process.platform === "win32")("a run", () => {
  let repo = ""
  // Bun on Windows reads an empty path as the cwd, so an unguarded rm would delete the checkout.
  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true })
    repo = ""
  })

  const SOURCE = [
    "export function clamp(value: number, max: number): number {",
    "  if (value > max) return max",
    "  return value",
    "}",
    "export const isEven = (n: number): boolean => n % 2 === 0",
    "",
  ].join("\n")

  function fixture(testBody: string, equivalents?: object): void {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "mutate-run-")))
    const files: Record<string, string> = {
      "package.json": JSON.stringify({
        name: "fixture",
        private: true,
        scripts: { test: "bun test packages/a/test" },
      }),
      "packages/a/src/math.ts": SOURCE,
      "packages/a/test/math.test.ts": [
        'import { expect, test } from "bun:test"',
        'import { existsSync, readFileSync, writeFileSync } from "node:fs"',
        'import { clamp, isEven } from "../src/math.ts"',
        'const mutated = !readFileSync(new URL("../src/math.ts", import.meta.url), "utf8").includes("value > max")',
        testBody,
        "",
      ].join("\n"),
      ".gitignore": ".mutation/\n.mutation-step-summary.md\n",
    }
    if (equivalents !== undefined) files["mutation-equivalents.json"] = JSON.stringify(equivalents)
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, file)), { recursive: true })
      writeFileSync(join(repo, file), text)
    }
    const git = (...args: string[]) =>
      spawnSync("git", ["-c", "user.email=m@example.com", "-c", "user.name=m", ...args], {
        cwd: repo,
      })
    git("init", "-q")
    git("add", "-A")
    git("commit", "-qm", "fixture")
  }

  const mutate = (...args: string[]) => {
    const summary = join(repo, ".mutation-step-summary.md")
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
    })
    return { ...result, summary: existsSync(summary) ? readFileSync(summary, "utf8") : "" }
  }

  const matrix = (): { tests: Array<{ file: string }>; mutants: MutantResult[] } =>
    JSON.parse(readFileSync(join(repo, ".mutation/kill-matrix.json"), "utf8")).files[0]

  test(
    "kills, keeps the survivor, honours an equivalent and restores the file",
    () => {
      fixture(
        [
          'test("clamps", () => { expect(clamp(5, 3)).toBe(3); expect(clamp(1, 3)).toBe(1) })',
          'test("evens", () => { expect(isEven(2)).toBe(true) })',
        ].join("\n"),
        {
          "packages/a/src/math.ts": [
            {
              op: "binary >->>=",
              fn: "clamp",
              code: "if (value > max) return max",
              from: ">",
              reason: "at value === max both branches return the same number",
            },
          ],
        },
      )
      const result = mutate("--files", "packages/a/src/math.ts")
      expect(result.status).toBe(0)
      expect(readFileSync(join(repo, "packages/a/src/math.ts"), "utf8")).toBe(SOURCE)
      const report = matrix()
      expect(report.tests.map((t) => t.file)).toEqual(["packages/a/test/math.test.ts"])
      expect(report.mutants.map((m) => [m.op, m.status])).toEqual([
        ["condition->true", "killed"],
        ["condition->false", "killed"],
        ["binary >->>=", "equivalent"],
        ["binary ===->!==", "killed"],
      ])
      expect(report.mutants[0]?.killedBy).toEqual(["packages/a/test/math.test.ts:5 clamps"])
      expect(result.summary).toContain("| `packages/a/src/math.ts` | 4 | 3 | 0 | 1 | 0 | 100.0% |")
      expect(readFileSync(join(repo, ".mutation/summary.md"), "utf8")).toBe(result.summary)
    },
    RUN_TIMEOUT,
  )

  test(
    "--changed mutates only the changed lines and lists the survivor",
    () => {
      fixture('test("evens", () => { expect(isEven(2)).toBe(true) })')
      writeFileSync(
        join(repo, "packages/a/src/math.ts"),
        SOURCE.replace("return value\n", "return value + 0\n"),
      )
      const result = mutate("--changed", "HEAD")
      expect(result.status).toBe(0)
      expect(matrix().mutants.map((m) => [m.line, m.op, m.status])).toEqual([
        [3, "return undefined", "survived"],
        [3, "binary +->-", "survived"],
      ])
      expect(result.summary).toContain("### Surviving mutants on changed lines")
      expect(result.summary).toContain(
        "| `packages/a/src/math.ts:3` | `return undefined` | `return value + 0` | `clamp` |",
      )
      const survivors = JSON.parse(readFileSync(join(repo, ".mutation/survivors.json"), "utf8"))
      expect(survivors["packages/a/src/math.ts"][0]).toEqual({
        op: "return undefined",
        fn: "clamp",
        code: "return value + 0",
        from: "return value + 0",
        reason: "",
      })
    },
    RUN_TIMEOUT,
  )

  test(
    "SIGINT mid-run restores the mutated file",
    () => {
      // The test interrupts its own runner the first time it sees a mutant in place.
      fixture(
        'test("interrupt", async () => { if (mutated) { process.kill(process.ppid, "SIGINT"); await new Promise(() => {}) } })',
      )
      const result = mutate("--files", "packages/a/src/math.ts")
      expect(result.status).toBe(130)
      expect(readFileSync(join(repo, "packages/a/src/math.ts"), "utf8")).toBe(SOURCE)
    },
    RUN_TIMEOUT,
  )

  test(
    "exits 3 when the run leaves the git status changed",
    () => {
      fixture(
        'test("litters", () => { if (mutated) writeFileSync(new URL("../../../stray.txt", import.meta.url), "x") })',
      )
      const result = mutate("--files", "packages/a/src/math.ts")
      expect(result.status).toBe(3)
      expect(result.stderr).toContain("stray.txt")
      expect(readFileSync(join(repo, "packages/a/src/math.ts"), "utf8")).toBe(SOURCE)
    },
    RUN_TIMEOUT,
  )

  test(
    "a process a test leaves running does not hold the run open",
    () => {
      fixture(
        'test("starts a server", () => { Bun.spawn(["sleep", "120"], { stdout: "inherit", stderr: "inherit" }); expect(clamp(5, 3)).toBe(3) })',
      )
      const result = mutate("--files", "packages/a/src/math.ts", "--timeout", "30000")
      expect(result.status).toBe(0)
      expect(matrix().mutants.map((m) => m.status)).toEqual([
        "survived",
        "killed",
        "survived",
        "survived",
      ])
    },
    RUN_TIMEOUT,
  )
})

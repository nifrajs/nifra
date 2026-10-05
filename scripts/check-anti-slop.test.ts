import { afterEach, beforeEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { collectFindings, compareCounts, loadRules, run, scan } from "./check-anti-slop.ts"

const PLUGIN_DIR = join(import.meta.dir, "anti-slop")

const FIXTURE = `declare const input: unknown
declare const ok: boolean
type Item = { id: number }

export const chained = input as unknown as Item
export const constOnly = [1] as const
export const spread = { ...(ok ? { a: 1 } : {}) }
export const kept = { ...(ok ? { a: 1 } : { b: 2 }) }
export function widened() {
  const value: unknown = { id: 1 }
  return value as Item
}
export function parsed(raw: unknown) {
  const value: unknown = raw
  return value as Item
}
// biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the fixture checks the suppression path
export const justified = input as Item
`

let project: string
let baseline: string

const git = (...args: string[]): void => {
  const result = spawnSync("git", args, { cwd: project, encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr)
}

const writeTracked = async (file: string, source: string): Promise<void> => {
  await writeFile(join(project, file), source)
  git("add", file)
}

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "anti-slop-"))
  baseline = join(project, "baseline.json")
  const rules = await loadRules()
  await writeFile(
    join(project, "biome.json"),
    JSON.stringify({
      plugins: [...rules.values()].map((rule) => join(PLUGIN_DIR, `${rule}.grit`)),
      linter: { rules: { recommended: false } },
      formatter: { enabled: false },
      assist: { enabled: false },
    }),
  )
  git("init", "-q")
  await writeTracked("fixture.ts", FIXTURE)
})

afterEach(async () => {
  await rm(project, { recursive: true, force: true })
})

test("each plugin flags its pattern and leaves the near misses alone", async () => {
  const { findings } = await scan(project)
  expect(findings.map(({ rule, line }) => `${line} ${rule}`).sort()).toEqual([
    "11 noWidenThenAssert",
    "11 requireSafetyCommentForTypeAssertion",
    "15 requireSafetyCommentForTypeAssertion",
    "5 noChainedTypeAssertions",
    "5 requireSafetyCommentForTypeAssertion",
    "5 requireSafetyCommentForTypeAssertion",
    "7 noConditionalEmptyObjectSpread",
  ])
})

test("untracked files are not counted", async () => {
  await writeFile(join(project, "local.ts"), "export const x = (1 as unknown) as string\n")
  const { findings } = await scan(project)
  expect(findings.some((finding) => finding.file === "local.ts")).toBe(false)
})

test("a plugin diagnostic no rule claims fails the run instead of counting as zero", async () => {
  const rules = await loadRules()
  const report = JSON.stringify({
    diagnostics: [{ category: "plugin", message: "Error(s) during loading of plugins" }],
  })
  expect(() => collectFindings(report, rules)).toThrow("unrecognised plugin diagnostic")
})

test("compareCounts treats a deleted file as a decrease, not an increase", () => {
  const result = compareCounts({ rule: { "gone.ts": 2, "kept.ts": 1 } }, { rule: { "kept.ts": 3 } })
  expect(result.increased).toEqual([{ rule: "rule", file: "kept.ts", was: 1, now: 3 }])
  expect(result.decreased).toEqual([{ rule: "rule", file: "gone.ts", was: 2, now: 0 }])
})

test("the ratchet freezes existing findings and rejects new ones", async () => {
  const paths = { cwd: project, baseline }
  expect((await run([], paths)).code).toBe(2)
  expect((await run(["--update"], paths)).code).toBe(0)
  expect((await run([], paths)).code).toBe(0)

  await writeTracked(
    "moved.ts",
    "declare const ok: boolean\nexport const m = { ...(ok ? {} : { a: 1 }) }\n",
  )
  const failed = await run([], paths)
  expect(failed.code).toBe(1)
  expect(failed.report).toContain("    noConditionalEmptyObjectSpread: 0 -> 1")
  expect(failed.report).toContain("      moved.ts:2")
  expect(failed.report.join("\n")).toContain("biome-ignore lint/plugin/<rule>")

  expect((await run(["--update"], paths)).code).toBe(1)
  expect((await run(["--accept-increase"], paths)).code).toBe(2)
  const raised = await run(["--update", "--accept-increase"], paths)
  expect(raised.code).toBe(0)
  expect(raised.report.join("\n")).toContain("moved.ts noConditionalEmptyObjectSpread: 0 -> 1")

  git("rm", "-q", "-f", "moved.ts")
  const below = await run([], paths)
  expect(below.code).toBe(0)
  expect(below.report[0]).toContain("1 entry/entries below it")
  expect((await run(["--update"], paths)).code).toBe(0)
  expect(await readFile(baseline, "utf8")).not.toContain("moved.ts")
})

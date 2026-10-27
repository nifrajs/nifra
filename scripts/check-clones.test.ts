import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { compareCounts, findClones, run, WINDOW } from "./check-clones.ts"

const block = (
  name: string,
): string => `export function ${name}(input: { a: number; b: number; c: string }) {
  const total = input.a + input.b * 2 - input.a / 3
  if (total > 10 && input.c.length > 0) return { total, label: input.c.toUpperCase() }
  for (let i = 0; i < input.b; i++) console.log(i, input.a, input.c)
  return { total: total - 1, label: input.c.slice(0, 2) }
}
`

test("a block copied between two files of one package is one clone, both copies counted", () => {
  const { clones, counts } = findClones([
    { path: "packages/alpha/src/one.ts", text: block("first") },
    { path: "packages/alpha/src/two.ts", text: `const unrelated = 1\n${block("second")}` },
  ])
  expect(clones).toHaveLength(1)
  const [clone] = clones
  expect(clone?.pkg).toBe("alpha")
  expect(clone?.tokens).toBeGreaterThanOrEqual(WINDOW)
  expect([clone?.a.path, clone?.b.path]).toEqual([
    "packages/alpha/src/one.ts",
    "packages/alpha/src/two.ts",
  ])
  expect(clone?.b.firstLine).toBe(2)
  expect(counts).toEqual({ alpha: 2 * (clone?.tokens ?? 0) })
})

test("a copy in another package is not counted", () => {
  const found = findClones([
    { path: "packages/alpha/src/one.ts", text: block("first") },
    { path: "packages/beta/src/one.ts", text: block("second") },
  ])
  expect(found).toEqual({ clones: [], counts: {} })
})

test("shared import lists are not copies", () => {
  const names = Array.from({ length: 40 }, (_, i) => `name${i}`).join(", ")
  const imports = `import { ${names} } from "./names.ts"\nexport { ${names} } from "./names.ts"\n`
  const found = findClones([
    { path: "packages/alpha/src/one.ts", text: `${imports}export const one = 1\n` },
    { path: "packages/alpha/src/two.ts", text: `${imports}export const two = 2\n` },
  ])
  expect(found).toEqual({ clones: [], counts: {} })
})

test("a third copy adds its own tokens once, and counts compare both ways", () => {
  const two = findClones([
    { path: "packages/alpha/src/one.ts", text: block("first") },
    { path: "packages/alpha/src/two.ts", text: block("second") },
  ]).counts
  const three = findClones([
    { path: "packages/alpha/src/one.ts", text: block("first") },
    { path: "packages/alpha/src/two.ts", text: block("second") },
    { path: "packages/alpha/src/three.ts", text: block("third") },
  ]).counts
  expect((three.alpha ?? 0) * 2).toBe((two.alpha ?? 0) * 3)
  expect(compareCounts({ alpha: 1, gone: 5 }, three)).toEqual({
    increased: [{ pkg: "alpha", was: 1, now: three.alpha ?? 0 }],
    decreased: [{ pkg: "gone", was: 5, now: 0 }],
  })
})

test("a tracked copy fails the gate until the baseline accepts it; an untracked one is not seen", async () => {
  const project = await mkdtemp(join(tmpdir(), "clones-"))
  const baseline = join(project, "baseline.json")
  const git = (...args: string[]): void => {
    const result = spawnSync("git", args, { cwd: project, encoding: "utf8" })
    if (result.status !== 0) throw new Error(result.stderr)
  }
  const write = async (file: string, text: string, tracked: boolean): Promise<void> => {
    await writeFile(join(project, file), text)
    if (tracked) git("add", file)
  }
  const gate = (...flags: string[]) =>
    run(["bun", "check-clones.ts", ...flags], { cwd: project, baseline })
  try {
    git("init", "-q")
    await mkdir(join(project, "packages/alpha/src"), { recursive: true })
    await write("packages/alpha/src/one.ts", block("first"), true)
    expect((await gate()).code).toBe(2)
    expect((await gate("--update")).code).toBe(0)
    expect(JSON.parse(await readFile(baseline, "utf8"))).toEqual({})

    await write("packages/alpha/src/local.ts", block("local"), false)
    expect((await gate()).code).toBe(0)

    await write("packages/alpha/src/two.ts", block("second"), true)
    const refused = await gate()
    expect(refused.code).toBe(1)
    expect(refused.report.join("\n")).toContain(
      "packages/alpha/src/one.ts:1-6 = packages/alpha/src/two.ts:1-6",
    )
    expect((await gate("--update")).code).toBe(1)
    expect((await gate("--update", "--accept-increase")).code).toBe(0)
    expect((await gate()).code).toBe(0)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

import { afterEach, beforeEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { releaseTreeReport, uncommittedPaths } from "./check-release-tree.ts"

const GATE = join(import.meta.dir, "check-release-tree.ts")
let repo: string

const git = (...args: string[]): void => {
  const result = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd: repo, encoding: "utf8" },
  )
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
}

async function gate(releaseMode: boolean): Promise<{ code: number; out: string }> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }
  if (releaseMode) env.RELEASE_MODE = "1"
  const child = Bun.spawn([process.execPath, GATE], {
    cwd: repo,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, out: stdout + stderr }
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "release-tree-"))
  git("init", "-q")
  writeFileSync(join(repo, ".gitignore"), "ignored/\n")
  writeFileSync(join(repo, "a.ts"), "export {}\n")
  writeFileSync(join(repo, "b.ts"), "export {}\n")
  git("add", ".")
  git("commit", "-q", "--no-verify", "-m", "base")
})
afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

test("a tree matching HEAD passes in a release run", async () => {
  mkdirSync(join(repo, "ignored", "nested"), { recursive: true })
  writeFileSync(join(repo, "ignored", "nested", "biome.json"), "{}")
  expect(uncommittedPaths(repo)).toEqual([])
  expect(await gate(true)).toEqual({
    code: 0,
    out: "✓ release tree: the working tree matches HEAD\n",
  })
}, 30_000)

test("a release run refuses modified, staged, renamed and untracked paths", async () => {
  writeFileSync(join(repo, "a.ts"), "export const a = 1\n")
  git("mv", "b.ts", "c.ts")
  mkdirSync(join(repo, "stray"))
  writeFileSync(join(repo, "stray", "x.ts"), "")
  expect([...uncommittedPaths(repo)].sort()).toEqual(["a.ts", "c.ts", "stray/x.ts"])

  const release = await gate(true)
  expect(release.code).toBe(1)
  expect(release.out).toContain("a release run verifies HEAD")
  expect(release.out).toContain("  stray/x.ts")

  const local = await gate(false)
  expect(local.code).toBe(0)
  expect(local.out).toContain("this run verifies uncommitted work")
}, 30_000)

test("a long listing is cut to the first twenty paths", () => {
  const paths = Array.from({ length: 25 }, (_, index) => `f${index}.ts`)
  const report = releaseTreeReport(paths, true)
  expect(report.ok).toBe(false)
  expect(report.text).toContain("  f19.ts")
  expect(report.text).not.toContain("  f20.ts")
  expect(report.text).toContain("  ... and 5 more")
})

test("outside a git checkout the gate fails instead of passing", () => {
  const outside = mkdtempSync(join(tmpdir(), "release-tree-none-"))
  try {
    expect(() => uncommittedPaths(outside)).toThrow(/git status failed/)
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

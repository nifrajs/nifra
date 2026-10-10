import { afterEach, expect, test } from "bun:test"
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")
const GATE = join(import.meta.dir, "check-plugin-manifest.ts")
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A copy of the manifests the gate reads, so one can be broken without touching the repository. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "plugin-manifest-"))
  roots.push(root)
  cpSync(join(ROOT, "packages", "skills"), join(root, "packages", "skills"), { recursive: true })
  cpSync(join(ROOT, ".claude-plugin"), join(root, ".claude-plugin"), { recursive: true })
  return root
}

async function gate(cwd: string): Promise<{ code: number; stderr: string }> {
  const child = Bun.spawn([process.execPath, "run", GATE], { cwd, stdout: "pipe", stderr: "pipe" })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  return { code, stderr }
}

function edit(root: string, path: string, change: (text: string) => string): void {
  const file = join(root, path)
  writeFileSync(file, change(readFileSync(file, "utf8")))
}

test("control: an untouched copy passes", async () => {
  expect((await gate(fixture())).code).toBe(0)
}, 30_000)

test("CRLF skill frontmatter passes", async () => {
  const root = fixture()
  const skills = join(root, "packages/skills/skills")
  for (const dir of readdirSync(skills)) {
    edit(root, `packages/skills/skills/${dir}/SKILL.md`, (text) => text.replace(/\r?\n/g, "\r\n"))
  }
  expect((await gate(root)).code).toBe(0)
}, 30_000)

test("a plugin version that drifts from the package fails", async () => {
  const root = fixture()
  edit(root, "packages/skills/.claude-plugin/plugin.json", (text) =>
    text.replace(/"version":\s*"[^"]+"/, '"version": "0.0.1"'),
  )
  const { code, stderr } = await gate(root)
  expect(code).toBe(1)
  expect(stderr).toContain("plugin.json version 0.0.1 !=")
}, 30_000)

test("a skill whose frontmatter name is not its directory fails", async () => {
  const root = fixture()
  const skill = [...new Bun.Glob("*/SKILL.md").scanSync(join(root, "packages/skills/skills"))][0]
  if (skill === undefined) throw new Error("no skill bundle to break")
  edit(root, `packages/skills/skills/${skill}`, (text) =>
    text.replace(/^name:\s*\S+/m, "name: renamed"),
  )
  const { code, stderr } = await gate(root)
  expect(code).toBe(1)
  expect(stderr).toContain(`${skill}: frontmatter name renamed != directory`)
}, 30_000)

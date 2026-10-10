import { afterEach, expect, test } from "bun:test"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")
const GATE = join(import.meta.dir, "check-openai-plugin.ts")
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A copy of the plugin package the gate reads, so it can be broken without touching the repository. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "openai-plugin-"))
  roots.push(root)
  cpSync(join(ROOT, "plugins", "nifra"), join(root, "plugins", "nifra"), { recursive: true })
  return root
}

async function gate(cwd: string): Promise<{ code: number; stderr: string }> {
  const child = Bun.spawn([process.execPath, "run", GATE], { cwd, stdout: "pipe", stderr: "pipe" })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  return { code, stderr }
}

function editManifest(root: string, change: (manifest: Record<string, unknown>) => void): void {
  const file = join(root, "plugins", "nifra", "plugin.json")
  const manifest: Record<string, unknown> = JSON.parse(readFileSync(file, "utf8"))
  change(manifest)
  writeFileSync(file, JSON.stringify(manifest, null, 2))
}

test("control: an untouched copy passes", async () => {
  expect((await gate(fixture())).code).toBe(0)
}, 30_000)

test("a manifest without the OpenAI extension or with the wrong license fails", async () => {
  const root = fixture()
  editManifest(root, (manifest) => {
    manifest.license = "UNLICENSED"
    manifest.extensions = {}
  })
  const { code, stderr } = await gate(root)
  expect(code).toBe(1)
  expect(stderr).toContain('plugin.json license must be "MIT"')
  expect(stderr).toContain("plugin.json extensions.com.openai is required")
}, 30_000)

test("a missing manifest fails instead of checking nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "openai-plugin-empty-"))
  roots.push(root)
  const { code, stderr } = await gate(root)
  expect(code).toBe(1)
  expect(stderr).toContain("plugins/nifra/plugin.json: missing or invalid JSON")
}, 30_000)

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createCapabilityManifest,
  deniedCapabilities,
  parseCapabilityManifest,
} from "../src/capabilities.ts"
import { BoundedSubagentRunner } from "../src/subagents.ts"

describe("optional agent safety surfaces", () => {
  test("parses capability manifests and fails closed on denied capabilities", () => {
    const manifest = createCapabilityManifest(
      ["filesystem.read", "process.exec"],
      ["filesystem.read"],
      "run the verifier",
    )
    expect(deniedCapabilities(manifest)).toEqual(["process.exec"])
    expect(parseCapabilityManifest(manifest)).toEqual(manifest)
    expect(() =>
      parseCapabilityManifest({ version: 1, requested: ["unknown"], trusted: [] }),
    ).toThrow("unknown capability")
  })

  test("enforces workspace policy and forwards the selected cwd", async () => {
    const runner = new BoundedSubagentRunner(
      {
        run: async ({ cwd }) => cwd,
      },
      { workspace: { root: process.cwd() } },
    )
    await expect(
      runner.run({ id: "inside", role: "reviewer", prompt: "inspect", cwd: process.cwd() }),
    ).resolves.toMatchObject({ ok: true, output: process.cwd() })
    await expect(
      runner.run({ id: "outside", role: "reviewer", prompt: "inspect", cwd: "/tmp" }),
    ).resolves.toMatchObject({ ok: false, error: "subagent workspace escapes policy root" })
  })

  test("a symlink inside the workspace root does not lead a subagent out of it", async () => {
    const base = mkdtempSync(join(tmpdir(), "nifra-subagent-"))
    try {
      const root = join(base, "root")
      mkdirSync(join(root, "inside"), { recursive: true })
      mkdirSync(join(base, "outside"))
      symlinkSync(join(base, "outside"), join(root, "escape"))
      symlinkSync(join(root, "inside"), join(root, "alias"))
      let runs = 0
      const runner = new BoundedSubagentRunner(
        {
          run: ({ cwd }) => {
            runs += 1
            return cwd
          },
        },
        { workspace: { root } },
      )
      const spec = { id: "child", role: "worker", prompt: "edit" }
      await expect(runner.run({ ...spec, cwd: "escape" })).resolves.toMatchObject({
        ok: false,
        error: "subagent workspace escapes policy root",
      })
      await expect(runner.run({ ...spec, cwd: "escape/not-yet-created" })).resolves.toMatchObject({
        ok: false,
      })
      expect(runs).toBe(0)
      // A link that stays inside the root, and a directory not created yet, still run.
      await expect(runner.run({ ...spec, cwd: "alias" })).resolves.toMatchObject({ ok: true })
      await expect(runner.run({ ...spec, cwd: "inside/new" })).resolves.toMatchObject({ ok: true })

      const leased = new BoundedSubagentRunner(
        { run: () => "ran" },
        {
          workspace: {
            root,
            isolatedWorktree: () => ({ cwd: join(root, "escape") }),
          },
        },
      )
      await expect(leased.run(spec)).resolves.toMatchObject({
        ok: false,
        error: "isolated worktree escapes workspace policy",
      })
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

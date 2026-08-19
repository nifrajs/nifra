import { describe, expect, test } from "bun:test"
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
})

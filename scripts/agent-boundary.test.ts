import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findAgentBoundaryFailures } from "./check-agent-boundary.ts"

describe("agent package boundary", () => {
  test("keeps framework packages free of agent and Workbench imports", async () => {
    expect(await findAgentBoundaryFailures()).toEqual([])
  })

  test("refuses an agent import or dependency in a protected package", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-boundary-"))
    try {
      const core = join(root, "packages", "core")
      mkdirSync(join(core, "src"), { recursive: true })
      writeFileSync(join(core, "src", "leak.ts"), 'import { runAgent } from "@nifrajs/agent"\n')
      writeFileSync(
        join(core, "package.json"),
        JSON.stringify({ dependencies: { "@nifrajs/coding-agent": "1.0.0" } }),
      )
      expect(await findAgentBoundaryFailures(root)).toEqual([
        `${core}/src/leak.ts: forbidden agent import @nifrajs/agent`,
        `${core}/package.json: forbidden agent dependency @nifrajs/coding-agent`,
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("a root with no protected package fails instead of checking nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-boundary-empty-"))
    try {
      expect(await findAgentBoundaryFailures(root)).toEqual([
        `${root}: no protected package found - nothing was checked`,
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

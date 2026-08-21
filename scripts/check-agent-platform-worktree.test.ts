import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  auditAgentPlatformWorktree,
  matchesAgentPlatformAllowlist,
} from "./check-agent-platform-worktree.ts"

function packageDigest(): string {
  return createHash("sha256")
    .update(readFileSync(resolve("package.json")))
    .digest("hex")
}

function fileDigest(path: string): string {
  return createHash("sha256")
    .update(readFileSync(resolve(path)))
    .digest("hex")
}

describe("agent-platform worktree gate", () => {
  test("matches exact, directory, and wildcard allowlist entries", () => {
    expect(matchesAgentPlatformAllowlist("package.json", ["package.json"])).toBe(true)
    expect(
      matchesAgentPlatformAllowlist("packages/agent/src/gateway.ts", ["packages/agent/**"]),
    ).toBe(true)
    expect(
      matchesAgentPlatformAllowlist("packages/agent/README.md", ["packages/*/README.md"]),
    ).toBe(true)
    expect(matchesAgentPlatformAllowlist("outside.ts", ["packages/agent/**"])).toBe(false)
  })

  test("preserves unrelated baseline dirt without permitting overlap", () => {
    const baseline = {
      version: 1 as const,
      commit: "fixture",
      files: [
        {
          path: "bench/http/aggregate.ts",
          digest: fileDigest("bench/http/aggregate.ts"),
        },
      ],
    }
    const unrelated = auditAgentPlatformWorktree("P0-T3", baseline, ["bench/http/aggregate.ts"])
    expect(unrelated.ok).toBe(true)
    expect(unrelated.failures.some((failure) => failure.includes("out-of-allowlist"))).toBe(false)

    const overlap = auditAgentPlatformWorktree(
      "P0-T3",
      { version: 1, commit: "fixture", files: [{ path: "package.json", digest: packageDigest() }] },
      ["package.json"],
    )
    expect(overlap.failures.some((failure) => failure.includes("already dirty"))).toBe(true)
  })

  test("rejects an out-of-allowlist mutation, including a staged-path-shaped record", () => {
    const report = auditAgentPlatformWorktree(
      "P0-T3",
      { version: 1, commit: "fixture", files: [] },
      ["evil.ts"],
    )
    expect(report.failures.some((failure) => failure.includes("out-of-allowlist"))).toBe(true)
  })
})

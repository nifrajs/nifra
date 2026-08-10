import { describe, expect, test } from "bun:test"
import { parseCompatibleReplayFile } from "@nifrajs/core/replay"
import { runRuleRegistry, sourceIndex } from "../src/rules/index.ts"
import { securityRules } from "../src/rules/security.ts"

async function scan(file: string, content: string) {
  return runRuleRegistry(
    {
      root: "/tmp/project",
      sources: sourceIndex([{ file, content }]),
      project: {},
    },
    securityRules,
  )
}

describe("built-in security rules", () => {
  test("flags fail-open catches, secret comparisons, and PII logs", async () => {
    const findings = await scan(
      "routes/security.ts",
      [
        "function requireAuth() { try { check() } catch { return } }",
        "const token = input.token",
        "if (token === expected) console.log(email)",
      ].join("\n"),
    )
    expect(findings.map((finding) => finding.code)).toEqual(["NF-S001", "NF-S002", "NF-S003"])
    expect(findings.find((finding) => finding.code === "NF-S002")?.fix?.recipe).toBe(
      "security.timing-safe-equal",
    )
  })

  test("keeps reviewed overrides visible without failing", async () => {
    const findings = await scan(
      "routes/security.ts",
      [
        "const token = input.token",
        "// @nifra-gate-reviewed",
        "if (token === expected) console.log(token)",
      ].join("\n"),
    )
    expect(findings.every((finding) => finding.severity === "info")).toBe(true)
    expect(findings.every((finding) => finding.evidence?.includes("@nifra-gate-reviewed"))).toBe(
      true,
    )
  })
})

test("legacy replay metadata remains parseable", () => {
  expect(parseCompatibleReplayFile({ seed: 7, caseId: "GET /", runtime: "bun" })).toEqual({
    seed: 7,
    caseId: "GET /",
    runtime: "bun",
  })
  expect(parseCompatibleReplayFile({ seed: 7, schedule: [] })).toEqual({ seed: 7, schedule: [] })
})

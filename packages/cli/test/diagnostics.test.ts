import { describe, expect, test } from "bun:test"
import {
  type Diagnostic,
  diagnosticCompatibilityOf,
  diagnosticWithCompatibility,
  toSarifLog,
} from "../src/diagnostics.ts"

describe("toSarifLog", () => {
  test("projects stable diagnostics into a review-safe SARIF run", () => {
    const diagnostics: readonly Diagnostic[] = [
      {
        code: "NF-C002",
        severity: "error",
        message: "typed client drift",
        file: "src\\routes\\users.ts",
        line: 12,
        evidence: ["GET /users"],
        fix: { recipe: "typed-client", command: "nifra fix --code NF-C002" },
        verify: "nifra check --lints-only",
      },
      {
        code: "NF-C002",
        severity: "warn",
        message: "another occurrence",
        file: "src/routes/other.ts",
        line: 0,
      },
      { code: "NF-I001", severity: "info", message: "advisory without a file" },
    ]

    const sarif = toSarifLog(diagnostics, {
      toolName: "nifra-check",
      toolVersion: "3.3.0",
      uriBaseId: "%SRCROOT%",
    })
    const run = sarif.runs[0]!

    expect(sarif.version).toBe("2.1.0")
    expect(sarif.$schema).toContain("sarif-2.1.0")
    expect(run.tool.driver).toMatchObject({ name: "nifra-check", version: "3.3.0" })
    expect(run.tool.driver.rules).toEqual([
      { id: "NF-C002", shortDescription: { text: "typed client drift" } },
      { id: "NF-I001", shortDescription: { text: "advisory without a file" } },
    ])
    expect(run.results).toEqual([
      {
        ruleId: "NF-C002",
        level: "error",
        message: { text: "typed client drift" },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: "src/routes/users.ts", uriBaseId: "%SRCROOT%" },
              region: { startLine: 12 },
            },
          },
        ],
        properties: {
          "nifra.evidence": ["GET /users"],
          "nifra.verify": "nifra check --lints-only",
          "nifra.fix.recipe": "typed-client",
          "nifra.fix.command": "nifra fix --code NF-C002",
        },
      },
      {
        ruleId: "NF-C002",
        level: "warning",
        message: { text: "another occurrence" },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: "src/routes/other.ts", uriBaseId: "%SRCROOT%" },
            },
          },
        ],
      },
      { ruleId: "NF-I001", level: "note", message: { text: "advisory without a file" } },
    ])
  })

  test("emits an empty but valid run for a clean check", () => {
    expect(toSarifLog([])).toEqual({
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "nifra", rules: [] } },
          results: [],
        },
      ],
    })
  })
})

describe("diagnostic compatibility metadata", () => {
  test("is available to the legacy projector but absent from structured serialization", () => {
    const value = diagnosticWithCompatibility(
      {
        code: "NF-C002",
        severity: "error",
        message: "typed client drift",
      },
      {
        rule: "typed-client",
        fix: "use the typed client",
        suggestion: { kind: "manual", title: "Use the typed client" },
      },
    )

    expect(diagnosticCompatibilityOf(value)).toEqual({
      rule: "typed-client",
      fix: "use the typed client",
      suggestion: { kind: "manual", title: "Use the typed client" },
    })
    expect(JSON.stringify(value)).toBe(
      JSON.stringify({ code: "NF-C002", severity: "error", message: "typed client drift" }),
    )
  })
})

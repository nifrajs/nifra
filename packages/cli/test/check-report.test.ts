import { describe, expect, test } from "bun:test"
import type { CheckResult } from "../src/check.ts"
import { renderCheckReport } from "../src/check.ts"

// The report/exit-code parity contract: `ok` is computed over ALL diagnostics, so every diagnostic -
// named section or not - must be visible in the human text report, and the trailer must state the
// counts that produced the verdict. A finding that flips the exit code but only shows in `--json`
// is the failure mode these tests pin down.

function result(partial: Partial<CheckResult>): CheckResult {
  const diagnostics = partial.diagnostics ?? []
  return {
    ok: !diagnostics.some((d) => d.severity === "error"),
    typecheck: "pass",
    diagnostics,
    ...partial,
  }
}

describe("renderCheckReport parity", () => {
  test("every diagnostic appears in the text report, including rules without a named section", () => {
    const r = result({
      diagnostics: [
        // Named section rule.
        {
          rule: "typed-client",
          severity: "error",
          message: "hand-rolled fetch() to /api/users",
          file: "src/a.ts",
          line: 3,
        },
        // Registry rule publishing under its NF- code - not in the named section list.
        {
          rule: "NF-S002",
          severity: "error",
          code: "NF-S002",
          message: "secret compared with ===",
          file: "src/auth.ts",
          line: 9,
        },
        // Application rule-pack code - unknown to the built-in registry.
        {
          rule: "APP-X001",
          severity: "warning",
          code: "APP-X001",
          message: "app pack advisory finding",
        },
      ],
    })
    const text = renderCheckReport(r).join("\n")
    for (const d of r.diagnostics) expect(text).toContain(d.message)
    expect(r.ok).toBe(false)
  })

  test("unlisted built-in codes render under their registry title", () => {
    const text = renderCheckReport(
      result({
        diagnostics: [
          {
            rule: "NF-C018",
            severity: "error",
            code: "NF-C018",
            message: "route segment 'delete' collides with a reserved client proxy key",
            file: "src/backend.ts",
            line: 12,
          },
        ],
      }),
    ).join("\n")
    expect(text).toContain("Reserved client segment check (NF-C018)")
    expect(text).toContain("✗ Reserved client segment check (NF-C018): 1")
  })

  test("unknown rule codes fall back to the raw rule name", () => {
    const text = renderCheckReport(
      result({
        diagnostics: [{ rule: "APP-X001", severity: "warning", message: "custom finding" }],
      }),
    ).join("\n")
    expect(text).toContain("⚠ APP-X001: 1 (advisory)")
  })

  test("trailer states error and advisory counts", () => {
    const failing = renderCheckReport(
      result({
        diagnostics: [
          { rule: "typed-client", severity: "error", message: "e1" },
          { rule: "NF-S002", severity: "error", message: "e2" },
          { rule: "response-route", severity: "warning", message: "w1" },
        ],
      }),
    )
    expect(failing.at(-1)).toBe("✗ check failed: 2 errors (+1 advisory)")

    const singular = renderCheckReport(
      result({ diagnostics: [{ rule: "typed-client", severity: "error", message: "e1" }] }),
    )
    expect(singular.at(-1)).toBe("✗ check failed: 1 error")

    const advisoryOnly = renderCheckReport(
      result({ diagnostics: [{ rule: "response-route", severity: "warning", message: "w1" }] }),
    )
    expect(advisoryOnly.at(-1)).toBe("✓ check passed (1 advisory)")

    const clean = renderCheckReport(result({}))
    expect(clean.at(-1)).toBe("✓ check passed")
  })

  test("truncation is stated in the report", () => {
    const text = renderCheckReport(
      result({
        diagnostics: [{ rule: "typed-client", severity: "error", message: "e1" }],
        truncated: { shown: 1, total: 41 },
      }),
    ).join("\n")
    expect(text).toContain("showing 1 of 41 diagnostics (truncated)")
  })
})

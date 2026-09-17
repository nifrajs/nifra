import { describe, expect, test } from "bun:test"
import { composeReviewReport } from "../src/compose.ts"
import type { ReviewReportDraft } from "../src/types.ts"

const HASH_A = "a".repeat(64)
const HASH_B = "b".repeat(64)

function draft(strict: boolean): ReviewReportDraft {
  return {
    strict,
    scope: {
      kind: "diff",
      state: "valid",
      gitRef: "main",
      changedPaths: ["src/z.ts", "src/a.ts"],
      pathDigest: HASH_A,
      outOfScopeCount: 0,
    },
    checks: [
      {
        id: "security",
        required: true,
        status: "pass",
        duration: "standard",
        counts: { findings: 1, errors: 0, warnings: 1, info: 0, outOfScope: 0 },
        findingIds: ["finding-1"],
        evidence: [{ source: "check", token: "security", digest: HASH_B }],
      },
    ],
    findings: [
      {
        id: "finding-1",
        check: "security",
        code: "NF-S001",
        severity: "warning",
        category: "security",
        evidence: [{ source: "check", token: "security", digest: HASH_B }],
      },
    ],
  }
}

describe("review report composer", () => {
  test("sorts sanitized inputs and derives a non-strict passing outcome", async () => {
    const result = await composeReviewReport(draft(false))
    expect(result.status).toBe("pass")
    expect(result.blocking).toBe(0)
    expect(result.ok).toBe(true)
    expect(result.scope.changedPaths).toEqual(["src/a.ts", "src/z.ts"])
    expect(Object.isFrozen(result)).toBe(true)
  })

  test("counts strict warnings and unresolved fixes as blocking", async () => {
    const strict = await composeReviewReport({
      ...draft(true),
      fixes: [{ recipe: "manifest.sync", status: "no-op", reasonCode: "fix-no-op" }],
    })
    expect(strict.status).toBe("fail")
    expect(strict.blocking).toBe(2)
    expect(strict.ok).toBe(false)
  })
})

import { describe, expect, test } from "bun:test"
import { canonicalizeReviewReport, digestReviewReport } from "../src/canonical.ts"
import type { ReviewReport } from "../src/types.ts"

const HASH_A = "a".repeat(64)
const HASH_B = "b".repeat(64)

function report(duration: "fast" | "slow"): ReviewReport {
  return {
    version: 1,
    strict: false,
    scope: {
      kind: "project",
      state: "valid",
      changedPaths: ["src/index.ts", "src/app.ts"],
      pathDigest: HASH_A,
      outOfScopeCount: 0,
    },
    checks: [
      {
        id: "typecheck",
        required: true,
        status: "pass",
        duration,
        counts: { findings: 0, errors: 0, warnings: 0, info: 0, outOfScope: 0 },
        findingIds: [],
        evidence: [{ source: "check", token: "typescript", digest: HASH_B }],
      },
    ],
    findings: [],
    blocking: 0,
    ok: true,
    status: "pass",
    digest: HASH_A,
  }
}

describe("review report canonicalization", () => {
  test("excludes display duration and produces the same digest for the same structure", async () => {
    const fast = report("fast")
    const slow = report("slow")
    expect(canonicalizeReviewReport(fast)).toBe(canonicalizeReviewReport(slow))
    expect(canonicalizeReviewReport(fast)).not.toContain("duration")
    await expect(digestReviewReport(fast)).resolves.toBe(await digestReviewReport(slow))
  })

  test("sorts paths and rejects non-finite or negative-zero canonical values", () => {
    const value = canonicalizeReviewReport(report("fast"))
    expect(value.indexOf("src/app.ts")).toBeLessThan(value.indexOf("src/index.ts"))
    expect(() =>
      canonicalizeReviewReport({ ...report("fast"), blocking: -0 } as ReviewReport),
    ).toThrow(TypeError)
  })
})

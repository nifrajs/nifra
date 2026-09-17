import { describe, expect, test } from "bun:test"
import { digestReviewReport } from "../src/canonical.ts"
import { parseReviewReport, ReviewParserError } from "../src/parser.ts"
import type { ReviewReport } from "../src/types.ts"

const HASH_A = "a".repeat(64)
const HASH_B = "b".repeat(64)

function baseReport(): ReviewReport {
  return {
    version: 1,
    strict: false,
    scope: {
      kind: "project",
      state: "valid",
      changedPaths: [],
      pathDigest: HASH_A,
      outOfScopeCount: 0,
    },
    checks: [
      {
        id: "typecheck",
        required: true,
        status: "pass",
        duration: "fast",
        counts: { findings: 0, errors: 0, warnings: 0, info: 0, outOfScope: 0 },
        findingIds: [],
        evidence: [{ source: "check", token: "typecheck", digest: HASH_B }],
      },
    ],
    findings: [],
    blocking: 0,
    ok: true,
    status: "pass",
    digest: HASH_A,
  }
}

async function signedReport(overrides: Partial<ReviewReport> = {}): Promise<ReviewReport> {
  const report = { ...baseReport(), ...overrides } as ReviewReport
  return { ...report, digest: await digestReviewReport(report) }
}

describe("review report parser", () => {
  test("rejects an unknown root key instead of silently stripping it", async () => {
    const promise = parseReviewReport({ unexpected: true })
    await expect(promise).rejects.toBeInstanceOf(ReviewParserError)
    await expect(promise).rejects.toMatchObject({ code: "unknown-key" })
  })

  test("accepts a signed report and deeply freezes its parsed structure", async () => {
    const parsed = await parseReviewReport(await signedReport())
    expect(parsed.status).toBe("pass")
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.scope)).toBe(true)
    expect(Object.isFrozen(parsed.checks[0])).toBe(true)
    expect(Object.isFrozen(parsed.checks[0]?.evidence[0])).toBe(true)
  })

  test("rejects forbidden content at a nested evidence sink", async () => {
    const report = await signedReport()
    const unsafe = {
      ...report,
      checks: [
        {
          ...report.checks[0],
          evidence: [{ source: "check", token: "typecheck", digest: HASH_B, secret: "x" }],
        },
      ],
    }
    await expect(parseReviewReport(unsafe)).rejects.toMatchObject({ code: "forbidden-content" })
  })

  test("rejects traversal paths and unsafe git refs", async () => {
    const report = await signedReport({
      scope: {
        kind: "diff",
        state: "valid",
        gitRef: "feature..secret",
        changedPaths: ["src/index.ts"],
        pathDigest: HASH_A,
        outOfScopeCount: 0,
      },
    })
    await expect(parseReviewReport(report)).rejects.toMatchObject({ code: "invalid-path" })

    const pathReport = await signedReport({
      scope: {
        kind: "project",
        state: "valid",
        changedPaths: ["../secret.ts"],
        pathDigest: HASH_A,
        outOfScopeCount: 0,
      },
    })
    await expect(parseReviewReport(pathReport)).rejects.toMatchObject({ code: "invalid-path" })
  })

  test("rejects mismatched derived outcome and non-canonical ordering", async () => {
    const report = await signedReport({ blocking: 1, ok: false, status: "fail" })
    await expect(parseReviewReport(report)).rejects.toMatchObject({
      code: "derived-field-mismatch",
    })

    const unsorted = await signedReport({
      checks: [baseReport().checks[0]!, { ...baseReport().checks[0]!, id: "security" }],
    })
    await expect(parseReviewReport(unsorted)).rejects.toMatchObject({ code: "non-canonical" })
  })

  test("accepts JSON input but rejects an invalid digest", async () => {
    const report = await signedReport()
    await expect(parseReviewReport(JSON.stringify(report))).resolves.toMatchObject({
      digest: report.digest,
    })
    await expect(parseReviewReport({ ...report, digest: HASH_B })).rejects.toMatchObject({
      code: "derived-field-mismatch",
    })
  })
})

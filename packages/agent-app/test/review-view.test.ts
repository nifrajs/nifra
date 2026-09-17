import { describe, expect, test } from "bun:test"
import { toReviewView } from "../src/view-models.ts"

const DIGEST = "a".repeat(64)

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    strict: false,
    scope: {
      kind: "project",
      state: "valid",
      changedPaths: ["src/app.ts"],
      pathDigest: DIGEST,
      outOfScopeCount: 0,
    },
    checks: [
      {
        id: "typecheck",
        required: true,
        status: "pass",
        duration: "standard",
        counts: { findings: 1, errors: 0, warnings: 1, info: 0, outOfScope: 0 },
        findingIds: ["finding-1"],
        evidence: [{ source: "check", token: "r-typecheck", digest: DIGEST }],
      },
      {
        id: "coverage",
        required: false,
        status: "skipped",
        duration: "none",
        counts: { findings: 0, errors: 0, warnings: 0, info: 0, outOfScope: 0 },
        findingIds: [],
        evidence: [{ source: "coverage", token: "r-coverage", digest: DIGEST }],
        reasonCode: "not-configured",
      },
    ],
    findings: [
      {
        id: "finding-1",
        check: "typecheck",
        code: "NF-X001",
        severity: "warning",
        category: "correctness",
        location: { path: "src/app.ts", line: 7 },
        evidence: [{ source: "check", token: "r-finding", digest: DIGEST, path: "src/app.ts" }],
      },
    ],
    blocking: 0,
    ok: true,
    status: "pass",
    digest: DIGEST,
    ...overrides,
  }
}

describe("content-free review view", () => {
  test("projects pass, skipped checks, unknown bounded codes, and counters", () => {
    const view = toReviewView(report())
    expect(view).toBeDefined()
    expect(view?.status).toBe("pass")
    expect(view?.ok).toBe(true)
    expect(view?.scope).toMatchObject({ changedPathCount: 1, outOfScopeCount: 0 })
    expect(view?.checks.map((check) => check.id)).toEqual(["coverage", "typecheck"])
    expect(view?.checks.find((check) => check.id === "coverage")?.status).toBe("skipped")
    expect(view?.findings[0]?.code).toBe("NF-X001")
    expect(view?.findings[0]?.location).toEqual({ path: "src/app.ts", line: 7 })
  })

  test("projects fail and inconclusive states without changing the report semantics", () => {
    const failed = toReviewView(
      report({
        findings: [
          {
            id: "finding-1",
            check: "typecheck",
            code: "NF-X001",
            severity: "error",
            category: "correctness",
            location: { path: "src/app.ts", line: 7 },
            evidence: [{ source: "check", token: "r-finding", digest: DIGEST, path: "src/app.ts" }],
          },
        ],
        checks: [
          {
            id: "typecheck",
            required: true,
            status: "fail",
            duration: "standard",
            counts: { findings: 1, errors: 1, warnings: 0, info: 0, outOfScope: 0 },
            findingIds: ["finding-1"],
            evidence: [{ source: "check", token: "r-typecheck", digest: DIGEST }],
          },
          {
            id: "coverage",
            required: false,
            status: "skipped",
            duration: "none",
            counts: { findings: 0, errors: 0, warnings: 0, info: 0, outOfScope: 0 },
            findingIds: [],
            evidence: [{ source: "coverage", token: "r-coverage", digest: DIGEST }],
            reasonCode: "not-configured",
          },
        ],
        status: "fail",
        ok: false,
        blocking: 1,
      }),
    )
    expect(failed?.status).toBe("fail")
    expect(failed?.ok).toBe(false)
    expect(failed?.blocking).toBe(1)

    const inconclusive = toReviewView(
      report({
        scope: {
          kind: "project",
          state: "invalid",
          changedPaths: ["src/app.ts"],
          pathDigest: DIGEST,
          outOfScopeCount: 0,
          reasonCode: "invalid-git-scope",
        },
        status: "inconclusive",
        ok: false,
      }),
    )
    expect(inconclusive?.status).toBe("inconclusive")
    expect(inconclusive?.ok).toBe(false)
  })

  test("rejects forbidden fields, unsafe paths, and malformed structural values", () => {
    expect(toReviewView(report({ message: "secret diagnostic" }))).toBeUndefined()
    expect(
      toReviewView(
        report({
          findings: [
            {
              id: "finding-1",
              check: "typecheck",
              code: "NF-X001",
              severity: "error",
              category: "correctness",
              location: { path: "../secret.ts", line: 1 },
              evidence: [{ source: "check", token: "r-finding", digest: DIGEST }],
            },
          ],
          ok: false,
          status: "fail",
          blocking: 1,
        }),
      ),
    ).toBeUndefined()
    expect(
      toReviewView(
        report({
          checks: [
            {
              id: "typecheck",
              required: true,
              status: "pass",
              duration: "standard",
              counts: { findings: 1, errors: 0, warnings: 1, info: 0, outOfScope: 0 },
              findingIds: ["finding-1"],
              evidence: [{ source: "unexpected", token: "r-typecheck", digest: DIGEST }],
            },
            {
              id: "coverage",
              required: false,
              status: "skipped",
              duration: "none",
              counts: { findings: 0, errors: 0, warnings: 0, info: 0, outOfScope: 0 },
              findingIds: [],
              evidence: [{ source: "coverage", token: "r-coverage", digest: DIGEST }],
              reasonCode: "not-configured",
            },
          ],
        }),
      ),
    ).toBeUndefined()
    expect(toReviewView(report({ digest: "not-a-digest" }))).toBeUndefined()
  })

  test("turns missing or malformed host output into a stable unavailable view", () => {
    expect(toReviewView({ ok: false, status: null })).toMatchObject({
      status: "unavailable",
      reasonCode: "unavailable",
      processStatus: null,
    })
    expect(toReviewView({ ok: true, status: 0, report: { message: "raw output" } })).toMatchObject({
      status: "unavailable",
      reasonCode: "invalid-report",
      processStatus: 0,
    })
    expect(toReviewView({ ok: true, status: 0, report: report() })).toMatchObject({
      status: "pass",
      processStatus: 0,
    })
    expect(toReviewView({ ok: false, status: 1, errorCode: "untrusted-host-error" })).toMatchObject(
      { status: "unavailable", reasonCode: "invalid-report", processStatus: null },
    )
    expect(toReviewView({ ok: false, status: 1, errorCode: "timeout" })).toMatchObject({
      status: "unavailable",
      reasonCode: "process-failed",
      processStatus: 1,
    })
  })
})

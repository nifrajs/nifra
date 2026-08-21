import { expect, test } from "bun:test"
import { toEvalComparisonView, toFaultInjectionViews } from "@nifrajs/agent-app"

test("eval view shows explicit regression and fault states", () => {
  const view = toEvalComparisonView({
    suiteId: "studio-suite",
    comparisons: [
      { caseId: "case-a", rubricId: "invariant", code: "tolerated", regressionId: "a" },
      { caseId: "case-b", rubricId: "invariant", code: "regressed", regressionId: "b" },
      { caseId: "case-c", rubricId: "invariant", code: "missing", regressionId: "c" },
      { caseId: "case-d", rubricId: "invariant", code: "incomparable", regressionId: "d" },
    ],
    regressions: ["b"],
  })
  expect(view?.comparisons.map((entry) => entry.code)).toEqual([
    "tolerated",
    "regressed",
    "missing",
    "incomparable",
  ])
  expect(
    toFaultInjectionViews([
      {
        id: "lease",
        kind: "lease",
        scheduleToken: "42:lease:1",
        regressionId: "lease/1",
        ok: false,
      },
    ])[0]?.ok,
  ).toBe(false)
})

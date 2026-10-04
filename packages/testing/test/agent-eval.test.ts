import { expect, test } from "bun:test"
import { assertAgentEval, defineAgentEvalSuite, runAgentEvalComposition } from "../src/index.ts"

test("agent eval composition exposes explicit component regressions", async () => {
  const suite = defineAgentEvalSuite({
    id: "explicit-regressions",
    rubrics: [{ id: "invariant", outcomes: ["fail", "pass"], score: { min: 0, max: 1 } }],
    cases: [{ id: "case", evaluate: () => [{ rubricId: "invariant", outcome: "pass", score: 1 }] }],
  })
  const report = await runAgentEvalComposition({
    suite,
    contractLab: async () => ({ ok: false, code: "schema_drift" }),
    certification: async () => ({ ok: true, digest: "certified" }),
  })
  expect(report.ok).toBe(false)
  expect(report.regressionIds).toEqual(["contract-lab/schema_drift"])
  expect(() => assertAgentEval(report)).toThrow()
  expect(JSON.stringify(report)).not.toMatch(/prompt|message|input|output|reasoning/i)
})

test("a case lists its rubric verdicts in code-unit order, whatever the locale", async () => {
  const rubric = { outcomes: ["fail", "pass"], score: { min: 0, max: 1 } }
  const suite = defineAgentEvalSuite({
    id: "verdict-order",
    rubrics: [
      { id: "a_b", ...rubric },
      { id: "a.b", ...rubric },
    ],
    cases: [
      {
        id: "case",
        evaluate: () => [
          { rubricId: "a_b", outcome: "pass", score: 1 },
          { rubricId: "a.b", outcome: "pass", score: 1 },
        ],
      },
    ],
  })
  const report = await suite.run()
  // ICU puts `_` before `.`; code-unit order puts `.` (0x2E) before `_` (0x5F).
  expect(report.cases[0]?.verdicts.map((verdict) => verdict.rubricId)).toEqual(["a.b", "a_b"])
})

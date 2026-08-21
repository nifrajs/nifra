import { expect, test } from "bun:test"
import {
  assertAgentFailureMatrix,
  defineAgentEvalSuite,
  referenceFaultProfile,
  runAgentEvalComposition,
  runAgentFailureMatrix,
} from "../src/index.ts"

test("agent failure matrix is deterministic across all declared boundaries", async () => {
  const first = await runAgentFailureMatrix({ seed: 42 })
  const second = await runAgentFailureMatrix({ seed: 42 })
  expect(first).toEqual(second)
  expect(first.cases.map((entry) => entry.kind)).toEqual([
    "approval",
    "cancellation",
    "cursor",
    "deployment",
    "lease",
    "model",
    "registry",
    "tool",
  ])
  expect(first.ok).toBe(true)
  expect(() => assertAgentFailureMatrix(first)).not.toThrow()
  expect(JSON.stringify(first)).not.toMatch(/prompt|message|input|output|payload|secret/i)
})
test("composition reuses the existing fault profile and idempotency owners", async () => {
  const suite = defineAgentEvalSuite({
    id: "agent-composition",
    rubrics: [{ id: "invariant", outcomes: ["fail", "pass"], score: { min: 0, max: 1 } }],
    cases: [
      { id: "stable", evaluate: () => [{ rubricId: "invariant", outcome: "pass", score: 1 }] },
    ],
  })
  const report = await runAgentEvalComposition({
    suite,
    faultProfile: { profile: referenceFaultProfile, seed: 7 },
    idempotency: {
      run: () => ({
        method: "POST",
        path: "/effect",
        declared: ["effect.commit"],
        entries: [
          { seq: 0, at: 0, capability: "effect.commit", phase: "committed", digest: "stable" },
        ],
      }),
    },
  })
  expect(report.ok).toBe(true)
  expect(report.components.map((entry) => entry.id)).toEqual(["fault-profile", "idempotency"])
  expect(report.regressionIds).toEqual([])
})

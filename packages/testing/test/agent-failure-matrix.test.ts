import { expect, test } from "bun:test"
import {
  assertAgentEvalBaseline,
  assertAgentFailureMatrix,
  compareAgentEvalBaseline,
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

test("the matrix drives an agent through each boundary and fails one that swallows the crash", async () => {
  const seen: string[] = []
  const honest = await runAgentFailureMatrix({
    execute: (boundary, checkpoint) => {
      seen.push(boundary.kind)
      checkpoint()
    },
  })
  expect(honest.ok).toBe(true)
  expect(seen).toHaveLength(8)
  const swallowing = await runAgentFailureMatrix({
    execute: (boundary, checkpoint) => {
      if (boundary.kind !== "tool") return checkpoint()
      try {
        checkpoint()
      } catch {
        // An agent that hides a tool crash.
      }
    },
  })
  expect(swallowing.ok).toBe(false)
  expect(swallowing.cases.filter((entry) => !entry.ok).map((entry) => entry.kind)).toEqual(["tool"])
  expect(() => assertAgentFailureMatrix(swallowing)).toThrow("tool-effect")
})

test("a baseline comparison fails on a lost or reshaped verdict and passes a new one", async () => {
  const rubric = { id: "quality", outcomes: ["fail", "pass"], score: { min: 0, max: 1 } }
  const suite = (
    cases: readonly { readonly id: string; readonly outcome?: string; readonly max?: number }[],
  ) =>
    defineAgentEvalSuite({
      id: "s",
      rubrics: [{ ...rubric, score: { min: 0, max: cases[0]?.max ?? 1 } }],
      cases: cases.map((entry) => ({
        id: entry.id,
        evaluate: () =>
          entry.outcome === undefined
            ? []
            : [
                {
                  rubricId: "quality",
                  outcome: entry.outcome,
                  score: entry.outcome === "pass" ? 1 : 0,
                },
              ],
      })),
    }).run()
  const baseline = await suite([{ id: "c1", outcome: "pass" }])
  const lost = await compareAgentEvalBaseline(baseline, await suite([{ id: "c1" }]))
  expect(lost.comparisons.map((entry) => entry.code)).toEqual(["missing"])
  expect(lost.regressions).toEqual(["s/c1/quality"])
  const reshaped = await suite([{ id: "c1", outcome: "fail", max: 2 }])
  expect((await compareAgentEvalBaseline(baseline, reshaped)).comparisons[0]?.code).toBe(
    "incomparable",
  )
  await expect(assertAgentEvalBaseline(baseline, reshaped)).rejects.toThrow("s/c1/quality")
  const grown = await suite([
    { id: "c1", outcome: "pass" },
    { id: "c2", outcome: "pass" },
  ])
  const added = await compareAgentEvalBaseline(baseline, grown)
  expect(added.comparisons.map((entry) => entry.code)).toEqual(["equal", "added"])
  expect(added.regressions).toEqual([])
  const optedOut = await compareAgentEvalBaseline(baseline, reshaped, { failOn: ["regressed"] })
  expect(optedOut.regressions).toEqual([])
})

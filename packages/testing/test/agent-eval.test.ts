import { describe, expect, test } from "bun:test"
import {
  type AgentEvalCase,
  AgentEvalRegressionError,
  assertAgentEvalBaseline,
  type ComparisonCode,
  compareAgentEvalBaseline,
  defineAgentEvalSuite,
  parseRubricVerdict,
  type RubricSpec,
  type RubricVerdict,
} from "../src/agent-eval.ts"

// Ordered worst -> best; rank = index. A pass->fail drop is a regression, not incomparable.
const OUTCOME: RubricSpec = {
  id: "outcome",
  outcomes: ["fail", "partial", "pass"],
  score: { min: 0, max: 1 },
  metrics: ["latency_ms"],
}

function verdictCase(id: string, verdict: RubricVerdict): AgentEvalCase {
  return { id, evaluate: () => [verdict] }
}

const v = (outcome: string, score: number, metrics?: Record<string, number>): RubricVerdict => ({
  rubricId: "outcome",
  outcome,
  score,
  ...(metrics ? { metrics } : {}),
})

describe("defineAgentEvalSuite", () => {
  test("rejects duplicate case ids", () => {
    expect(() =>
      defineAgentEvalSuite({
        id: "s",
        rubrics: [OUTCOME],
        cases: [verdictCase("dup", v("pass", 1)), verdictCase("dup", v("fail", 0))],
      }),
    ).toThrow(/duplicate case id/)
  })

  test("rejects duplicate rubric ids", () => {
    expect(() =>
      defineAgentEvalSuite({
        id: "s",
        rubrics: [OUTCOME, { ...OUTCOME }],
        cases: [verdictCase("c", v("pass", 1))],
      }),
    ).toThrow(/duplicate rubric id/)
  })

  test("case order and digests survive declaration reordering", async () => {
    const forward = defineAgentEvalSuite({
      id: "s",
      rubrics: [OUTCOME],
      cases: [verdictCase("b", v("pass", 1)), verdictCase("a", v("fail", 0))],
    })
    const reversed = defineAgentEvalSuite({
      id: "s",
      rubrics: [OUTCOME],
      cases: [verdictCase("a", v("fail", 0)), verdictCase("b", v("pass", 1))],
    })
    expect(forward.caseIds).toEqual(["a", "b"])
    const rf = await forward.run()
    const rr = await reversed.run()
    expect(rf.cases.map((c) => c.caseId)).toEqual(["a", "b"])
    expect(rf.digest).toBe(rr.digest)
  })
})

describe("rubric verdict validation", () => {
  test("rejects an unknown outcome code", () => {
    expect(() => parseRubricVerdict(OUTCOME, v("exploded", 1))).toThrow(/unknown outcome/)
  })

  test("rejects a score out of range", () => {
    expect(() => parseRubricVerdict(OUTCOME, v("pass", 1.5))).toThrow(/out of/)
    expect(() => parseRubricVerdict(OUTCOME, v("pass", Number.NaN))).toThrow(/finite/)
  })

  test("rejects an unknown metric", () => {
    expect(() => parseRubricVerdict(OUTCOME, v("pass", 1, { tokens: 9 }))).toThrow(/unknown metric/)
  })

  test("rejects free-form text carried on the verdict", () => {
    const poisoned = { ...v("pass", 1), reasoning: "the agent tried hard" }
    expect(() => parseRubricVerdict(OUTCOME, poisoned)).toThrow(/unexpected key/)
  })

  test("rejects a non-numeric metric value", () => {
    const poisoned = { ...v("pass", 1), metrics: { latency_ms: "slow" } }
    expect(() => parseRubricVerdict(OUTCOME, poisoned)).toThrow(/finite number/)
  })

  test("run rejects a case scoring a rubric twice", async () => {
    const suite = defineAgentEvalSuite({
      id: "s",
      rubrics: [OUTCOME],
      cases: [{ id: "c", evaluate: () => [v("pass", 1), v("fail", 0)] }],
    })
    await expect(suite.run()).rejects.toThrow(/twice/)
  })
})

describe("baseline comparison", () => {
  const suite = (cases: readonly AgentEvalCase[]) =>
    defineAgentEvalSuite({ id: "s", rubrics: [OUTCOME], cases })

  const codeFor = (
    comparison: { comparisons: readonly { caseId: string; code: ComparisonCode }[] },
    caseId: string,
  ): ComparisonCode =>
    comparison.comparisons.find((c) => c.caseId === caseId)?.code as ComparisonCode

  test("classifies equal / improved / tolerated / regressed / missing / incomparable", async () => {
    // `gone` exists only in the baseline (missing); `shape` scores the same case with a differing
    // score range across the two runs (incomparable). The rest exercise the score/outcome ladder.
    const baseShaped = await defineAgentEvalSuite({
      id: "s",
      rubrics: [OUTCOME, { id: "shape", outcomes: ["no", "yes"], score: { min: 0, max: 10 } }],
      cases: [
        verdictCase("equal", v("pass", 0.9)),
        verdictCase("improved", v("partial", 0.5)),
        verdictCase("tolerated", v("pass", 0.9)),
        verdictCase("regressed", v("pass", 0.9)),
        verdictCase("gone", v("pass", 1)),
        { id: "shaped", evaluate: () => [{ rubricId: "shape", outcome: "yes", score: 5 }] },
      ],
    }).run()
    const currentShaped = await defineAgentEvalSuite({
      id: "s",
      rubrics: [OUTCOME, { id: "shape", outcomes: ["no", "yes"], score: { min: 0, max: 1 } }],
      cases: [
        verdictCase("equal", v("pass", 0.9)),
        verdictCase("improved", v("pass", 0.95)),
        verdictCase("tolerated", v("pass", 0.88)),
        verdictCase("regressed", v("fail", 0.1)),
        { id: "shaped", evaluate: () => [{ rubricId: "shape", outcome: "yes", score: 0.5 }] },
      ],
    }).run()

    const cmp = await compareAgentEvalBaseline(baseShaped, currentShaped, {
      tolerances: [{ rubricId: "outcome", abs: 0.05 }],
    })
    expect(codeFor(cmp, "equal")).toBe("equal")
    expect(codeFor(cmp, "improved")).toBe("improved")
    expect(codeFor(cmp, "tolerated")).toBe("tolerated")
    expect(codeFor(cmp, "regressed")).toBe("regressed")
    expect(codeFor(cmp, "gone")).toBe("missing")
    expect(codeFor(cmp, "shaped")).toBe("incomparable")
  })

  test("a seeded regression fails the assertion with a stable id", async () => {
    const good = await suite([verdictCase("login", v("pass", 1))]).run()
    const bad = await suite([verdictCase("login", v("fail", 0))]).run()
    await expect(assertAgentEvalBaseline(good, bad)).rejects.toThrow(AgentEvalRegressionError)
    try {
      await assertAgentEvalBaseline(good, bad)
    } catch (error) {
      const err = error as AgentEvalRegressionError
      expect(err.comparison.regressions).toEqual(["s/login/outcome"])
    }
  })

  test("tolerated worsening does not fail the assertion", async () => {
    const good = await suite([verdictCase("c", v("pass", 0.9))]).run()
    const dip = await suite([verdictCase("c", v("pass", 0.87))]).run()
    const cmp = await assertAgentEvalBaseline(good, dip, { tolerances: [{ abs: 0.05 }] })
    expect(cmp.regressions).toEqual([])
    expect(codeFor(cmp, "c")).toBe("tolerated")
  })

  test("comparison digest is stable across identical inputs", async () => {
    const base = await suite([verdictCase("c", v("pass", 1))]).run()
    const cur = await suite([verdictCase("c", v("partial", 0.5))]).run()
    const a = await compareAgentEvalBaseline(base, cur)
    const b = await compareAgentEvalBaseline(base, cur)
    expect(a.digest).toBe(b.digest)
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/)
  })
})

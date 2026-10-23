import { describe, expect, test } from "bun:test"
import {
  type AgentEvalSuiteSpec,
  assertAgentEvalBaseline,
  compareAgentEvalBaseline,
  defineAgentEvalSuite,
  parseRubricVerdict,
  type RubricSpec,
  type RubricVerdict,
  runAgentEvalComposition,
} from "../src/index.ts"

const rubric: RubricSpec = {
  id: "quality",
  outcomes: ["fail", "pass"],
  score: { min: 0, max: 10 },
  metrics: ["steps"],
}

const verdict = (score: number, outcome = "pass"): RubricVerdict => ({
  rubricId: "quality",
  outcome,
  score,
})

const suiteOf = (spec: Partial<AgentEvalSuiteSpec>) =>
  defineAgentEvalSuite({
    id: "refusals",
    rubrics: [rubric],
    cases: [{ id: "case", evaluate: () => [verdict(5)] }],
    ...spec,
  })

describe("agent eval verdict parsing", () => {
  test("accepts declared metrics and refuses every malformed verdict", () => {
    expect(parseRubricVerdict(rubric, { ...verdict(5), metrics: { steps: 3 } })).toEqual({
      ...verdict(5),
      metrics: { steps: 3 },
    })
    for (const [value, message] of [
      ["verdict", "verdict must be an object"],
      [{ ...verdict(5), note: "x" }, "verdict carries unexpected key 'note'"],
      [{ ...verdict(5), rubricId: "speed" }, "verdict rubricId 'speed' != 'quality'"],
      [verdict(5, "maybe"), "unknown outcome 'maybe' for rubric quality"],
      [verdict(Number.NaN), "verdict score for quality must be a finite number"],
      [verdict(11), "score 11 out of [0, 10] for quality"],
      [{ ...verdict(5), metrics: [] }, "verdict metrics must be an object"],
      [{ ...verdict(5), metrics: { tokens: 1 } }, "unknown metric 'tokens' for quality"],
      [{ ...verdict(5), metrics: { steps: "3" } }, "metric 'steps' must be a finite number"],
    ] as const)
      expect(() => parseRubricVerdict(rubric, value)).toThrow(`agent eval: ${message}`)
  })
})

describe("agent eval suite definition", () => {
  test("refuses a malformed rubric", () => {
    for (const [bad, message] of [
      [{ ...rubric, id: "Bad Id" }, "rubric id must be a bounded token"],
      [{ ...rubric, outcomes: [] }, "rubric must declare 1-32 outcomes"],
      [{ ...rubric, outcomes: ["pass", "pass"] }, "duplicate outcome 'pass'"],
      [
        { ...rubric, score: { min: 0, max: Number.POSITIVE_INFINITY } },
        "rubric score range must be finite",
      ],
      [{ ...rubric, score: { min: 2, max: 1 } }, "rubric score min must not exceed max"],
      [
        { ...rubric, metrics: Array.from({ length: 33 }, (_, i) => `m${i}`) },
        "rubric declares more than 32 metrics",
      ],
      [{ ...rubric, metrics: ["Steps"] }, "metric name must be a bounded token"],
      [{ ...rubric, metrics: ["steps", "steps"] }, "duplicate metric 'steps'"],
    ] as const)
      expect(() => suiteOf({ rubrics: [bad] })).toThrow(`agent eval: ${message}`)
  })

  test("refuses a malformed suite", () => {
    const evaluate = () => [verdict(5)]
    for (const [spec, message] of [
      [{ version: 0 }, "suite version must be a positive integer"],
      [{ rubrics: [] }, "suite must declare 1-32 rubrics"],
      [{ rubrics: [rubric, rubric] }, "duplicate rubric id 'quality'"],
      [{ cases: [] }, "suite must declare 1-512 cases"],
      [
        {
          cases: [
            { id: "case", evaluate },
            { id: "case", evaluate },
          ],
        },
        "duplicate case id 'case'",
      ],
    ] as const)
      expect(() => suiteOf(spec)).toThrow(`agent eval: ${message}`)
  })

  test("a run refuses a verdict without a rubric, for an unknown rubric, or twice", async () => {
    for (const [produced, message] of [
      [[{ outcome: "pass", score: 1 }], "case 'case' produced a verdict without a rubricId"],
      [[{ ...verdict(1), rubricId: "speed" }], "case 'case' scored unknown rubric 'speed'"],
      [[verdict(1), verdict(2)], "case 'case' scored rubric 'quality' twice"],
    ] as const) {
      const suite = suiteOf({
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion lint/plugin/noChainedTypeAssertions: deliberately malformed verdicts, to prove the runtime refuses what the type already would.
        cases: [{ id: "case", evaluate: () => produced as unknown as RubricVerdict[] }],
      })
      await expect(suite.run()).rejects.toThrow(`agent eval: ${message}`)
    }
  })
})

describe("agent eval baselines", () => {
  const reportFor = (score: number, higherIsBetter = true) =>
    suiteOf({
      rubrics: [{ ...rubric, higherIsBetter }],
      cases: [{ id: "case", evaluate: () => [verdict(score)] }],
    }).run()

  test("a score change in the same outcome is improved, tolerated or regressed", async () => {
    const base = await reportFor(8)
    const codeOf = async (score: number, options = {}) =>
      (await compareAgentEvalBaseline(base, await reportFor(score), options)).comparisons[0]?.code
    expect(await codeOf(9)).toBe("improved")
    expect(await codeOf(7)).toBe("regressed")
    expect(await codeOf(7, { tolerances: [{ abs: 1 }] })).toBe("tolerated")
    expect(await codeOf(7, { tolerances: [{ rubricId: "quality", rel: 0.125 }] })).toBe("tolerated")
    expect(await codeOf(7, { tolerances: [{ rubricId: "speed", abs: 5 }] })).toBe("regressed")
  })

  test("a lower-is-better rubric improves as its score falls", async () => {
    const base = await reportFor(8, false)
    const comparison = await compareAgentEvalBaseline(base, await reportFor(6, false))
    expect(comparison.comparisons[0]?.code).toBe("improved")
  })

  test("an assertion with nothing failing returns the comparison", async () => {
    const base = await reportFor(8)
    const comparison = await assertAgentEvalBaseline(base, await reportFor(8))
    expect(comparison.regressions).toEqual([])
    expect(comparison.comparisons[0]?.code).toBe("equal")
  })
})

describe("agent eval composition", () => {
  test("a trajectory component contributes its evidence and regression ids", async () => {
    const report = await runAgentEvalComposition({
      suite: suiteOf({}),
      trajectory: async () => ({ ok: false, digest: "trace", regressionIds: ["trajectory/loop"] }),
    })
    expect(report.components).toEqual([{ id: "trajectory", ok: false, digest: "trace" }])
    expect(report.regressionIds).toEqual(["trajectory/loop"])
    expect(report.ok).toBe(false)
  })
})

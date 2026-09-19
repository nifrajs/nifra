import { describe, expect, test } from "bun:test"
import {
  assertPredictionLab,
  PREDICTION_LAB_SEED,
  predictionLabCaseIds,
  runPredictionLab,
} from "../src/prediction-lab.ts"

describe("prediction lab - seeded hostile prediction/projection corpus", () => {
  test("all cases pass and carry stable IDs with replay seeds", async () => {
    const report = await runPredictionLab()
    expect(report.ok).toBe(true)
    expect(report.failures).toEqual([])
    expect(report.seed).toBe(PREDICTION_LAB_SEED)
    expect(report.results.map((result) => result.id)).toEqual([...predictionLabCaseIds])
    for (const result of report.results) {
      expect(result.replay).toEqual({ seed: report.seed, caseId: result.id })
    }
    expect(report.counts.passed).toBe(report.results.length)
    expect(report.counts.failed).toBe(0)
  })

  test("the corpus is deterministic and green for the same seed", async () => {
    const first = await runPredictionLab({ seed: 42 })
    const second = await runPredictionLab({ seed: 42 })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(first).toEqual(second)
  })

  test("only replays a stable subset by case ID and can replay its returned witness", async () => {
    const report = await runPredictionLab({ only: ["prediction-stale-version"] })
    expect(report.ok).toBe(true)
    expect(report.results.map((result) => result.id)).toEqual(["prediction-stale-version"])
    const caseId = report.results[0]?.replay.caseId
    if (caseId === undefined) throw new Error("expected replay case")
    const replay = await runPredictionLab({ seed: report.seed, only: caseId })
    expect(replay).toEqual(report)
  })

  test("rejects unknown case IDs and invalid seeds", async () => {
    await expect(runPredictionLab({ only: "does-not-exist" })).rejects.toThrow(/unknown case ID/)
    await expect(runPredictionLab({ only: [] })).rejects.toThrow(/at least one/)
    await expect(runPredictionLab({ seed: Number.NaN })).rejects.toThrow(/finite safe integer/)
    await expect(runPredictionLab({ seed: 1.5 })).rejects.toThrow(/finite safe integer/)
  })

  test("assertPredictionLab resolves the report when green", async () => {
    const report = await assertPredictionLab()
    expect(report.ok).toBe(true)
  })

  test("declares the complete hostile corpus and projection parity case", async () => {
    expect([...predictionLabCaseIds]).toEqual([
      "prediction-stale-version",
      "prediction-expired-at-predict",
      "prediction-expire-sweep",
      "prediction-prototype-path",
      "prediction-non-atomic-patch",
      "prediction-duplicate-id-invalid",
      "prediction-commit-conflict",
      "prediction-tool-failure-rolls-back",
      "prediction-reconcile-failure-rolls-back",
      "prediction-commit-accepts-server",
      "projection-webmcp-mcp-parity",
    ])
    const report = await runPredictionLab({ only: "projection-webmcp-mcp-parity" })
    expect(report.ok).toBe(true)
    expect(report.results[0]?.ok).toBe(true)
  })
})

import { describe, expect, test } from "bun:test"
import {
  type Matrix,
  type Measure,
  median,
  mergeRuns,
  pairedRatio,
  pooledRatio,
  type RoundCell,
  roundOrder,
  roundRatios,
} from "./rounds.ts"
import { httpRuntimeFromResults } from "./site-bench.ts"

const rows = (n: number): string[] => Array.from({ length: n }, (_, i) => `row${i}`)

/** Sum over `rounds` of (position of a - position of b): 0 means neither row is favoured by order. */
function orderBias(items: readonly string[], a: string, b: string, rounds: readonly number[]) {
  return rounds.reduce((sum, round) => {
    const order = roundOrder(items, round)
    return sum + order.indexOf(a) - order.indexOf(b)
  }, 0)
}

describe("round order", () => {
  test("every round samples every row exactly once", () => {
    for (const n of [1, 2, 3, 4, 6, 12]) {
      const items = rows(n)
      for (let round = 0; round < 3 * n; round++) {
        expect([...roundOrder(items, round)].sort()).toEqual([...items].sort())
      }
    }
    expect(roundOrder([], 3)).toEqual([])
  })

  test("odd rounds reverse the even round before them, and the rotation advances per pair", () => {
    const items = ["a", "b", "c", "d"]
    expect(roundOrder(items, 0)).toEqual(["a", "b", "c", "d"])
    expect(roundOrder(items, 1)).toEqual(["d", "c", "b", "a"])
    expect(roundOrder(items, 2)).toEqual(["b", "c", "d", "a"])
    expect(roundOrder(items, 3)).toEqual(["a", "d", "c", "b"])
    expect(roundOrder(items, 8)).toEqual(roundOrder(items, 0))
  })

  test("within every pair of rounds, no row runs before another more often", () => {
    for (const n of [2, 3, 4, 6, 8, 12]) {
      const items = rows(n)
      // A run's rounds start at an even offset, so its pairs stay aligned.
      for (const offset of [0, 2, 4, 10]) {
        const run = [0, 1, 2, 3].map((r) => r + offset)
        for (const a of items) {
          for (const b of items) expect(orderBias(items, a, b, run)).toBe(0)
        }
      }
    }
  })

  test("every row runs first and last over 2n rounds", () => {
    for (const n of [3, 4, 6]) {
      const items = rows(n)
      const rounds = Array.from({ length: 2 * n }, (_, round) => roundOrder(items, round))
      expect(new Set(rounds.map((order) => order[0]))).toEqual(new Set(items))
      expect(new Set(rounds.map((order) => order.at(-1)))).toEqual(new Set(items))
    }
  })
})

describe("per-round ratios", () => {
  test("median averages the middle pair of an even count", () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([])).toBe(0)
  })

  test("a round without a positive baseline pairs nothing", () => {
    expect(roundRatios([10, 20, 30], [5, 0])).toEqual([2])
    expect(pairedRatio([10], [0])).toBe(0)
  })

  test("the median of per-round ratios ignores the round a load spike sank", () => {
    const raw = [100, 50, 90]
    const nifra = [100, 50, 80]
    expect(pairedRatio(nifra, raw)).toBe(1)
    // The ratio of the two medians is what the sequential matrix published.
    expect(median(nifra) / median(raw)).toBeCloseTo(0.889, 3)
  })

  test("a paired ratio cancels drift that moves both rows of a round", () => {
    const raw = [1000, 500, 800, 250, 900]
    expect(
      pairedRatio(
        raw.map((rps) => rps * 0.97),
        raw,
      ),
    ).toBeCloseTo(0.97, 10)
  })
})

const m = (rps: number): Measure => ({ rps, p50ms: 1000 / rps, p99ms: 4000 / rps })
const cell = (...rps: number[]): RoundCell => ({ rounds: rps.map(m) })

describe("pooling whole-matrix runs", () => {
  test("rounds pair only inside the run that measured them", () => {
    // Run 1 lost the ceiling's second round; pairing by position across the concatenation would
    // set nifra's 100 against run 2's 50 and report 2x.
    const runs: Matrix<RoundCell>[] = [
      { bun: { nifra: { get: cell(100, 100) }, raw: { get: cell(100) } } },
      { bun: { nifra: { get: cell(50) }, raw: { get: cell(50) } } },
    ]
    expect(pooledRatio(runs, "bun", "nifra", "raw", "get")).toBe(1)
    expect(pooledRatio(runs, "bun", "nifra", "missing", "get")).toBeUndefined()
  })

  test("a merged cell holds every round, their medians, and the pooled ratio to its ceiling", () => {
    const runs: Matrix<RoundCell>[] = [
      {
        bun: {
          nifra: { get: cell(99, 198), body: cell(40) },
          raw: { get: cell(100, 200) },
          "raw-body": { body: cell(50) },
        },
      },
      { bun: { nifra: { get: cell(150) }, raw: { get: cell(150) } } },
    ]
    const merged = mergeRuns(runs, (_, workload) => (workload === "body" ? "raw-body" : "raw"))
    const get = merged.bun?.nifra?.get
    expect(get?.rounds.map((r) => r.rps)).toEqual([99, 198, 150])
    expect(get?.rps).toBe(150)
    expect(get?.p50ms).toBeCloseTo(1000 / 150, 10)
    expect(get?.ofCeiling).toBe(0.99)
    expect(merged.bun?.raw?.get?.ofCeiling).toBe(1)
    expect(merged.bun?.nifra?.body?.ofCeiling).toBe(0.8)
  })

  test("a row with no ceiling, or no rounds, carries no ratio", () => {
    const merged = mergeRuns([{ node: { nifra: { get: cell(10) }, x: { get: cell() } } }], () => {
      return undefined
    })
    expect(merged.node?.nifra?.get).not.toHaveProperty("ofCeiling")
    expect(merged.node?.x).toEqual({})
  })
})

describe("site slice", () => {
  test("the published % of raw is the paired ratio, not a ratio of medians", () => {
    const merged = mergeRuns(
      [{ bun: { nifra: { get: cell(100, 50, 80) }, "bun-native": { get: cell(100, 50, 90) } } }],
      () => "bun-native",
    )
    expect(httpRuntimeFromResults(merged, "get")).toEqual([
      { runtime: "Bun", reqs: 80, pctOfRaw: 100, you: true },
    ])
    // Results without per-round data keep the old ratio of the two cells.
    expect(
      httpRuntimeFromResults(
        { bun: { nifra: { get: m(80) }, "bun-native": { get: m(90) } } },
        "get",
      ),
    ).toEqual([{ runtime: "Bun", reqs: 80, pctOfRaw: 89, you: true }])
  })
})

import { describe, expect, test } from "bun:test"
import { binomialHalfCdf, medianInterval } from "./stats.ts"

/** mulberry32: a seeded generator, so the coverage simulation draws the same samples every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe("binomialHalfCdf", () => {
  test("matches the exact sums", () => {
    expect(binomialHalfCdf(12, 2)).toBeCloseTo(79 / 4096, 15)
    expect(binomialHalfCdf(6, 0)).toBeCloseTo(1 / 64, 15)
    expect(binomialHalfCdf(5, -1)).toBe(0)
    expect(binomialHalfCdf(5, 5)).toBe(1)
  })

  test("stays finite where 2^-n underflows a double", () => {
    expect(binomialHalfCdf(2000, 1000)).toBeCloseTo(0.5089, 3)
  })
})

describe("medianInterval", () => {
  const ascending = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1)

  test("n = 12 takes the 3rd and 10th order statistics", () => {
    const got = medianInterval([9, 2, 12, 5, 1, 7, 3, 11, 4, 10, 6, 8])
    expect(got).toEqual({ median: 6.5, lo: 3, hi: 10, coverage: 1 - (2 * 79) / 4096, n: 12 })
  })

  test("needs six values for 95%, where the interval is [min, max]", () => {
    expect(medianInterval(ascending(5))).toBeUndefined()
    expect(medianInterval(ascending(6))).toEqual({
      median: 3.5,
      lo: 1,
      hi: 6,
      coverage: 1 - 2 / 64,
      n: 6,
    })
  })

  test("is the narrowest interval that still reaches the confidence", () => {
    for (let n = 6; n <= 80; n++) {
      const got = medianInterval(ascending(n))
      if (got === undefined) throw new Error(`no interval for n=${n}`)
      expect(got.coverage).toBeGreaterThanOrEqual(0.95)
      // One order statistic further in drops below 95%.
      const k = got.lo
      expect(1 - 2 * binomialHalfCdf(n, k)).toBeLessThan(0.95)
    }
  })

  test("covers the true median of a skewed distribution at least 95% of the time", () => {
    const random = seeded(20261017)
    const trueMedian = Math.LN2 // the median of Exp(1)
    for (const n of [6, 12, 20]) {
      let covered = 0
      const trials = 4000
      for (let t = 0; t < trials; t++) {
        const draws = Array.from({ length: n }, () => -Math.log(1 - random()))
        const got = medianInterval(draws)
        if (got !== undefined && got.lo <= trueMedian && trueMedian <= got.hi) covered++
      }
      expect(covered / trials).toBeGreaterThanOrEqual(0.945)
    }
  })

  test("leaves its input unsorted", () => {
    const values = [3, 1, 2, 6, 5, 4]
    medianInterval(values)
    expect(values).toEqual([3, 1, 2, 6, 5, 4])
  })

  test("rejects a confidence outside (0, 1) and non-finite values", () => {
    expect(() => medianInterval(ascending(8), 1)).toThrow(RangeError)
    expect(() => medianInterval(ascending(8), 0)).toThrow(RangeError)
    expect(() => medianInterval([1, 2, 3, 4, 5, Number.NaN])).toThrow(RangeError)
  })
})

/**
 * Confidence intervals for the per-round ratios a CI benchmark run collects. Those come 12-20 at a
 * time and follow no known distribution, which rules out a t-interval, and a percentile bootstrap of
 * the median under-covers at that size. The order-statistic interval used here holds for any
 * continuous distribution, and its coverage is computed from the binomial rather than assumed.
 */
import { median } from "../rounds.ts"

export interface MedianInterval {
  readonly median: number
  readonly lo: number
  readonly hi: number
  /** Exact coverage of [lo, hi], at least the confidence that was asked for. */
  readonly coverage: number
  readonly n: number
}

/** P(X <= k) for X ~ Binomial(n, 1/2), summed in log space so 2^-n cannot underflow for large n. */
export function binomialHalfCdf(n: number, k: number): number {
  if (k < 0) return 0
  if (k >= n) return 1
  let logP = -n * Math.LN2
  let cdf = Math.exp(logP)
  for (let i = 0; i < k; i++) {
    logP += Math.log((n - i) / (i + 1))
    cdf += Math.exp(logP)
  }
  return cdf
}

/**
 * The median of `values` and the narrowest order-statistic interval [x(k), x(n+1-k)] whose coverage
 * is at least `confidence`. `undefined` when even [min, max] covers less, which at 95% means n < 6.
 */
export function medianInterval(
  values: readonly number[],
  confidence = 0.95,
): MedianInterval | undefined {
  if (!(confidence > 0 && confidence < 1)) {
    throw new RangeError(`confidence must lie strictly between 0 and 1, got ${confidence}`)
  }
  if (values.some((v) => !Number.isFinite(v))) {
    throw new RangeError("medianInterval needs finite values")
  }
  const n = values.length
  const tail = (1 - confidence) / 2
  let k = 0
  while (2 * (k + 1) <= n + 1 && binomialHalfCdf(n, k) <= tail) k++
  if (k === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const lo = sorted[k - 1]
  const hi = sorted[n - k]
  if (lo === undefined || hi === undefined) return undefined
  return { median: median(sorted), lo, hi, coverage: 1 - 2 * binomialHalfCdf(n, k - 1), n }
}

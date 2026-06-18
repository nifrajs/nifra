/**
 * Minimal, dependency-free microbenchmark harness.
 *
 * Honest enough for a baseline and a CI regression gate; it warms up the JIT,
 * times batches (so per-call `nanoseconds()` overhead doesn't dominate fast
 * ops), and reports the median across rounds plus a tail figure. It is NOT a
 * replacement for a statistics-grade tool — a later phase may swap in `mitata` for
 * publish-grade numbers. The point today is a working harness and a
 * reproducible number.
 */

export interface BenchResult {
  name: string
  opsPerSec: number
  medianNs: number
  p99Ns: number
  samples: number
}

export interface BenchOptions {
  /** Warmup rounds run (untimed) to let the JIT settle. */
  warmupRounds?: number
  /** Timed rounds; the per-op median across rounds is reported. */
  rounds?: number
  /** Iterations per round. Timing a batch avoids per-call timer overhead. */
  batch?: number
}

// A module-level sink consumed by every measured call. Without this the
// optimizer can prove the work has no effect and delete it, yielding fake
// "infinitely fast" results.
let sinkValue: unknown
function sink(value: unknown): void {
  sinkValue = value
}

/** Read the sink so callers/tests can assert the benchmarked work ran. */
export function readSink(): unknown {
  return sinkValue
}

function runBatch(fn: () => unknown, batch: number): void {
  for (let i = 0; i < batch; i++) sink(fn())
}

export function bench(name: string, fn: () => unknown, options: BenchOptions = {}): BenchResult {
  const warmupRounds = options.warmupRounds ?? 5
  const rounds = options.rounds ?? 30
  const batch = options.batch ?? 100_000

  for (let r = 0; r < warmupRounds; r++) runBatch(fn, batch)

  const perOpNs = new Float64Array(rounds)
  for (let r = 0; r < rounds; r++) {
    const start = Bun.nanoseconds()
    runBatch(fn, batch)
    perOpNs[r] = (Bun.nanoseconds() - start) / batch
  }
  perOpNs.sort() // TypedArray.prototype.sort is numeric by default.

  // rounds >= 1 by construction, so these indices are always present; the `?? 0`
  // satisfies noUncheckedIndexedAccess without masking a real bug.
  const medianNs = perOpNs[Math.floor(rounds * 0.5)] ?? 0
  const p99Ns = perOpNs[Math.min(rounds - 1, Math.floor(rounds * 0.99))] ?? 0

  return {
    name,
    opsPerSec: medianNs > 0 ? 1e9 / medianNs : 0,
    medianNs,
    p99Ns,
    samples: rounds * batch,
  }
}

/** Format a large ops/sec number compactly (e.g. 12_300_000 -> "12.3M"). */
export function formatOps(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return n.toFixed(0)
}

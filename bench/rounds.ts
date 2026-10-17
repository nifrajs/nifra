/**
 * Interleaved rounds, shared by the SSR and HTTP matrices. A round samples every row of a section
 * once, so a row and the baseline it is compared to are measured seconds apart rather than a whole
 * section apart. A ratio taken inside one round cancels the host-load drift that moved both samples;
 * a ratio of two medians measured minutes apart does not.
 */

/**
 * The order of round `round`. Rounds come in pairs that share one rotation, run forward and then
 * reversed, so within each pair any two rows swap places and a load trend across a round charges
 * both sides of a ratio equally. The rotation advances one row per pair, so every row also runs
 * first. Rotating every round instead leaves, for an even row count, the odd-position rows never
 * first and some pairs in one fixed order three rounds in four.
 */
export function roundOrder<T>(items: readonly T[], round: number): T[] {
  if (items.length === 0) return []
  const k = Math.floor(round / 2) % items.length
  const order = [...items.slice(k), ...items.slice(0, k)]
  return round % 2 === 1 ? order.reverse() : order
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  const upper = sorted[mid] ?? 0
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? 0) + upper) / 2
}

/** a[i] / b[i] for every round both rows measured; a round without a positive baseline pairs nothing. */
export function roundRatios(a: readonly number[], b: readonly number[]): number[] {
  return a.flatMap((value, i) => {
    const denominator = b[i]
    return denominator !== undefined && denominator > 0 ? [value / denominator] : []
  })
}

/** The median of the per-round ratios a/b: each round's pair ran minutes apart, not hours. */
export function pairedRatio(a: readonly number[], b: readonly number[]): number {
  return median(roundRatios(a, b))
}

export interface Measure {
  readonly rps: number
  readonly p50ms: number
  readonly p99ms: number
}

/** One sampled row x workload: one `Measure` per round, in round order. */
export interface RoundCell {
  readonly rounds: readonly Measure[]
}

/**
 * A matrix cell after pooling: the medians over every round, the rounds themselves, and the median
 * of the per-round ratios to the section's ceiling row.
 */
export interface MatrixCell extends Measure, RoundCell {
  readonly ofCeiling?: number
}

/** cells[runtime][row][workload] */
export type Matrix<Cell> = Record<string, Record<string, Record<string, Cell>>>

/** Append samples to `matrix[runtime][row][workload]`, creating the cell on first use. */
export function pushRounds(
  matrix: Matrix<{ rounds: Measure[] }>,
  runtime: string,
  row: string,
  workload: string,
  ...measures: readonly Measure[]
): void {
  const section = matrix[runtime] ?? {}
  matrix[runtime] = section
  const cells = section[row] ?? {}
  section[row] = cells
  const cell = cells[workload] ?? { rounds: [] }
  cells[workload] = cell
  cell.rounds.push(...measures)
}

const rpsOf = (cell: RoundCell | undefined): number[] => cell?.rounds.map((m) => m.rps) ?? []

/**
 * Every per-round ratio of row `a` to row `b` across whole-matrix runs. Rounds pair only inside the
 * run that measured them, so each run contributes its own ratios.
 */
export function pooledRatios(
  runs: readonly Matrix<RoundCell>[],
  runtime: string,
  a: string,
  b: string,
  workload: string,
): number[] {
  return runs.flatMap((run) =>
    roundRatios(rpsOf(run[runtime]?.[a]?.[workload]), rpsOf(run[runtime]?.[b]?.[workload])),
  )
}

/** The median of {@link pooledRatios}; `undefined` when no round paired. */
export function pooledRatio(
  runs: readonly Matrix<RoundCell>[],
  runtime: string,
  a: string,
  b: string,
  workload: string,
): number | undefined {
  const ratios = pooledRatios(runs, runtime, a, b, workload)
  return ratios.length > 0 ? median(ratios) : undefined
}

/**
 * Pool every run's rounds into one cell per runtime x row x workload. req/s and latencies are
 * medians over all rounds; `ofCeiling` is the pooled paired ratio to `ceilingOf(runtime, workload)`.
 */
export function mergeRuns(
  runs: readonly Matrix<RoundCell>[],
  ceilingOf: (runtime: string, workload: string) => string | undefined,
): Matrix<MatrixCell> {
  const pooled: Matrix<{ rounds: Measure[] }> = {}
  for (const run of runs) {
    for (const [runtime, rows] of Object.entries(run)) {
      for (const [row, workloads] of Object.entries(rows)) {
        for (const [workload, cell] of Object.entries(workloads)) {
          pushRounds(pooled, runtime, row, workload, ...cell.rounds)
        }
      }
    }
  }
  const merged: Matrix<MatrixCell> = {}
  for (const [runtime, rows] of Object.entries(pooled)) {
    const section: Record<string, Record<string, MatrixCell>> = {}
    merged[runtime] = section
    for (const [row, workloads] of Object.entries(rows)) {
      const cells: Record<string, MatrixCell> = {}
      section[row] = cells
      for (const [workload, { rounds }] of Object.entries(workloads)) {
        if (rounds.length === 0) continue
        const cell: Measure & RoundCell & { ofCeiling?: number } = {
          rps: median(rounds.map((m) => m.rps)),
          p50ms: median(rounds.map((m) => m.p50ms)),
          p99ms: median(rounds.map((m) => m.p99ms)),
          rounds,
        }
        const ceiling = ceilingOf(runtime, workload)
        const ofCeiling =
          ceiling === undefined ? undefined : pooledRatio(runs, runtime, row, ceiling, workload)
        if (ofCeiling !== undefined) cell.ofCeiling = ofCeiling
        cells[workload] = cell
      }
    }
  }
  return merged
}

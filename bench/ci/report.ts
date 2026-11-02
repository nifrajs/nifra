/**
 * The CI benchmark report: the raw `run.ts --json` lines of one suite x runtime job, plus the host
 * facts beside them, and the summary computed from them. The raw rounds are what the artifact keeps;
 * every percentage is recomputed from them, so a later regression gate can re-pool old reports.
 */
import { isRecord } from "../is-record.ts"
import { type Matrix, type Measure, median, pooledRatios, type RoundCell } from "../rounds.ts"
import type { CoreSplit } from "./host.ts"
import { type MedianInterval, medianInterval } from "./stats.ts"

export type Suite = "http" | "realworld" | "ssr"
export type Runtime = "bun" | "node" | "deno"
export const SUITES: readonly Suite[] = ["http", "realworld", "ssr"]
export const RUNTIMES: readonly Runtime[] = ["bun", "node", "deno"]

/** The runtimes each suite measures nifra on. SSR's rival apps and harness run on Bun and Node. */
export const SUITE_RUNTIMES: Readonly<Record<Suite, readonly Runtime[]>> = {
  http: RUNTIMES,
  realworld: RUNTIMES,
  ssr: ["bun", "node"],
}

/** The rival each runtime's http headline compares nifra against: the published comparisons. */
export const RIVALS: Readonly<Record<Runtime, string>> = {
  bun: "elysia",
  node: "fastify",
  deno: "elysia",
}

/** Who a workload compares, where the run names it rather than leaving it to {@link rivalRow}. */
export interface WorkloadRoles {
  readonly nifra: string
  /** Absent where the workload has no rival app, only a ceiling. */
  readonly rival?: string
}

/** One `run.ts --json` line. */
export interface RunOutput {
  readonly meta: Readonly<Record<string, string | number>>
  readonly results: Matrix<RoundCell>
  /** ceilings[runtime][workload] = the raw row that workload's ratios divide by. */
  readonly ceilings: Readonly<Record<string, Readonly<Record<string, string>>>>
  /** roles[runtime][workload]: SSR names them, since a table can lack a ceiling or hold two nifra rows. */
  readonly roles?: Readonly<Record<string, Readonly<Record<string, WorkloadRoles>>>>
}

export interface ReportSettings {
  readonly minRuns: number
  readonly maxRuns: number
  /** A row whose interval is wider than this percentage of its median is noisy. */
  readonly maxCiWidthPts: number
}

export interface HostFacts {
  readonly cpuModel: string | null
  readonly cpus: number
  readonly split: CoreSplit | null
  /** Hypervisor steal share during each run, `null` where /proc/stat was unreadable. */
  readonly steal: readonly (number | null)[]
}

export interface CiReport {
  readonly suite: Suite
  readonly runtime: Runtime
  readonly settings: ReportSettings
  readonly host: HostFacts
  readonly runs: readonly RunOutput[]
}

function record(v: unknown, where: string): Readonly<Record<string, unknown>> {
  if (!isRecord(v)) throw new Error(`${where}: expected an object`)
  return v
}

function finite(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${where}: expected a number`)
  return v
}

function text(v: unknown, where: string): string {
  if (typeof v !== "string") throw new Error(`${where}: expected a string`)
  return v
}

function oneOf<T extends string>(v: unknown, options: readonly T[], where: string): T {
  const found = options.find((o) => o === v)
  if (found === undefined) throw new Error(`${where}: expected one of ${options.join(", ")}`)
  return found
}

function parseMeasure(v: unknown, where: string): Measure {
  const m = record(v, where)
  return {
    rps: finite(m.rps, `${where}.rps`),
    p50ms: finite(m.p50ms, `${where}.p50ms`),
    p99ms: finite(m.p99ms, `${where}.p99ms`),
  }
}

function parseMatrix(v: unknown, where: string): Matrix<RoundCell> {
  const matrix: Matrix<RoundCell> = {}
  for (const [runtime, rows] of Object.entries(record(v, where))) {
    const section: Record<string, Record<string, RoundCell>> = {}
    matrix[runtime] = section
    for (const [row, workloads] of Object.entries(record(rows, `${where}.${runtime}`))) {
      const cells: Record<string, RoundCell> = {}
      section[row] = cells
      for (const [workload, cell] of Object.entries(record(workloads, `${where}.${row}`))) {
        const at = `${where}.${runtime}.${row}.${workload}`
        const rounds = record(cell, at).rounds
        if (!Array.isArray(rounds)) throw new Error(`${at}.rounds: expected an array`)
        cells[workload] = { rounds: rounds.map((m, i) => parseMeasure(m, `${at}.rounds[${i}]`)) }
      }
    }
  }
  return matrix
}

export function parseRunOutput(v: unknown, where = "run"): RunOutput {
  const run = record(v, where)
  const meta: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(record(run.meta, `${where}.meta`))) {
    meta[key] = typeof value === "number" ? value : text(value, `${where}.meta.${key}`)
  }
  const ceilings: Record<string, Record<string, string>> = {}
  for (const [runtime, byWorkload] of Object.entries(record(run.ceilings, `${where}.ceilings`))) {
    const table: Record<string, string> = {}
    for (const [workload, row] of Object.entries(record(byWorkload, `${where}.${runtime}`))) {
      table[workload] = text(row, `${where}.ceilings.${runtime}.${workload}`)
    }
    ceilings[runtime] = table
  }
  const parsed = { meta, results: parseMatrix(run.results, `${where}.results`), ceilings }
  if (run.roles === undefined) return parsed
  const roles: Record<string, Record<string, WorkloadRoles>> = {}
  for (const [runtime, byWorkload] of Object.entries(record(run.roles, `${where}.roles`))) {
    const table: Record<string, WorkloadRoles> = {}
    for (const [workload, value] of Object.entries(record(byWorkload, `${where}.${runtime}`))) {
      const at = `${where}.roles.${runtime}.${workload}`
      const named = record(value, at)
      const nifra = text(named.nifra, `${at}.nifra`)
      table[workload] =
        named.rival === undefined ? { nifra } : { nifra, rival: text(named.rival, `${at}.rival`) }
    }
    roles[runtime] = table
  }
  return { ...parsed, roles }
}

function parseSplit(v: unknown): CoreSplit | null {
  if (v === null) return null
  const split = record(v, "host.split")
  const cpus = (list: unknown, where: string): number[] => {
    if (!Array.isArray(list)) throw new Error(`${where}: expected an array`)
    return list.map((cpu, i) => finite(cpu, `${where}[${i}]`))
  }
  return {
    server: cpus(split.server, "host.split.server"),
    load: cpus(split.load, "host.split.load"),
    cores: finite(split.cores, "host.split.cores"),
  }
}

export function parseCiReport(v: unknown): CiReport {
  const report = record(v, "report")
  const settings = record(report.settings, "settings")
  const host = record(report.host, "host")
  if (!Array.isArray(host.steal)) throw new Error("host.steal: expected an array")
  if (!Array.isArray(report.runs)) throw new Error("runs: expected an array")
  const suite = oneOf(report.suite, SUITES, "suite")
  return {
    suite,
    runtime: oneOf(report.runtime, SUITE_RUNTIMES[suite], "runtime"),
    settings: {
      minRuns: finite(settings.minRuns, "settings.minRuns"),
      maxRuns: finite(settings.maxRuns, "settings.maxRuns"),
      maxCiWidthPts: finite(settings.maxCiWidthPts, "settings.maxCiWidthPts"),
    },
    host: {
      cpuModel: host.cpuModel === null ? null : text(host.cpuModel, "host.cpuModel"),
      cpus: finite(host.cpus, "host.cpus"),
      split: parseSplit(host.split),
      steal: host.steal.map((s, i) => (s === null ? null : finite(s, `host.steal[${i}]`))),
    },
    runs: report.runs.map((run, i) => parseRunOutput(run, `runs[${i}]`)),
  }
}

export type Verdict = "ok" | "noisy" | "too few rounds"

export interface RowSummary {
  readonly row: string
  /** Median req/s over every round of every run; load on a shared runner moves it between jobs. */
  readonly rps: number | undefined
  /** `undefined` throughout a workload without a ceiling row. */
  readonly ofCeiling: MedianInterval | undefined
  /** nifra's req/s over this row's, round by round; `undefined` on nifra's own row. */
  readonly nifraOver: MedianInterval | undefined
  readonly verdict: Verdict
}

export interface WorkloadSummary {
  readonly workload: string
  readonly ceiling: string | undefined
  readonly nifra: string | undefined
  /** The row the headline compares nifra with. */
  readonly rival: string | undefined
  readonly rows: readonly RowSummary[]
}

/** The interval's width as a percentage of its median, so a 10x ratio is held to the same relative precision as a 1x one. */
const widthPct = (i: MedianInterval): number =>
  i.median > 0 ? ((i.hi - i.lo) / i.median) * 100 : Number.POSITIVE_INFINITY

/** In first-seen order, so the summary follows run.ts's own section and workload order. */
function unique(values: Iterable<string>): string[] {
  return [...new Set(values)]
}

export function summarize(
  runs: readonly RunOutput[],
  runtime: Runtime,
  maxCiWidthPts: number,
): WorkloadSummary[] {
  const workloads = unique(
    runs.flatMap((run) => [
      ...Object.keys(run.roles?.[runtime] ?? {}),
      ...Object.keys(run.ceilings[runtime] ?? {}),
    ]),
  )
  const matrices = runs.map((run) => run.results)
  return workloads.flatMap((workload) => {
    const ceiling = runs
      .map((run) => run.ceilings[runtime]?.[workload])
      .find((c) => c !== undefined)
    const roles = runs.map((run) => run.roles?.[runtime]?.[workload]).find((r) => r !== undefined)
    if (ceiling === undefined && roles === undefined) return []
    const rowNames = unique(
      runs.flatMap((run) =>
        Object.entries(run.results[runtime] ?? {})
          .filter(([, cells]) => cells[workload] !== undefined)
          .map(([row]) => row),
      ),
    )
    const nifra = roles?.nifra ?? rowNames.find((row) => row.startsWith("nifra"))
    // http rows follow a naming rule; an SSR table names its own rival.
    const rival =
      roles === undefined && nifra !== undefined ? rivalRow(runtime, nifra) : roles?.rival
    const rows = rowNames.map((row): RowSummary => {
      const ofCeiling =
        ceiling === undefined
          ? undefined
          : medianInterval(pooledRatios(matrices, runtime, row, ceiling, workload))
      // nifra over the ceiling is nifra's own % of ceiling; repeating it would count its noise twice.
      const comparesNifra = nifra !== undefined && row !== nifra && row !== ceiling
      const nifraOver = comparesNifra
        ? medianInterval(pooledRatios(matrices, runtime, nifra, row, workload))
        : undefined
      const needed = [
        ...(ceiling === undefined ? [] : [ofCeiling]),
        ...(comparesNifra ? [nifraOver] : []),
      ]
      let verdict: Verdict = "ok"
      if (needed.some((i) => i === undefined)) verdict = "too few rounds"
      else if (needed.some((i) => i !== undefined && widthPct(i) > maxCiWidthPts)) verdict = "noisy"
      const rps = runs.flatMap(
        (run) => run.results[runtime]?.[row]?.[workload]?.rounds.map((m) => m.rps) ?? [],
      )
      return {
        row,
        rps: rps.length === 0 ? undefined : median(rps),
        ofCeiling,
        nifraOver,
        verdict,
      }
    })
    // Without a ceiling the rows keep the run's order: nifra's row, then its rivals.
    if (ceiling !== undefined) {
      rows.sort(
        (a, b) =>
          (b.ofCeiling?.median ?? -1) - (a.ofCeiling?.median ?? -1) ||
          (a.row < b.row ? -1 : a.row > b.row ? 1 : 0),
      )
    }
    return [{ workload, ceiling, nifra, rival, rows }]
  })
}

/** Rows that would not survive a comparison: too wide, or too few rounds for an interval. */
export function unsettledRows(workloads: readonly WorkloadSummary[]): number {
  return workloads.reduce((n, w) => n + w.rows.filter((r) => r.verdict !== "ok").length, 0)
}

/** The http rival row for nifra's row, keeping a suffix such as `-body`. */
export function rivalRow(runtime: Runtime, nifraRow: string): string {
  return `${RIVALS[runtime]}${nifraRow.slice("nifra".length)}`
}

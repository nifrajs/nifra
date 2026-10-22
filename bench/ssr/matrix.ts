/**
 * Which SSR tables a run measures, and the one `--json` line a CI job reads (bench/ci/report.ts). A
 * CI job measures one runtime: nifra's rows on it, every rival app, and each table's reference row,
 * all in the same interleaved rounds, so every ratio it reports pairs samples taken seconds apart.
 */
import type { Matrix, RoundCell } from "../rounds.ts"
import { rowKind, type SsrBenchMeasure, type SsrBenchTarget } from "./harness.ts"
import type { SsrTableSection } from "./targets.ts"

export type SsrRuntime = SsrBenchTarget["runtime"]
export const SSR_RUNTIMES: readonly SsrRuntime[] = ["bun", "node"]

function matches(section: SsrTableSection, filter: string): boolean {
  const [framework = "", table = ""] = section.label.toLowerCase().split(" - ")
  const [fw = "", which] = filter.toLowerCase().split(":")
  return fw === framework && (which === undefined || table.startsWith(`table ${which}`))
}

/**
 * `react` selects both React tables, `react:A` only Table A; no filter selects every table. A filter
 * that matches no table throws: a typo would otherwise measure nothing and pass.
 */
export function selectSections(
  sections: readonly SsrTableSection[],
  filters: readonly string[],
): SsrTableSection[] {
  const unmatched = filters.filter((filter) => !sections.some((s) => matches(s, filter)))
  if (unmatched.length > 0) {
    throw new Error(`no SSR table matches ${unmatched.map((f) => JSON.stringify(f)).join(", ")}`)
  }
  return sections.filter((s) => filters.length === 0 || filters.some((f) => matches(s, f)))
}

const isNifraApp = (t: SsrBenchTarget): boolean =>
  rowKind(t) === "app" && t.name.startsWith("nifra")

/** The table without nifra's app rows on other runtimes. Rival apps and reference rows stay. */
export function forRuntime(section: SsrTableSection, runtime: SsrRuntime): SsrTableSection {
  return {
    ...section,
    targets: section.targets.filter((t) => !isNifraApp(t) || t.runtime === runtime),
  }
}

/** One comparison a CI report summarizes: a nifra row, its rival and the table's ceiling. */
export interface CiWorkload {
  readonly workload: string
  readonly nifra: SsrBenchTarget
  /** The rival app the headline compares nifra with; the table's baseline where it pairs. */
  readonly rival: SsrBenchTarget | undefined
  /** The table's row that runs no framework: the raw renderer, or the static file server. */
  readonly ceiling: SsrBenchTarget | undefined
  readonly rows: readonly SsrBenchTarget[]
}

/**
 * The comparisons one table feeds: one per nifra row, against the rival apps that serve the same way
 * (a cache-warmed ISR row pairs with the rival's ISR row) and the table's ceiling. Throws rather than
 * leave a row out of every comparison or a nifra row with nothing to compare against.
 */
export function ciWorkloads(section: SsrTableSection): CiWorkload[] {
  const nifraRows = section.targets.filter(isNifraApp)
  const rivals = section.targets.filter((t) => rowKind(t) === "app" && !isNifraApp(t))
  const references = section.targets.filter((t) => rowKind(t) !== "app")
  if (nifraRows.length === 0) throw new Error(`${section.label}: no nifra row`)
  if (references.length > 1) {
    throw new Error(`${section.label}: ${references.length} ceiling rows, expected at most one`)
  }
  const ceiling = references[0]
  const cached = (t: SsrBenchTarget): boolean => t.warmupCache === true
  const workloads = nifraRows.map((nifra): CiWorkload => {
    const paired = rivals.filter((r) => cached(r) === cached(nifra))
    const workload = nifraRows.length === 1 ? section.label : `${section.label}: ${nifra.name}`
    if (paired.length === 0 && ceiling === undefined) {
      throw new Error(`${workload}: no rival or ceiling row to compare ${nifra.name} with`)
    }
    return {
      workload,
      nifra,
      rival: paired.find((r) => r.name === section.baseline) ?? paired[0],
      ceiling,
      rows: [nifra, ...paired, ...(ceiling === undefined ? [] : [ceiling])],
    }
  })
  const unpaired = rivals.filter((r) => !workloads.some((w) => w.rows.includes(r)))
  if (unpaired.length > 0) {
    throw new Error(
      `${section.label}: no nifra row pairs with ${unpaired.map((r) => r.name).join(", ")}`,
    )
  }
  return workloads
}

/** Who a CI workload compares; the shape bench/ci/report.ts parses. */
export interface CiRoles {
  readonly nifra: string
  readonly rival?: string
}

export interface CiRunOutput {
  readonly meta: Readonly<Record<string, string | number>>
  readonly results: Matrix<RoundCell>
  /** ceilings[runtime][workload]: only the tables that have a ceiling row. */
  readonly ceilings: Record<string, Record<string, string>>
  readonly roles: Record<string, Record<string, CiRoles>>
}

/** A measured table: the section as run, and every measured row's rounds by target name. */
export interface MeasuredTable {
  readonly section: SsrTableSection
  readonly rounds: Readonly<Record<string, readonly SsrBenchMeasure[]>>
}

/** The `--json` line: every round of every row, keyed results[runtime][row][workload]. */
export function ciRunOutput(
  runtime: SsrRuntime,
  tables: readonly MeasuredTable[],
  meta: Readonly<Record<string, string | number>>,
): CiRunOutput {
  const rows: Record<string, Record<string, RoundCell>> = {}
  const ceilings: Record<string, string> = {}
  const roles: Record<string, CiRoles> = {}
  for (const { section, rounds } of tables) {
    for (const w of ciWorkloads(section)) {
      for (const row of w.rows) {
        const measured = rounds[row.name]
        if (measured === undefined) throw new Error(`${w.workload}: ${row.name} has no rounds`)
        const cells = rows[row.name] ?? {}
        rows[row.name] = cells
        cells[w.workload] = { rounds: measured }
      }
      if (w.ceiling !== undefined) ceilings[w.workload] = w.ceiling.name
      roles[w.workload] =
        w.rival === undefined
          ? { nifra: w.nifra.name }
          : { nifra: w.nifra.name, rival: w.rival.name }
    }
  }
  return {
    meta,
    results: { [runtime]: rows },
    ceilings: { [runtime]: ceilings },
    roles: { [runtime]: roles },
  }
}

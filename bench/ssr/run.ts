/**
 * SSR benchmark runner - honest tables per UI runtime (bench/ssr/README.md).
 *
 * Each table builds its targets, then measures them in interleaved rounds: every round starts each
 * server fresh, in a rotated order, and takes one oha sample. A row's ratio is the median of its
 * per-round ratios to the table's baseline, so load drift on a busy host cancels out of the ratio
 * even when it moves the absolute req/s.
 *
 *   bun run bench:ssr                       # every table
 *   bun run bench/ssr/run.ts react vue:A    # React (both tables) + Vue Table A
 *   BENCH_ROUNDS=3 BENCH_SSR_JSON=out.json bun run bench/ssr/run.ts svelte
 */
import { capturedMeta, ohaVersion, writeSiteBench } from "../site-bench.ts"
import {
  nodeVersion,
  SSR_BENCH_CONNECTIONS,
  SSR_BENCH_DURATION_S,
  SSR_BENCH_ROUNDS,
  SSR_BENCH_WARMUP_S,
} from "./harness.ts"
import { assertEveryTargetMeasured, runSection } from "./section.ts"
import {
  frontendSlice,
  heroSsrSlice,
  multipliersSlice,
  type SsrRunRow,
  ssrTablesSlice,
  ssrTargetVersion,
} from "./site-slice.ts"
import { ALL_TABLE_SECTIONS, type SsrTableSection } from "./targets.ts"

/** `react` selects both React tables, `react:A` only Table A. No argument selects every table. */
function selected(section: SsrTableSection, filters: readonly string[]): boolean {
  if (filters.length === 0) return true
  const [framework = "", table = ""] = section.label.toLowerCase().split(" - ")
  return filters.some((filter) => {
    const [fw = "", which] = filter.toLowerCase().split(":")
    return fw === framework && (which === undefined || table.startsWith(`table ${which}`))
  })
}

const filters = process.argv.slice(2)
console.log(
  `SSR benchmarks - Bun ${Bun.version} · Node ${nodeVersion()} · ${SSR_BENCH_ROUNDS} interleaved rounds × (${SSR_BENCH_WARMUP_S}s warmup + ${SSR_BENCH_DURATION_S}s oha) @ ${SSR_BENCH_CONNECTIONS} conns`,
)

// Table A (uncached SSR) feeds the landing chart + multipliers + the per-request tables; Table B
// (SSG/ISR) feeds its own separately-labelled tables. The two are never blended.
const tableARows: SsrRunRow[] = []
const tableBRows: SsrRunRow[] = []
const rawSamples: Record<string, Record<string, number[]>> = {}
const failures: string[] = []
for (const section of ALL_TABLE_SECTIONS) {
  if (!selected(section, filters)) continue
  const result = await runSection(section)
  rawSamples[section.label] = result.samples
  failures.push(...result.failures)
  if (section.label.includes("Table A")) tableARows.push(...result.rows)
  if (section.label.includes("Table B")) tableBRows.push(...result.rows)
}
assertEveryTargetMeasured(failures)
const jsonOut = Bun.env.BENCH_SSR_JSON
if (jsonOut !== undefined) await Bun.write(jsonOut, `${JSON.stringify(rawSamples, null, 1)}\n`)
const resultsOut = Bun.env.BENCH_SSR_RESULTS_JSON
if (resultsOut !== undefined) {
  await Bun.write(
    resultsOut,
    `${JSON.stringify({ tableA: tableARows, tableB: tableBRows }, null, 2)}\n`,
    { createPath: true },
  )
}

// Refresh the website's numbers only from a run where every target of that table measured - a
// partial run (a framework build failing on this machine) must not overwrite good published numbers.
const expected = (table: string): number =>
  ALL_TABLE_SECTIONS.filter((s) => s.label.includes(table)).reduce(
    (n, s) => n + s.targets.length,
    0,
  )
const expectedA = expected("Table A")
const expectedB = expected("Table B")
if (tableARows.length === expectedA && tableBRows.length === expectedB) {
  // writeSiteBench logs the update itself.
  await writeSiteBench({
    heroSsr: heroSsrSlice(tableARows, ssrTargetVersion),
    frontend: frontendSlice(tableARows, ssrTargetVersion),
    multipliers: multipliersSlice(tableARows, ssrTargetVersion),
    ssrTables: ssrTablesSlice(tableARows, ssrTargetVersion),
    ssrTablesB: ssrTablesSlice(tableBRows, ssrTargetVersion),
    ssrCaptured: capturedMeta({ bun: Bun.version, node: nodeVersion(), oha: ohaVersion() }),
  })
} else {
  console.log(
    `\nsite/shared/data/benchmarks.json NOT updated: A ${tableARows.length}/${expectedA}, B ${tableBRows.length}/${expectedB} targets measured`,
  )
}

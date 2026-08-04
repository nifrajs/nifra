/**
 * SSR benchmark runner - honest tables per UI runtime (see SSR-BENCHMARKS.md).
 *
 *   bun run bench:ssr
 */
import { writeSiteBench } from "../site-bench.ts"
import {
  measureTarget,
  nodeVersion,
  printResultRow,
  SSR_BENCH_CONNECTIONS,
  SSR_BENCH_DURATION_S,
  SSR_BENCH_RUNS,
  type SsrBenchTarget,
} from "./harness.ts"
import {
  frontendSlice,
  heroSsrSlice,
  multipliersSlice,
  type SsrRunRow,
  ssrTablesSlice,
} from "./site-slice.ts"
import { ALL_TABLE_SECTIONS } from "./targets.ts"

async function runTable(
  label: string,
  blurb: string,
  targets: readonly SsrBenchTarget[],
): Promise<SsrRunRow[]> {
  console.log(`\n${label}\n${blurb}\n`)
  const framework = label.split(" - ")[0] ?? label
  const rows: SsrRunRow[] = []
  for (const target of targets) {
    try {
      const result = await measureTarget(target)
      printResultRow(target, result)
      rows.push({ framework, target, result })
    } catch (e) {
      console.error(
        `  ${target.name.padEnd(22)}  FAILED: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }
  return rows
}

console.log(
  `SSR benchmarks - Bun ${Bun.version} · Node ${nodeVersion()} · oha median-of-${SSR_BENCH_RUNS} × ${SSR_BENCH_DURATION_S}s @ ${SSR_BENCH_CONNECTIONS} conns`,
)

// Table A (uncached SSR) feeds the landing chart + multipliers + the per-request tables; Table B
// (SSG/ISR) feeds its own separately-labelled tables. The two are never blended (SSR-BENCHMARKS.md).
const tableARows: SsrRunRow[] = []
const tableBRows: SsrRunRow[] = []
for (const section of ALL_TABLE_SECTIONS) {
  const rows = await runTable(section.label, section.blurb, section.targets)
  if (section.label.includes("Table A")) tableARows.push(...rows)
  if (section.label.includes("Table B")) tableBRows.push(...rows)
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
    heroSsr: heroSsrSlice(tableARows),
    frontend: frontendSlice(tableARows),
    multipliers: multipliersSlice(tableARows),
    ssrTables: ssrTablesSlice(tableARows),
    ssrTablesB: ssrTablesSlice(tableBRows),
  })
} else {
  console.log(
    `\nsite/data/benchmarks.json NOT updated: A ${tableARows.length}/${expectedA}, B ${tableBRows.length}/${expectedB} targets measured`,
  )
}

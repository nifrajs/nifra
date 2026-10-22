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
 *   bun run bench/ssr/run.ts --runtime node --json   # one CI job's matrix (bench/ci/run.ts)
 *
 * `--runtime` keeps nifra's rows on one runtime; `--json` then prints the progress to stderr and
 * one result line to stdout, and leaves the website's numbers alone.
 */
import { capturedMeta, ohaVersion, writeSiteBench } from "../site-bench.ts"
import {
  nodeVersion,
  SSR_BENCH_CONNECTIONS,
  SSR_BENCH_DURATION_S,
  SSR_BENCH_ROUNDS,
  SSR_BENCH_WARMUP_S,
} from "./harness.ts"
import {
  ciRunOutput,
  ciWorkloads,
  forRuntime,
  type MeasuredTable,
  SSR_RUNTIMES,
  selectSections,
} from "./matrix.ts"
import { assertEveryTargetMeasured, hostSteps, runSection } from "./section.ts"
import {
  frontendSlice,
  heroSsrSlice,
  multipliersSlice,
  type SsrRunRow,
  ssrTablesSlice,
  ssrTargetVersion,
} from "./site-slice.ts"
import { ALL_TABLE_SECTIONS } from "./targets.ts"

const argv = process.argv.slice(2)
const jsonMode = argv.includes("--json")
const runtimeAt = argv.indexOf("--runtime")
const runtime = SSR_RUNTIMES.find((r) => runtimeAt >= 0 && r === argv[runtimeAt + 1])
if (runtimeAt >= 0 && runtime === undefined) {
  throw new Error(`--runtime takes one of ${SSR_RUNTIMES.join(", ")}`)
}
if (jsonMode && runtime === undefined) throw new Error("--json needs --runtime")
const filters = argv.filter((a, i) => !a.startsWith("--") && (runtimeAt < 0 || i !== runtimeAt + 1))
const sections = selectSections(ALL_TABLE_SECTIONS, filters).map((s) =>
  runtime === undefined ? s : forRuntime(s, runtime),
)
// Fail on a table the report could not summarize before spending its build and rounds.
if (jsonMode) for (const section of sections) ciWorkloads(section)
const log = jsonMode ? console.error : console.log

const node = nodeVersion()
log(
  `SSR benchmarks - Bun ${Bun.version} · Node ${node} · ${SSR_BENCH_ROUNDS} interleaved rounds × (${SSR_BENCH_WARMUP_S}s warmup + ${SSR_BENCH_DURATION_S}s oha) @ ${SSR_BENCH_CONNECTIONS} conns`,
)

// Table A (uncached SSR) feeds the landing chart + multipliers + the per-request tables; Table B
// (SSG/ISR) feeds its own separately-labelled tables. The two are never blended.
const tableARows: SsrRunRow[] = []
const tableBRows: SsrRunRow[] = []
const rawSamples: Record<string, Record<string, number[]>> = {}
const measured: MeasuredTable[] = []
const failures: string[] = []
for (const section of sections) {
  const result = await runSection(section, { ...hostSteps, log })
  measured.push({ section, rounds: result.rounds })
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
if (jsonMode && runtime !== undefined) {
  const meta = {
    bun: Bun.version,
    node,
    oha: ohaVersion(),
    rounds: SSR_BENCH_ROUNDS,
    connections: SSR_BENCH_CONNECTIONS,
    durationS: SSR_BENCH_DURATION_S,
    warmupS: SSR_BENCH_WARMUP_S,
  }
  console.log(JSON.stringify(ciRunOutput(runtime, measured, meta)))
} else if (tableARows.length === expectedA && tableBRows.length === expectedB) {
  // writeSiteBench logs the update itself.
  await writeSiteBench({
    heroSsr: heroSsrSlice(tableARows, ssrTargetVersion),
    frontend: frontendSlice(tableARows, ssrTargetVersion),
    multipliers: multipliersSlice(tableARows, ssrTargetVersion),
    ssrTables: ssrTablesSlice(tableARows, ssrTargetVersion),
    ssrTablesB: ssrTablesSlice(tableBRows, ssrTargetVersion),
    ssrCaptured: capturedMeta({ bun: Bun.version, node, oha: ohaVersion() }),
  })
} else {
  console.log(
    `\nsite/shared/data/benchmarks.json NOT updated: A ${tableARows.length}/${expectedA}, B ${tableBRows.length}/${expectedB} targets measured`,
  )
}

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
import { loadavg } from "node:os"
import { writeSiteBench } from "../site-bench.ts"
import {
  buildTarget,
  measureOnce,
  median,
  nodeVersion,
  pairedRatio,
  printResultRow,
  roundOrder,
  rowKind,
  SSR_BENCH_CONNECTIONS,
  SSR_BENCH_DURATION_S,
  SSR_BENCH_ROUNDS,
  SSR_BENCH_WARMUP_S,
  type SsrBenchMeasure,
  type SsrBenchTarget,
} from "./harness.ts"
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

interface SectionResult {
  readonly rows: SsrRunRow[]
  readonly samples: Record<string, number[]>
}

async function runSection(section: SsrTableSection): Promise<SectionResult> {
  console.log(`\n${section.label}\n${section.blurb}\n`)
  const framework = section.label.split(" - ")[0] ?? section.label
  const fail = (target: SsrBenchTarget, e: unknown): void =>
    console.error(
      `  ${target.name.padEnd(38)}  FAILED: ${e instanceof Error ? e.message : String(e)}`,
    )

  const live: SsrBenchTarget[] = []
  for (const target of section.targets) {
    try {
      await buildTarget(target)
      live.push(target)
    } catch (e) {
      fail(target, e)
    }
  }

  const samples = new Map<SsrBenchTarget, SsrBenchMeasure[]>()
  const payloads = new Map<SsrBenchTarget, { raw: number; gzip: number }>()
  const failed = new Set<SsrBenchTarget>()
  for (let round = 0; round < SSR_BENCH_ROUNDS; round++) {
    for (const target of roundOrder(live, round)) {
      if (failed.has(target)) continue
      try {
        const m = await measureOnce(target, !payloads.has(target))
        if (m.payload !== undefined) payloads.set(target, m.payload)
        samples.set(target, [...(samples.get(target) ?? []), m])
      } catch (e) {
        // A row missing a round cannot be paired with the others, so it drops out of the table.
        failed.add(target)
        fail(target, e)
      }
    }
    const line = live
      .filter((t) => !failed.has(t))
      .map((t) => `${t.name} ${samples.get(t)?.[round]?.rps.toLocaleString() ?? "-"}`)
    console.log(
      `  round ${round + 1}/${SSR_BENCH_ROUNDS}  load ${loadavg()[0]?.toFixed(1)}  ${line.join(" · ")}`,
    )
  }

  const measured = live.filter((t) => !failed.has(t))
  const rpsOf = (t: SsrBenchTarget): number[] => (samples.get(t) ?? []).map((m) => m.rps)
  const baseline = measured.find((t) => t.name === section.baseline)
  const rows: SsrRunRow[] = []
  console.log(`\n  ratio = median of per-round ratios to ${section.baseline}\n`)
  for (const kindOrder of ["app", "static-host", "own-server"] as const) {
    const group = measured.filter((t) => rowKind(t) === kindOrder)
    if (group.length > 0 && kindOrder === "own-server") {
      console.log(
        "\n  Not like for like - nifra's render API called from a server you write yourself:",
      )
    }
    for (const target of group) {
      const all = samples.get(target) ?? []
      const payload = payloads.get(target) ?? { raw: 0, gzip: 0 }
      const result = {
        rps: Math.round(median(all.map((m) => m.rps))),
        p50ms: median(all.map((m) => m.p50ms)),
        p99ms: median(all.map((m) => m.p99ms)),
        payloadRaw: payload.raw,
        payloadGzip: payload.gzip,
      }
      const ratio =
        baseline === undefined ? "" : `${pairedRatio(rpsOf(target), rpsOf(baseline)).toFixed(3)}x`
      printResultRow(target, result, ratio)
      rows.push({ framework, target, result })
    }
  }

  // How much of the own-server speed a real app keeps, per runtime - the cost of the framework.
  for (const app of measured.filter((t) => rowKind(t) === "app" && t.name.startsWith("nifra"))) {
    const own = measured.find((t) => rowKind(t) === "own-server" && t.runtime === app.runtime)
    if (own === undefined) continue
    console.log(
      `  ${app.name} / ${own.name}: ${pairedRatio(rpsOf(app), rpsOf(own)).toFixed(3)}x (paired)`,
    )
  }
  return {
    rows,
    samples: Object.fromEntries(measured.map((t) => [t.name, rpsOf(t)])),
  }
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
for (const section of ALL_TABLE_SECTIONS) {
  if (!selected(section, filters)) continue
  const { rows, samples } = await runSection(section)
  rawSamples[section.label] = samples
  if (section.label.includes("Table A")) tableARows.push(...rows)
  if (section.label.includes("Table B")) tableBRows.push(...rows)
}
const jsonOut = Bun.env.BENCH_SSR_JSON
if (jsonOut !== undefined) await Bun.write(jsonOut, `${JSON.stringify(rawSamples, null, 1)}\n`)

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
  })
} else {
  console.log(
    `\nsite/shared/data/benchmarks.json NOT updated: A ${tableARows.length}/${expectedA}, B ${tableBRows.length}/${expectedB} targets measured`,
  )
}

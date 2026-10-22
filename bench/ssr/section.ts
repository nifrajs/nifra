/** One SSR table's build + interleaved measurement, split from run.ts so its failure paths are testable. */
import { loadavg } from "node:os"
import {
  buildTarget,
  formatResultRow,
  measureOnce,
  median,
  pairedRatio,
  roundOrder,
  rowKind,
  SSR_BENCH_ROUND_OFFSET,
  SSR_BENCH_ROUNDS,
  type SsrBenchMeasure,
  type SsrBenchTarget,
} from "./harness.ts"
import type { SsrRunRow } from "./site-slice.ts"
import type { SsrTableSection } from "./targets.ts"

export interface SectionResult {
  readonly rows: SsrRunRow[]
  readonly samples: Record<string, number[]>
  /** Every measured row's samples by target name, one per round in round order. */
  readonly rounds: Record<string, SsrBenchMeasure[]>
  /** `<section> / <target>: <reason>` for every target that failed to build or to measure a round. */
  readonly failures: string[]
}

/** What a section run does to the host; a test swaps these for fakes. */
export interface SectionSteps {
  readonly build: (target: SsrBenchTarget) => Promise<void>
  readonly measure: typeof measureOnce
  readonly rounds: number
  readonly roundOffset?: number
  /** Progress and result lines; failures always go to stderr. */
  readonly log?: (line: string) => void
}

export const hostSteps: SectionSteps = {
  build: buildTarget,
  measure: measureOnce,
  rounds: SSR_BENCH_ROUNDS,
  roundOffset: SSR_BENCH_ROUND_OFFSET,
}

export async function runSection(
  section: SsrTableSection,
  steps: SectionSteps = hostSteps,
): Promise<SectionResult> {
  const log = steps.log ?? console.log
  log(`\n${section.label}\n${section.blurb}\n`)
  const framework = section.label.split(" - ")[0] ?? section.label
  const failures: string[] = []
  const fail = (target: SsrBenchTarget, e: unknown): void => {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`  ${target.name.padEnd(38)}  FAILED: ${msg}`)
    failures.push(`${section.label} / ${target.name}: ${msg}`)
  }

  const live: SsrBenchTarget[] = []
  for (const target of section.targets) {
    try {
      await steps.build(target)
      live.push(target)
    } catch (e) {
      fail(target, e)
    }
  }

  const samples = new Map<SsrBenchTarget, SsrBenchMeasure[]>()
  const payloads = new Map<SsrBenchTarget, { raw: number; gzip: number }>()
  const failed = new Set<SsrBenchTarget>()
  for (let round = 0; round < steps.rounds; round++) {
    for (const target of roundOrder(live, round + (steps.roundOffset ?? 0))) {
      if (failed.has(target)) continue
      try {
        const m = await steps.measure(target, !payloads.has(target))
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
    log(
      `  round ${round + 1}/${steps.rounds}  load ${loadavg()[0]?.toFixed(1)}  ${line.join(" · ")}`,
    )
  }

  const measured = live.filter((t) => !failed.has(t))
  const rpsOf = (t: SsrBenchTarget): number[] => (samples.get(t) ?? []).map((m) => m.rps)
  const baseline = measured.find((t) => t.name === section.baseline)
  const rows: SsrRunRow[] = []
  log(`\n  ratio = median of per-round ratios to ${section.baseline}\n`)
  for (const kindOrder of ["app", "renderer", "static-host"] as const) {
    for (const target of measured.filter((t) => rowKind(t) === kindOrder)) {
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
      log(formatResultRow(target, result, ratio))
      rows.push({ framework, target, result, samples: rpsOf(target) })
    }
  }

  return {
    rows,
    samples: Object.fromEntries(measured.map((t) => [t.name, rpsOf(t)])),
    rounds: Object.fromEntries(
      measured.map((t) => [
        t.name,
        (samples.get(t) ?? []).map(({ rps, p50ms, p99ms }) => ({ rps, p50ms, p99ms })),
      ]),
    ),
    failures,
  }
}

/** A run with a failed row must exit non-zero: a CI job would otherwise pass with that row missing. */
export function assertEveryTargetMeasured(failures: readonly string[]): void {
  if (failures.length > 0) {
    throw new Error(`benchmark results are invalid; ${failures.join("; ")}`)
  }
}

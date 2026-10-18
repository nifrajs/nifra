/** One SSR table's build + interleaved measurement, split from run.ts so its failure paths are testable. */
import { loadavg } from "node:os"
import {
  buildTarget,
  measureOnce,
  median,
  pairedRatio,
  printResultRow,
  roundOrder,
  rowKind,
  SSR_BENCH_ROUNDS,
  type SsrBenchMeasure,
  type SsrBenchTarget,
} from "./harness.ts"
import type { SsrRunRow } from "./site-slice.ts"
import type { SsrTableSection } from "./targets.ts"

export interface SectionResult {
  readonly rows: SsrRunRow[]
  readonly samples: Record<string, number[]>
  /** `<section> / <target>: <reason>` for every target that failed to build or to measure a round. */
  readonly failures: string[]
}

/** What a section run does to the host; a test swaps these for fakes. */
export interface SectionSteps {
  readonly build: (target: SsrBenchTarget) => Promise<void>
  readonly measure: typeof measureOnce
  readonly rounds: number
}

const hostSteps: SectionSteps = {
  build: buildTarget,
  measure: measureOnce,
  rounds: SSR_BENCH_ROUNDS,
}

export async function runSection(
  section: SsrTableSection,
  steps: SectionSteps = hostSteps,
): Promise<SectionResult> {
  console.log(`\n${section.label}\n${section.blurb}\n`)
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
    for (const target of roundOrder(live, round)) {
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
    console.log(
      `  round ${round + 1}/${steps.rounds}  load ${loadavg()[0]?.toFixed(1)}  ${line.join(" · ")}`,
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
      rows.push({ framework, target, result, samples: rpsOf(target) })
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
    failures,
  }
}

/** A run with a failed row must exit non-zero: a CI job would otherwise pass with that row missing. */
export function assertEveryTargetMeasured(failures: readonly string[]): void {
  if (failures.length > 0) {
    throw new Error(`benchmark results are invalid; ${failures.join("; ")}`)
  }
}

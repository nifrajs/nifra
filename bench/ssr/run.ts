/**
 * SSR benchmark runner — honest tables per UI runtime (see SSR-BENCHMARKS.md).
 *
 *   bun run bench:ssr
 */
import {
  measureTarget,
  nodeVersion,
  printResultRow,
  SSR_BENCH_CONNECTIONS,
  SSR_BENCH_DURATION_S,
  SSR_BENCH_RUNS,
  type SsrBenchTarget,
} from "./harness.ts"
import { ALL_TABLE_SECTIONS } from "./targets.ts"

async function runTable(
  label: string,
  blurb: string,
  targets: readonly SsrBenchTarget[],
): Promise<void> {
  console.log(`\n${label}\n${blurb}\n`)
  for (const target of targets) {
    try {
      const result = await measureTarget(target)
      printResultRow(target, result)
    } catch (e) {
      console.error(
        `  ${target.name.padEnd(22)}  FAILED: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }
}

console.log(
  `SSR benchmarks — Bun ${Bun.version} · Node ${nodeVersion()} · oha median-of-${SSR_BENCH_RUNS} × ${SSR_BENCH_DURATION_S}s @ ${SSR_BENCH_CONNECTIONS} conns`,
)

for (const section of ALL_TABLE_SECTIONS) {
  await runTable(section.label, section.blurb, section.targets)
}

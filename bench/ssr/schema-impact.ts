/** Paired SSR A/B for detailed loaderOutput projection and validation vs generic JSON validation. */
import { cpus } from "node:os"
import { join } from "node:path"
import { ohaVersion, writeSiteBench } from "../site-bench.ts"
import {
  median,
  nodeVersion,
  SSR_BENCH_CONNECTIONS,
  SSR_BENCH_DURATION_S,
  SSR_BENCH_ROUNDS,
  SSR_BENCH_WARMUP_S,
  type SsrBenchMeasure,
  type SsrBenchTarget,
} from "./harness.ts"
import { hostSteps, runSection } from "./section.ts"
import type { SsrTableSection } from "./targets.ts"

const HERE = import.meta.dir
const CLI = join(HERE, "../../packages/cli/src/cli.ts")
const validate = { rootId: "root", text: "Item 50", liCount: 50 } as const
const runtimes = ["node", "bun"] as const

function target(runtime: (typeof runtimes)[number], schema: "detailed" | "json"): SsrBenchTarget {
  const name = `nifra+react (${runtime}, ${schema} output schema)`
  const cwd = join(HERE, schema === "detailed" ? "nifra-app" : "nifra-app-json-output")
  const port = (runtime === "node" ? 4380 : 4390) + (schema === "json" ? 1 : 0)
  return {
    name,
    runtime,
    cwd,
    build: ["bun", CLI, "build", "--target", runtime, "--out", `dist-schema-${schema}-${runtime}`],
    serve: [runtime, `dist-schema-${schema}-${runtime}/server.js`],
    port,
    validate,
  }
}

function summarize(detailed: readonly SsrBenchMeasure[], genericJson: readonly SsrBenchMeasure[]) {
  if (detailed.length !== genericJson.length || detailed.length === 0) {
    throw new Error("schema A/B requires the same non-empty set of paired rounds")
  }
  if (genericJson.some((sample) => sample.rps <= 0)) {
    throw new Error("generic JSON schema samples must have positive throughput")
  }
  const pairedRatios = detailed.map((sample, index) => sample.rps / (genericJson[index]?.rps ?? 0))
  return {
    detailedSchemaRps: Math.round(median(detailed.map((sample) => sample.rps))),
    genericJsonSchemaRps: Math.round(median(genericJson.map((sample) => sample.rps))),
    /** Positive means detailed validation was faster; negative means it reduced throughput. */
    throughputDeltaPercent: Math.round((median(pairedRatios) - 1) * 1000) / 10,
    detailedSchemaSamples: detailed.map((sample) => sample.rps),
    genericJsonSchemaSamples: genericJson.map((sample) => sample.rps),
  }
}

const results = {} as Record<(typeof runtimes)[number], ReturnType<typeof summarize>>
for (const runtime of runtimes) {
  const detailed = target(runtime, "detailed")
  const genericJson = target(runtime, "json")
  const section: SsrTableSection = {
    label: `Loader output schema A/B - ${runtime}`,
    blurb:
      "Same Nifra React app and 50-item loader; detailed shape validation vs generic JSON validation.",
    baseline: genericJson.name,
    targets: [detailed, genericJson],
  }
  const result = await runSection(section, hostSteps)
  const detailedSamples = result.rounds[detailed.name]
  const genericJsonSamples = result.rounds[genericJson.name]
  if (
    detailedSamples === undefined ||
    genericJsonSamples === undefined ||
    result.failures.length > 0
  ) {
    throw new Error(`${section.label} did not produce every paired sample`)
  }
  results[runtime] = summarize(detailedSamples, genericJsonSamples)
}

const capture = {
  date: new Date().toISOString().slice(0, 10),
  source: "Local paired SSR A/B",
  machine: cpus()[0]?.model ?? "unknown",
  bun: Bun.version,
  node: nodeVersion(),
  oha: ohaVersion(),
  rounds: SSR_BENCH_ROUNDS,
  connections: SSR_BENCH_CONNECTIONS,
  durationS: SSR_BENCH_DURATION_S,
  warmupS: SSR_BENCH_WARMUP_S,
  results,
}

if (process.argv.includes("--write")) await writeSiteBench({ ssrSchemaImpact: capture })
console.log(JSON.stringify(capture, null, 2))

/** Measure the loader-output guard itself, then relate it to the same app's local SSR response time. */
import { cpus } from "node:os"
import { join } from "node:path"
import { isRecord } from "../is-record.ts"
import { ohaVersion, writeSiteBench } from "../site-bench.ts"
import {
  median,
  nodeVersion,
  SSR_BENCH_CONNECTIONS,
  SSR_BENCH_DURATION_S,
  SSR_BENCH_ROUNDS,
  SSR_BENCH_WARMUP_S,
  type SsrBenchTarget,
} from "./harness.ts"
import { hostSteps, runSection } from "./section.ts"
import type { SsrTableSection } from "./targets.ts"

const HERE = import.meta.dir
const CLI = join(HERE, "../../packages/cli/src/cli.ts")
const WORKER = join(HERE, "output-guard-cost-worker.mjs")
const runtimes = ["node", "bun"] as const

interface GuardWorkerCapture {
  readonly runtime: (typeof runtimes)[number]
  readonly runtimeVersion: string
  readonly rounds: number
  readonly iterationsPerRound: number
  readonly warmupIterations: number
  readonly guardSamplesUs: readonly number[]
  readonly identitySamplesUs: readonly number[]
  readonly pairedOverheadSamplesUs: readonly number[]
}

const isNumberArray = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item))

function parseWorkerCapture(
  value: unknown,
  runtime: (typeof runtimes)[number],
): GuardWorkerCapture {
  if (
    !isRecord(value) ||
    value.runtime !== runtime ||
    typeof value.runtimeVersion !== "string" ||
    typeof value.rounds !== "number" ||
    typeof value.iterationsPerRound !== "number" ||
    typeof value.warmupIterations !== "number" ||
    !isNumberArray(value.guardSamplesUs) ||
    !isNumberArray(value.identitySamplesUs) ||
    !isNumberArray(value.pairedOverheadSamplesUs) ||
    value.guardSamplesUs.length !== value.rounds ||
    value.identitySamplesUs.length !== value.rounds ||
    value.pairedOverheadSamplesUs.length !== value.rounds
  ) {
    throw new Error(`${runtime} output-guard worker returned an invalid capture`)
  }
  return {
    runtime,
    runtimeVersion: value.runtimeVersion,
    rounds: value.rounds,
    iterationsPerRound: value.iterationsPerRound,
    warmupIterations: value.warmupIterations,
    guardSamplesUs: value.guardSamplesUs,
    identitySamplesUs: value.identitySamplesUs,
    pairedOverheadSamplesUs: value.pairedOverheadSamplesUs,
  }
}

function measureGuard(runtime: (typeof runtimes)[number]): GuardWorkerCapture {
  const command = runtime === "node" ? ["node", WORKER] : ["bun", WORKER]
  const process = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" })
  if (!process.success) {
    throw new Error(
      `${runtime} output-guard worker failed: ${new TextDecoder().decode(process.stderr)}`,
    )
  }
  const output = new TextDecoder().decode(process.stdout).trim()
  if (output === "") throw new Error(`${runtime} output-guard worker returned no capture`)
  const parsed: unknown = JSON.parse(output)
  return parseWorkerCapture(parsed, runtime)
}

function ssrTarget(runtime: (typeof runtimes)[number]): SsrBenchTarget {
  return {
    name: `Nifra + React (${runtime}, detailed loaderOutput)`,
    runtime,
    cwd: join(HERE, "nifra-app"),
    build: ["bun", CLI, "build", "--target", runtime, "--out", `dist-output-cost-${runtime}`],
    serve: [runtime, `dist-output-cost-${runtime}/server.js`],
    port: runtime === "node" ? 4380 : 4390,
    validate: { rootId: "root", text: "Item 50", liCount: 50 },
  }
}

async function measureSsrP50(runtime: (typeof runtimes)[number]) {
  const target = ssrTarget(runtime)
  const section: SsrTableSection = {
    label: `Output guard request context - ${runtime}`,
    blurb:
      "The same Nifra React route and detailed loaderOutput schema as the direct guard timing.",
    baseline: target.name,
    targets: [target],
  }
  const capture = await runSection(section, hostSteps)
  const samples = capture.rounds[target.name]
  if (samples === undefined || capture.failures.length > 0 || samples.length !== SSR_BENCH_ROUNDS) {
    throw new Error(`${section.label} did not produce every request sample`)
  }
  return {
    rps: Math.round(median(samples.map((sample) => sample.rps))),
    p50ms: median(samples.map((sample) => sample.p50ms)),
  }
}

interface RuntimeResult {
  readonly runtimeVersion: string
  readonly guardRounds: number
  readonly iterationsPerRound: number
  readonly rps: number
  readonly p50ms: number
  readonly guardUsPerRequest: number
  readonly identityUsPerRequest: number
  readonly addedUsPerRequest: number
  readonly guardShareOfP50Percent: number
  readonly guardSamplesUs: readonly number[]
  readonly identitySamplesUs: readonly number[]
}

const results: Partial<Record<(typeof runtimes)[number], RuntimeResult>> = {}

for (const runtime of runtimes) {
  const guard = measureGuard(runtime)
  const request = await measureSsrP50(runtime)
  const guardUsPerRequest = median(guard.guardSamplesUs)
  const identityUsPerRequest = median(guard.identitySamplesUs)
  const addedUsPerRequest = median(guard.pairedOverheadSamplesUs)
  results[runtime] = {
    runtimeVersion: guard.runtimeVersion,
    guardRounds: guard.rounds,
    iterationsPerRound: guard.iterationsPerRound,
    rps: request.rps,
    p50ms: request.p50ms,
    guardUsPerRequest,
    identityUsPerRequest,
    addedUsPerRequest,
    guardShareOfP50Percent: (addedUsPerRequest / (request.p50ms * 1000)) * 100,
    guardSamplesUs: guard.guardSamplesUs,
    identitySamplesUs: guard.identitySamplesUs,
  }
}

const node = results.node
const bun = results.bun
if (node === undefined || bun === undefined) throw new Error("both runtime captures are required")

const capture = {
  date: new Date().toISOString().slice(0, 10),
  source: "Local direct output-guard timing + SSR request context",
  machine: cpus()[0]?.model ?? "unknown",
  bun: Bun.version,
  node: nodeVersion(),
  oha: ohaVersion(),
  items: 50,
  connections: SSR_BENCH_CONNECTIONS,
  durationS: SSR_BENCH_DURATION_S,
  warmupS: SSR_BENCH_WARMUP_S,
  guardRounds: assertMatchingRounds(node, bun),
  iterationsPerRound: node.iterationsPerRound,
  results: { node, bun },
}

if (process.argv.includes("--write")) await writeSiteBench({ ssrOutputGuardCost: capture })
console.log(JSON.stringify(capture, null, 2))

function assertMatchingRounds(nodeCapture: RuntimeResult, bunCapture: RuntimeResult): number {
  if (nodeCapture.guardRounds !== bunCapture.guardRounds) {
    throw new Error("Node and Bun output-guard rounds differ")
  }
  if (nodeCapture.iterationsPerRound !== bunCapture.iterationsPerRound) {
    throw new Error("Node and Bun output-guard iterations differ")
  }
  return nodeCapture.guardRounds
}

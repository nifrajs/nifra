/**
 * Fresh-process aggregator for the worst-case matrix. Each child already takes a median of its
 * count-bounded paired rounds; this adds a median across independent processes so JIT state and
 * machine drift cannot become a framework-specific result.
 *
 *   bun run bench/http/worst-case/aggregate.ts deno --runs 7
 *   BENCH_SCALE=10 bun run bench/http/worst-case/aggregate.ts --runs 3
 */
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const RUN = join(dirname(fileURLToPath(import.meta.url)), "run.ts")

interface Measure {
  readonly rps: number
  readonly p50ms: number
  readonly p99ms: number
}

type Results = Record<string, Record<string, Record<string, Measure>>>

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[sorted.length >> 1] ?? 0
}

function parseArgs(argv: readonly string[]): { runtime?: string; runs: number } {
  const runsIndex = argv.indexOf("--runs")
  const rawRuns = runsIndex >= 0 ? argv[runsIndex + 1] : undefined
  const runs = rawRuns !== undefined && /^\d+$/.test(rawRuns) ? Number(rawRuns) : 3
  if (!Number.isSafeInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer")
  const runtime = argv.find((arg, index) => {
    if (arg.startsWith("--")) return false
    return index === 0 || argv[index - 1] !== "--runs"
  })
  if (runtime !== undefined && !["bun", "node", "deno"].includes(runtime)) {
    throw new Error(`unknown runtime "${runtime}". known: bun, node, deno`)
  }
  return runtime === undefined ? { runs } : { runtime, runs }
}

async function runOnce(
  runtime: string | undefined,
): Promise<{ meta: Record<string, unknown>; results: Results }> {
  const args = ["run", RUN]
  if (runtime !== undefined) args.push(runtime)
  args.push("--json")
  const proc = Bun.spawn(["bun", ...args], {
    stdout: "pipe",
    stderr: "inherit",
    env: { ...Bun.env },
  })
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (code !== 0) throw new Error(`worst-case run exited ${code}`)
  const line = stdout.trim().split("\n").filter(Boolean).at(-1)
  if (line === undefined) throw new Error("worst-case run emitted no JSON result")
  try {
    return JSON.parse(line) as { meta: Record<string, unknown>; results: Results }
  } catch (error) {
    throw new Error(`worst-case run emitted invalid JSON: ${String(error)}`)
  }
}

function aggregate(samples: readonly Results[]): Results {
  const output: Results = {}
  for (const runtime of ["bun", "node", "deno"]) {
    const workloads = new Set<string>()
    const frameworks = new Set<string>()
    for (const sample of samples) {
      for (const framework of Object.keys(sample[runtime] ?? {})) {
        frameworks.add(framework)
        for (const workload of Object.keys(sample[runtime]?.[framework] ?? []))
          workloads.add(workload)
      }
    }
    if (frameworks.size === 0 || workloads.size === 0) continue
    output[runtime] = {}
    for (const framework of frameworks) {
      output[runtime][framework] = {}
      for (const workload of workloads) {
        const measures = samples
          .map((sample) => sample[runtime]?.[framework]?.[workload])
          .filter((measure): measure is Measure => measure !== undefined && measure.rps > 0)
        if (measures.length === 0) continue
        output[runtime][framework][workload] = {
          rps: Math.round(median(measures.map((measure) => measure.rps))),
          p50ms: median(measures.map((measure) => measure.p50ms)),
          p99ms: median(measures.map((measure) => measure.p99ms)),
        }
      }
    }
  }
  return output
}

const { runtime, runs } = parseArgs(process.argv.slice(2))
const samples: Results[] = []
let meta: Record<string, unknown> = {}
for (let i = 0; i < runs; i++) {
  const result = await runOnce(runtime)
  meta = result.meta
  samples.push(result.results)
}

const results = aggregate(samples)
console.log(
  `\nWORST-CASE aggregate - fresh-process median-of-${runs} matrices ` +
    `(child runs are paired and order-alternated)\n` +
    `Bun driver ${String(meta.bun ?? "unknown")}; same-run ratios are the signal.\n`,
)

for (const section of ["bun", "node", "deno"]) {
  const got = results[section]
  if (got === undefined) continue
  console.log(`## ${section}\n`)
  const workloads = Object.keys(got.nifra ?? got.elysia ?? {})
  for (const workload of workloads) {
    console.log(`  ${workload}`)
    for (const framework of ["nifra", "elysia"]) {
      const measure = got[framework]?.[workload]
      if (measure === undefined) continue
      console.log(
        `    ${framework.padEnd(7)} ${measure.rps.toLocaleString().padStart(9)} req/s   ` +
          `p50 ${measure.p50ms.toFixed(2).padStart(6)}ms   p99 ${measure.p99ms.toFixed(2).padStart(7)}ms`,
      )
    }
    const nifra = got.nifra?.[workload]?.rps ?? 0
    const elysia = got.elysia?.[workload]?.rps ?? 0
    if (nifra > 0 && elysia > 0)
      console.log(`    → nifra is ${Math.round((nifra / elysia) * 100)}% of Elysia`)
    console.log("")
  }
}

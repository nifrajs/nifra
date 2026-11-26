/**
 * One CI benchmark job: a suite's matrix, run again in a fresh process until every row's interval is
 * narrow enough or the run budget is spent. Past `--min-runs`, a rerun measures only the workloads
 * that still hold a noisy row. The stopping rule looks only at interval widths, never at which row is
 * ahead, so sampling longer cannot favour a result. Writes one report artifact and summary section
 * per runtime. Noisy rows do not fail the job; a harness error does.
 *
 *   bun run bench/ci/run.ts --suite http --runtime node --pin --out bench-ci/http-node.json
 *   bun run bench/ci/run.ts --suite ssr --runtime node,bun --pin --out 'bench-ci/ssr-{runtime}.json'
 */
import { appendFileSync, mkdirSync } from "node:fs"
import { availableParallelism } from "node:os"
import { dirname, join } from "node:path"
import { pinned } from "../pinning.ts"
import { type CoreSplit, readCoreSplit, readCpuModel, readCpuTimes, stealShare } from "./host.ts"
import { renderFootnote, renderSection } from "./render.ts"
import {
  type CiReport,
  parseCiReport,
  parseRunOutput,
  type RunOutput,
  type Runtime,
  SUITE_RUNTIMES,
  SUITES,
  type Suite,
  summarize,
  unsettledWorkloads,
} from "./report.ts"

const ROOT = join(import.meta.dir, "..", "..")

/** The command each suite's matrix runs for one runtime, printing one JSON result line last. */
const SUITE_RUN: Readonly<Record<Suite, (runtimes: string) => readonly [string, ...string[]]>> = {
  http: (runtime) => ["bench/http/run.ts", runtime, "--json", "--full"],
  realworld: (runtime) => ["bench/http-realworld/run.ts", runtime, "--json"],
  ssr: (runtimes) => ["bench/ssr/run.ts", "--runtime", runtimes, "--json"],
}

interface Options {
  readonly suite: Suite
  /** More than one only for ssr, whose runner measures them in the same rounds. */
  readonly runtimes: readonly Runtime[]
  readonly minRuns: number
  readonly maxRuns: number
  readonly maxCiWidthPts: number
  readonly pin: boolean
  readonly out: string
}

function parseOptions(argv: readonly string[]): Options {
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const int = (flag: string, fallback: number): number => {
    const raw = value(flag)
    if (raw === undefined) return fallback
    if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${flag} takes a positive integer`)
    return Number(raw)
  }
  const suite = SUITES.find((s) => s === value("--suite"))
  if (suite === undefined) throw new Error(`--suite takes one of ${SUITES.join(", ")}`)
  const asked = (value("--runtime") ?? "").split(",")
  const runtimes = asked.flatMap((name) => SUITE_RUNTIMES[suite].filter((r) => r === name))
  if (runtimes.length !== asked.length || (suite !== "ssr" && runtimes.length !== 1)) {
    throw new Error(`--runtime for ${suite} takes ${SUITE_RUNTIMES[suite].join(", ")}`)
  }
  const minRuns = int("--min-runs", 3)
  const maxRuns = int("--max-runs", 5)
  if (maxRuns < minRuns) throw new Error("--max-runs must be at least --min-runs")
  const width = value("--max-ci-width") ?? "10"
  if (!/^\d+(?:\.\d+)?$/.test(width) || Number(width) <= 0) {
    throw new Error("--max-ci-width takes a positive percentage of the median")
  }
  const out = value("--out") ?? `bench-ci/${suite}-{runtime}.json`
  if (runtimes.length > 1 && !out.includes("{runtime}")) {
    throw new Error("--out needs {runtime} when --runtime names several")
  }
  return {
    suite,
    runtimes,
    minRuns,
    maxRuns,
    maxCiWidthPts: Number(width),
    pin: argv.includes("--pin"),
    out,
  }
}

async function runOnce(
  options: Options,
  index: number,
  split: CoreSplit | null,
  due: readonly string[] | undefined,
): Promise<{ runs: RunOutput[]; steal: number | null }> {
  const argv = SUITE_RUN[options.suite](options.runtimes.join(","))
  // An even offset keeps each run's rounds in forward/reversed pairs (bench/rounds.ts).
  const env: Record<string, string | undefined> = {
    ...Bun.env,
    BENCH_ROUND_OFFSET: String(2 * index),
    BENCH_SKIP_BUILD: index === 0 ? undefined : "1",
    BENCH_ONLY_WORKLOADS: due === undefined ? undefined : JSON.stringify(due),
  }
  const loadCpus = split?.load.join(",")
  if (split !== null) {
    env.BENCH_SERVER_CPUS = split.server.join(",")
    env.BENCH_LOAD_CPUS = loadCpus
  }
  const before = readCpuTimes()
  const proc = Bun.spawn(pinned(["bun", "run", ...argv], loadCpus), {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "inherit",
    env,
  })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  const after = readCpuTimes()
  const script = argv[0]
  if (code !== 0) throw new Error(`${script} ${options.runtimes.join(",")} exited ${code}`)
  // One JSON result line per runtime, last, in the order asked.
  const lines = out.trim().split("\n").slice(-options.runtimes.length)
  const runs = lines.map((line) => {
    let json: unknown
    try {
      json = JSON.parse(line)
    } catch {
      throw new Error(`${script} printed no JSON result line: ${line.slice(0, 160)}`)
    }
    return parseRunOutput(json)
  })
  const steal = before === undefined || after === undefined ? undefined : stealShare(before, after)
  return { runs, steal: steal ?? null }
}

const options = parseOptions(process.argv.slice(2))
let split: CoreSplit | null = null
if (options.pin) {
  split = readCoreSplit() ?? null
  if (split === null) throw new Error("--pin needs Linux: /proc/self/status lists no allowed CPUs")
}

const measured: { readonly runtime: Runtime; readonly runs: RunOutput[] }[] = options.runtimes.map(
  (runtime) => ({ runtime, runs: [] }),
)
const steal: (number | null)[] = []
let due: string[] | undefined
for (let index = 0; index < options.maxRuns; index++) {
  const label = `${options.suite}/${options.runtimes.join(",")}`
  const scope = due === undefined ? "every workload" : `${due.length} noisy workload(s)`
  process.stderr.write(`${label}: run ${index + 1} of at most ${options.maxRuns}, ${scope}\n`)
  const result = await runOnce(options, index, split, due)
  for (const [at, { runs }] of measured.entries()) {
    const run = result.runs[at]
    if (run === undefined) throw new Error(`run ${index + 1} printed no result for every runtime`)
    runs.push(run)
  }
  steal.push(result.steal)
  if (index + 1 < options.minRuns) continue
  const noisy = measured.flatMap(({ runtime, runs }) =>
    unsettledWorkloads(summarize(runs, runtime, options.maxCiWidthPts)),
  )
  if (noisy.length === 0) break
  due = [...new Set(noisy)]
}

for (const { runtime, runs } of measured) {
  const report: CiReport = {
    suite: options.suite,
    runtime,
    settings: {
      minRuns: options.minRuns,
      maxRuns: options.maxRuns,
      maxCiWidthPts: options.maxCiWidthPts,
    },
    host: { cpuModel: readCpuModel() ?? null, cpus: availableParallelism(), split, steal },
    runs,
  }
  const serialized = JSON.stringify(report)
  // The summary job reads this file back; fail here, beside the numbers, if the two ever disagree.
  parseCiReport(JSON.parse(serialized))
  const out = options.out.replace("{runtime}", runtime)
  mkdirSync(dirname(out), { recursive: true })
  await Bun.write(out, `${serialized}\n`)

  const markdown = `${renderSection(report)}\n${renderFootnote(options.maxCiWidthPts)}\n`
  console.log(markdown)
  const summaryFile = Bun.env.GITHUB_STEP_SUMMARY
  if (summaryFile !== undefined && summaryFile !== "") appendFileSync(summaryFile, markdown)
}

/**
 * One CI benchmark job: a suite's matrix for one runtime, run again in a fresh process until every
 * row's interval is narrow enough or the run budget is spent. The stopping rule looks only at
 * interval widths, never at which row is ahead, so sampling longer cannot favour a result. Writes the
 * report artifact and this job's summary section. Noisy rows do not fail the job; a harness error does.
 *
 *   bun run bench/ci/run.ts --suite http --runtime node --pin --out bench-ci/http-node.json
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
  unsettledRows,
} from "./report.ts"

const ROOT = join(import.meta.dir, "..", "..")

/** The command each suite's matrix runs for one runtime, printing one JSON result line last. */
const SUITE_RUN: Readonly<Record<Suite, (runtime: Runtime) => readonly [string, ...string[]]>> = {
  http: (runtime) => ["bench/http/run.ts", runtime, "--json", "--full"],
  realworld: (runtime) => ["bench/http-realworld/run.ts", runtime, "--json"],
  ssr: (runtime) => ["bench/ssr/run.ts", "--runtime", runtime, "--json"],
}

/** Env a suite needs unless the caller set it. SSR defaults to 5 rounds; the offset needs pairs. */
const SUITE_ENV: Readonly<Record<Suite, Readonly<Record<string, string>>>> = {
  http: {},
  realworld: {},
  ssr: { BENCH_ROUNDS: "4" },
}

interface Options {
  readonly suite: Suite
  readonly runtime: Runtime
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
  const runtime = SUITE_RUNTIMES[suite].find((r) => r === value("--runtime"))
  if (runtime === undefined) {
    throw new Error(`--runtime for ${suite} takes one of ${SUITE_RUNTIMES[suite].join(", ")}`)
  }
  const minRuns = int("--min-runs", 3)
  const maxRuns = int("--max-runs", 5)
  if (maxRuns < minRuns) throw new Error("--max-runs must be at least --min-runs")
  const width = value("--max-ci-width") ?? "10"
  if (!/^\d+(?:\.\d+)?$/.test(width) || Number(width) <= 0) {
    throw new Error("--max-ci-width takes a positive number of percentage points")
  }
  return {
    suite,
    runtime,
    minRuns,
    maxRuns,
    maxCiWidthPts: Number(width),
    pin: argv.includes("--pin"),
    out: value("--out") ?? `bench-ci/${suite}-${runtime}.json`,
  }
}

async function runOnce(
  options: Options,
  index: number,
  split: CoreSplit | null,
): Promise<{ run: RunOutput; steal: number | null }> {
  const argv = SUITE_RUN[options.suite](options.runtime)
  // An even offset keeps each run's rounds in forward/reversed pairs (bench/rounds.ts).
  const env: Record<string, string | undefined> = {
    ...SUITE_ENV[options.suite],
    ...Bun.env,
    BENCH_ROUND_OFFSET: String(2 * index),
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
  if (code !== 0) throw new Error(`${script} ${options.runtime} exited ${code}`)
  const line = out.trim().split("\n").at(-1) ?? ""
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch {
    throw new Error(`${script} printed no JSON result line: ${line.slice(0, 160)}`)
  }
  const steal = before === undefined || after === undefined ? undefined : stealShare(before, after)
  return { run: parseRunOutput(json), steal: steal ?? null }
}

const options = parseOptions(process.argv.slice(2))
let split: CoreSplit | null = null
if (options.pin) {
  split = readCoreSplit() ?? null
  if (split === null) throw new Error("--pin needs Linux: /proc/self/status lists no allowed CPUs")
}

const runs: RunOutput[] = []
const steal: (number | null)[] = []
while (runs.length < options.maxRuns) {
  process.stderr.write(
    `${options.suite}/${options.runtime}: run ${runs.length + 1} of at most ${options.maxRuns}\n`,
  )
  const result = await runOnce(options, runs.length, split)
  runs.push(result.run)
  steal.push(result.steal)
  if (runs.length < options.minRuns) continue
  if (unsettledRows(summarize(runs, options.runtime, options.maxCiWidthPts)) === 0) break
}

const report: CiReport = {
  suite: options.suite,
  runtime: options.runtime,
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
mkdirSync(dirname(options.out), { recursive: true })
await Bun.write(options.out, `${serialized}\n`)

const markdown = `${renderSection(report)}\n${renderFootnote(options.maxCiWidthPts)}\n`
console.log(markdown)
const summaryFile = Bun.env.GITHUB_STEP_SUMMARY
if (summaryFile !== undefined && summaryFile !== "") appendFileSync(summaryFile, markdown)

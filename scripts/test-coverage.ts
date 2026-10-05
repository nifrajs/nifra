import { spawn } from "node:child_process"
import { readFile, unlink } from "node:fs/promises"
import { resolve } from "node:path"

export interface LcovRecord {
  readonly file: string
  readonly functionsFound: number
  readonly functionsHit: number
  readonly linesFound: number
  readonly linesHit: number
}

export interface TestRunSummary {
  readonly completed: boolean
  readonly hasFailure: boolean
  readonly hasNonZeroCount: boolean
}

export interface FloorMiss {
  readonly file: string
  readonly metric: "functions" | "lines"
  readonly percent: number
}

function counter(value: string): number | undefined {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

/** Parse one record per `SF:` block from LCOV, without trusting malformed generated output. */
export function parseLcovRecords(source: string): readonly LcovRecord[] | undefined {
  const records: {
    file: string
    functionsFound: number
    functionsHit: number
    linesFound: number
    linesHit: number
  }[] = []
  let sawFunctionRecord = false
  let sawLineRecord = false

  for (const raw of source.split("\n")) {
    const line = raw.trim()
    if (line.startsWith("SF:")) {
      if (line.slice(3).length === 0) return undefined
      records.push({
        // Bun writes `src\small.ts` on Windows; baselines name every file with `/`.
        file: line.slice(3).replaceAll("\\", "/"),
        functionsFound: 0,
        functionsHit: 0,
        linesFound: 0,
        linesHit: 0,
      })
      continue
    }
    const record = records.at(-1)
    if (line.startsWith("FNF:") || line.startsWith("FNH:")) {
      const value = counter(line.slice(4))
      if (value === undefined || record === undefined) return undefined
      if (line.startsWith("FNF:")) record.functionsFound += value
      else record.functionsHit += value
      sawFunctionRecord = true
      continue
    }
    if (line.startsWith("DA:")) {
      const hitCount = counter(line.slice(3).split(",")[1] ?? "")
      if (hitCount === undefined || record === undefined) return undefined
      record.linesFound += 1
      if (hitCount > 0) record.linesHit += 1
      sawLineRecord = true
    }
  }

  if (records.length === 0 || !sawFunctionRecord || !sawLineRecord) return undefined
  if (records.some((record) => record.functionsHit > record.functionsFound)) return undefined
  if (records.some((record) => record.linesHit > record.linesFound)) return undefined
  return records
}

/**
 * Bun holds every file to `coverageThreshold` on its own, so one file short of the floor fails the run
 * whatever the total. A miss the committed baseline already records below the floor is `held`: the
 * ratchet (`check:coverage`) keeps that file from dropping further. Every other miss is `failing`.
 */
export function floorMisses(
  records: readonly LcovRecord[],
  threshold: number,
  baseline: Readonly<Record<string, Partial<Record<FloorMiss["metric"], unknown>>>>,
): { readonly failing: readonly FloorMiss[]; readonly held: readonly FloorMiss[] } {
  const failing: FloorMiss[] = []
  const held: FloorMiss[] = []
  for (const record of records) {
    for (const [metric, hit, found] of [
      ["functions", record.functionsHit, record.functionsFound],
      ["lines", record.linesHit, record.linesFound],
    ] as const) {
      const fraction = found === 0 ? 1 : hit / found
      if (fraction >= threshold) continue
      const recorded = Object.hasOwn(baseline, record.file)
        ? baseline[record.file]?.[metric]
        : undefined
      const miss = { file: record.file, metric, percent: fraction * 100 }
      if (typeof recorded === "number" && recorded / 100 < threshold) held.push(miss)
      else failing.push(miss)
    }
  }
  return { failing, held }
}

export function parseCoverageThreshold(source: string): number | undefined {
  const match = /^\s*coverageThreshold\s*=\s*([^\s#]+)\s*$/m.exec(source)
  if (match === null) return undefined
  const threshold = Number(match[1])
  return Number.isFinite(threshold) && threshold >= 0 && threshold <= 1 ? threshold : undefined
}

export function summarizeTestRun(output: string): TestRunSummary {
  const normalized = output.replace(/\r\n?/g, "\n")
  const completed = /\bRan \d+ tests? across \d+ files?\./.test(normalized)
  const hasFailure = /\(fail\)/.test(normalized)
  const hasNonZeroCount = [/^\s*[1-9]\d*\s+fail\b/m, /^\s*[1-9]\d*\s+errors?\b/m].some((pattern) =>
    pattern.test(normalized),
  )
  return { completed, hasFailure, hasNonZeroCount }
}

export function coverageReportPath(args: readonly string[], cwd: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith("--coverage-dir="))
  if (inline !== undefined) {
    const directory = inline.slice("--coverage-dir=".length)
    return directory.length === 0 ? undefined : resolve(cwd, directory, "lcov.info")
  }
  const index = args.indexOf("--coverage-dir")
  if (index !== -1) {
    const directory = args[index + 1]
    return directory === undefined || directory.startsWith("-")
      ? undefined
      : resolve(cwd, directory, "lcov.info")
  }
  return resolve(cwd, "coverage", "lcov.info")
}

function exitStatus(status: number | null): number {
  return status === null || status === 0 ? 1 : status
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined
    }
    throw error
  }
}

async function runChild(
  args: readonly string[],
): Promise<{ readonly status: number | null; readonly output: string }> {
  let output = ""
  const child = spawn(process.execPath, ["test", ...args], {
    stdio: ["inherit", "pipe", "pipe"],
  })
  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk)
    output += chunk.toString()
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk)
    output += chunk.toString()
  })
  const status = await new Promise<number | null>((resolveStatus) => {
    child.once("close", resolveStatus)
    child.once("error", () => resolveStatus(1))
  })
  return { status, output }
}

export async function runCoverage(argv: readonly string[] = process.argv): Promise<number> {
  const args = argv.slice(2)
  if (args.length === 0) {
    console.error("[coverage-test] usage: bun run scripts/test-coverage.ts <bun test arguments>")
    return 2
  }

  const cwd = process.cwd()
  const reportPath = coverageReportPath(args, cwd)
  if (reportPath === undefined) {
    console.error("[coverage-test] --coverage-dir is missing a directory")
    return 2
  }

  try {
    await unlink(reportPath)
  } catch (error) {
    if (
      !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
    ) {
      console.error(`[coverage-test] cannot clear ${reportPath}`)
      return 2
    }
  }

  const result = await runChild(args)
  const summary = summarizeTestRun(result.output)
  if (!summary.completed || summary.hasFailure || summary.hasNonZeroCount) {
    console.error(
      "[coverage-test] test run did not complete cleanly; refusing to classify its exit",
    )
    return exitStatus(result.status)
  }

  const [lcov, config, baselineText] = await Promise.all([
    readText(reportPath),
    readText(resolve(cwd, "bunfig.toml")),
    readText(resolve(cwd, process.env.COVERAGE_BASELINE ?? "coverage-baseline.json")),
  ])
  const records = lcov === undefined ? undefined : parseLcovRecords(lcov)
  const threshold = config === undefined ? undefined : parseCoverageThreshold(config)
  if (records === undefined || threshold === undefined) {
    console.error("[coverage-test] missing or malformed LCOV/config; refusing to classify the exit")
    return 2
  }

  const { failing, held } = floorMisses(records, threshold, baselineOf(baselineText))
  if (failing.length > 0) {
    console.error(`[coverage-test] below the ${threshold * 100}% per-file floor:`)
    for (const miss of failing)
      console.error(`  ${miss.file} ${miss.metric}: ${miss.percent.toFixed(2)}%`)
    return 1
  }
  if (held.length > 0)
    console.error(
      `[coverage-test] ${held.length} file metric(s) sit below the floor where the committed ` +
        "baseline already records them; `check:coverage` keeps them from dropping further.",
    )

  if (result.status !== 0 && held.length === 0) {
    console.error(
      `[coverage-test] Bun exited ${result.status} after a complete zero-failure run with every file ` +
        "at the floor, so treating it as the known shutdown-status quirk.",
    )
  }
  return 0
}

/** The committed ratchet baseline. A missing or unreadable one holds nothing, so every miss fails. */
function baselineOf(text: string | undefined): Record<string, Record<string, unknown>> {
  if (text === undefined) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? Object.fromEntries(
          Object.entries(parsed).flatMap(([file, value]) =>
            typeof value === "object" && value !== null ? [[file, { ...value }]] : [],
          ),
        )
      : {}
  } catch {
    return {}
  }
}

if (import.meta.main) process.exit(await runCoverage())

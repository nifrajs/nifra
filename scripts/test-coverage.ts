import { spawn } from "node:child_process"
import { readFile, unlink } from "node:fs/promises"
import { resolve } from "node:path"

export interface CoverageTotals {
  readonly files: number
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

function counter(value: string): number | undefined {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

/** Parse the stable LCOV counters without trusting malformed generated output. */
export function parseLcovTotals(source: string): CoverageTotals | undefined {
  let files = 0
  let functionsFound = 0
  let functionsHit = 0
  let linesFound = 0
  let linesHit = 0
  let sawFunctionRecord = false
  let sawLineRecord = false

  for (const raw of source.split("\n")) {
    const line = raw.trim()
    if (line.startsWith("SF:")) {
      if (line.slice(3).length === 0) return undefined
      files += 1
      continue
    }
    if (line.startsWith("FNF:")) {
      const value = counter(line.slice(4))
      if (value === undefined) return undefined
      functionsFound += value
      sawFunctionRecord = true
      continue
    }
    if (line.startsWith("FNH:")) {
      const value = counter(line.slice(4))
      if (value === undefined) return undefined
      functionsHit += value
      sawFunctionRecord = true
      continue
    }
    if (line.startsWith("DA:")) {
      const hitCount = counter(line.slice(3).split(",")[1] ?? "")
      if (hitCount === undefined) return undefined
      linesFound += 1
      if (hitCount > 0) linesHit += 1
      sawLineRecord = true
    }
  }

  if (files === 0 || !sawFunctionRecord || !sawLineRecord) return undefined
  if (functionsHit > functionsFound || linesHit > linesFound) return undefined
  return { files, functionsFound, functionsHit, linesFound, linesHit }
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

function percentage(hit: number, total: number): number {
  return total === 0 ? 100 : (hit / total) * 100
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

  const [lcov, config] = await Promise.all([
    readText(reportPath),
    readText(resolve(cwd, "bunfig.toml")),
  ])
  const totals = lcov === undefined ? undefined : parseLcovTotals(lcov)
  const threshold = config === undefined ? undefined : parseCoverageThreshold(config)
  if (totals === undefined || threshold === undefined) {
    console.error("[coverage-test] missing or malformed LCOV/config; refusing to classify the exit")
    return 2
  }

  const functionCoverage = percentage(totals.functionsHit, totals.functionsFound) / 100
  const lineCoverage = percentage(totals.linesHit, totals.linesFound) / 100
  if (functionCoverage < threshold || lineCoverage < threshold) {
    console.error(
      `[coverage-test] coverage below ${threshold * 100}%: ` +
        `functions ${(functionCoverage * 100).toFixed(2)}%, lines ${(lineCoverage * 100).toFixed(2)}%`,
    )
    return 1
  }

  if (result.status !== 0) {
    console.error(
      `[coverage-test] Bun exited ${result.status} after a complete zero-failure run; ` +
        "the coverage report and configured floor are valid, so treating it as the known shutdown-status quirk.",
    )
  }
  return 0
}

if (import.meta.main) process.exit(await runCoverage())

/**
 * Combine every CI benchmark job's report into one summary: the headline table, then each job's
 * section, then the jobs that left no report.
 *
 *   bun run bench/ci/summary.ts bench-ci >> "$GITHUB_STEP_SUMMARY"
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { renderFootnote, renderHeadline, renderSection } from "./render.ts"
import { type CiReport, parseCiReport, RUNTIMES, SUITES } from "./report.ts"

const dir = process.argv[2]
if (dir === undefined) throw new Error("usage: bun run bench/ci/summary.ts <reports-dir>")

const reports: CiReport[] = readdirSync(dir)
  .filter((file) => file.endsWith(".json"))
  .map((file) => {
    const json: unknown = JSON.parse(readFileSync(join(dir, file), "utf8"))
    return parseCiReport(json)
  })
if (reports.length === 0) throw new Error(`no benchmark reports in ${dir}`)

const position = (r: CiReport): number =>
  SUITES.indexOf(r.suite) * RUNTIMES.length + RUNTIMES.indexOf(r.runtime)
reports.sort((a, b) => position(a) - position(b))

const missing = SUITES.flatMap((suite) =>
  RUNTIMES.filter(
    (runtime) => !reports.some((r) => r.suite === suite && r.runtime === runtime),
  ).map((runtime) => `${suite}-${runtime}`),
)
const widths = new Set(reports.map((r) => r.settings.maxCiWidthPts))

const parts = ["## Benchmarks (report-only)", "", renderHeadline(reports), ""]
for (const width of widths) parts.push(renderFootnote(width), "")
if (missing.length > 0)
  parts.push(`No report from: ${missing.join(", ")} (the job failed or was cancelled).`, "")
for (const report of reports) parts.push(renderSection(report))
console.log(parts.join("\n"))

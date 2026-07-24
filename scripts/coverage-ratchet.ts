/**
 * Coverage ratchet: a file may not get less covered than it already is.
 *
 * ## Why, when there is already a floor
 *
 * `bunfig.toml` enforces ≥90% per file. That is a MINIMUM, and it says nothing about the distance a
 * file has already travelled past it. A module at 99% can shed coverage for a year and the gate stays
 * green until the moment it crosses 90 - at which point the drop is attributed to whoever happened to
 * be editing it, not to the changes that spent the margin. Fourteen files currently sit between 90 and
 * 93%, which is what that erosion looks like from the outside.
 *
 * So the floor answers "is this file tested at all" and this answers "is it less tested than it was".
 * Both are needed; neither replaces the other.
 *
 * ## What it does NOT cover
 *
 * `coveragePathIgnorePatterns` removes a file from the lcov report entirely, so anything excluded from
 * the floor is invisible here too. That is a real limit, stated rather than papered over: those files
 * are guarded by the measurement written next to each exclusion in `bunfig.toml`, not by this.
 *
 * ## Usage
 *
 *   bun run check:coverage            # verify nothing regressed
 *   bun run check:coverage --update   # accept the current numbers as the new baseline
 *
 * The baseline is committed. Updating it is a deliberate, reviewable act - a diff showing coverage
 * going DOWN is a decision someone made, which is the entire point.
 */

const LCOV = process.env.COVERAGE_LCOV ?? "coverage/lcov.info"
const BASELINE = "coverage-baseline.json"

/**
 * Slack before a drop is called a regression.
 *
 * Not a tolerance for sloppiness - coverage genuinely moves a little between runs when a file's total
 * line count changes (adding three covered lines to a 100-line file moves the percentage without
 * testing anything less). A whole point is far below the smallest real regression and far above that
 * jitter.
 */
const TOLERANCE = 1.0

interface FileCoverage {
  readonly functions: number
  readonly lines: number
}

/** Parse the subset of lcov we need: per-file function and line hit ratios, as percentages. */
export function parseLcov(source: string): Record<string, FileCoverage> {
  const out: Record<string, FileCoverage> = {}
  let file: string | undefined
  let fnFound = 0
  let fnHit = 0
  let lineFound = 0
  let lineHit = 0

  const flush = (): void => {
    if (file === undefined) return
    // A file with no functions is 100% covered for functions - vacuously, but treating it as 0 would
    // ratchet a constants module to a number it can never regain.
    out[file] = {
      functions: fnFound === 0 ? 100 : (fnHit / fnFound) * 100,
      lines: lineFound === 0 ? 100 : (lineHit / lineFound) * 100,
    }
    file = undefined
    fnFound = fnHit = lineFound = lineHit = 0
  }

  for (const raw of source.split("\n")) {
    const line = raw.trim()
    if (line.startsWith("SF:")) {
      flush()
      file = line.slice(3)
    } else if (line.startsWith("FNF:")) fnFound = Number(line.slice(4))
    else if (line.startsWith("FNH:")) fnHit = Number(line.slice(4))
    else if (line.startsWith("DA:")) {
      const count = Number(line.slice(3).split(",")[1] ?? "0")
      lineFound += 1
      if (count > 0) lineHit += 1
    } else if (line === "end_of_record") flush()
  }
  flush()
  return out
}

interface Regression {
  readonly file: string
  readonly metric: "functions" | "lines"
  readonly was: number
  readonly now: number
}

/** Every file that lost more than {@link TOLERANCE} against the baseline. Pure, so it is unit-testable. */
export function findRegressions(
  baseline: Record<string, FileCoverage>,
  current: Record<string, FileCoverage>,
  tolerance = TOLERANCE,
): Regression[] {
  const out: Regression[] = []
  for (const [file, was] of Object.entries(baseline)) {
    const now = current[file]
    // A file that vanished from the report was deleted or renamed - not a coverage regression, and
    // failing on it would make every rename a two-step dance.
    if (now === undefined) continue
    for (const metric of ["functions", "lines"] as const) {
      if (now[metric] < was[metric] - tolerance) {
        out.push({ file, metric, was: was[metric], now: now[metric] })
      }
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.metric.localeCompare(b.metric))
}

const pct = (n: number): string => `${n.toFixed(2)}%`

async function main(): Promise<void> {
  const update = process.argv.includes("--update")
  const lcov = Bun.file(LCOV)
  if (!(await lcov.exists())) {
    console.error(
      `[coverage-ratchet] no lcov report at ${LCOV}. Produce one first:\n` +
        "  bun run test:coverage",
    )
    process.exit(2)
  }
  const current = parseLcov(await lcov.text())
  const fileCount = Object.keys(current).length
  if (fileCount === 0) {
    console.error(`[coverage-ratchet] ${LCOV} listed no files - refusing to treat that as a pass.`)
    process.exit(2)
  }

  if (update) {
    await Bun.write(BASELINE, `${JSON.stringify(sortKeys(current), null, 2)}\n`)
    console.log(`[coverage-ratchet] baseline updated: ${fileCount} files → ${BASELINE}`)
    return
  }

  const baselineFile = Bun.file(BASELINE)
  if (!(await baselineFile.exists())) {
    console.error(
      `[coverage-ratchet] no ${BASELINE}. Create it once with:\n  bun run check:coverage --update`,
    )
    process.exit(2)
  }
  const baseline = JSON.parse(await baselineFile.text()) as Record<string, FileCoverage>
  const regressions = findRegressions(baseline, current)
  const added = Object.keys(current).filter((f) => baseline[f] === undefined)

  if (regressions.length > 0) {
    console.error(`[coverage-ratchet] coverage regressed in ${regressions.length} place(s):\n`)
    for (const r of regressions) {
      console.error(`  ${r.file}\n    ${r.metric}: ${pct(r.was)} → ${pct(r.now)}`)
    }
    console.error(
      "\nAdd the tests, or accept the drop deliberately with `bun run check:coverage --update`\n" +
        "(the baseline is committed, so the reduction shows up in review).",
    )
    process.exit(1)
  }
  console.log(
    `[coverage-ratchet] ok — ${fileCount} files, none below baseline` +
      (added.length > 0 ? ` (${added.length} new, not yet in the baseline)` : ""),
  )
}

function sortKeys(record: Record<string, FileCoverage>): Record<string, FileCoverage> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))
}

if (import.meta.main) await main()

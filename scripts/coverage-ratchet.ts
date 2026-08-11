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
 *   bun run check:coverage                       # verify nothing regressed
 *   bun run check:coverage --update              # raise the baseline to the current numbers
 *   bun run check:coverage --update --accept-drop  # …and lower the entries that regressed
 *
 * The baseline is committed. Updating it is a deliberate, reviewable act - a diff showing coverage
 * going DOWN is a decision someone made, which is the entire point.
 *
 * ## Why `--update` alone refuses to lower a number
 *
 * A ratchet whose escape hatch is one flag away from the failure message is not a ratchet: the fastest
 * way past a red gate becomes rerunning it with `--update`, and the reduction lands in the same commit
 * as the change that caused it, described as a baseline refresh. So `--update` is raise-only. It fails
 * on exactly the drops the check would have failed on, and lowering one takes a second, differently
 * named flag - `--accept-drop` - which prints every number it lowered so the act is named out loud.
 */

import { readFile, writeFile } from "node:fs/promises"

const DEFAULT_LCOV = "coverage/lcov.info"
const DEFAULT_BASELINE = "coverage-baseline.json"

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

function sortKeys(record: Record<string, FileCoverage>): Record<string, FileCoverage> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))
}

/** What a run decided: the process exit code, and the lines to print. */
export interface RatchetOutcome {
  /** 0 ok, 1 coverage regressed, 2 the gate could not run at all. */
  readonly code: 0 | 1 | 2
  readonly report: readonly string[]
}

/** Where a run reads from and writes to. Explicit so a test can point a whole run at a temp directory
 * instead of the repo - a gate nothing can exercise is not a gate, and this one had grown a hardcoded
 * baseline path while the lcov path was already overridable. */
export interface RatchetPaths {
  readonly lcov?: string
  readonly baseline?: string
}

/**
 * Run the ratchet and return what it decided, rather than printing and calling `process.exit` inside.
 *
 * That split is what makes the gate testable end to end: the caller below turns the outcome into
 * output and an exit status, and a test drives the same function against fixture files and asserts the
 * code. Reading and writing through `node:fs/promises` rather than `Bun.file`/`Bun.write` is part of
 * the same goal - under `bun test --coverage` (1.3.14) this file's Bun file-API calls collapsed its
 * whole LINE coverage to 2%, reporting even module-level constants as unexecuted while the tests that
 * depend on them passed. Function coverage stayed correct throughout, so the numbers were wrong rather
 * than the code untested, and the plain Node API reports it accurately.
 */
export async function run(
  argv: readonly string[] = process.argv,
  paths: RatchetPaths = {},
): Promise<RatchetOutcome> {
  const update = argv.includes("--update")
  const acceptDrop = argv.includes("--accept-drop")
  const lcovPath = paths.lcov ?? process.env.COVERAGE_LCOV ?? DEFAULT_LCOV
  const baselinePath = paths.baseline ?? process.env.COVERAGE_BASELINE ?? DEFAULT_BASELINE

  const lcovText = await readFile(lcovPath, "utf8").catch(() => undefined)
  if (lcovText === undefined) {
    return {
      code: 2,
      report: [
        `[coverage-ratchet] no lcov report at ${lcovPath}. Produce one first:`,
        "  bun run test:coverage",
      ],
    }
  }
  const current = parseLcov(lcovText)
  const fileCount = Object.keys(current).length
  if (fileCount === 0) {
    return {
      code: 2,
      report: [
        `[coverage-ratchet] ${lcovPath} listed no files - refusing to treat that as a pass.`,
      ],
    }
  }

  if (acceptDrop && !update) {
    return {
      code: 2,
      report: [
        "[coverage-ratchet] --accept-drop does nothing without --update. Nothing was written.",
      ],
    }
  }

  const write = async (): Promise<void> => {
    await writeFile(baselinePath, `${JSON.stringify(sortKeys(current), null, 2)}\n`)
  }

  const baselineText = await readFile(baselinePath, "utf8").catch(() => undefined)
  if (baselineText === undefined) {
    // No baseline yet: --update bootstraps it. There is nothing to lower, so nothing to refuse.
    if (update) {
      await write()
      return {
        code: 0,
        report: [`[coverage-ratchet] baseline created: ${fileCount} files -> ${baselinePath}`],
      }
    }
    return {
      code: 2,
      report: [
        `[coverage-ratchet] no ${baselinePath}. Create it once with:`,
        "  bun run check:coverage --update",
      ],
    }
  }
  const baseline = JSON.parse(baselineText) as Record<string, FileCoverage>
  const regressions = findRegressions(baseline, current)

  if (update) {
    // Raise-only. A drop the check would fail on is a drop `--update` refuses to bury: the same
    // regressions, the same threshold, refused at the point someone tries to write them away.
    if (regressions.length > 0 && !acceptDrop) {
      return {
        code: 1,
        report: [
          `[coverage-ratchet] refusing to lower the baseline in ${regressions.length} place(s):`,
          "",
          ...regressions.flatMap((r) => [
            `  ${r.file}`,
            `    ${r.metric}: ${pct(r.was)} -> ${pct(r.now)}`,
          ]),
          "",
          "Add the tests. If the drop is intended, say so explicitly:",
          "  bun run check:coverage --update --accept-drop",
        ],
      }
    }
    await write()
    return {
      code: 0,
      report: [
        `[coverage-ratchet] baseline updated: ${fileCount} files -> ${baselinePath}`,
        ...(regressions.length > 0
          ? [
              "",
              `[coverage-ratchet] lowered ${regressions.length} entry/entries under --accept-drop:`,
              ...regressions.map((r) => `  ${r.file} ${r.metric}: ${pct(r.was)} -> ${pct(r.now)}`),
            ]
          : []),
      ],
    }
  }

  if (regressions.length > 0) {
    return {
      code: 1,
      report: [
        `[coverage-ratchet] coverage regressed in ${regressions.length} place(s):`,
        "",
        ...regressions.flatMap((r) => [
          `  ${r.file}`,
          `    ${r.metric}: ${pct(r.was)} -> ${pct(r.now)}`,
        ]),
        "",
        "Add the tests, or accept the drop deliberately with `bun run check:coverage --update`",
        "(the baseline is committed, so the reduction shows up in review).",
      ],
    }
  }
  const added = Object.keys(current).filter((f) => baseline[f] === undefined).length
  return {
    code: 0,
    report: [
      `[coverage-ratchet] ok - ${fileCount} files, none below baseline` +
        (added > 0 ? ` (${added} new, not yet in the baseline)` : ""),
    ],
  }
}

if (import.meta.main) {
  const outcome = await run()
  for (const line of outcome.report) {
    if (outcome.code === 0) console.log(line)
    else console.error(line)
  }
  process.exit(outcome.code)
}

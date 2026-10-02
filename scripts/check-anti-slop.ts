/**
 * Anti-slop ratchet: no file may gain a finding from the Biome plugins in `scripts/anti-slop/`.
 *
 * The plugins port four rules from dmmulroy/anti-slop (MIT). They report at `info`, so `biome check`
 * stays green over the sites that predate them while editors still show every one. This gate is what
 * enforces them: each file's per-rule count may not rise above the committed baseline, so the existing
 * sites are frozen and new code meets the rules.
 *
 * A justified new site takes a suppression whose reason states the invariant:
 *
 *   // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: <the checked invariant>
 *
 * ## Usage
 *
 *   bun run check:anti-slop                             # verify no file gained a finding
 *   bun run check:anti-slop --update                    # lower the baseline to the current counts
 *   bun run check:anti-slop --update --accept-increase  # ...and raise the entries that grew
 *
 * `--update` is lower-only for the coverage ratchet's reason: an escape hatch one flag away from the
 * failure message is not a ratchet. Raising a count takes a second, differently named flag that prints
 * every entry it raised. Moving code to a new file is the expected use - the count follows the code.
 */

import { spawnSync } from "node:child_process"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")
const PLUGIN_DIR = join(ROOT, "scripts/anti-slop")
const DEFAULT_BASELINE = join(ROOT, "anti-slop-baseline.json")
const BIOME = join(ROOT, "node_modules/.bin/biome")

/** Finding count per rule, then per file. */
export type Counts = Record<string, Record<string, number>>

export interface Finding {
  readonly rule: string
  readonly file: string
  readonly line: number
}

interface Diagnostic {
  readonly category?: string
  readonly message?: string
  readonly location?: { readonly path?: string; readonly start?: { readonly line?: number } }
}

/** Map each plugin's diagnostic message to its rule name - the file name `lint/plugin/<name>` uses. */
export async function loadRules(dir = PLUGIN_DIR): Promise<Map<string, string>> {
  const rules = new Map<string, string>()
  const names = (await readdir(dir)).filter((name) => name.endsWith(".grit")).sort()
  for (const name of names) {
    const source = await readFile(join(dir, name), "utf8")
    const messages = [...source.matchAll(/message\s*=\s*"((?:[^"\\]|\\.)*)"/g)]
    const message = messages[0]?.[1]
    if (messages.length !== 1 || message === undefined) {
      throw new Error(`${name}: expected one diagnostic message, found ${messages.length}`)
    }
    rules.set(message, name.slice(0, -".grit".length))
  }
  if (rules.size === 0) throw new Error(`no .grit plugins in ${dir}`)
  return rules
}

/**
 * The plugin findings in a Biome JSON report. Any other `plugin` diagnostic - a plugin that failed to
 * load reports under the same category - is an error: counting it as zero findings would pass the gate
 * with every rule switched off.
 */
export function collectFindings(reportText: string, rules: ReadonlyMap<string, string>): Finding[] {
  const report: { readonly diagnostics?: readonly Diagnostic[] } = JSON.parse(reportText)
  if (!Array.isArray(report.diagnostics)) throw new Error("Biome report has no diagnostics array")
  const findings: Finding[] = []
  for (const diagnostic of report.diagnostics) {
    if (diagnostic.category !== "plugin") continue
    const rule = rules.get(diagnostic.message ?? "")
    const file = diagnostic.location?.path
    if (rule === undefined || file === undefined) {
      throw new Error(`unrecognised plugin diagnostic: ${diagnostic.message ?? "(no message)"}`)
    }
    findings.push({ rule, file, line: diagnostic.location?.start?.line ?? 0 })
  }
  return findings
}

export function countFindings(findings: readonly Finding[], rules: Iterable<string>): Counts {
  const counts: Counts = {}
  for (const rule of rules) counts[rule] = {}
  for (const { rule, file } of findings) {
    const byFile = counts[rule] ?? {}
    byFile[file] = (byFile[file] ?? 0) + 1
    counts[rule] = byFile
  }
  return counts
}

export interface Change {
  readonly rule: string
  readonly file: string
  readonly was: number
  readonly now: number
}

/** Every (rule, file) whose count rose, and every one that fell - a deleted file falls to zero. */
export function compareCounts(
  baseline: Counts,
  current: Counts,
): { readonly increased: Change[]; readonly decreased: Change[] } {
  const increased: Change[] = []
  const decreased: Change[] = []
  for (const [rule, files] of Object.entries(current)) {
    for (const [file, now] of Object.entries(files)) {
      const was = baseline[rule]?.[file] ?? 0
      if (now > was) increased.push({ rule, file, was, now })
    }
  }
  for (const [rule, files] of Object.entries(baseline)) {
    for (const [file, was] of Object.entries(files)) {
      const now = current[rule]?.[file] ?? 0
      if (now < was) decreased.push({ rule, file, was, now })
    }
  }
  const order = (a: Change, b: Change): number =>
    a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule)
  return { increased: increased.sort(order), decreased: decreased.sort(order) }
}

function sortCounts(counts: Counts): Counts {
  return Object.fromEntries(
    Object.entries(counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([rule, files]) => [
        rule,
        Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
      ]),
  )
}

function lint(cwd: string): string {
  const result = spawnSync(
    BIOME,
    ["lint", "--reporter=json", "--max-diagnostics=none", "--diagnostic-level=info", "."],
    { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
  )
  if (result.error !== undefined) throw result.error
  if (result.stdout.trim() === "") throw new Error(`biome produced no report:\n${result.stderr}`)
  return result.stdout
}

/**
 * Tracked files only: Biome also lints local untracked files, and their paths must not reach the
 * committed baseline. A staged file is tracked, so new code is checked from `git add` on.
 */
function trackedFiles(cwd: string): Set<string> {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`git ls-files failed:\n${result.stderr}`)
  return new Set(result.stdout.split("\0").filter((file) => file !== ""))
}

/** The plugin findings in the tracked files of the project at `cwd`, and their counts. */
export async function scan(cwd: string): Promise<{ findings: Finding[]; counts: Counts }> {
  const rules = await loadRules()
  const tracked = trackedFiles(cwd)
  const findings = collectFindings(lint(cwd), rules).filter((finding) => tracked.has(finding.file))
  return { findings, counts: countFindings(findings, rules.values()) }
}

/** What a run decided: the process exit code, and the lines to print. */
export interface RatchetOutcome {
  /** 0 ok, 1 a file gained findings, 2 the gate could not run at all. */
  readonly code: 0 | 1 | 2
  readonly report: readonly string[]
}

/** Where a run lints and which baseline it reads and writes; explicit so a test can use a temp project. */
export interface RatchetPaths {
  readonly cwd?: string
  readonly baseline?: string
}

export async function run(
  argv: readonly string[] = process.argv,
  paths: RatchetPaths = {},
): Promise<RatchetOutcome> {
  const update = argv.includes("--update")
  const acceptIncrease = argv.includes("--accept-increase")
  const baselinePath = paths.baseline ?? DEFAULT_BASELINE

  if (acceptIncrease && !update) {
    return {
      code: 2,
      report: ["[anti-slop] --accept-increase does nothing without --update. Nothing was written."],
    }
  }

  let current: Counts
  let findings: Finding[]
  try {
    ;({ findings, counts: current } = await scan(paths.cwd ?? ROOT))
  } catch (error) {
    return {
      code: 2,
      report: [`[anti-slop] could not run: ${error instanceof Error ? error.message : error}`],
    }
  }

  const write = async (): Promise<void> => {
    await writeFile(baselinePath, `${JSON.stringify(sortCounts(current), null, 2)}\n`)
  }
  const total = findings.length

  const baselineText = await readFile(baselinePath, "utf8").catch(() => undefined)
  if (baselineText === undefined) {
    if (update) {
      await write()
      return {
        code: 0,
        report: [`[anti-slop] baseline created: ${total} findings -> ${baselinePath}`],
      }
    }
    return {
      code: 2,
      report: [
        `[anti-slop] no ${baselinePath}. Create it once with:`,
        "  bun run check:anti-slop --update",
      ],
    }
  }
  const baseline: Counts = JSON.parse(baselineText)
  const { increased, decreased } = compareCounts(baseline, current)

  const describe = (changes: readonly Change[]): string[] =>
    changes.flatMap((change) => [
      `  ${change.file}`,
      `    ${change.rule}: ${change.was} -> ${change.now}`,
      ...findings
        .filter((finding) => finding.rule === change.rule && finding.file === change.file)
        .map((finding) => `      ${finding.file}:${finding.line}`),
    ])

  if (increased.length > 0 && !(update && acceptIncrease)) {
    return {
      code: 1,
      report: [
        update
          ? `[anti-slop] refusing to raise the baseline in ${increased.length} place(s):`
          : `[anti-slop] findings increased in ${increased.length} place(s):`,
        "",
        ...describe(increased),
        "",
        "Fix the new site, or state why it is sound with a suppression on the line above it:",
        "  // biome-ignore lint/plugin/<rule>: <the invariant that makes it safe>",
        "If the findings only moved here with the code, say so explicitly:",
        "  bun run check:anti-slop --update --accept-increase",
      ],
    }
  }

  if (update) {
    await write()
    return {
      code: 0,
      report: [
        `[anti-slop] baseline updated: ${total} findings -> ${baselinePath}`,
        ...(increased.length > 0
          ? [
              "",
              `[anti-slop] raised ${increased.length} entry/entries under --accept-increase:`,
              ...increased.map((c) => `  ${c.file} ${c.rule}: ${c.was} -> ${c.now}`),
            ]
          : []),
      ],
    }
  }

  return {
    code: 0,
    report: [
      `[anti-slop] ok - ${total} findings, no file above baseline` +
        (decreased.length > 0
          ? ` (${decreased.length} entry/entries below it - lock them in with --update)`
          : ""),
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

/**
 * `nifra upgrade <version>` — an executable, per-release upgrade runner. Framework and shared-package
 * bumps otherwise spread the same mechanical edits across every consuming app by hand; a recipe turns
 * them into `detect → transform → verify`:
 *
 *   1. **pin sweep** — set every matching dependency to the target version across the workspace's
 *      package.json files, preserving the caret/tilde/exact style and skipping `workspace:`/`link:` specs.
 *   2. **import moves** — rewrite exact import specifiers (e.g. `old-lib` → `old-lib/nifra`).
 *   3. **verify** — reuse the existing `nifra check` gate; no new verification surface.
 *
 * Dry-run by default (prints the plan, writes nothing); `--write` applies. Fail-closed on an unknown
 * target version or a missing package.json, and deterministic (same repo + target → same edits).
 *
 * Deliberately NOT a codemod engine: transforms are string/specifier-level only. Structural (AST)
 * transforms are a future addition — a recipe that needs one is the signal to add the engine, not before.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { Glob } from "bun"
import { getRecipe, listRecipeVersions, type UpgradeRecipe } from "./recipes/index.ts"

export interface UpgradeOptions {
  /** Target version, e.g. "1.8.0". Required unless `list` is set. */
  readonly version?: string
  /** Apply the edits. Without it, the run is a dry-run that only prints the plan. */
  readonly write?: boolean
  /** Emit a machine-readable plan/result instead of the human report. */
  readonly json?: boolean
  /** Print the available target versions and return. */
  readonly list?: boolean
  /** After `--write`, run `nifra check` and fail the command if it fails. Default true. */
  readonly verify?: boolean
}

export interface PinChange {
  readonly file: string
  readonly field: string
  readonly name: string
  readonly from: string
  readonly to: string
}

export interface ImportChange {
  readonly file: string
  readonly from: string
  readonly to: string
  readonly count: number
}

export interface UpgradePlan {
  readonly version: string
  readonly pins: readonly PinChange[]
  readonly importMoves: readonly ImportChange[]
  readonly notes: readonly string[]
}

const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const

// Only a bare semver spec is rewritten. Anything else — workspace:*, link:/file:, npm: aliases, git
// urls, "*", "latest", or a multi-part range — is intentionally left untouched (skipped, not guessed).
const SEMVER_SPEC = /^([\^~]|>=|<=|>|<|=)?\s*(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * Rewrite a dependency version spec to `toVersion`, preserving the range operator (`^`, `~`, …).
 * Returns null when the spec is not a plain semver spec (→ skip it) or already equals the target.
 */
export function rewriteVersionSpec(spec: string, toVersion: string): string | null {
  const match = SEMVER_SPEC.exec(spec.trim())
  if (!match) return null
  const operator = match[1] ?? ""
  const next = `${operator}${toVersion}`
  return next === spec ? null : next
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Apply pin rules to one package.json's TEXT (format-preserving — targeted string replaces, never a
 * JSON re-serialize that would reorder keys or drop comments-as-formatting). Returns the new text and
 * the changes made.
 */
export function pinSweepText(
  text: string,
  rules: readonly { match: string; to: string }[],
): { text: string; changes: Array<Omit<PinChange, "file">> } {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    return { text, changes: [] }
  }
  let out = text
  const changes: Array<Omit<PinChange, "file">> = []
  for (const field of DEP_FIELDS) {
    const deps = parsed[field]
    if (typeof deps !== "object" || deps === null) continue
    for (const [name, rawSpec] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof rawSpec !== "string") continue
      const rule = rules.find((r) => name.startsWith(r.match))
      if (!rule) continue
      const next = rewriteVersionSpec(rawSpec, rule.to)
      if (next === null) continue
      // Replace exactly `"name"<ws>:<ws>"spec"`, preserving the surrounding whitespace.
      const pattern = new RegExp(`("${escapeRegExp(name)}"\\s*:\\s*")${escapeRegExp(rawSpec)}(")`)
      const replaced = out.replace(pattern, `$1${next}$2`)
      if (replaced !== out) {
        out = replaced
        changes.push({ field, name, from: rawSpec, to: next })
      }
    }
  }
  return { text: out, changes }
}

const IMPORT_SPEC = (from: string): RegExp =>
  new RegExp(
    `(\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\brequire\\s*\\(\\s*|\\bimport\\s+)(['"])${escapeRegExp(from)}(['"])`,
    "g",
  )

/** Rewrite exact import/export/require/dynamic-import specifiers in one source file's text. */
export function applyImportMoves(
  text: string,
  moves: readonly { from: string; to: string }[],
): { text: string; changes: Array<{ from: string; to: string; count: number }> } {
  let out = text
  const changes: Array<{ from: string; to: string; count: number }> = []
  for (const move of moves) {
    if (move.from === move.to) continue
    let count = 0
    out = out.replace(IMPORT_SPEC(move.from), (_full, prefix: string, q1: string, q2: string) => {
      count += 1
      return `${prefix}${q1}${move.to}${q2}`
    })
    if (count > 0) changes.push({ from: move.from, to: move.to, count })
  }
  return { text: out, changes }
}

const SOURCE_GLOB = "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"
const IGNORE_SEGMENTS = ["node_modules/", "/dist/", "/build/", "/.git/", "/coverage/", "/.next/"]

const isIgnored = (path: string): boolean =>
  path.startsWith("node_modules/") || IGNORE_SEGMENTS.some((seg) => path.includes(seg))

function scan(cwd: string, pattern: string): string[] {
  const glob = new Glob(pattern)
  const out: string[] = []
  for (const path of glob.scanSync({ cwd, dot: false })) {
    if (!isIgnored(path)) out.push(path)
  }
  return out.sort() // deterministic order
}

/** Compute the plan (and, when `write`, apply it) for a target recipe against `cwd`. */
export function computeUpgrade(
  cwd: string,
  recipe: UpgradeRecipe,
  write: boolean,
): UpgradePlan {
  const pins: PinChange[] = []
  const importMoves: ImportChange[] = []

  if (recipe.pins.length > 0) {
    for (const rel of scan(cwd, "**/package.json")) {
      const abs = join(cwd, rel)
      const text = readFileSync(abs, "utf8")
      const result = pinSweepText(text, recipe.pins)
      if (result.changes.length === 0) continue
      for (const change of result.changes) pins.push({ file: rel, ...change })
      if (write) writeFileSync(abs, result.text)
    }
  }

  if (recipe.importMoves.length > 0) {
    for (const rel of scan(cwd, SOURCE_GLOB)) {
      const abs = join(cwd, rel)
      const text = readFileSync(abs, "utf8")
      const result = applyImportMoves(text, recipe.importMoves)
      if (result.changes.length === 0) continue
      for (const change of result.changes) importMoves.push({ file: rel, ...change })
      if (write) writeFileSync(abs, result.text)
    }
  }

  return { version: recipe.version, pins, importMoves, notes: recipe.notes ?? [] }
}

function renderPlan(plan: UpgradePlan, write: boolean): string {
  const lines: string[] = []
  const verb = write ? "Applied" : "Planned"
  lines.push(`nifra upgrade → ${plan.version}  (${write ? "write" : "dry-run"})`)
  lines.push("")
  if (plan.pins.length === 0 && plan.importMoves.length === 0) {
    lines.push("Already up to date — no changes.")
    return lines.join("\n")
  }
  if (plan.pins.length > 0) {
    lines.push(`${verb} ${plan.pins.length} dependency pin(s):`)
    for (const p of plan.pins) lines.push(`  ${p.file}  ${p.name}: ${p.from} → ${p.to}`)
    lines.push("")
  }
  if (plan.importMoves.length > 0) {
    const total = plan.importMoves.reduce((n, m) => n + m.count, 0)
    lines.push(`${verb} ${total} import move(s) across ${plan.importMoves.length} file(s):`)
    for (const m of plan.importMoves) lines.push(`  ${m.file}  ${m.from} → ${m.to}  (${m.count})`)
    lines.push("")
  }
  for (const note of plan.notes) lines.push(`note: ${note}`)
  if (!write) lines.push("\nRe-run with --write to apply, then nifra check verifies.")
  return lines.join("\n").trimEnd()
}

/** CLI entry. Returns false (→ non-zero exit) on an unknown version, no project, or a failed verify. */
export async function runUpgrade(cwd: string, options: UpgradeOptions): Promise<boolean> {
  if (options.list) {
    const versions = listRecipeVersions()
    if (options.json) console.log(JSON.stringify({ versions }, null, 2))
    else console.log(`available upgrade targets:\n${versions.map((v) => `  ${v}`).join("\n")}`)
    return true
  }

  const { version } = options
  if (version === undefined) {
    console.error("[nifra] upgrade needs a target version, e.g. `nifra upgrade 1.8.0` (or --list)")
    return false
  }
  const recipe = getRecipe(version)
  if (!recipe) {
    console.error(
      `[nifra] no upgrade recipe for ${version}. Available: ${listRecipeVersions().join(", ") || "(none)"}`,
    )
    return false
  }

  // Detect: the cwd must be a project (or workspace) root.
  try {
    readFileSync(join(cwd, "package.json"), "utf8")
  } catch {
    console.error(`[nifra] no package.json in ${relative(process.cwd(), cwd) || "."} — run from a project root`)
    return false
  }

  const write = options.write === true
  const plan = computeUpgrade(cwd, recipe, write)

  if (options.json) {
    console.log(JSON.stringify({ ...plan, write }, null, 2))
  } else {
    console.log(renderPlan(plan, write))
  }

  // Verify only makes sense once edits are on disk. Default on after --write; opt out with --no-verify.
  if (write && options.verify !== false) {
    const { runCheck } = await import("./check.ts")
    const ok = await runCheck(cwd, { json: false })
    if (!ok) {
      if (!options.json) console.error("\n[nifra] upgrade applied but `nifra check` failed — review above.")
      return false
    }
  }
  return true
}

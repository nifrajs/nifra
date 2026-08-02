/**
 * `nifra upgrade <version>` - an executable, per-release upgrade runner. Framework and shared-package
 * bumps otherwise spread the same mechanical edits across every consuming app by hand; a recipe turns
 * them into `detect → transform → verify`:
 *
 *   1. **pin sweep** - set every matching dependency to the target version across the workspace's
 *      package.json files, preserving the caret/tilde/exact style and skipping `workspace:`/`link:` specs.
 *   2. **dependency moves** - replace removed packages with their supported successor without
 *      reserializing package.json or leaving duplicate dependency keys.
 *   3. **import moves** - rewrite exact import specifiers to their updated module paths.
 *   4. **verify** - reuse the existing `nifra check` gate; no new verification surface.
 *
 * Dry-run by default (prints the plan, writes nothing); `--write` applies. Fail-closed on an unknown
 * target version or a missing package.json, and deterministic (same repo + target → same edits).
 *
 * Deliberately NOT a codemod engine: transforms are string/specifier-level only. Structural (AST)
 * transforms are a future addition - a recipe that needs one is the signal to add the engine, not before.
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
  /** Permit a target BELOW the installed version (a rollback). Default false → fail-closed. */
  readonly allowDowngrade?: boolean
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

export interface DependencyMoveChange {
  readonly file: string
  readonly field: string
  readonly from: string
  readonly to: string
  readonly fromVersion: string
  readonly toVersion: string
  readonly action: "renamed" | "removed"
}

export interface UpgradePlan {
  readonly version: string
  readonly pins: readonly PinChange[]
  readonly dependencyMoves: readonly DependencyMoveChange[]
  readonly importMoves: readonly ImportChange[]
  /** Pins refused because the target is BELOW the installed version (a rollback). Empty when allowed. */
  readonly downgrades: readonly PinChange[]
  readonly notes: readonly string[]
}

const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const

// Only a bare semver spec is rewritten. Anything else - workspace:*, link:/file:, npm: aliases, git
// urls, "*", "latest", or a multi-part range - is intentionally left untouched (skipped, not guessed).
const SEMVER_SPEC =
  /^([\^~]|>=|<=|>|<|=)?\s*(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

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

/** Numeric core (major, minor, patch) of a semver spec, ignoring the range operator + prerelease/build. */
export function specVersionTuple(spec: string): readonly [number, number, number] | null {
  const match = SEMVER_SPEC.exec(spec.trim())
  if (!match) return null
  return [Number(match[2]), Number(match[3]), Number(match[4])]
}

interface ParsedSpecVersion {
  readonly core: readonly [number, number, number]
  readonly prerelease: readonly (number | string)[]
}

function parseSpecVersion(spec: string): ParsedSpecVersion | null {
  const match = SEMVER_SPEC.exec(spec.trim())
  if (!match) return null
  const prerelease = (match[5] ?? "").split(".")
  return {
    core: [Number(match[2]), Number(match[3]), Number(match[4])],
    prerelease:
      match[5] === undefined
        ? []
        : prerelease.map((part) => (/^\d+$/.test(part) ? Number(part) : part)),
  }
}

/** Compare two semver cores: <0 when a<b, 0 equal, >0 when a>b. */
export function compareSemverCore(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

/** Compare full semver precedence, including prereleases (`2.3.0-beta` < `2.3.0`). */
export function compareSemverSpec(a: string, b: string): number {
  const left = parseSpecVersion(a)
  const right = parseSpecVersion(b)
  if (left === null || right === null) return 0
  const core = compareSemverCore(left.core, right.core)
  if (core !== 0) return core
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length
      ? 0
      : left.prerelease.length === 0
        ? 1
        : -1
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let i = 0; i < length; i++) {
    const x = left.prerelease[i]
    const y = right.prerelease[i]
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) return x - y
    } else if (typeof x === "number") return -1
    else if (typeof y === "number") return 1
    else if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Apply pin rules to one package.json's TEXT (format-preserving - targeted string replaces, never a
 * JSON re-serialize that would reorder keys or drop comments-as-formatting). Returns the new text and
 * the changes made.
 */
export function pinSweepText(
  text: string,
  rules: readonly { match: string; to: string }[],
  allowDowngrade = false,
): {
  text: string
  changes: Array<Omit<PinChange, "file">>
  downgrades: Array<Omit<PinChange, "file">>
} {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    return { text, changes: [], downgrades: [] }
  }
  let out = text
  const changes: Array<Omit<PinChange, "file">> = []
  const downgrades: Array<Omit<PinChange, "file">> = []
  for (const field of DEP_FIELDS) {
    const deps = parsed[field]
    if (typeof deps !== "object" || deps === null) continue
    for (const [name, rawSpec] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof rawSpec !== "string") continue
      const rule = rules.find(
        (r) => name === r.match || (r.match.endsWith("/") && name.startsWith(r.match)),
      )
      if (!rule) continue
      const next = rewriteVersionSpec(rawSpec, rule.to)
      if (next === null) continue
      // Refuse a rollback: `upgrade <version>` pins an exact target, so an OLD target on a newer install
      // walks dependencies backward (e.g. ^2.3.0 → ^2.0.0) and can break a shared-package peer range.
      const current = specVersionTuple(rawSpec)
      const target = specVersionTuple(rule.to)
      if (
        !allowDowngrade &&
        current !== null &&
        target !== null &&
        compareSemverSpec(rawSpec, rule.to) > 0
      ) {
        downgrades.push({ field, name, from: rawSpec, to: next })
        continue
      }
      // Replace exactly `"name"<ws>:<ws>"spec"`, preserving the surrounding whitespace.
      const pattern = new RegExp(`("${escapeRegExp(name)}"\\s*:\\s*")${escapeRegExp(rawSpec)}(")`)
      const replaced = out.replace(pattern, `$1${next}$2`)
      if (replaced !== out) {
        out = replaced
        changes.push({ field, name, from: rawSpec, to: next })
      }
    }
  }
  return { text: out, changes, downgrades }
}

function dependencyObjectRange(
  text: string,
  field: (typeof DEP_FIELDS)[number],
): { start: number; end: number } | undefined {
  const match = new RegExp(`"${field}"\\s*:\\s*\\{`).exec(text)
  if (match === null) return undefined
  const open = text.indexOf("{", match.index)
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = open; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === "{") depth++
    else if (char === "}" && --depth === 0) return { start: open + 1, end: index }
  }
  return undefined
}

function rewriteDependencyEntry(
  text: string,
  field: (typeof DEP_FIELDS)[number],
  from: string,
  fromVersion: string,
  to: string | undefined,
  toVersion: string | undefined,
): string {
  const range = dependencyObjectRange(text, field)
  if (range === undefined) return text
  const body = text.slice(range.start, range.end)
  const key = escapeRegExp(from)
  const version = escapeRegExp(fromVersion)
  const entry = new RegExp(`"${key}"(\\s*:\\s*)"${version}"`)
  const match = entry.exec(body)
  if (match === null) return text

  let nextBody: string
  if (to !== undefined && toVersion !== undefined) {
    nextBody =
      body.slice(0, match.index) +
      `"${to}"${match[1]}"${toVersion}"` +
      body.slice(match.index + match[0].length)
  } else {
    let start = match.index
    let end = match.index + match[0].length
    let after = end
    while (/\\s/.test(body[after] ?? "")) after++
    if (body[after] === ",") {
      end = after + 1
    } else {
      let before = start - 1
      while (before >= 0 && /\\s/.test(body[before] ?? "")) before--
      if (body[before] === ",") start = before
    }
    nextBody = body.slice(0, start) + body.slice(end)
  }
  return text.slice(0, range.start) + nextBody + text.slice(range.end)
}

/** Move removed package dependencies without reserializing or reordering package.json. */
export function moveDependenciesText(
  text: string,
  moves: readonly { from: string; to: string; toVersion: string }[],
): { text: string; changes: Array<Omit<DependencyMoveChange, "file">> } {
  let out = text
  const changes: Array<Omit<DependencyMoveChange, "file">> = []
  for (const move of moves) {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(out) as Record<string, unknown>
    } catch {
      return { text, changes: [] }
    }
    for (const field of DEP_FIELDS) {
      const deps = parsed[field]
      if (typeof deps !== "object" || deps === null) continue
      const dependencyMap = deps as Record<string, unknown>
      if (!Object.hasOwn(dependencyMap, move.from)) continue
      const fromVersion = dependencyMap[move.from]
      if (typeof fromVersion !== "string") continue
      const movedVersion = rewriteVersionSpec(fromVersion, move.toVersion) ?? fromVersion
      // Dependency fields have different install semantics. A devDependency does not satisfy a runtime
      // dependency, so only deduplicate the successor inside the same field.
      const targetExists = Object.hasOwn(dependencyMap, move.to)
      const action = targetExists ? "removed" : "renamed"
      const next = rewriteDependencyEntry(
        out,
        field,
        move.from,
        fromVersion,
        targetExists ? undefined : move.to,
        targetExists ? undefined : movedVersion,
      )
      if (next === out) continue
      out = next
      changes.push({
        field,
        from: move.from,
        to: move.to,
        fromVersion,
        toVersion: movedVersion,
        action,
      })
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
  allowDowngrade = false,
): UpgradePlan {
  const pins: PinChange[] = []
  const dependencyMoves: DependencyMoveChange[] = []
  const importMoves: ImportChange[] = []
  const downgrades: PinChange[] = []

  if ((recipe.dependencyMoves?.length ?? 0) > 0 || recipe.pins.length > 0) {
    for (const rel of scan(cwd, "**/package.json")) {
      const abs = join(cwd, rel)
      const original = readFileSync(abs, "utf8")
      const moved = moveDependenciesText(original, recipe.dependencyMoves ?? [])
      for (const change of moved.changes) dependencyMoves.push({ file: rel, ...change })
      const pinned = pinSweepText(moved.text, recipe.pins, allowDowngrade)
      for (const change of pinned.changes) pins.push({ file: rel, ...change })
      for (const d of pinned.downgrades) downgrades.push({ file: rel, ...d })
      if (write && pinned.text !== original) writeFileSync(abs, pinned.text)
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

  return {
    version: recipe.version,
    pins,
    dependencyMoves,
    importMoves,
    downgrades,
    notes: recipe.notes ?? [],
  }
}

function renderPlan(plan: UpgradePlan, write: boolean): string {
  const lines: string[] = []
  const verb = write ? "Applied" : "Planned"
  lines.push(`nifra upgrade → ${plan.version}  (${write ? "write" : "dry-run"})`)
  lines.push("")
  if (
    plan.pins.length === 0 &&
    plan.dependencyMoves.length === 0 &&
    plan.importMoves.length === 0
  ) {
    lines.push("Already up to date - no changes.")
    return lines.join("\n")
  }
  if (plan.dependencyMoves.length > 0) {
    lines.push(`${verb} ${plan.dependencyMoves.length} dependency move(s):`)
    for (const move of plan.dependencyMoves) {
      const detail =
        move.action === "renamed"
          ? `${move.from}@${move.fromVersion} → ${move.to}@${move.toVersion}`
          : `removed ${move.from}@${move.fromVersion}; ${move.to} is already declared`
      lines.push(`  ${move.file}  ${detail}`)
    }
    lines.push("")
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

/** Explain a refused rollback: which pins would roll back, why it's blocked, and the escape hatch. */
function renderDowngradeRefusal(version: string, downgrades: readonly PinChange[]): string {
  return [
    `nifra upgrade → ${version}: refusing to DOWNGRADE ${downgrades.length} pin(s) below what's installed.`,
    "",
    ...downgrades.map((d) => `  ${d.file}  ${d.name}: ${d.from} → ${d.to}  (would roll back)`),
    "",
    "`nifra upgrade <version>` sets each pin to exactly <version>; an older target on a newer install",
    "rolls dependencies backward and can violate a shared-package peer range. Target a version >= the",
    "installed one, or pass --allow-downgrade if the rollback is intended.",
  ].join("\n")
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
    console.error(
      `[nifra] no package.json in ${relative(process.cwd(), cwd) || "."} - run from a project root`,
    )
    return false
  }

  const write = options.write === true
  const allowDowngrade = options.allowDowngrade === true

  // Fail-closed on rollback: a dry pass writes nothing, so we can refuse before any package.json is touched.
  const preview = computeUpgrade(cwd, recipe, false, allowDowngrade)
  if (preview.downgrades.length > 0) {
    if (options.json) {
      console.log(JSON.stringify({ ...preview, write: false, refused: "downgrade" }, null, 2))
    } else {
      console.error(renderDowngradeRefusal(recipe.version, preview.downgrades))
    }
    return false
  }

  const plan = write ? computeUpgrade(cwd, recipe, true, allowDowngrade) : preview

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
      if (!options.json)
        console.error("\n[nifra] upgrade applied but `nifra check` failed - review above.")
      return false
    }
  }
  return true
}

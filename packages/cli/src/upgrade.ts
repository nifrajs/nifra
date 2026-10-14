/**
 * `nifra upgrade <version>` - an executable, per-release upgrade runner. Framework and shared-package
 * bumps otherwise spread the same mechanical edits across every consuming app by hand; a recipe turns
 * them into `detect → transform → verify`:
 *
 *   1. **pin sweep** - set every matching dependency to the target version across the workspace's
 *      package.json files, preserving the caret/tilde/exact style and skipping `workspace:`/`link:` specs.
 *      `overrides`, `resolutions` and `pnpm.overrides` are swept too, since they decide what installs.
 *      The MCP launch pin in `.mcp.json`, `.cursor/mcp.json`, CLAUDE.md and AGENTS.md moves too, the
 *      edit `nifra init-agents --sync-mcp` makes; a version pinned anywhere else (a Dockerfile, a CI
 *      workflow, another lockfile) is listed only.
 *   2. **dependency moves** - replace removed packages with their supported successor without
 *      reserializing package.json or leaving duplicate dependency keys.
 *   3. **import moves** - rewrite exact import specifiers to their updated module paths.
 *   4. **verify** - reuse the existing `nifra check` gate; no new verification surface. It reads the
 *      installed packages, so while the edited pins are not installed yet it is skipped with the
 *      install command to run first: a check then would judge the release being left.
 *
 * Upgrading across several releases runs every recipe between the installed version (the lowest
 * fixed-group version the workspace declares) and the target, oldest first, then pins the target. A
 * target newer than this CLI prints the newer CLI's command instead of guessing at recipes it does not
 * carry; nothing is downloaded or run on the user's behalf.
 *
 * Dry-run by default (prints the plan, writes nothing); `--write` applies. Fail-closed on an unknown
 * target version or a missing package.json, and deterministic (same repo + target → same edits).
 *
 * Deliberately NOT a codemod engine: transforms are string/specifier-level only. Structural (AST)
 * transforms are a future addition - a recipe that needs one is the signal to add the engine, not before.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import type { ReflectedHookReport } from "@nifrajs/core/reflection"
import { Glob } from "bun"
import {
  collectHookReport,
  diffHookReports,
  HOOKS_BEFORE_UPGRADE_FILE,
  type HookReportChange,
  parseHookReport,
  renderHookDiff,
} from "./hooks-report.ts"
import { type AncestorPinSite, ancestorPins, declaresCli, PIN_SITES } from "./init-agents.ts"
import {
  BUN_LOCK,
  describeChange,
  linkLockUpdate,
  pruneLinkLocks,
  type StaleLinkLock,
  staleLinkLocks,
} from "./lock-links.ts"
import { getRecipe, listRecipeVersions, type UpgradeRecipe } from "./recipes/index.ts"
import { markerTarget } from "./rules/comment-markers.ts"

export interface UpgradeOptions {
  /** Target version, e.g. "1.8.0". Required unless `list` is set. */
  readonly version?: string
  /** Apply the edits. Without it, the run is a dry-run that only prints the plan. */
  readonly write?: boolean
  /** Emit a machine-readable plan/result instead of the human report. */
  readonly json?: boolean
  /** Print the available target versions and return. */
  readonly list?: boolean
  /** After `--write`, run `nifra check` and fail the command if it fails, once the install matches
   * the target; until then, print the install command to run first. Default true. */
  readonly verify?: boolean
  /** Permit a target BELOW the installed version (a rollback). Default false → fail-closed. */
  readonly allowDowngrade?: boolean
  /** Pin the exact target (`3.6.0`), dropping the `^`/`~` a spec used. Default false → keep it. */
  readonly exact?: boolean
  /** The running CLI's version: the newest target it applies. Default: its newest recipe. */
  readonly cliVersion?: string
  /**
   * With `--write`, capture `nifra routes --hooks` before and after the edits and print the diff, so a
   * change in which hooks run where is visible. Loads the backend. Default true; `--no-hooks` skips it.
   */
  readonly hooks?: boolean
  /** Proceed although a linked repository loads its own nifra at another version. Default false. */
  readonly allowLinkedSkew?: boolean
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

/** An agent file whose MCP launch pins another `@nifrajs/cli`, re-pinned to the target. */
export interface AgentPinChange {
  readonly file: string
  /** The versions it pinned, in order of appearance. */
  readonly from: readonly string[]
  /** The target version, or `unpinned` when the project declares `@nifrajs/cli`: the launch then runs
   * that install and never needs re-pinning. */
  readonly to: string
}

/** A retired comment in the project, and the line it applied to before the release retired it. */
export interface RetiredMarkerSite {
  readonly file: string
  readonly line: number
  readonly marker: string
  /** The line the comment covered; `undefined` when a blank line follows its comment block. */
  readonly covers: { readonly line: number; readonly text: string } | undefined
  readonly instead: string
}

export interface UpgradePlan {
  readonly version: string
  readonly pins: readonly PinChange[]
  readonly agentPins: readonly AgentPinChange[]
  readonly dependencyMoves: readonly DependencyMoveChange[]
  readonly importMoves: readonly ImportChange[]
  /** Pins refused because the target is BELOW the installed version (a rollback). Empty when allowed. */
  readonly downgrades: readonly PinChange[]
  /** Comments a release in the chain stopped honoring. Listed only, never rewritten. */
  readonly retiredMarkers: readonly RetiredMarkerSite[]
  /** Installed group packages linked from outside the workspace root, at another version. Never edited. */
  readonly linkedOutside: readonly LinkedGroupInstall[]
  /** Repositories a `link:`/`file:` dependency points outside the root, each loading its own nifra at
   * another version. Never edited; the upgrade refuses while any is listed. */
  readonly linkedSkew: readonly LinkedSkew[]
  /** Other versions pinned outside package.json. Never edited. */
  readonly strayPins: readonly StrayPin[]
  /** `file:` entries of the project's bun.lock whose recorded dependencies the linked package.json
   * (as this upgrade leaves it) no longer declares. Bun never refreshes them on its own. */
  readonly linkLocks: readonly StaleLinkLock[]
  /** Whether `--write` dropped {@link linkLocks} from bun.lock, so `bun install` re-reads them. */
  readonly lockPruned: boolean
  readonly notes: readonly string[]
}

const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const
const PEER_FIELD = "peerDependencies"

// Only a bare semver spec is rewritten. Anything else - workspace:*, link:/file:, npm: aliases, git
// urls, "*", "latest", or a multi-part range - is intentionally left untouched (skipped, not guessed).
const SEMVER_SPEC =
  /^([\^~]|>=|<=|>|<|=)?\s*(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

const UPPER_BOUND = /^\s*<=?/

// A strict bound kept on the target would exclude it: `>5.2.0` → `>5.3.0` refuses 5.3.0.
const INCLUSIVE_OPERATOR: Readonly<Record<string, string>> = { ">": ">=", "<": "<=" }

/**
 * Rewrite a dependency version spec to `toVersion`, preserving the range operator (`^`, `~`, …;
 * a strict `>` or `<` becomes `>=` or `<=`, so the result admits the target), or dropping it when
 * `exact`. Returns null when the spec is not a plain semver spec (→ skip it) or already equals the
 * target.
 */
export function rewriteVersionSpec(spec: string, toVersion: string, exact = false): string | null {
  const match = SEMVER_SPEC.exec(spec.trim())
  if (!match) return null
  const written = match[1] ?? ""
  const operator = exact ? "" : (INCLUSIVE_OPERATOR[written] ?? written)
  const next = `${operator}${toVersion}`
  return next === spec ? null : next
}

/** The version a plain semver spec names (`^2.4.1` → `2.4.1`), or null for any other spec. */
export function specVersion(spec: string): string | null {
  const match = SEMVER_SPEC.exec(spec.trim())
  if (!match) return null
  return `${match[2]}.${match[3]}.${match[4]}${match[5] === undefined ? "" : `-${match[5]}`}`
}

// A release target: a bare version, never a range, so it can be pinned and printed in a command.
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

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

/**
 * Whether a plain semver spec's range admits `version`, as npm reads it: `^` and `~` stop before the
 * next breaking release, and a prerelease satisfies only a spec naming a prerelease of its own core.
 * False for any other spec.
 */
export function specIncludes(spec: string, version: string): boolean {
  const match = SEMVER_SPEC.exec(spec.trim())
  const target = parseSpecVersion(version)
  const floor = specVersion(spec)
  if (match === null || target === null || floor === null) return false
  const core: readonly [number, number, number] = [
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
  ]
  if (
    target.prerelease.length > 0 &&
    (match[5] === undefined || compareSemverCore(core, target.core) !== 0)
  )
    return false
  const order = compareSemverSpec(version, floor)
  switch (match[1]) {
    case ">=":
      return order >= 0
    case ">":
      return order > 0
    case "<=":
      return order <= 0
    case "<":
      return order < 0
    case "^": {
      const below: readonly [number, number, number] =
        core[0] > 0 ? [core[0] + 1, 0, 0] : core[1] > 0 ? [0, core[1] + 1, 0] : [0, 0, core[2] + 1]
      return order >= 0 && compareSemverCore(target.core, below) < 0
    }
    case "~":
      return order >= 0 && compareSemverCore(target.core, [core[0], core[1] + 1, 0]) < 0
    default:
      return order === 0
  }
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
  exact = false,
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
  for (const { path, key, target: name, spec: rawSpec } of pinEntries(parsed)) {
    const field = path.join(".")
    const rule = rules.find(
      (r) => name === r.match || (r.match.endsWith("/") && name.startsWith(r.match)),
    )
    if (!rule) continue
    // A peer range states what a library accepts, not what installs: widening a floor that already
    // admits the target would drop every consumer still on an older release, and an exact peer pin
    // would admit one release only.
    const peer = field === PEER_FIELD
    if (peer && specIncludes(rawSpec, rule.to)) continue
    // An upper bound has no floor to raise: one that admits the target (`<6.0.0`) stays as written,
    // in every field, and is never read as a rollback.
    if (UPPER_BOUND.test(rawSpec) && specIncludes(rawSpec, rule.to)) continue
    const next = rewriteVersionSpec(rawSpec, rule.to, exact && !peer)
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
      downgrades.push({ field, name: key, from: rawSpec, to: next })
      continue
    }
    // Replace exactly `"key"<ws>:<ws>"spec"` inside this field's object, preserving the whitespace. A
    // nested `overrides` entry repeated with the same spec maps the same way, so every one is replaced.
    const range = objectRangeAt(out, path)
    if (range === undefined) continue
    const pattern = new RegExp(`("${escapeRegExp(key)}"\\s*:\\s*")${escapeRegExp(rawSpec)}(")`, "g")
    const body = out.slice(range.start, range.end)
    const replaced = body.replace(pattern, `$1${next}$2`)
    if (replaced !== body) {
      out = out.slice(0, range.start) + replaced + out.slice(range.end)
      changes.push({ field, name: key, from: rawSpec, to: next })
    }
  }
  return { text: out, changes, downgrades }
}

/** Where a package manager forces one version over every range: npm and Bun `overrides` (nested by
 * parent), Yarn and Bun `resolutions`, pnpm `pnpm.overrides`. */
const OVERRIDE_FIELDS: readonly (readonly string[])[] = [
  ["overrides"],
  ["resolutions"],
  ["pnpm", "overrides"],
]

/**
 * The package an override key pins: `@nifrajs/core`, `parent/@nifrajs/core` and the same behind a `**`
 * glob (resolutions), `parent>@nifrajs/core` and `@nifrajs/core@<4` (pnpm).
 */
function overrideTarget(key: string): string {
  const last = key.slice(key.lastIndexOf(">") + 1)
  return /(?:^|\/)((?:@[^/@]+\/)?[^/@]+)(?:@[^/]*)?$/.exec(last)?.[1] ?? last
}

/** Every string version spec a package.json declares for a package, with the field path it sits in. */
function pinEntries(
  parsed: Record<string, unknown>,
): Array<{ path: readonly string[]; key: string; target: string; spec: string }> {
  const entries: Array<{ path: readonly string[]; key: string; target: string; spec: string }> = []
  for (const field of DEP_FIELDS) {
    const deps = parsed[field]
    if (typeof deps !== "object" || deps === null) continue
    for (const [name, spec] of Object.entries(deps))
      if (typeof spec === "string") entries.push({ path: [field], key: name, target: name, spec })
  }
  for (const path of OVERRIDE_FIELDS) {
    let value: unknown = parsed
    for (const key of path)
      value = typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined
    // npm nests an override under the package whose dependency it pins; `.` pins that package itself.
    const walk = (object: object, parent: string | undefined): void => {
      for (const [key, spec] of Object.entries(object)) {
        const target = key === "." ? parent : overrideTarget(key)
        if (typeof spec === "string" && target !== undefined)
          entries.push({ path, key, target, spec })
        else if (typeof spec === "object" && spec !== null && !Array.isArray(spec))
          walk(spec, target)
      }
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) walk(value, undefined)
  }
  return entries
}

/** The body (between the braces) of the object at `path` in a JSON text: top-level key first, then
 * each nested one, never a same-named key deeper in the document. */
function objectRangeAt(
  text: string,
  path: readonly string[],
): { start: number; end: number } | undefined {
  const rootOpen = text.indexOf("{")
  if (rootOpen === -1) return undefined
  let range: { start: number; end: number } | undefined = {
    start: rootOpen + 1,
    end: closingBrace(text, rootOpen),
  }
  for (const key of path) {
    if (range === undefined) return undefined
    range = memberObjectRange(text, range, key)
  }
  return range
}

/** The index of the `"` that closes the string opening at `open`. */
function stringEnd(text: string, open: number): number {
  for (let index = open + 1; index < text.length; index++) {
    if (text[index] === "\\") index++
    else if (text[index] === '"') return index
  }
  return text.length
}

/** The index of the brace that closes the one at `open`. */
function closingBrace(text: string, open: number): number {
  let depth = 0
  for (let index = open; index < text.length; index++) {
    const char = text[index]
    if (char === '"') index = stringEnd(text, index)
    else if (char === "{" || char === "[") depth++
    else if ((char === "}" || char === "]") && --depth === 0) return index
  }
  return text.length
}

/** The body of `key`'s object value among the direct members of the object body `within`. */
function memberObjectRange(
  text: string,
  within: { start: number; end: number },
  key: string,
): { start: number; end: number } | undefined {
  let depth = 0
  for (let index = within.start; index < within.end; index++) {
    const char = text[index]
    if (char === "{" || char === "[") depth++
    else if (char === "}" || char === "]") depth--
    else if (char === '"') {
      const close = stringEnd(text, index)
      let after = close + 1
      while (/\s/.test(text[after] ?? "")) after++
      if (depth === 0 && text[after] === ":" && text.slice(index + 1, close) === key) {
        after++
        while (/\s/.test(text[after] ?? "")) after++
        return text[after] === "{"
          ? { start: after + 1, end: closingBrace(text, after) }
          : undefined
      }
      index = close
    }
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
  const range = objectRangeAt(text, [field])
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
    while (/\s/.test(body[after] ?? "")) after++
    if (body[after] === ",") {
      end = after + 1
    } else {
      let before = start - 1
      while (before >= 0 && /\s/.test(body[before] ?? "")) before--
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
  exact = false,
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
      const movedVersion = rewriteVersionSpec(fromVersion, move.toVersion, exact) ?? fromVersion
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
  // The edit is textual; a result that no longer parses is never written.
  try {
    JSON.parse(out)
  } catch {
    return { text, changes: [] }
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
const IGNORED_DIRECTORIES = new Set(["node_modules", "dist", "build", ".git", "coverage", ".next"])

// Any directory on the path counts, the top-level one included (`dist/index.js`). Bun's glob yields
// `dist\index.js` on Windows.
const isIgnored = (path: string): boolean =>
  path
    .split(/[\\/]/)
    .slice(0, -1)
    .some((segment) => IGNORED_DIRECTORIES.has(segment))

function scan(cwd: string, pattern: string, dot = false): string[] {
  const glob = new Glob(pattern)
  const out: string[] = []
  // The write boundary: a symlinked file or directory (a linked repository) is never yielded, so the
  // upgrade can only edit files that live under `cwd`.
  for (const path of glob.scanSync({ cwd, dot, followSymlinks: false })) {
    if (!isIgnored(path)) out.push(path.replaceAll("\\", "/"))
  }
  return out.sort() // deterministic order
}

// The fixed version group: every package released together at one version.
export const isFixedGroup = (name: string): boolean =>
  name.startsWith("@nifrajs/") || name === "nifra" || name === "create-nifra"

const groupPins = (version: string): UpgradeRecipe["pins"] => [
  { match: "@nifrajs/", to: version },
  { match: "create-nifra", to: version },
  { match: "nifra", to: version },
]

/** Every fixed-group package a package.json under `cwd` names, whatever its spec. */
export function groupDeclaredNames(cwd: string): ReadonlySet<string> {
  const names = new Set<string>()
  for (const rel of scan(cwd, "**/package.json")) {
    try {
      const parsed = JSON.parse(readFileSync(join(cwd, rel), "utf8")) as Record<string, unknown>
      for (const { target } of pinEntries(parsed)) if (isFixedGroup(target)) names.add(target)
    } catch {
      // Not JSON: it declares nothing.
    }
  }
  return names
}

/**
 * Every fixed-group version the package.json files under `cwd` declare with a plain semver spec, each
 * with the files that declare it. An override counts: it decides what installs. A peer range does
 * not (`>=3.1.0` names a floor a library accepts, not a version anything loads), and `workspace:`,
 * `link:` and other non-semver specs are not versions.
 */
export function groupPinVersions(cwd: string): ReadonlyMap<string, readonly string[]> {
  return groupSpecVersions(cwd, false)
}

function groupSpecVersions(cwd: string, peers: boolean): Map<string, string[]> {
  const versions = new Map<string, string[]>()
  for (const rel of scan(cwd, "**/package.json")) {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(readFileSync(join(cwd, rel), "utf8")) as Record<string, unknown>
    } catch {
      continue
    }
    for (const { path, target, spec } of pinEntries(parsed)) {
      if (!isFixedGroup(target) || (path[0] === PEER_FIELD) !== peers) continue
      const version = specVersion(spec)
      if (version === null) continue
      const files = versions.get(version) ?? []
      if (!files.includes(rel)) files.push(rel)
      versions.set(version, files)
    }
  }
  return versions
}

/** A fixed-group version spelled outside package.json, which the upgrade lists and never edits. */
export interface StrayPin {
  readonly file: string
  readonly line: number
  /** As written: `@nifrajs/cli@3.1.0`. */
  readonly pin: string
  /** A lockfile other than the workspace's own: regenerate it. Listed once, with its other stale pins
   * counted in `more`. */
  readonly lockfile: boolean
  readonly more: number
}

const STRAY_PIN_FILES = [
  "**/{.mcp.json,mcp.json}",
  "**/{AGENTS.md,CLAUDE.md}",
  "**/{Dockerfile,Dockerfile.*,*.Dockerfile,*.dockerfile,Containerfile}",
  "**/{docker-compose,compose}*.{yml,yaml}",
  ".github/workflows/*.{yml,yaml}",
  ".gitlab-ci.yml",
  "**/*.lock",
  "**/{package-lock.json,pnpm-lock.yaml}",
]
const LOCKFILE = /(?:\.lock|package-lock\.json|pnpm-lock\.yaml)$/
const GROUP_PIN =
  /(?<![\w.@/-])(@nifrajs\/[a-z0-9._-]+|create-nifra|nifra)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g

/**
 * Fixed-group versions other than `version` pinned where `nifra upgrade` does not edit: MCP configs and
 * agent guidance beyond the launch pin it moves, container files, CI workflows, and lockfiles besides
 * the workspace's own (which install rewrites). `planned` holds a file's text after the upgrade's own
 * edits, so a dry run lists what `--write` would leave.
 */
export function strayPins(
  cwd: string,
  version: string,
  planned: ReadonlyMap<string, string> = new Map(),
): StrayPin[] {
  const found: StrayPin[] = []
  const files = new Set(STRAY_PIN_FILES.flatMap((pattern) => scan(cwd, pattern, true)))
  for (const rel of [...files].sort()) {
    const lockfile = LOCKFILE.test(rel)
    if (lockfile && !/[\\/]/.test(rel)) continue
    let text: string
    try {
      if (statSync(join(cwd, rel)).size > 8_000_000) continue
      text = planned.get(rel) ?? readFileSync(join(cwd, rel), "utf8")
    } catch {
      continue
    }
    const stale = [...text.matchAll(GROUP_PIN)].filter(
      (match) => compareSemverSpec(match[2] ?? "", version) !== 0,
    )
    const site = (match: RegExpMatchArray, more: number): StrayPin => ({
      file: rel,
      line: text.slice(0, match.index ?? 0).split("\n").length,
      pin: match[0],
      lockfile,
      more,
    })
    const first = stale[0]
    if (first === undefined) continue
    if (lockfile) found.push(site(first, stale.length - 1))
    else for (const match of stale) found.push(site(match, 0))
  }
  return found
}

/** Whether `rel` is a regular file under `cwd` reached through no symlink: the upgrade's write boundary. */
function plainFileAt(cwd: string, rel: string): boolean {
  let path = cwd
  const parts = rel.split("/")
  for (const [index, part] of parts.entries()) {
    path = join(path, part)
    let stat: ReturnType<typeof lstatSync>
    try {
      stat = lstatSync(path)
    } catch {
      return false
    }
    if (stat.isSymbolicLink()) return false
    if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) return false
  }
  return true
}

/**
 * The MCP launch pin in each agent file at `cwd`, and in each file above it whose launches all serve
 * it ({@link ancestorPins}), moved to `version`: the files and the edit of `nifra init-agents
 * --sync-mcp`, so an agent launches the nifra the project installs once it does.
 */
function agentPinEdits(
  cwd: string,
  version: string,
  above: readonly AncestorPinSite[],
): Array<{ readonly change: AgentPinChange; readonly text: string; readonly abs: string }> {
  const target = declaresCli(cwd) ? null : version
  const edits: Array<{ change: AgentPinChange; text: string; abs: string }> = []
  const sites = [
    ...PIN_SITES.map((site) => ({ dir: cwd, file: site.path, path: site.path, site })),
    ...above.map((entry) => ({ ...entry, file: entry.site.path })),
  ]
  for (const { dir, file, path, site } of sites) {
    if (!plainFileAt(dir, file)) continue
    const abs = join(dir, file)
    // A launch above the project runs from that directory, which need not see the install: it stays pinned.
    const to = dir === cwd ? target : version
    // latin1 is one char per byte, so every byte outside a pin is written back as it was.
    const scan = site.repin(readFileSync(abs, "latin1"), to)
    if (scan.stale.length === 0) continue
    edits.push({
      change: { file: path, from: scan.stale, to: to ?? "unpinned" },
      text: scan.text,
      abs,
    })
  }
  return edits
}

/** An installed fixed-group package, followed to its real location. */
export interface LinkedGroupInstall {
  readonly package: string
  readonly path: string
  readonly version: string
}

const packageVersionAt = (dir: string): string | undefined => {
  try {
    const meta: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
    const version = Reflect.get(Object(meta), "version")
    return typeof version === "string" && version.length > 0 ? version : undefined
  } catch {
    return undefined
  }
}

/** A repository linked into the project that resolves nifra from its own `node_modules`. */
export interface LinkedSkew {
  /** The dependency's name, as the manifest declares it. */
  readonly package: string
  /** The project-relative manifest that declares it. */
  readonly declaredIn: string
  /** The linked repository's real path. */
  readonly path: string
  /** Each fixed-group package it installs itself, at a version other than the target. */
  readonly installs: readonly { readonly package: string; readonly version: string }[]
}

/**
 * Every `link:` or `file:` dependency whose installed folder resolves outside `cwd` and installs a
 * fixed-group package of its own at a version other than `target`. Its imports resolve from its real
 * path, so it keeps loading that copy after this project upgrades: a `server()` it builds can no longer
 * be merged here, and single-copy never redirects across versions. A copy that resolves back inside
 * `cwd` follows this project's install and is not counted.
 */
export function linkedSkew(cwd: string, target: string): readonly LinkedSkew[] {
  let root: string
  try {
    root = realpathSync(cwd)
  } catch {
    root = cwd
  }
  const inside = (path: string): boolean => path === root || path.startsWith(root + sep)
  const seen = new Set<string>()
  const found: LinkedSkew[] = []
  for (const rel of scan(cwd, "**/package.json")) {
    let manifest: unknown
    try {
      manifest = JSON.parse(readFileSync(join(cwd, rel), "utf8"))
    } catch {
      continue
    }
    for (const field of DEP_FIELDS) {
      const block: unknown = Reflect.get(Object(manifest), field)
      if (typeof block !== "object" || block === null) continue
      for (const [name, spec] of Object.entries(block)) {
        if (typeof spec !== "string" || !/^(?:link|file):/.test(spec)) continue
        let path: string | undefined
        for (const base of [join(cwd, dirname(rel)), cwd]) {
          try {
            path = realpathSync(join(base, "node_modules", name))
            break
          } catch {
            // Not installed beside this manifest: try the root's node_modules.
          }
        }
        if (path === undefined || inside(path) || seen.has(path)) continue
        seen.add(path)
        const installs = installedGroupPackages(path)
          .filter((entry) => !inside(entry.path) && entry.version !== target)
          .map((entry) => ({ package: entry.package, version: entry.version }))
        if (installs.length > 0) found.push({ package: name, declaredIn: rel, path, installs })
      }
    }
  }
  return found
}

/**
 * Every fixed-group package installed in `cwd/node_modules`, realpath-resolved so a linked repository
 * reports its own version. `inside` is false for one that resolves outside the workspace root.
 */
export function installedGroupPackages(
  cwd: string,
): readonly (LinkedGroupInstall & { readonly inside: boolean })[] {
  const modules = join(cwd, "node_modules")
  const names = ["nifra", "create-nifra"].filter((name) => existsSync(join(modules, name)))
  try {
    for (const name of readdirSync(join(modules, "@nifrajs"))) names.push(`@nifrajs/${name}`)
  } catch {
    // No scoped installs.
  }
  let root: string
  try {
    root = realpathSync(cwd)
  } catch {
    root = cwd
  }
  const found: (LinkedGroupInstall & { inside: boolean })[] = []
  for (const name of names) {
    let path: string
    try {
      path = realpathSync(join(modules, name))
    } catch {
      continue
    }
    const version = packageVersionAt(path)
    if (version === undefined) continue
    found.push({
      package: name,
      path,
      version,
      inside: path === root || path.startsWith(root + sep),
    })
  }
  return found
}

/**
 * The version the workspace upgrades from: the lowest fixed-group version any package.json under
 * `cwd` pins ({@link groupPinVersions}), since recipes newer than it still have edits to make
 * somewhere. Without a pin, the lowest one installed inside the root, then the lowest peer floor;
 * null when none names one.
 */
export function installedGroupVersion(cwd: string): string | null {
  const lowest = (versions: Iterable<string>): string | null => {
    let found: string | null = null
    for (const version of versions)
      if (found === null || compareSemverSpec(version, found) < 0) found = version
    return found
  }
  return (
    lowest(groupPinVersions(cwd).keys()) ??
    lowest(
      installedGroupPackages(cwd)
        .filter((entry) => entry.inside)
        .map((entry) => entry.version),
    ) ??
    lowest(groupSpecVersions(cwd, true).keys())
  )
}

/** One recipe that applies every release recipe after `installed` up to `target`, oldest first. */
export interface ChainedRecipe extends UpgradeRecipe {
  /** The release recipes it applies, oldest first. */
  readonly steps: readonly string[]
}

/**
 * Chain the recipes after `installed` (exclusive) up to `target` (inclusive): their dependency and
 * import moves in release order, their notes labeled by release, and the fixed group pinned to
 * `target`. Without a known installed version only the target's own recipe applies.
 */
export function chainRecipes(target: string, installed: string | null): ChainedRecipe {
  const steps =
    installed === null
      ? getRecipe(target) === undefined
        ? []
        : [target]
      : listRecipeVersions().filter(
          (version) =>
            compareSemverSpec(version, installed) > 0 && compareSemverSpec(version, target) <= 0,
        )
  const recipes = steps.flatMap((version) => getRecipe(version) ?? [])
  // A later rule for the same match replaces an earlier one; the target's pins win last.
  const pins = new Map<string, string>()
  for (const recipe of recipes) for (const rule of recipe.pins) pins.set(rule.match, rule.to)
  for (const rule of getRecipe(target)?.pins ?? groupPins(target)) pins.set(rule.match, rule.to)
  return {
    version: target,
    steps,
    pins: [...pins].map(([match, to]) => ({ match, to })),
    dependencyMoves: recipes.flatMap((recipe) => recipe.dependencyMoves ?? []),
    importMoves: recipes.flatMap((recipe) => recipe.importMoves),
    retiredMarkers: recipes.flatMap((recipe) => recipe.retiredMarkers ?? []),
    notes: recipes.flatMap((recipe) =>
      (recipe.notes ?? []).map((note) => `${recipe.version}: ${note}`),
    ),
  }
}

/** Compute the plan (and, when `write`, apply it) for a target recipe against `cwd`. */
export function computeUpgrade(
  cwd: string,
  recipe: UpgradeRecipe,
  write: boolean,
  allowDowngrade = false,
  exact = false,
  above: readonly AncestorPinSite[] = [],
): UpgradePlan {
  const pins: PinChange[] = []
  const agentPins: AgentPinChange[] = []
  const planned = new Map<string, string>()
  const dependencyMoves: DependencyMoveChange[] = []
  const importMoves: ImportChange[] = []
  const downgrades: PinChange[] = []
  const retiredMarkers: RetiredMarkerSite[] = []
  const linkedOutside = installedGroupPackages(cwd)
    .filter((entry) => !entry.inside && entry.version !== recipe.version)
    .map(({ package: name, path, version }) => ({ package: name, path, version }))

  const manifests = new Map<string, string>()
  if ((recipe.dependencyMoves?.length ?? 0) > 0 || recipe.pins.length > 0) {
    for (const rel of scan(cwd, "**/package.json")) {
      const abs = join(cwd, rel)
      const original = readFileSync(abs, "utf8")
      const moved = moveDependenciesText(original, recipe.dependencyMoves ?? [], exact)
      for (const change of moved.changes) dependencyMoves.push({ file: rel, ...change })
      const pinned = pinSweepText(moved.text, recipe.pins, allowDowngrade, exact)
      for (const change of pinned.changes) pins.push({ file: rel, ...change })
      for (const d of pinned.downgrades) downgrades.push({ file: rel, ...d })
      if (pinned.text !== original) manifests.set(resolve(abs), pinned.text)
      if (write && pinned.text !== original) writeFileSync(abs, pinned.text)
    }
  }

  // Read against the manifests as this upgrade leaves them, so a dry run lists what --write drops.
  const linkLocks = plainFileAt(cwd, BUN_LOCK) ? staleLinkLocks(resolve(cwd), manifests) : []
  let lockPruned = false
  if (write && linkLocks.length > 0) {
    const lockPath = join(cwd, BUN_LOCK)
    const pruned = pruneLinkLocks(
      readFileSync(lockPath, "utf8"),
      linkLocks.map((entry) => entry.package),
    )
    if (pruned !== undefined) {
      writeFileSync(lockPath, pruned)
      lockPruned = true
    }
  }

  for (const { change, text, abs } of agentPinEdits(cwd, recipe.version, above)) {
    agentPins.push(change)
    planned.set(change.file, text)
    if (write) writeFileSync(abs, Buffer.from(text, "latin1"))
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

  // Read after the import moves, so a listed line number is the one the file has after `--write`.
  const retired = recipe.retiredMarkers ?? []
  if (retired.length > 0) {
    for (const rel of scan(cwd, SOURCE_GLOB)) {
      const text = readFileSync(join(cwd, rel), "utf8")
      if (!retired.some(({ marker }) => text.includes(marker))) continue
      const lines = text.split("\n")
      for (let line = 1; line <= lines.length; line++) {
        for (const { marker, instead } of retired) {
          if (!(lines[line - 1] ?? "").includes(marker)) continue
          const target = markerTarget(lines, line)
          const covers =
            target === undefined
              ? undefined
              : { line: target, text: (lines[target - 1] ?? "").trim() }
          retiredMarkers.push({ file: rel, line, marker, covers, instead })
        }
      }
    }
  }

  return {
    version: recipe.version,
    pins,
    agentPins,
    dependencyMoves,
    importMoves,
    downgrades,
    retiredMarkers,
    linkedOutside,
    linkedSkew: linkedSkew(cwd, recipe.version),
    strayPins: strayPins(cwd, recipe.version, planned),
    linkLocks,
    lockPruned,
    notes: recipe.notes ?? [],
  }
}

function renderPlan(
  plan: UpgradePlan,
  write: boolean,
  from: string | null,
  steps: readonly string[],
): string {
  const lines: string[] = []
  const verb = write ? "Applied" : "Planned"
  lines.push(`nifra upgrade → ${plan.version}  (${write ? "write" : "dry-run"})`)
  if (from !== null) {
    lines.push(
      steps.length === 0
        ? `From ${from}; no release recipe in between.`
        : `From ${from}, applying the ${steps.join(", ")} recipe${steps.length === 1 ? "" : "s"}.`,
    )
  }
  lines.push("")
  if (
    plan.pins.length === 0 &&
    plan.agentPins.length === 0 &&
    plan.dependencyMoves.length === 0 &&
    plan.importMoves.length === 0 &&
    plan.retiredMarkers.length === 0 &&
    plan.linkedOutside.length === 0 &&
    plan.linkedSkew.length === 0 &&
    plan.strayPins.length === 0 &&
    plan.linkLocks.length === 0
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
  if (plan.agentPins.length > 0) {
    lines.push(`${verb} ${plan.agentPins.length} MCP launch pin(s):`)
    for (const p of plan.agentPins)
      lines.push(`  ${p.file}  @nifrajs/cli: ${p.from.join(", ")} → ${p.to}`)
    if (write) lines.push("  Restart your agent so it launches the new nifra MCP server.")
    lines.push("")
  }
  if (plan.importMoves.length > 0) {
    const total = plan.importMoves.reduce((n, m) => n + m.count, 0)
    lines.push(`${verb} ${total} import move(s) across ${plan.importMoves.length} file(s):`)
    for (const m of plan.importMoves) lines.push(`  ${m.file}  ${m.from} → ${m.to}  (${m.count})`)
    lines.push("")
  }
  if (plan.retiredMarkers.length > 0) {
    lines.push(
      `${plan.retiredMarkers.length} retired comment(s) that silence nothing now; nifra check reports what each covered:`,
    )
    for (const site of plan.retiredMarkers) {
      const covers =
        site.covers === undefined
          ? "covers no line"
          : `covers line ${site.covers.line}: ${site.covers.text}`
      lines.push(`  ${site.file}:${site.line}  ${site.marker}  ${covers}`)
      lines.push(`    write instead: ${site.instead}`)
    }
    lines.push("")
  }
  if (plan.linkedOutside.length > 0) {
    lines.push(
      "Left alone, linked from outside the workspace root (upgrade that repository on its own):",
    )
    for (const entry of plan.linkedOutside)
      lines.push(`  ${entry.package} ${entry.version} at ${entry.path}`)
    lines.push("")
  }
  const pinned = plan.strayPins.filter((site) => !site.lockfile)
  if (pinned.length > 0) {
    lines.push(`Left alone, another version pinned outside package.json (update by hand):`)
    for (const site of pinned) lines.push(`  ${site.file}:${site.line}  ${site.pin}`)
    lines.push("")
  }
  const locks = plan.strayPins.filter((site) => site.lockfile)
  if (locks.length > 0) {
    lines.push(
      `Left alone, a lockfile besides the workspace's own (regenerate it after installing):`,
    )
    for (const site of locks) {
      const more = site.more === 0 ? "" : ` and ${site.more} more`
      lines.push(`  ${site.file}:${site.line}  ${site.pin}${more}`)
    }
    lines.push("")
  }
  if (plan.linkLocks.length > 0) {
    lines.push(
      plan.lockPruned
        ? `Dropped ${plan.linkLocks.length} file: package(s) from bun.lock, whose recorded dependencies Bun never refreshes; \`bun install\` reads each linked package.json again:`
        : write
          ? `bun.lock records stale dependencies for ${plan.linkLocks.length} file: package(s), which Bun never refreshes; run \`${linkLockUpdate(plan.linkLocks)}\`:`
          : `bun.lock records stale dependencies for ${plan.linkLocks.length} file: package(s), which Bun never refreshes; --write drops them so \`bun install\` reads each linked package.json again:`,
    )
    for (const entry of plan.linkLocks)
      lines.push(
        `  ${entry.package} (file:${entry.path})  ${entry.changes.map(describeChange).join(", ")}`,
      )
    if (plan.lockPruned)
      lines.push(
        "  Run `bun install` before committing bun.lock: until it records these packages again, `bun install --frozen-lockfile` fails.",
      )
    lines.push("")
  }
  for (const note of plan.notes) lines.push(`note: ${note}`)
  if (!write) lines.push("\nRe-run with --write to apply, then install and run nifra check.")
  return lines.join("\n").trimEnd()
}

/** Explain a refused rollback: which pins would roll back, why it's blocked, and the escape hatch. */
/** The linked repositories to upgrade first, each with the commands that move it to `version`. */
function renderLinkedSkew(
  version: string,
  skew: readonly LinkedSkew[],
  cwd: string,
  allowed: boolean,
): string {
  const lines = [
    `${allowed ? "Allowed by --allow-linked-skew" : "Blocked"}: ${skew.length} linked repositor${skew.length === 1 ? "y loads" : "ies load"} its own nifra at another version. Its imports resolve from its own node_modules, so after this upgrade a server() it builds cannot be merge()d here ("merge() requires a server() from this copy of @nifrajs/core").`,
  ]
  for (const entry of skew) {
    const at = relative(cwd, entry.path).split(sep).join("/") || "."
    lines.push(
      `  ${entry.package} (${entry.declaredIn}) at ${at}: ${entry.installs.map((install) => `${install.package} ${install.version}`).join(", ")}`,
      `    cd ${at} && nifra upgrade ${version} --write && bun install`,
    )
  }
  if (!allowed)
    lines.push(
      "Upgrade each one first, then run this again. --allow-linked-skew upgrades this project anyway.",
    )
  return lines.join("\n")
}

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

/** The hook report around `--write`: the diff and where the pre-upgrade report was saved, or why not.
 * `install` means the edits are not installed yet, so only the pre-upgrade report was taken. */
export type UpgradeHookScope =
  | { readonly saved: string; readonly changes: readonly HookReportChange[] }
  | { readonly saved: string; readonly pending: "install" }
  | { readonly error: string; readonly saved?: string }

/** The edits `--write` made that the installed packages do not reflect yet. */
export interface PendingInstall {
  /** The command that installs them, by the lockfile the project keeps. */
  readonly command: string
  /** Fixed-group packages installed inside the root at a version other than the target. */
  readonly installed: readonly { readonly package: string; readonly version: string }[]
}

const INSTALL_COMMANDS: readonly (readonly [lockfile: string, command: string])[] = [
  ["pnpm-lock.yaml", "pnpm install"],
  ["yarn.lock", "yarn install"],
  ["package-lock.json", "npm install"],
]

/**
 * Whether the project needs an install before a check can judge the target: `--write` changed what
 * package.json declares or what bun.lock records, or node_modules holds a group package at another
 * version. A link from outside the root is left out; installing here does not move it.
 */
export function pendingInstall(cwd: string, plan: UpgradePlan): PendingInstall | undefined {
  const installed = installedGroupPackages(cwd)
    .filter((entry) => entry.inside && entry.version !== plan.version)
    .map(({ package: name, version }) => ({ package: name, version }))
  const edited = plan.pins.length > 0 || plan.dependencyMoves.length > 0 || plan.lockPruned
  if (!edited && installed.length === 0) return undefined
  const command =
    INSTALL_COMMANDS.find(([lockfile]) => existsSync(join(cwd, lockfile)))?.[1] ?? "bun install"
  return { command, installed }
}

const SHOWN_INSTALLS = 3

function renderPendingInstall(pending: PendingInstall, version: string): string {
  const shown = pending.installed
    .slice(0, SHOWN_INSTALLS)
    .map((entry) => `${entry.package} ${entry.version}`)
  const more = pending.installed.length - shown.length
  const holds =
    shown.length === 0
      ? "the edited pins are not installed yet"
      : `node_modules still holds ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`
  return [
    `Not checked yet: \`nifra check\` reads the installed packages, and ${holds}, so it would judge the release this upgrade leaves rather than ${version}. Install, then check:`,
    `  ${pending.command}`,
    "  nifra check",
  ].join("\n")
}

async function hookReportBefore(cwd: string): Promise<ReflectedHookReport | { error: string }> {
  try {
    const { loadBackendApp } = await import("./load.ts")
    const { backend } = await loadBackendApp(cwd)
    return await collectHookReport(backend)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** The report after the edits, from a fresh process: the edited sources must not come from this one's
 * module cache. Saves the pre-upgrade report for `nifra routes --hooks --since` after an install.
 * While the edits are not installed, the old release would load in its place, so none is taken. */
async function hookScopeAcross(
  cwd: string,
  before: ReflectedHookReport | { error: string },
  installed: boolean,
): Promise<UpgradeHookScope> {
  if ("error" in before) return { error: before.error }
  const saved = join(cwd, HOOKS_BEFORE_UPGRADE_FILE)
  mkdirSync(dirname(saved), { recursive: true })
  writeFileSync(saved, `${JSON.stringify(before, null, 2)}\n`)
  if (!installed) return { saved: HOOKS_BEFORE_UPGRADE_FILE, pending: "install" }
  const entry = fileURLToPath(
    new URL(import.meta.url.endsWith(".ts") ? "./cli.ts" : "./cli.js", import.meta.url),
  )
  const child = Bun.spawn([process.execPath, entry, "routes", "--hooks", "--json"], {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [text, , code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const after = parseHookReport(text)
  if (after === undefined) {
    return {
      error: `\`nifra routes --hooks\` exited ${code} after the edits`,
      saved: HOOKS_BEFORE_UPGRADE_FILE,
    }
  }
  return { saved: HOOKS_BEFORE_UPGRADE_FILE, changes: diffHookReports(before, after) }
}

function renderHookScope(scope: UpgradeHookScope): string {
  const since = (saved: string): string[] => [
    "The new release's hooks run once its packages are installed. After installing, compare against the report saved before the edits:",
    `  nifra routes --hooks --since ${saved}`,
  ]
  if ("error" in scope) {
    const head = `Hook scope: not captured (${scope.error}).`
    return scope.saved === undefined ? head : [head, ...since(scope.saved)].join("\n")
  }
  if ("pending" in scope) return since(scope.saved).join("\n")
  return [
    "Hook scope across the edits (nifra routes --hooks):",
    renderHookDiff(scope.changes)
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
    ...since(scope.saved),
  ].join("\n")
}

/** The targets this CLI applies: each release recipe up to its own version, and that version. */
export function upgradeTargets(cliVersion: string): string[] {
  const versions = listRecipeVersions().filter(
    (version) => compareSemverSpec(version, cliVersion) <= 0,
  )
  if (!versions.includes(cliVersion)) versions.push(cliVersion)
  return versions.sort(compareSemverSpec)
}

/** Each target with the notes of every release after the installed one: what an app can observe
 * changing on the way up. Older releases are listed by version only. */
function renderUpgradeList(
  targets: readonly string[],
  installed: string | null,
  notes: Readonly<Record<string, readonly string[]>>,
): string {
  const lines = [
    installed === null
      ? "available upgrade targets:"
      : `available upgrade targets (this project declares ${installed}):`,
  ]
  for (const version of targets) {
    const ahead = installed === null || compareSemverSpec(version, installed) > 0
    lines.push(`  ${version}${version === installed ? "  (declared)" : ""}`)
    if (!ahead) continue
    const list = notes[version] ?? []
    if (list.length === 0) lines.push("    no change an app can observe")
    for (const note of list) lines.push(`    - ${note}`)
  }
  lines.push(
    "",
    "A newer release upgrades with its own CLI: bunx @nifrajs/cli@<version> upgrade <version>",
  )
  return lines.join("\n")
}

/** The command that runs `version`'s own CLI with the same flags. `version` is a validated release. */
function newerCliCommand(version: string, options: UpgradeOptions): string {
  const flags = [
    options.write === true ? "--write" : "",
    options.exact === true ? "--exact" : "",
    options.allowDowngrade === true ? "--allow-downgrade" : "",
    options.verify === false ? "--no-verify" : "",
    options.hooks === false ? "--no-hooks" : "",
    options.json === true ? "--json" : "",
  ].filter((flag) => flag !== "")
  return ["bunx", `@nifrajs/cli@${version}`, "upgrade", version, ...flags].join(" ")
}

/** CLI entry. Returns false (→ non-zero exit) on an unknown version, no project, or a failed verify. */
export async function runUpgrade(cwd: string, options: UpgradeOptions): Promise<boolean> {
  const cliVersion = options.cliVersion ?? listRecipeVersions().at(-1) ?? "0.0.0"
  const targets = upgradeTargets(cliVersion)
  if (options.list) {
    const installed = installedGroupVersion(cwd)
    const notes = Object.fromEntries(targets.map((v) => [v, getRecipe(v)?.notes ?? []]))
    if (options.json)
      console.log(JSON.stringify({ versions: targets, cliVersion, installed, notes }, null, 2))
    else console.log(renderUpgradeList(targets, installed, notes))
    return true
  }

  const { version } = options
  if (version === undefined) {
    console.error(
      `[nifra] upgrade needs a target version, e.g. \`nifra upgrade ${cliVersion}\` (or --list)`,
    )
    return false
  }
  if (!RELEASE_VERSION.test(version)) {
    console.error(`[nifra] ${JSON.stringify(version)} is not a release version, e.g. ${cliVersion}`)
    return false
  }
  if (compareSemverSpec(version, cliVersion) > 0) {
    // Recipes ship with the CLI: only the target release's CLI knows every recipe up to it. Print its
    // command rather than downloading and running code on the user's behalf.
    const command = newerCliCommand(version, options)
    if (options.json) {
      console.log(
        JSON.stringify({ version, cliVersion, refused: "newer-than-cli", command }, null, 2),
      )
    } else {
      console.error(
        `nifra upgrade → ${version}: this CLI is ${cliVersion} and carries the recipes up to it.\n` +
          `Run the ${version} CLI, which carries every recipe up to ${version}:\n\n  ${command}`,
      )
    }
    return false
  }
  if (!targets.includes(version)) {
    console.error(
      `[nifra] no upgrade recipe for ${version}. This CLI upgrades to: ${targets.join(", ")}. ` +
        `For ${version} itself, run: ${newerCliCommand(version, options)}`,
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
  const exact = options.exact === true
  const from = installedGroupVersion(cwd)
  const recipe = chainRecipes(version, from)

  // Fail-closed on rollback: a dry pass writes nothing, so we can refuse before any package.json is touched.
  const above = (await ancestorPins(cwd)).owned
  const preview = computeUpgrade(cwd, recipe, false, allowDowngrade, exact, above)
  if (preview.downgrades.length > 0) {
    if (options.json) {
      console.log(
        JSON.stringify(
          { ...preview, from, steps: recipe.steps, write: false, refused: "downgrade" },
          null,
          2,
        ),
      )
    } else {
      console.error(renderDowngradeRefusal(recipe.version, preview.downgrades))
    }
    return false
  }
  // Refused before anything is written: the linked repository fails at the first merge(), not here.
  if (preview.linkedSkew.length > 0 && options.allowLinkedSkew !== true) {
    if (options.json) {
      console.log(
        JSON.stringify(
          { ...preview, from, steps: recipe.steps, write: false, refused: "linked-skew" },
          null,
          2,
        ),
      )
    } else {
      if (!write) console.log(renderPlan(preview, false, from, recipe.steps))
      console.error(renderLinkedSkew(recipe.version, preview.linkedSkew, cwd, false))
    }
    return false
  }

  const captureHooks = write && options.hooks !== false
  const before = captureHooks ? await hookReportBefore(cwd) : undefined
  const plan = write ? computeUpgrade(cwd, recipe, true, allowDowngrade, exact, above) : preview
  const pending = write ? pendingInstall(cwd, plan) : undefined
  const hooks =
    before === undefined ? undefined : await hookScopeAcross(cwd, before, pending === undefined)

  // Verify only makes sense once edits are on disk and installed. Default on after --write; opt out
  // with --no-verify. An uninstalled upgrade passes, so `upgrade --write && bun install` chains.
  const verify = write && options.verify !== false && pending === undefined
  if (options.json) {
    // The check result rides inside the one JSON document; its human report would break the stream.
    const report: Record<string, unknown> = { ...plan, from, steps: recipe.steps, write }
    if (hooks !== undefined) report.hooks = hooks
    if (pending !== undefined) report.install = pending
    let ok = true
    if (verify) {
      const { collectProjectVerification } = await import("./verification.ts")
      const verification = await collectProjectVerification(cwd, { lintsOnly: false })
      const check = await verification.check()
      report.check = check
      ok = check.ok
    }
    console.log(JSON.stringify(report, null, 2))
    return ok
  }
  console.log(renderPlan(plan, write, from, recipe.steps))
  if (plan.linkedSkew.length > 0)
    console.warn(`\n${renderLinkedSkew(recipe.version, plan.linkedSkew, cwd, true)}`)
  if (hooks !== undefined) console.log(`\n${renderHookScope(hooks)}`)
  if (pending !== undefined && options.verify !== false)
    console.log(`\n${renderPendingInstall(pending, recipe.version)}`)

  if (verify) {
    const { runCheck } = await import("./check.ts")
    const ok = await runCheck(cwd, { json: false })
    if (!ok) {
      console.error("\n[nifra] upgrade applied but `nifra check` failed - review above.")
      return false
    }
  }
  return true
}

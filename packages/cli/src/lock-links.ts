/**
 * A `file:` dependency's own dependencies, as bun.lock records them. Bun records them when it first
 * installs the linked package and does not read its package.json again, so once the linked package
 * moves to another version of a dependency the lock still names the old one and Bun installs a second
 * copy under the linked package. Checked on Bun 1.4.2: `bun install --force` keeps the stale entry;
 * `bun update <name>`, or dropping the entry and its scoped entries before `bun install`, clears it.
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { parseJsonc } from "./internal/project-specifiers.ts"

export const BUN_LOCK = "bun.lock"

/** The fields Bun installs from a linked package's manifest. */
const INSTALLED_FIELDS: readonly string[] = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
]

/** One dependency whose recorded spec is not the one the linked package.json declares now. */
export interface LinkLockChange {
  readonly name: string
  /** As bun.lock recorded it; absent when the linked package added it since. */
  readonly recorded?: string
  /** As the linked package.json declares it; absent when it was removed since. */
  readonly declared?: string
}

/** A `file:` entry of bun.lock whose recorded dependencies the linked package.json no longer declares. */
export interface StaleLinkLock {
  /** The package, as the lock keys it. */
  readonly package: string
  /** The linked directory, as the lock names it relative to the lockfile. */
  readonly path: string
  readonly changes: readonly LinkLockChange[]
}

const recordOf = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {}

const textOf = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

/** A top-level lock key (`name`, `@scope/name`), not a dependency scoped under one (`name/dep`). */
const topLevel = (key: string): boolean =>
  key.startsWith("@") ? key.split("/").length === 2 : !key.includes("/")

/** The directory of the nearest bun.lock at or above `cwd`, up to the repository root. */
export function bunLockDir(cwd: string): string | undefined {
  for (let dir = resolve(cwd); ; ) {
    if (existsSync(join(dir, BUN_LOCK))) return dir
    const parent = dirname(dir)
    if (parent === dir || existsSync(join(dir, ".git"))) return undefined
    dir = parent
  }
}

/**
 * Each `file:` entry of the bun.lock in `dir` whose recorded dependencies differ from what the linked
 * package.json declares. `manifests` (absolute path -> text) stands in for package.json files an edit
 * has planned but not written yet. A lock or manifest that cannot be read reports nothing.
 */
export function staleLinkLocks(
  dir: string,
  manifests: ReadonlyMap<string, string> = new Map(),
): StaleLinkLock[] {
  let lock: unknown
  try {
    lock = parseJsonc(readFileSync(join(dir, BUN_LOCK), "utf8"))
  } catch {
    return []
  }
  const stale: StaleLinkLock[] = []
  for (const [key, entry] of Object.entries(recordOf(Reflect.get(Object(lock), "packages")))) {
    if (!topLevel(key) || !Array.isArray(entry)) continue
    const spec = textOf(entry[0])
    const at = spec?.indexOf("@file:", 1) ?? -1
    if (spec === undefined || at === -1) continue
    const path = spec.slice(at + "@file:".length)
    const manifestPath = resolve(dir, path, "package.json")
    let declared: unknown
    try {
      declared = JSON.parse(manifests.get(manifestPath) ?? readFileSync(manifestPath, "utf8"))
    } catch {
      continue
    }
    const recorded = recordOf(entry[1])
    const changes: LinkLockChange[] = []
    for (const field of INSTALLED_FIELDS) {
      const was = recordOf(recorded[field])
      const now = recordOf(Reflect.get(Object(declared), field))
      for (const name of new Set([...Object.keys(was), ...Object.keys(now)])) {
        const before = textOf(was[name])
        const after = textOf(now[name])
        if (before === after) continue
        const change: { name: string; recorded?: string; declared?: string } = { name }
        if (before !== undefined) change.recorded = before
        if (after !== undefined) change.declared = after
        changes.push(change)
      }
    }
    if (changes.length > 0) stale.push({ package: key, path, changes })
  }
  return stale
}

/** `name 1.0.0 -> 2.0.0`, with `(none)` for a side that does not have it. */
export const describeChange = (change: LinkLockChange): string =>
  `${change.name} ${change.recorded ?? "(none)"} -> ${change.declared ?? "(none)"}`

const ENTRY_KEY = /^ {4}("(?:[^"\\]|\\.)*"): \[/

/**
 * bun.lock text without the `packages` entries of `names` and the dependencies scoped under them,
 * so the next `bun install` reads each linked package.json again. `undefined` unless the text is laid
 * out one entry per line, as Bun writes it, and the result parses to the same lock less those
 * entries: the caller names `bun update` instead.
 */
export function pruneLinkLocks(text: string, names: readonly string[]): string | undefined {
  const lines = text.split("\n")
  const start = lines.findIndex((line) => /^ {2}"packages": \{\s*$/.test(line))
  if (start === -1) return undefined
  const end = lines.findIndex((line, index) => index > start && /^ {2}\}/.test(line))
  if (end === -1) return undefined
  const dropped = (key: string): boolean =>
    names.some((name) => key === name || key.startsWith(`${name}/`))
  const kept = lines.filter((line, index) => {
    if (index <= start || index >= end) return true
    const key = ENTRY_KEY.exec(line)?.[1]
    return key === undefined || !dropped(String(JSON.parse(key)))
  })
  const pruned = kept.join("\n")
  try {
    const before = recordOf(parseJsonc(text))
    const after = recordOf(parseJsonc(pruned))
    const expected = Object.fromEntries(
      Object.entries(recordOf(before.packages)).filter(([key]) => !dropped(key)),
    )
    const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
    if (!same(recordOf(after.packages), expected)) return undefined
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (key !== "packages" && !same(before[key], after[key])) return undefined
    }
  } catch {
    return undefined
  }
  return pruned
}

/** The `bun update` that makes Bun read each linked package.json again. */
export const linkLockUpdate = (entries: readonly StaleLinkLock[]): string =>
  `bun update ${entries.map((entry) => entry.package).join(" ")}`

/** The advisory both `nifra doctor` and `nifra check` print. */
export function staleLinkLockMessage(stale: {
  readonly lock: string
  readonly entries: readonly StaleLinkLock[]
}): string {
  const listed = stale.entries
    .map((entry) => {
      const shown = entry.changes.slice(0, 3).map(describeChange).join(", ")
      const more = entry.changes.length > 3 ? ` and ${entry.changes.length - 3} more` : ""
      return `${entry.package} (file:${entry.path}): ${shown}${more}`
    })
    .join("; ")
  return (
    `${stale.lock} records dependencies its file: packages no longer declare, and Bun never reads a linked package.json again, so it installs those versions beside the declared ones: ${listed}. ` +
    `Run \`${linkLockUpdate(stale.entries)}\`, or \`nifra upgrade --write\` to drop the entries, then \`bun install\`.`
  )
}

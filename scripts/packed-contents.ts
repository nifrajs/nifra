/**
 * What a package tarball holds, read from the tarball itself. The source-tree scans see the files a
 * package directory has; these see the files npm receives, which is where a `files` entry, a missing
 * `.npmignore` line or a build step can add something nobody reviewed.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { codeUnitOrder } from "./code-unit-order.ts"

export interface PackedFile {
  /** The path inside the package, without the tarball's top directory. */
  readonly path: string
  readonly bytes: Uint8Array
}

/** Every file in a `.tgz`, its top directory (`package/`) dropped, in code-unit order. */
export function readTarball(tgz: string): PackedFile[] {
  const dir = mkdtempSync(join(tmpdir(), "nifra-packed-"))
  try {
    const untar = spawnSync("tar", ["-xzf", tgz, "-C", dir], { encoding: "utf8" })
    if (untar.status !== 0) throw new Error(`tar -xzf ${tgz} failed: ${untar.stderr}`)
    const files: PackedFile[] = []
    for (const entry of new Bun.Glob("**/*").scanSync({ cwd: dir, dot: true, onlyFiles: true })) {
      const path = entry.replace(/\\/g, "/")
      files.push({ path: path.slice(path.indexOf("/") + 1), bytes: readFileSync(join(dir, entry)) })
    }
    return files.sort((a, b) => codeUnitOrder(a.path, b.path))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Paths no published package may carry, whatever its `files` field says. */
export const NEVER_SHIPPED: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  {
    // Scaffold templates ship a starter test on purpose; nothing else ships tests.
    pattern: /^(?!template[^/]*\/).*\.(?:test|spec|test-d)\.[cm]?[jt]sx?$/,
    why: "a test file",
  },
  {
    pattern:
      /(?:^|\/)(?:node_modules|coverage|__tests__|\.tmp-[^/]*|\.git|\.private|\.claude|\.planning|\.serena)\//,
    why: "a local, generated or private directory",
  },
  { pattern: /(?:^|\/)\.env(?:\.(?!example$)[^/]*)?$/, why: "an environment file" },
  { pattern: /\.(?:pem|key|p12|pfx|crt|keystore)$/, why: "key material" },
  {
    pattern: /\.(?:log|tgz|bundle|sqlite|db|tsbuildinfo)$/,
    why: "a log, archive, database or build cache",
  },
  { pattern: /(?:^|\/)\.DS_Store$/, why: "OS metadata" },
]

export function neverShipped(paths: readonly string[]): string[] {
  const found: string[] = []
  for (const path of paths) {
    const rule = NEVER_SHIPPED.find(({ pattern }) => pattern.test(path))
    if (rule !== undefined) found.push(`${path}: ${rule.why}`)
  }
  return found
}

// A build that embeds where it ran (a source map's `sources`, an inlined `__dirname`) publishes the
// builder's home directory. That includes `/home/runner/`: releases are built on CI.
const HOME_PATH = /(?:\/Users|\/home)\/[A-Za-z0-9._-]+\//

/** Files holding a private marker or an absolute home-directory path. Markers are never echoed. */
export function contentFindings(
  files: readonly PackedFile[],
  markers: readonly string[],
): string[] {
  const lowered = markers.map((marker) => marker.toLowerCase())
  const decoder = new TextDecoder("utf-8", { fatal: false })
  const found: string[] = []
  for (const file of files) {
    const text = decoder.decode(file.bytes)
    const lower = text.toLowerCase()
    if (lowered.some((marker) => lower.includes(marker)))
      found.push(`${file.path}: private marker present`)
    if (HOME_PATH.test(text)) found.push(`${file.path}: absolute home-directory path`)
  }
  return found
}

/** Markers from `PRIVATE_MARKERS`, comma-separated, blanks dropped. */
export function privateMarkers(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((marker) => marker.trim())
    .filter((marker) => marker.length > 0)
}

export interface FileListDrift {
  readonly added: readonly string[]
  readonly removed: readonly string[]
}

export function fileListDrift(
  expected: readonly string[] | undefined,
  actual: readonly string[],
): FileListDrift {
  const before = new Set(expected ?? [])
  const after = new Set(actual)
  return {
    added: actual.filter((path) => !before.has(path)),
    removed: (expected ?? []).filter((path) => !after.has(path)),
  }
}

export function describeDrift(name: string, drift: FileListDrift): string | undefined {
  if (drift.added.length + drift.removed.length === 0) return undefined
  const lines = [`${name}: ${drift.added.length} file(s) added, ${drift.removed.length} removed`]
  for (const path of drift.added.slice(0, 20)) lines.push(`    + ${path}`)
  for (const path of drift.removed.slice(0, 20)) lines.push(`    - ${path}`)
  const hidden = Math.max(0, drift.added.length - 20) + Math.max(0, drift.removed.length - 20)
  if (hidden > 0) lines.push(`    … and ${hidden} more`)
  return lines.join("\n")
}

/** The committed record of which files each package publishes: package name to sorted paths. */
export type PackedSnapshot = Readonly<Record<string, readonly string[]>>

export const SNAPSHOT_FILE = "packed-files.json"

export function renderSnapshot(snapshot: PackedSnapshot): string {
  const ordered: Record<string, readonly string[]> = {}
  for (const name of Object.keys(snapshot).sort(codeUnitOrder)) ordered[name] = snapshot[name]!
  return `${JSON.stringify(ordered, null, 2)}\n`
}

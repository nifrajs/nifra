/**
 * Changeset coverage gate: every published package whose source moved since the last release must be
 * named by a pending changeset.
 *
 * This exists because a release note is not a courtesy, it is the only record a consumer reads before
 * upgrading - and the failure mode is silent. A change to `packages/client/src/treaty.ts` once shipped
 * under a changeset that declared `@nifrajs/core`, `@nifrajs/auth`, and `@nifrajs/middleware`, so the
 * client's CHANGELOG for that release described a different, unrelated commit and the actual change had
 * no line anywhere. Nothing failed: the bump was mechanically correct for the changesets that existed.
 * Only the changesets were wrong, and no gate compared "packages that changed" against "packages that
 * said they changed".
 *
 * Under this repo's `fixed` versioning every package bumps to the same version regardless, so a missing
 * entry costs nothing at the version level - which is exactly why it goes unnoticed. What it costs is
 * the CHANGELOG line, which lands in the named package and nowhere else.
 *
 * The comparison base is the last release commit, found as the most recent commit that DELETED
 * `.changeset/*.md` (what `changeset version` does when it consumes them). That makes the gate
 * self-anchoring: it needs no tag, no PR base ref, and no network, and it answers over exactly the
 * range the pending changesets are supposed to describe.
 *
 * Scope: `packages/<dir>/src/**` only. Tests, fixtures, docs, and configuration do not ship. A package
 * marked `private` in its package.json is not published and is skipped.
 *
 * There is no bypass flag on purpose. The remedy for a change that genuinely warrants no release note
 * is a three-line patch changeset saying so - honest, reviewable, and (under fixed versioning) with no
 * effect on the version that ships.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  type PublishedPackage,
  publishedPackages as readPublishedPackages,
} from "./public-package-manifest.ts"

const ROOT = join(import.meta.dir, "..")

/** How many example paths to print per uncovered package before the list is elided. */
const MAX_EXAMPLES = 5

const git = (root: string, args: readonly string[]): string => {
  const proc = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`)
  }
  return proc.stdout.toString()
}

/**
 * The last commit that consumed changesets, i.e. the last release. Undefined when the history has never
 * had one, or when a shallow clone does not reach back that far - the caller treats that as
 * inconclusive rather than as "nothing changed".
 */
export const lastReleaseCommit = (root: string = ROOT): string | undefined => {
  const out = git(root, [
    "log",
    "--diff-filter=D",
    "--format=%H",
    "-1",
    "--",
    ".changeset/*.md",
  ]).trim()
  return out === "" ? undefined : out
}

/** Changed files since the base, committed and uncommitted alike - staged work counts as changed. */
export const changedFiles = (base: string, root: string = ROOT): readonly string[] => {
  const committed = git(root, ["diff", "--name-only", `${base}..HEAD`]).split("\n")
  const working = git(root, ["status", "--porcelain=1", "-z"])
    .split("\0")
    .filter((entry) => entry !== "")
    // Porcelain v1 records are `XY <path>`; a rename carries its old path as a separate NUL field with
    // no status prefix, dropped here rather than mistaken for a path whose first two characters are a
    // status code.
    .map((entry) => (/^[ MADRCU?!]{2} /.test(entry) ? entry.slice(3) : undefined))
    .filter((path): path is string => path !== undefined)
  return [...new Set([...committed, ...working])].filter((path) => path !== "")
}

export type PackageInfo = PublishedPackage

/** Published workspace packages, keyed by directory name under `packages/`. */
export const publishedPackages = (root: string = ROOT): ReadonlyMap<string, PackageInfo> => {
  const out = new Map<string, PackageInfo>()
  for (const pkg of readPublishedPackages(root)) out.set(pkg.dir, pkg)
  return out
}

/** Package names named by the pending changesets, from each file's YAML frontmatter block. */
export const declaredPackages = (root: string = ROOT): ReadonlySet<string> => {
  const out = new Set<string>()
  for (const file of readdirSync(join(root, ".changeset"))) {
    if (!file.endsWith(".md") || file === "README.md") continue
    const text = readFileSync(join(root, ".changeset", file), "utf8")
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    if (frontmatter === null) continue
    for (const line of (frontmatter[1] as string).split("\n")) {
      const entry = /^\s*"?([^":]+)"?\s*:\s*(major|minor|patch)\s*$/.exec(line)
      if (entry !== null) out.add((entry[1] as string).trim())
    }
  }
  return out
}

/**
 * Published packages with changed source and no changeset naming them, mapped to a bounded sample of
 * the offending paths. Pure over its inputs so the mapping is testable without a repository.
 */
export const uncoveredPackages = (
  paths: readonly string[],
  packages: ReadonlyMap<string, PackageInfo>,
  declared: ReadonlySet<string>,
): ReadonlyMap<string, readonly string[]> => {
  const out = new Map<string, string[]>()
  for (const path of paths) {
    const match = /^packages\/([^/]+)\/src\/.+/.exec(path)
    if (match === null) continue
    const info = packages.get(match[1] as string)
    if (info === undefined || declared.has(info.name)) continue
    const files = out.get(info.name)
    if (files === undefined) out.set(info.name, [path])
    else if (files.length < MAX_EXAMPLES) files.push(path)
  }
  return out
}

const run = (root: string): number => {
  const base = lastReleaseCommit(root)
  if (base === undefined) {
    console.error(
      "changeset-coverage: cannot find the last release commit (no commit in this history deletes .changeset/*.md).",
    )
    console.error(
      "changeset-coverage: this scan is inconclusive, not clean - fetch the full history and rerun.",
    )
    return 1
  }

  const uncovered = uncoveredPackages(
    changedFiles(base, root),
    publishedPackages(root),
    declaredPackages(root),
  )

  if (uncovered.size === 0) {
    console.log(
      `✓ changeset coverage: every package whose source changed since ${base.slice(0, 8)} is named by a pending changeset`,
    )
    return 0
  }

  const plural = uncovered.size === 1
  console.error(
    `changeset-coverage: ${uncovered.size} package${plural ? "" : "s"} changed since the last release (${base.slice(0, 8)}) with no pending changeset naming ${plural ? "it" : "them"}:`,
  )
  for (const [name, files] of [...uncovered].sort(([a], [b]) => a.localeCompare(b))) {
    console.error(`\n  ${name}`)
    for (const file of files) console.error(`    ${file}`)
  }
  console.error(
    "\nchangeset-coverage: the release will still bump these packages (versioning is fixed across the workspace),",
  )
  console.error(
    "changeset-coverage: but their CHANGELOG will not mention the change - the consumer upgrading into it reads nothing.",
  )
  console.error("changeset-coverage: run `bun run changeset` and name every package listed above.")
  console.error(
    "changeset-coverage: a change that warrants no release note still gets a patch entry saying that - there is no bypass.",
  )
  return 1
}

if (import.meta.main) process.exit(run(ROOT))

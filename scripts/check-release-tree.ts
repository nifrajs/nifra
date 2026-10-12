import { spawnSync } from "node:child_process"

const SHOWN = 20

/** Paths where the working tree differs from HEAD: modified, staged, deleted, or untracked and not ignored. */
export function uncommittedPaths(root: string): readonly string[] {
  const status = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  })
  if (status.status !== 0)
    throw new Error(`git status failed in ${root}: ${(status.stderr ?? "").trim()}`)
  const fields = status.stdout.split("\0")
  const paths: string[] = []
  for (let index = 0; index < fields.length; index++) {
    const entry = fields[index]!
    if (entry.length < 4) continue
    paths.push(entry.slice(3))
    // A rename or copy carries its source path as the next field.
    if (entry[0] === "R" || entry[0] === "C") index++
  }
  return paths
}

/**
 * A release run certifies a commit, so it refuses a tree that differs from it: another checkout's
 * uncommitted work, or a stray file, would be verified in the commit's place. Any other run only warns,
 * because `check:release` is also how work is checked before it is committed.
 */
export function releaseTreeReport(
  paths: readonly string[],
  release: boolean,
): { readonly ok: boolean; readonly text: string } {
  if (paths.length === 0) return { ok: true, text: "✓ release tree: the working tree matches HEAD" }
  const listing = paths.slice(0, SHOWN).map((path) => `  ${path}`)
  if (paths.length > SHOWN) listing.push(`  ... and ${paths.length - SHOWN} more`)
  const header = release
    ? "✗ release tree: a release run verifies HEAD, but the working tree differs from it. Commit or remove these, or verify a fresh clone:"
    : "! release tree: this run verifies uncommitted work; a release run (RELEASE_MODE=1) refuses it:"
  return { ok: !release, text: [header, ...listing].join("\n") }
}

if (import.meta.main) {
  const paths = uncommittedPaths(process.cwd())
  const report = releaseTreeReport(paths, process.env.RELEASE_MODE === "1")
  if (paths.length === 0) console.log(report.text)
  else console.error(report.text)
  if (!report.ok) process.exit(1)
}

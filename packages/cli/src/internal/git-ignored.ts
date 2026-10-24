/**
 * Paths git considers ignored under `cwd`, in ONE batched `git check-ignore` call - so `.gitignore`
 * (root + nested + the global excludesfile) is honoured, not just a built-in list. This keeps a scan out
 * of generated trees and other copies that live under a repo but aren't the project: a
 * monorepo that gitignores `builder/projects/` (238 generated apps) would otherwise be walked in full.
 * Tracked files are never reported, whatever a pattern says. Returns an EMPTY set when there's no git /
 * not a repo / git errors, so the caller degrades to its own list - never throws, never blocks.
 */
export async function gitIgnored(cwd: string, rels: readonly string[]): Promise<Set<string>> {
  if (rels.length === 0) return new Set()
  try {
    const proc = Bun.spawn(["git", "check-ignore", "--stdin", "-z"], {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    })
    proc.stdin.write(`${rels.join("\0")}\0`)
    await proc.stdin.end()
    // -z keeps both directions literal: Git otherwise C-quotes Unicode/escapes on output and
    // interprets quoted input. Only matching paths are emitted; exit 1 means none matched.
    const out = await new Response(proc.stdout).text()
    await proc.exited
    return ignoredOf(out)
  } catch {
    return new Set()
  }
}

/** {@link gitIgnored} for a caller that cannot await. */
export function gitIgnoredSync(cwd: string, rels: readonly string[]): Set<string> {
  if (rels.length === 0) return new Set()
  try {
    const result = Bun.spawnSync(["git", "check-ignore", "--stdin", "-z"], {
      cwd,
      stdin: new TextEncoder().encode(`${rels.join("\0")}\0`),
      stdout: "pipe",
      stderr: "ignore",
    })
    return ignoredOf(result.stdout.toString())
  } catch {
    return new Set()
  }
}

const ignoredOf = (out: string): Set<string> =>
  new Set(out.split("\0").filter((path) => path !== ""))

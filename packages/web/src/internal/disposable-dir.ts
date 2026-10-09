import { existsSync, realpathSync } from "node:fs"
import { isAbsolute, parse, relative, sep } from "node:path"

/**
 * Throws unless `dir` is safe to delete recursively: not a filesystem root, and neither equal to nor
 * an ancestor of any path in `keep` (the sources a build reads, the working directory). Both sides are
 * compared after resolving symlinks, so a link pointing at the project is refused too. A `dir` that
 * does not exist yet is always safe.
 */
export function assertDisposableDir(option: string, dir: string, keep: readonly string[]): void {
  if (!existsSync(dir)) return
  const real = realpathSync.native(dir)
  if (parse(real).root === real)
    throw new Error(`[nifra/web] ${option} (${dir}) is a filesystem root; refusing to clear it.`)
  for (const path of keep) {
    if (!existsSync(path)) continue
    const rel = relative(real, realpathSync.native(path))
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue
    throw new Error(
      `[nifra/web] ${option} (${dir}) ${rel === "" ? "is" : "contains"} ${path}; the build clears ` +
        `${option} first, which would delete it. Point ${option} at a directory of its own.`,
    )
  }
}

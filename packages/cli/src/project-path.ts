import { lstatSync, readlinkSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"

const MAX_SYMLINKS = 40

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined
}

/**
 * Where a write to `path` lands, canonicalized: the real path of its nearest existing ancestor plus
 * the components still missing below it. A dangling symlink is followed to the path it names, since
 * writing through it creates that path. `undefined` when the filesystem cannot say.
 */
export function writeTargetOf(path: string): string | undefined {
  let probe = resolve(path)
  const missing: string[] = []
  let links = 0
  for (;;) {
    try {
      return resolve(realpathSync(probe), ...[...missing].reverse())
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return undefined
    }
    let link: string | undefined
    try {
      if (lstatSync(probe).isSymbolicLink()) link = readlinkSync(probe)
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return undefined
    }
    if (link !== undefined) {
      if (++links > MAX_SYMLINKS) return undefined
      probe = resolve(dirname(probe), link)
      continue
    }
    const parent = dirname(probe)
    if (parent === probe) return undefined
    missing.push(basename(probe))
    probe = parent
  }
}

function escapesRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

/** Resolve a diagnostic path only when both its lexical and filesystem paths stay in the project. */
export async function resolveInsideProject(
  root: string,
  candidate: string,
): Promise<string | undefined> {
  try {
    if (isAbsolute(candidate)) return undefined
    const resolvedRoot = resolve(root)
    const resolved = resolve(resolvedRoot, candidate)
    if (escapesRoot(resolvedRoot, resolved)) return undefined

    // The same canonicalizer on both sides: fs/promises expands Windows 8.3 names, realpathSync does not.
    const realRoot = realpathSync(resolvedRoot)
    const realCandidate = writeTargetOf(resolved)
    if (realCandidate === undefined || escapesRoot(realRoot, realCandidate)) return undefined
    return resolved
  } catch {
    return undefined
  }
}

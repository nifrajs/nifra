import { realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"

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

    const realRoot = await realpath(resolvedRoot)
    let realCandidate: string
    try {
      realCandidate = await realpath(resolved)
    } catch (error) {
      if (!(error && typeof error === "object" && (error as { code?: string }).code === "ENOENT")) {
        return undefined
      }
      const realParent = await realpath(dirname(resolved))
      realCandidate = resolve(realParent, basename(resolved))
    }
    if (escapesRoot(realRoot, realCandidate)) return undefined
    return resolved
  } catch {
    return undefined
  }
}

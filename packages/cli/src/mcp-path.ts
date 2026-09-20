import { realpathSync } from "node:fs"
import { basename, isAbsolute, relative, resolve } from "node:path"

/**
 * Resolve an MCP path without allowing lexical or symlink escapes from the selected project.
 *
 * MCP callers are not equivalent to a local CLI user: the selected checkout is their filesystem
 * capability boundary. The nearest-existing-ancestor walk also supports output files that do not
 * exist yet while still canonicalizing every existing path component.
 */
export function resolveMcpProjectPath(root: string, value: string): string | null {
  if (value.length === 0 || isAbsolute(value)) return null

  const lexicalRoot = resolve(root)
  const target = resolve(lexicalRoot, value)
  const lexicalRelative = relative(lexicalRoot, target)
  if (lexicalRelative.startsWith("..") || isAbsolute(lexicalRelative)) return null

  let canonicalRoot: string
  try {
    canonicalRoot = realpathSync(lexicalRoot)
  } catch {
    return null
  }

  let probe = target
  const missing: string[] = []
  while (true) {
    try {
      const canonicalProbe = realpathSync(probe)
      const canonicalRelative = relative(canonicalRoot, canonicalProbe)
      if (canonicalRelative.startsWith("..") || isAbsolute(canonicalRelative)) return null

      const candidate = resolve(canonicalProbe, ...missing.reverse())
      const candidateRelative = relative(canonicalRoot, candidate)
      return candidateRelative.startsWith("..") || isAbsolute(candidateRelative) ? null : candidate
    } catch (error) {
      if (!(error && typeof error === "object" && (error as { code?: string }).code === "ENOENT"))
        return null
      const parent = resolve(probe, "..")
      if (parent === probe) return null
      missing.push(basename(probe))
      probe = parent
    }
  }
}

export function mcpProjectPathError(label: string, value: string): string {
  return `${label} must be a relative path inside the selected project directory: ${value}`
}

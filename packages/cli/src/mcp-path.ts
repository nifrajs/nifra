import { realpathSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import { writeTargetOf } from "./project-path.ts"

/**
 * Resolve an MCP path without allowing lexical or symlink escapes from the selected project.
 *
 * MCP callers are not equivalent to a local CLI user: the selected checkout is their filesystem
 * capability boundary. The nearest-existing-ancestor walk also supports output files that do not
 * exist yet while still canonicalizing every existing path component, and a dangling symlink is
 * judged by where it points.
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

  const candidate = writeTargetOf(target)
  if (candidate === undefined) return null
  const candidateRelative = relative(canonicalRoot, candidate)
  return candidateRelative.startsWith("..") || isAbsolute(candidateRelative) ? null : candidate
}

export function mcpProjectPathError(label: string, value: string): string {
  return `${label} must be a relative path inside the selected project directory: ${value}`
}

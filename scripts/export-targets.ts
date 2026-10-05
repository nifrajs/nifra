/**
 * The files a package.json `exports` map can resolve to, for the gates that check a packed tarball
 * ships each one.
 */

/** One `exports` target, labeled with the subpath and the condition path that reach it. */
export interface ExportTarget {
  readonly label: string
  readonly target: string
}

/**
 * Every target at any depth: a string, a fallback array, or a condition object nested under another
 * condition (`"import": { "types": ..., "default": ... }`). `null` excludes a subpath and names no file.
 */
export function exportTargets(exports: unknown): ExportTarget[] {
  const targets: ExportTarget[] = []
  const walk = (value: unknown, keys: readonly string[]): void => {
    if (typeof value === "string") targets.push({ label: labelOf(keys), target: value })
    else if (Array.isArray(value)) for (const item of value) walk(item, keys)
    else if (value !== null && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) walk(inner, [...keys, key])
    }
  }
  walk(exports, [])
  return targets
}

// Keys starting with "." are subpaths; an object without them is the condition sugar for ".".
const labelOf = (keys: readonly string[]): string => {
  const [first = "."] = keys
  const subpath = first.startsWith(".") ? first : "."
  const conditions = first.startsWith(".") ? keys.slice(1) : keys
  return conditions.length === 0 ? subpath : `${subpath} (${conditions.join(".")})`
}

/** Whether a packed entry satisfies the target; a `*` pattern needs at least one entry it matches. */
export function shipsTarget(target: string, packedEntries: ReadonlySet<string>): boolean {
  const path = target.replace(/^\.\//, "")
  const star = path.indexOf("*")
  if (star === -1) return packedEntries.has(path)
  const prefix = path.slice(0, star)
  const suffix = path.slice(star + 1)
  for (const entry of packedEntries) {
    if (
      entry.length > prefix.length + suffix.length &&
      entry.startsWith(prefix) &&
      entry.endsWith(suffix)
    ) {
      return true
    }
  }
  return false
}

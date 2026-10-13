import { isAbsolute, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

/** A recorded `file:line:col` as a project-relative POSIX path and line, when it is inside the project
 * and not under a `node_modules`. */
export function projectSite(
  root: string,
  site: string | undefined,
): { readonly file: string; readonly line: number } | undefined {
  const [, raw, line] = site?.match(/^(.*):(\d+):\d+$/) ?? []
  if (raw === undefined || line === undefined) return undefined
  const path = raw.startsWith("file://") ? fileURLToPath(raw) : raw
  if (!isAbsolute(path)) return undefined
  const rel = relative(root, path)
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined
  if (rel.split(sep).includes("node_modules")) return undefined
  return { file: rel.split(sep).join("/"), line: Number(line) }
}

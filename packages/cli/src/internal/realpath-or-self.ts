import { realpathSync } from "node:fs"

/** The real path, or `path` as given when it cannot be resolved: it does not exist yet, or is unreadable. */
export function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

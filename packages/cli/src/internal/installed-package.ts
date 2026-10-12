import { existsSync } from "node:fs"
import { dirname, join } from "node:path"

/** The manifest of the installed package `name`, as Node finds it: the nearest `node_modules/<name>`
 * at or above the importing file. A workspace link resolves through its symlink. */
export function installedManifest(fromFile: string, name: string): string | undefined {
  let dir = dirname(fromFile)
  for (;;) {
    const manifest = join(dir, "node_modules", name, "package.json")
    if (existsSync(manifest)) return manifest
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

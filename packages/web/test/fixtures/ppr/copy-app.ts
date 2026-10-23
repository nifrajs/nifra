import { cpSync, mkdtempSync } from "node:fs"
import { join } from "node:path"

const APP = join(import.meta.dir, "app")

/**
 * A unique copy of the fixture app's routes and lib, under `packages/web/test` where its imports
 * (React, the adapters) resolve as they do for the original. The caller removes it.
 */
export function copyPprApp(prefix: string): string {
  const root = mkdtempSync(join(import.meta.dir, "../..", `.tmp-${prefix}`))
  cpSync(join(APP, "routes"), join(root, "routes"), { recursive: true })
  cpSync(join(APP, "lib"), join(root, "lib"), { recursive: true })
  return root
}

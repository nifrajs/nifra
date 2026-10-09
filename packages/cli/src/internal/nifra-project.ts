import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { CONFIG_FILE, FRAMEWORK_FILE } from "../app-files.ts"

const NIFRA_PACKAGE = /^(?:@nifrajs\/|nifra$)/
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
]

/** Whether a package.json text names `nifra` or a `@nifrajs/` package, or carries a `nifra` setting. */
function declaresNifra(manifest: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(manifest)
  } catch {
    // A manifest nobody can read proves nothing either way, so the directory stays checked.
    return true
  }
  if (typeof parsed !== "object" || parsed === null) return true
  if ("nifra" in parsed) return true
  return DEPENDENCY_FIELDS.some((field) => {
    const deps: unknown = Reflect.get(parsed, field)
    return (
      typeof deps === "object" &&
      deps !== null &&
      Object.keys(deps).some((name) => NIFRA_PACKAGE.test(name))
    )
  })
}

/**
 * Whether a project-relative directory ("" for the root) belongs to a nifra project, read statically.
 * The checked root always does: running the check there says so. Below it, walking up, the first
 * directory with a nifra config decides yes, and the first package.json decides by naming `nifra` or
 * a `@nifrajs/` package, or carrying a `nifra` setting; a nested package that does none of that is
 * another project, such as another framework's app kept beside this one.
 */
export function createNifraProjectProbe(root: string): (dir: string) => boolean {
  const cache = new Map<string, boolean>()
  const probe = (dir: string): boolean => {
    const cached = cache.get(dir)
    if (cached !== undefined) return cached
    const at = join(root, dir)
    let nifra: boolean
    if (dir === "" || existsSync(join(at, CONFIG_FILE)) || existsSync(join(at, FRAMEWORK_FILE)))
      nifra = true
    else if (existsSync(join(at, "package.json"))) {
      let manifest: string
      try {
        manifest = readFileSync(join(at, "package.json"), "utf8")
      } catch {
        manifest = ""
      }
      nifra = declaresNifra(manifest)
    } else nifra = probe(dir.slice(0, Math.max(dir.lastIndexOf("/"), 0)))
    cache.set(dir, nifra)
    return nifra
  }
  return probe
}

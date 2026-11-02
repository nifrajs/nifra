import { existsSync, readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
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
  return cachedWalkUp(root, (at, dir) => {
    if (dir === "" || existsSync(join(at, CONFIG_FILE)) || existsSync(join(at, FRAMEWORK_FILE)))
      return true
    if (!existsSync(join(at, "package.json"))) return undefined
    let manifest: string
    try {
      manifest = readFileSync(join(at, "package.json"), "utf8")
    } catch {
      manifest = ""
    }
    return declaresNifra(manifest)
  })
}

/**
 * A probe that answers a project-relative directory with `decide`'s answer for it, or, where that is
 * `undefined`, its parent's; nothing decided up to the root means no. Each directory is decided once.
 */
function cachedWalkUp(
  root: string,
  decide: (at: string, dir: string) => boolean | undefined,
): (dir: string) => boolean {
  const cache = new Map<string, boolean>()
  const probe = (dir: string): boolean => {
    const cached = cache.get(dir)
    if (cached !== undefined) return cached
    const answer =
      decide(join(root, dir), dir) ??
      (dir !== "" && probe(dir.slice(0, Math.max(dir.lastIndexOf("/"), 0))))
    cache.set(dir, answer)
    return answer
  }
  return probe
}

export type ProjectKind = "api" | "web"

export interface KindDeclaration {
  /** `"api"` or `"web"` from `"nifra": { "kind" }`, or `undefined` when the package declares none. */
  readonly kind: ProjectKind | undefined
  /** The package.json that decides, relative to the checked root (`../package.json` above it). */
  readonly manifest: string | undefined
  /** The problem with a declared value that is neither `"api"` nor `"web"`. */
  readonly invalid?: string
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

const recordOf = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined

/**
 * The `"nifra": { "kind" }` that governs a project-relative directory: read from the nearest
 * package.json at or above it, the way the zone setting is read, with no app code run.
 */
export function createKindProbe(root: string): (dir: string) => KindDeclaration {
  const cache = new Map<string, KindDeclaration>()
  const probe = (absolute: string): KindDeclaration => {
    const cached = cache.get(absolute)
    if (cached !== undefined) return cached
    let declaration: KindDeclaration
    const manifestPath = join(absolute, "package.json")
    if (existsSync(manifestPath)) {
      const manifest = relative(root, manifestPath).replaceAll("\\", "/")
      const kind = recordOf(recordOf(readJson(manifestPath))?.nifra)?.kind
      if (kind === undefined) declaration = { kind: undefined, manifest }
      else if (kind === "api" || kind === "web") declaration = { kind, manifest }
      else
        declaration = {
          kind: undefined,
          manifest,
          invalid: `[nifra] ${manifest} "nifra.kind" must be "api" or "web", not ${JSON.stringify(kind)}`,
        }
    } else {
      const parent = dirname(absolute)
      declaration = parent === absolute ? { kind: undefined, manifest: undefined } : probe(parent)
    }
    cache.set(absolute, declaration)
    return declaration
  }
  return (dir) => probe(join(root, dir))
}

/** Whether a project-relative directory holds web config: a `nifra.config.ts` exporting `adapter`, or
 * `backend/framework.ts`. */
export function hasWebConfig(root: string, dir: string): boolean {
  if (existsSync(join(root, dir, FRAMEWORK_FILE))) return true
  const config = join(root, dir, CONFIG_FILE)
  if (!existsSync(config)) return false
  let text: string
  try {
    text = readFileSync(config, "utf8")
  } catch {
    return true
  }
  return /\bexport\s+(?:const|let|var|function)\s+adapter\b|\bexport\s*\{[^}]*\badapter\b/.test(
    text,
  )
}

const WEB_PACKAGE = /^@nifrajs\/web(?:-[a-z0-9-]+)?$/

/**
 * Whether a project-relative directory ("" for the root) is inside a nifra web app. Walking up, the
 * first directory with `nifra.config.ts` or `backend/framework.ts` makes it one; the first package.json
 * decides instead: `"nifra": { "kind": "api" }` says no, otherwise naming `@nifrajs/web` or an adapter
 * says yes. Nothing up to the root means no.
 */
export function createWebAppProbe(root: string): (dir: string) => boolean {
  return cachedWalkUp(root, (at) => {
    if (existsSync(join(at, CONFIG_FILE)) || existsSync(join(at, FRAMEWORK_FILE))) return true
    if (!existsSync(join(at, "package.json"))) return undefined
    const manifest = recordOf(readJson(join(at, "package.json")))
    return (
      recordOf(manifest?.nifra)?.kind !== "api" &&
      DEPENDENCY_FIELDS.some((field) => {
        const deps = recordOf(manifest?.[field])
        return deps !== undefined && Object.keys(deps).some((name) => WEB_PACKAGE.test(name))
      })
    )
  })
}

/** A zone or server-only finding outside any web app, with the API-only setting named. */
export const withApiKindHint = (message: string): string =>
  `${message}${message.endsWith(".") ? "" : "."} If this project serves no pages, declare it in package.json: "nifra": { "kind": "api" }`

/**
 * Whether `"nifra": { "kind": "api" }` takes a project-relative directory out of the zone checks. It
 * does only where no web config sits at or above the directory, up to the checked root: an app that
 * serves pages keeps its zone checks whatever its package.json says (NF-C037 reports the clash).
 */
export function createApiOnlyProbe(root: string): (dir: string) => boolean {
  const kindOf = createKindProbe(root)
  const web = new Map<string, boolean>()
  const webConfigUp = (dir: string): boolean => {
    const cached = web.get(dir)
    if (cached !== undefined) return cached
    const found =
      hasWebConfig(root, dir) ||
      (dir !== "" && webConfigUp(dir.slice(0, Math.max(dir.lastIndexOf("/"), 0))))
    web.set(dir, found)
    return found
  }
  return (dir) => kindOf(dir).kind === "api" && !webConfigUp(dir)
}

/**
 * Which zoned files the typecheck never read. `tsc --noEmit` passes for code outside its program, so
 * a stale tsconfig `include` (a folder moved under `backend/`, say) turns the contract gate into a
 * pass that checked nothing there. The check runs tsc with `--listFiles` and compares the program
 * against the app's zone folders.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { ROUTE_TABLE_FILE } from "@nifrajs/web/route-types"
import { stripComments } from "./check-scan.ts"

const ZONE_FOLDER = new Set(["routes", "frontend", "backend", "shared"])
const TS_SOURCE = /\.(?:[cm]?ts|tsx)$/
const NOT_PROGRAM_CODE = /\.d\.[cm]?ts$|\.(?:test|spec)\.[cm]?tsx?$/
const TSC_DIAGNOSTIC = /\(\d+,\d+\):\s*(?:error|warning)\s+TS\d+:/

const readTsconfig = (path: string): unknown => {
  try {
    return JSON.parse(stripComments(readFileSync(path, "utf8")).replace(/,(\s*[}\]])/g, "$1"))
  } catch {
    return undefined
  }
}

/** A `references[].path`, which names a tsconfig or the folder holding one, as a file. */
const referencedConfig = (from: string, path: string): string => {
  const target = resolve(dirname(from), path)
  return target.endsWith(".json") ? target : join(target, "tsconfig.json")
}

/**
 * The tsconfigs `nifra check` typechecks, each as its own program: `configured` (nifra.check.json
 * `tsconfigs`) when given, else `tsconfig.json` and every project it references, transitively. A
 * solution-style tsconfig (`"files": []` plus `references`) holds no files itself, so without its
 * references the typecheck would pass having read nothing. `missing` lists configured paths that do not
 * exist; references that do not exist are tsc's to report.
 */
export function typecheckProjects(
  cwd: string,
  configured?: readonly string[],
): { readonly paths: readonly string[]; readonly missing: readonly string[] } {
  if (configured !== undefined) {
    const paths = configured.map((path) => resolve(cwd, path))
    return {
      paths: paths.filter((path) => existsSync(path)),
      missing: configured.filter((_, index) => !existsSync(paths[index] ?? "")),
    }
  }
  const root = join(cwd, "tsconfig.json")
  if (!existsSync(root)) return { paths: [], missing: [] }
  const paths: string[] = []
  const queue = [root]
  while (queue.length > 0 && paths.length < 64) {
    const path = queue.shift()
    if (path === undefined || paths.includes(path) || !existsSync(path)) continue
    paths.push(path)
    const references: unknown = Reflect.get(Object(readTsconfig(path)), "references")
    if (!Array.isArray(references)) continue
    for (const reference of references) {
      const target: unknown = Reflect.get(Object(reference), "path")
      if (typeof target === "string") queue.push(referencedConfig(path, target))
    }
  }
  return { paths, missing: [] }
}

/** Split `tsc --listFiles` output into the program's files and the compiler's own output. */
export function splitListedFiles(output: string): {
  readonly programFiles: readonly string[]
  readonly output: string
} {
  const programFiles: string[] = []
  const rest: string[] = []
  for (const line of output.split(/\r?\n/)) {
    if (line !== "" && line === line.trim() && isAbsolute(line) && !TSC_DIAGNOSTIC.test(line))
      programFiles.push(line)
    else rest.push(line)
  }
  return { programFiles, output: rest.join("\n").trim() }
}

const real = (path: string): string => {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

// tsc prints forward slashes, and on Windows the drive letter's case is not stable.
const canonical = (path: string): string => {
  const posix = path.replaceAll("\\", "/")
  return process.platform === "win32" ? posix.toLowerCase() : posix
}

/** The zone folder a project file sits in (`backend`, `apps/web/routes`), or `undefined`. */
export function zoneFolderOf(file: string): string | undefined {
  const parts = file.split("/")
  const at = parts.findIndex((part, i) => i < parts.length - 1 && ZONE_FOLDER.has(part))
  return at === -1 ? undefined : parts.slice(0, at + 1).join("/")
}

/** True when a tsconfig between the app root and `cwd` makes the app its own program. */
function hasOwnProgram(cwd: string, app: string): boolean {
  let dir = app
  while (dir !== "" && dir !== ".") {
    if (existsSync(join(cwd, dir, "tsconfig.json"))) return true
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
  return false
}

/**
 * The `exclude` patterns of `<cwd>/tsconfig.json`, inherited through relative `extends` as tsc does,
 * rewritten relative to `cwd`. A file a tsconfig excludes is out of the program on purpose.
 */
export function tsconfigExcludes(cwd: string): string[] {
  let path = join(cwd, "tsconfig.json")
  for (let depth = 0; depth < 8 && existsSync(path); depth++) {
    const config = readTsconfig(path)
    if (typeof config !== "object" || config === null) return []
    const exclude: unknown = Reflect.get(config, "exclude")
    if (Array.isArray(exclude)) {
      const from = dirname(path)
      return exclude
        .filter((pattern): pattern is string => typeof pattern === "string")
        .map((pattern) => relative(cwd, resolve(from, pattern)).replaceAll("\\", "/"))
    }
    const base: unknown = Reflect.get(config, "extends")
    if (typeof base !== "string" || !base.startsWith(".")) return []
    path = resolve(dirname(path), base.endsWith(".json") ? base : `${base}.json`)
  }
  return []
}

// tsc reads a pattern that names a folder as everything below it.
const excludedBy = (patterns: readonly string[], file: string): boolean =>
  patterns.some(
    (pattern) => new Bun.Glob(pattern).match(file) || new Bun.Glob(`${pattern}/**`).match(file),
  )

// A named import of a navigation API from `@nifrajs/web` or an adapter: what the route table types.
const NAVIGATION_IMPORT =
  /\bimport\s+(?:type\s+)?\{[^}]*\b(?:useNavigate|Link|NavLink|Navigate|redirect|href|rawHref)\b[^}]*\}\s*from\s*["']@nifrajs\/web(?:-[a-z]+)?(?:\/(?:router|client))?["']/

/**
 * `.nifra/types/routes.d.ts` (project-relative) when a source file uses a navigation API, the table
 * exists, and no program holds it. A program that imports any route's `./+types` module loads the table
 * through that module's reference; one that does not, and does not name it, never sees it. Its `href`
 * calls have no route keys to check against. An app that uses none of these APIs is left alone.
 */
export function routeTableOutsideProgram(
  cwd: string,
  programFiles: readonly string[],
  sources: ReadonlyArray<{ readonly content: string }>,
): string | undefined {
  const table = join(cwd, ROUTE_TABLE_FILE)
  if (!existsSync(table) || !sources.some(({ content }) => NAVIGATION_IMPORT.test(content)))
    return undefined
  const wanted = new Set([canonical(table), canonical(real(table))])
  return programFiles.some((file) => wanted.has(canonical(file))) ? undefined : ROUTE_TABLE_FILE
}

/**
 * The TypeScript files under a zone folder that `programFiles` does not contain, project-relative and
 * in input order. Declaration files and tests are left out: a project may typecheck tests with a
 * separate config. So is an app nested under its own tsconfig, which this program does not own, and a
 * file the tsconfig's `exclude` names.
 */
export function filesOutsideProgram(
  cwd: string,
  files: readonly string[],
  programFiles: readonly string[],
): string[] {
  const program = new Set<string>()
  for (const file of programFiles) {
    program.add(canonical(file))
    if (!file.includes("/node_modules/")) program.add(canonical(real(file)))
  }
  const ownProgram = new Map<string, boolean>()
  const excluded = tsconfigExcludes(cwd)
  const outside: string[] = []
  for (const file of files) {
    if (!TS_SOURCE.test(file) || NOT_PROGRAM_CODE.test(file)) continue
    if (excludedBy(excluded, file)) continue
    const folder = zoneFolderOf(file)
    if (folder === undefined) continue
    const app = dirname(folder)
    let own = ownProgram.get(app)
    if (own === undefined) {
      own = hasOwnProgram(cwd, app)
      ownProgram.set(app, own)
    }
    if (own) continue
    const abs = join(cwd, file)
    if (program.has(canonical(abs)) || program.has(canonical(real(abs)))) continue
    outside.push(file)
  }
  return outside
}

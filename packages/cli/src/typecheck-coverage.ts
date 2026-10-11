/**
 * Which zoned files the typecheck never read. `tsc --noEmit` passes for code outside its program, so
 * a stale tsconfig `include` (a folder moved under `backend/`, say) turns the contract gate into a
 * pass that checked nothing there. The check runs tsc with `--listFiles` and compares the program
 * against the app's zone folders.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { stripComments } from "./check-scan.ts"

const ZONE_FOLDER = new Set(["routes", "frontend", "backend", "shared"])
const TS_SOURCE = /\.(?:[cm]?ts|tsx)$/
const NOT_PROGRAM_CODE = /\.d\.[cm]?ts$|\.(?:test|spec)\.[cm]?tsx?$/
const TSC_DIAGNOSTIC = /\(\d+,\d+\):\s*(?:error|warning)\s+TS\d+:/

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
    let config: unknown
    try {
      config = JSON.parse(stripComments(readFileSync(path, "utf8")).replace(/,(\s*[}\]])/g, "$1"))
    } catch {
      return []
    }
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

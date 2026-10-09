/**
 * A route manifest built by hand from a list that names no backend half. `buildManifest(files, load)`
 * pairs a page with its `.backend.*` half only when both are in `files`: it is pure, so it cannot know
 * a half is missing. A test or server that spells the list out (an array literal, or `import.meta.glob`
 * patterns) and leaves the halves out runs every route without its loader, action and guards.
 */
import { existsSync, readdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { Glob } from "bun"
import { codePositionMask } from "./check.ts"
import { expressionEnd } from "./rules/data-guard.ts"

/** A `buildManifest(...)` call whose file list reaches pages under `routes/` but not their halves. */
export interface HandBuiltManifest {
  readonly file: string
  readonly line: number
  /** How the list was spelled out. */
  readonly source: "array" | "glob"
  /** The backend halves, cwd-relative, of pages the list reaches but whose half it does not. */
  readonly missing: readonly string[]
}

/** A `buildManifest(...)` call and the literal entries or glob patterns of its file list. */
export interface ManifestList {
  readonly file: string
  readonly line: number
  readonly source: "array" | "glob"
  readonly entries: readonly string[]
}

// Mirrors `isRouteBackendFile` in @nifrajs/web's manifest.
const BACKEND_HALF = /\.backend\.(?:[cm]?[jt]s)$/
const LITERAL = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g

const lineAt = (text: string, index: number): number => text.slice(0, index).split("\n").length

/**
 * The `buildManifest(` calls in `content` whose first argument is spelled out in source: an array of
 * string literals, or an expression around `import.meta.glob(...)` with literal patterns. A list built
 * any other way (a variable, a spread, a template with a substitution) is not read.
 */
export function manifestListsIn(file: string, content: string): ManifestList[] {
  if (!content.includes("buildManifest")) return []
  const mask = codePositionMask(content)
  const lists: ManifestList[] = []
  for (const call of mask.matchAll(/\bbuildManifest\s*\(/g)) {
    const start = call.index + call[0].length
    const end = expressionEnd(mask, start)
    const argument = mask.slice(start, end).trim()
    const literals = [...content.slice(start, end).matchAll(LITERAL)].map((m) => m[2] ?? "")
    if (literals.some((text) => text.includes("${"))) continue
    let source: ManifestList["source"]
    if (argument.startsWith("[") && argument.endsWith("]")) {
      // Every element a literal: the mask, with literals blanked, holds only brackets and commas.
      if (!/^\[[\s,]*\]$/.test(argument)) continue
      source = "array"
    } else if (argument.includes("import.meta.glob(")) {
      source = "glob"
    } else continue
    lists.push({ file, line: lineAt(content, call.index), source, entries: literals })
  }
  return lists
}

function filesUnder(routesDir: string): readonly string[] {
  try {
    return readdirSync(routesDir, { recursive: true, encoding: "utf8" }).map((rel) =>
      rel.replaceAll("\\", "/"),
    )
  } catch {
    return []
  }
}

const stem = (file: string): string => file.replace(/\.[^./]+$/, "")

/** A glob pattern from source, relative to `routes/` when it names that directory. */
function routesRelative(pattern: string): string {
  const at = pattern.lastIndexOf("routes/")
  return at === -1 ? pattern.replace(/^(?:\.{0,2}\/)+/, "") : pattern.slice(at + "routes/".length)
}

function reaches(list: ManifestList): (file: string) => boolean {
  if (list.source === "array") {
    const listed = new Set(list.entries.map((entry) => entry.replace(/^\.\//, "")))
    return (file) => listed.has(file)
  }
  const glob = (pattern: string): ((file: string) => boolean) => {
    const compiled = new Glob(routesRelative(pattern))
    return (file) => compiled.match(file) || compiled.match(`routes/${file}`)
  }
  const include = list.entries.filter((p) => !p.startsWith("!")).map(glob)
  const exclude = list.entries.filter((p) => p.startsWith("!")).map((p) => glob(p.slice(1)))
  return (file) => include.some((match) => match(file)) && !exclude.some((match) => match(file))
}

/** The `routes/` directory nearest above `file`, up to and including `cwd`'s own, as a cwd-relative path. */
function routesDirFor(cwd: string, file: string): string | undefined {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const candidate = dir === "." ? "routes" : `${dir}/routes`
    const abs = join(cwd, candidate)
    if (existsSync(abs) && statSync(abs).isDirectory()) return candidate
    if (dir === "." || dir === "/" || dir === "") return undefined
  }
}

/** The lists that reach a page under their app's `routes/` but not the backend half beside it. */
export function handBuiltManifests(
  cwd: string,
  lists: readonly ManifestList[],
): HandBuiltManifest[] {
  const found: HandBuiltManifest[] = []
  const filesByDir = new Map<string, readonly string[]>()
  for (const list of lists) {
    const routesDir = routesDirFor(cwd, list.file)
    if (routesDir === undefined) continue
    let files = filesByDir.get(routesDir)
    if (files === undefined) {
      files = filesUnder(join(cwd, routesDir))
      filesByDir.set(routesDir, files)
    }
    const halves = files.filter((file) => BACKEND_HALF.test(file))
    if (halves.length === 0) continue
    const listed = reaches(list)
    const missing = halves.filter((half) => {
      if (listed(half)) return false
      const page = stem(half.replace(BACKEND_HALF, ""))
      return files.some((file) => !BACKEND_HALF.test(file) && stem(file) === page && listed(file))
    })
    if (missing.length > 0) {
      const shown = missing.map((half) => `${routesDir}/${half}`)
      found.push({ file: list.file, line: list.line, source: list.source, missing: shown })
    }
  }
  return found
}

/** The advisory `nifra doctor` prints for one finding. */
export function handBuiltManifestMessage(finding: HandBuiltManifest): string {
  const list = finding.source === "array" ? "a file list" : "import.meta.glob patterns"
  const shown = finding.missing.slice(0, 3)
  const more = finding.missing.length > 3 ? ` and ${finding.missing.length - 3} more` : ""
  return `${finding.file}:${finding.line} builds a route manifest from ${list} that leaves out ${finding.missing.length} backend half(s) of pages it lists (${shown.join(", ")}${more}). buildManifest pairs a page with its .backend.* half only when both are listed, so those pages run without their loaders, actions and guards. Use discoverRoutes("./routes") from @nifrajs/web/fs, or the generated server-manifest.`
}

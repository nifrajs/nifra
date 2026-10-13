/**
 * Bare specifiers that name a package the project owns, resolved through that package's `exports`
 * the way Bun resolves them. A package is the project's when it is a workspace member, or when its
 * `node_modules` entry links to a directory outside every `node_modules`; one installed from a
 * registry is never read, because its source is not the project's to check.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"
import { workspaceMemberDirs } from "../mcp-root.ts"

/** Bun's runtime conditions, in the order a conditions object is read; `types` is taken only when it
 * names a TypeScript source, which is what Bun would run. */
const CONDITIONS: ReadonlySet<string> = new Set(["bun", "import", "default"])
const TS_SOURCE = /\.[cm]?tsx?$/
const DECLARATION = /\.d\.[cm]?tsx?$/
/** Tried in order when a package without `exports` names a file without its extension. */
const EXTENSIONS: readonly string[] = ["", ".ts", ".tsx", ".mts", ".js", ".mjs", ".jsx"]
const PACKAGE_NAME = /^(?:@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*$/i

/** The file a specifier names, or why a package the project owns does not export it. */
export type ExportedFile =
  | { readonly path: string }
  | { readonly package: string; readonly reason: string }

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const manifestOf = (dir: string): Readonly<Record<string, unknown>> | undefined => {
  try {
    return record(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")))
  } catch {
    return undefined
  }
}

/** `@scope/name/sub/path` -> `["@scope/name", "./sub/path"]`; `undefined` for a relative, absolute,
 * `#` or `scheme:` specifier. */
export function splitBareSpecifier(specifier: string): [string, string] | undefined {
  if (/^[./#]/.test(specifier) || specifier.includes(":")) return undefined
  const parts = specifier.split("/")
  const take = specifier.startsWith("@") ? 2 : 1
  const name = parts.slice(0, take).join("/")
  if (!PACKAGE_NAME.test(name)) return undefined
  const rest = parts.slice(take)
  return [name, rest.length === 0 ? "." : `./${rest.join("/")}`]
}

/** The target a conditions value selects, with `*` replaced; `null` when the package excludes it. */
function conditionTarget(value: unknown, match: string): string | null | undefined {
  if (value === null) return null
  if (typeof value === "string") {
    // As Node and Bun refuse them: a target leaves the package only through `..` or `node_modules`.
    const segments = value.split("/")
    if (segments[0] !== "." || segments.some((part) => part === ".." || part === "node_modules"))
      return undefined
    return value.replaceAll("*", match)
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const target = conditionTarget(item, match)
      if (target !== undefined) return target
    }
    return undefined
  }
  const conditions = record(value)
  if (conditions === undefined) return undefined
  for (const [key, inner] of Object.entries(conditions)) {
    if (CONDITIONS.has(key)) {
      const target = conditionTarget(inner, match)
      if (target !== undefined) return target
    } else if (key === "types") {
      const target = conditionTarget(inner, match)
      if (typeof target === "string" && TS_SOURCE.test(target) && !DECLARATION.test(target))
        return target
    }
  }
  return undefined
}

/** What `exports` maps `subpath` to: an exact key first, then the `*` pattern with the longest
 * prefix, as Node and Bun match them. */
export function exportsTarget(exports: unknown, subpath: string): string | null | undefined {
  const map = record(exports)
  const subpaths =
    map !== undefined && Object.keys(map).some((key) => key.startsWith("."))
      ? map
      : { ".": exports }
  if (Object.hasOwn(subpaths, subpath)) return conditionTarget(subpaths[subpath], "")
  let best: { readonly key: string; readonly match: string } | undefined
  for (const key of Object.keys(subpaths)) {
    const star = key.indexOf("*")
    if (star === -1 || key.indexOf("*", star + 1) !== -1) continue
    const prefix = key.slice(0, star)
    const suffix = key.slice(star + 1)
    if (
      subpath.length < key.length ||
      !subpath.startsWith(prefix) ||
      !subpath.endsWith(suffix) ||
      (best !== undefined && prefix.length <= best.key.indexOf("*"))
    )
      continue
    best = { key, match: subpath.slice(prefix.length, subpath.length - suffix.length) }
  }
  if (best === undefined) return undefined
  if (best.match.split("/").includes("..")) return undefined
  return conditionTarget(subpaths[best.key], best.match)
}

const inside = (dir: string, path: string): boolean => {
  const rel = relative(dir, path)
  return rel !== "" && !rel.startsWith("..") && !rel.split(sep).includes("node_modules")
}

/** The file `subpath` names in the package at `dir`, or why it names none. */
function entryIn(dir: string, name: string, subpath: string): ExportedFile {
  const manifest = manifestOf(dir)
  const shown = subpath === "." ? name : `${name}/${subpath.slice(2)}`
  const exported =
    manifest?.exports !== undefined
      ? exportsTarget(manifest.exports, subpath)
      : subpath === "."
        ? typeof manifest?.module === "string"
          ? manifest.module
          : typeof manifest?.main === "string"
            ? manifest.main
            : "./index"
        : subpath
  if (exported === null || exported === undefined)
    return { package: name, reason: `${name} does not export "${subpath}"` }
  // An `exports` target is a file; a package without `exports` is probed the way Bun probes it.
  const base = join(dir, exported)
  const probes =
    manifest?.exports !== undefined
      ? [base]
      : [
          ...EXTENSIONS.map((extension) => `${base}${extension}`),
          ...EXTENSIONS.slice(1).map((extension) => join(base, `index${extension}`)),
        ]
  const found = probes.find(isFile)
  if (found === undefined)
    return { package: name, reason: `${shown} resolves to ${exported}, which does not exist` }
  let real: string
  try {
    real = realpathSync(found)
  } catch {
    return { package: name, reason: `${shown} resolves to ${exported}, which cannot be read` }
  }
  return inside(realpathSync(dir), real)
    ? { path: real }
    : { package: name, reason: `${shown} resolves outside the package` }
}

/** The nearest directory at or above `start`, up to the repository root, whose package.json declares
 * `workspaces`. */
function workspaceRoot(start: string): string | undefined {
  for (let dir = start; ; ) {
    const workspaces = manifestOf(dir)?.workspaces
    if (workspaces !== undefined) return dir
    const parent = dirname(dir)
    if (parent === dir || existsSync(join(dir, ".git"))) return undefined
    dir = parent
  }
}

/** Resolves a bare specifier from an absolute importing file; `undefined` when it is not bare. */
export type ExportedFileResolver = (from: string, specifier: string) => ExportedFile | undefined

/**
 * A resolver over the workspace `root` belongs to. Workspace members are read from their manifests
 * once; any other package is looked up in the `node_modules` above the importing file and read only
 * when that entry links outside every `node_modules`.
 */
export async function createExportedFileResolver(root: string): Promise<ExportedFileResolver> {
  const members = new Map<string, string>()
  const top = workspaceRoot(root)
  for (const dir of top === undefined ? [] : ((await workspaceMemberDirs(top)) ?? [])) {
    const name = manifestOf(dir)?.name
    if (typeof name === "string" && !members.has(name)) members.set(name, dir)
  }
  return (from, specifier) => {
    const split = splitBareSpecifier(specifier)
    if (split === undefined) return undefined
    const [name, subpath] = split
    const member = members.get(name)
    if (member !== undefined) return entryIn(member, name, subpath)
    for (let dir = dirname(from); ; ) {
      const linked = join(dir, "node_modules", name)
      if (existsSync(linked)) {
        let real: string
        try {
          real = realpathSync(linked)
        } catch {
          break
        }
        return real.split(sep).includes("node_modules")
          ? {
              package: name,
              reason: `${name} is installed from a registry, not a workspace package`,
            }
          : entryIn(real, name, subpath)
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return { package: name, reason: `${name} is not a workspace package and is not installed` }
  }
}

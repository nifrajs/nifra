/**
 * The first-party file an import specifier names, found the way a bundler finds it: a relative or
 * absolute path, a tsconfig `paths` alias or `baseUrl` name (following `extends`), or a package.json
 * `imports` entry (`#x`). A bare package specifier, a file under `node_modules` and a name that matches
 * nothing resolve to `undefined`, so a check never mistakes a dependency for project code.
 *
 * Never `Bun.resolveSync`: it can install a missing package and remembers answers for the life of the
 * process, and the MCP server is long-lived. A resolver caches what it reads for one check run only.
 */
import { readFileSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, extname, isAbsolute, join } from "node:path"

/** `(absolute importing file, specifier)` to the real path of the file it loads, or `undefined`. */
export type SpecifierResolver = (fromFile: string, specifier: string) => string | undefined

export interface ProjectResolver extends SpecifierResolver {
  /**
   * `specifier`, an alias as `fromFile` writes it, rewritten through the same alias to name `file`
   * instead, in the same style (extension, index). `undefined` when `specifier` is not an alias or no
   * target of its alias covers `file`. Paths are absolute and unresolved, as `fromFile` is spelled.
   */
  readonly respell: (fromFile: string, specifier: string, file: string) => string | undefined
  /** The `paths` patterns of the nearest tsconfig at or above `dir`, after its `extends` chain. */
  readonly pathPatterns: (dir: string) => readonly string[]
}

/** How an alias specifier reached its file: what a rewrite through the same alias has to fit. */
interface AliasRule {
  /** The pattern the specifier matched; `undefined` for a `baseUrl` name, which matches none. */
  readonly key: string | undefined
  /** Every pattern in the same scope: a rewritten name must still match `key`, or none for `baseUrl`. */
  readonly keys: readonly string[]
  /** The directory targets resolve against. */
  readonly base: string
  /** The key's targets in try order, `STAR` where the matched text goes. */
  readonly templates: readonly string[]
  /** The path the specifier spells before probing, and the file probing found. */
  readonly written: string
  readonly found: string
}

const STAR = "\u0000"

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"]
// TypeScript's ESM convention: `./x.js` names `x.ts` when only the source exists.
const SOURCE_FOR: Readonly<Record<string, readonly string[]>> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
}
// The package.json `imports` conditions a server-side bundle of this project matches, in no order:
// the target object's own key order decides, as in Node.
const CONDITIONS: ReadonlySet<string> = new Set(["bun", "import", "default"])
const MAX_EXTENDS = 16

interface PathsConfig {
  /** Directory `paths` targets resolve against: `baseUrl` when set, else the defining config's. */
  readonly pathsBase: string
  readonly paths: ReadonlyArray<readonly [string, readonly string[]]>
  readonly baseUrl: string | undefined
}

/** JSON with comments and trailing commas, as tsconfig files are written. Throws on anything else. */
export function parseJsonc(text: string): unknown {
  let code = ""
  for (let i = 0; i < text.length; ) {
    const ch = text[i]
    if (ch === '"') {
      let end = i + 1
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1
      code += text.slice(i, end + 1)
      i = end + 1
    } else if (ch === "/" && text[i + 1] === "/") {
      const newline = text.indexOf("\n", i)
      i = newline === -1 ? text.length : newline
    } else if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2)
      i = close === -1 ? text.length : close + 2
    } else {
      code += ch
      i += 1
    }
  }
  let json = ""
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i]
    if (ch === '"') {
      let end = i + 1
      while (end < code.length && code[end] !== '"') end += code[end] === "\\" ? 2 : 1
      json += code.slice(i, end + 1)
      i = end
    } else if (ch === "," && /^\s*[}\]]/.test(code.slice(i + 1))) {
    } else json += ch
  }
  return JSON.parse(json.replace(/^\uFEFF/, ""))
}

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined

const isFile = (path: string): boolean =>
  statSync(path, { throwIfNoEntry: false })?.isFile() ?? false

const real = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** The file a path names: as written, its source for a `.js` name, with an extension, or an index. */
function probe(base: string): string | undefined {
  if (isFile(base)) return base
  const ext = extname(base)
  for (const source of SOURCE_FOR[ext] ?? []) {
    const candidate = `${base.slice(0, -ext.length)}${source}`
    if (isFile(candidate)) return candidate
  }
  for (const extension of EXTENSIONS)
    if (isFile(`${base}${extension}`)) return `${base}${extension}`
  for (const extension of EXTENSIONS) {
    const index = join(base, `index${extension}`)
    if (isFile(index)) return index
  }
  return undefined
}

/**
 * `file` written the way `written` names `found`: as is, without its extension, as its folder when
 * `found` is an index, or with the `.js` name of a `.ts` source.
 */
function sameStyle(written: string, found: string, file: string): string {
  if (written === found) return file
  const ext = extname(file)
  const bare = file.slice(0, file.length - ext.length)
  if (found.startsWith(`${written}/index.`) || found.startsWith(`${written}\\index.`))
    return basename(file).startsWith("index.") ? dirname(file) : bare
  if (found.startsWith(written)) return bare
  const writtenExt = extname(written)
  return SOURCE_FOR[writtenExt] === undefined ? file : `${bare}${writtenExt}`
}

/** Longest-prefix `*` match, TypeScript's rule for `paths` and Node's for `imports`. */
function matchPattern(
  patterns: readonly string[],
  specifier: string,
): { readonly pattern: string; readonly star: string | undefined } | undefined {
  if (patterns.includes(specifier)) return { pattern: specifier, star: undefined }
  let best: { pattern: string; star: string } | undefined
  for (const pattern of patterns) {
    const at = pattern.indexOf("*")
    if (at === -1 || pattern.indexOf("*", at + 1) !== -1) continue
    const prefix = pattern.slice(0, at)
    const suffix = pattern.slice(at + 1)
    if (specifier.length < prefix.length + suffix.length) continue
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue
    if (best !== undefined && prefix.length <= best.pattern.indexOf("*")) continue
    best = { pattern, star: specifier.slice(prefix.length, specifier.length - suffix.length) }
  }
  return best
}

export function createSpecifierResolver(): ProjectResolver {
  const configs = new Map<string, PathsConfig | undefined>()
  const tsconfigByDir = new Map<string, string | undefined>()
  const manifests = new Map<string, Readonly<Record<string, unknown>> | undefined>()
  const packageByDir = new Map<string, string | undefined>()

  const readJsonc = (path: string): Readonly<Record<string, unknown>> | undefined => {
    try {
      return record(parseJsonc(readFileSync(path, "utf8")))
    } catch {
      return undefined
    }
  }

  /** The nearest `tsconfig.json` (or `jsconfig.json`) at or above `dir`, as Bun's resolver picks it. */
  const tsconfigFor = (dir: string): string | undefined => {
    if (tsconfigByDir.has(dir)) return tsconfigByDir.get(dir)
    const own = ["tsconfig.json", "jsconfig.json"].map((name) => join(dir, name)).find(isFile)
    const parent = dirname(dir)
    const found = own ?? (parent === dir ? undefined : tsconfigFor(parent))
    tsconfigByDir.set(dir, found)
    return found
  }

  /** An `extends` entry's file: a path relative to the config, or a package found in `node_modules`. */
  const extendedConfig = (from: string, name: string): string | undefined => {
    const withJson = (path: string): string | undefined =>
      isFile(path) ? path : isFile(`${path}.json`) ? `${path}.json` : undefined
    if (name.startsWith("./") || name.startsWith("../") || isAbsolute(name))
      return withJson(join(dirname(from), name))
    for (let dir = dirname(from); ; dir = dirname(dir)) {
      const target = join(dir, "node_modules", name)
      const direct = withJson(target)
      if (direct !== undefined) return direct
      const manifest = readJsonc(join(target, "package.json"))
      const field = manifest?.tsconfig
      const nested =
        typeof field === "string"
          ? withJson(join(target, field))
          : withJson(join(target, "tsconfig"))
      if (nested !== undefined) return nested
      if (dirname(dir) === dir) return undefined
    }
  }

  /** The `paths` and `baseUrl` a config ends up with after its `extends` chain. */
  const pathsConfig = (
    file: string,
    seen: ReadonlySet<string> = new Set(),
  ): PathsConfig | undefined => {
    if (configs.has(file)) return configs.get(file)
    if (seen.has(file) || seen.size >= MAX_EXTENDS) return undefined
    const config = readJsonc(file)
    let inherited: PathsConfig | undefined
    const extended = config?.extends
    for (const name of typeof extended === "string"
      ? [extended]
      : Array.isArray(extended)
        ? extended
        : []) {
      if (typeof name !== "string") continue
      const base = extendedConfig(file, name)
      const parent = base === undefined ? undefined : pathsConfig(base, new Set([...seen, file]))
      if (parent === undefined) continue
      inherited = {
        paths: parent.paths.length > 0 ? parent.paths : (inherited?.paths ?? []),
        baseUrl: parent.baseUrl ?? inherited?.baseUrl,
        pathsBase:
          parent.paths.length > 0 ? parent.pathsBase : (inherited?.pathsBase ?? parent.pathsBase),
      }
    }
    const options = record(config?.compilerOptions)
    const baseUrl =
      typeof options?.baseUrl === "string"
        ? join(dirname(file), options.baseUrl)
        : inherited?.baseUrl
    const ownPaths = record(options?.paths)
    const paths =
      ownPaths === undefined
        ? (inherited?.paths ?? [])
        : Object.entries(ownPaths).map(
            ([pattern, targets]) =>
              [
                pattern,
                Array.isArray(targets)
                  ? targets.filter((t): t is string => typeof t === "string")
                  : [],
              ] as const,
          )
    const pathsBase =
      baseUrl ?? (ownPaths === undefined ? (inherited?.pathsBase ?? dirname(file)) : dirname(file))
    const resolved = config === undefined ? undefined : { paths, baseUrl, pathsBase }
    configs.set(file, resolved)
    return resolved
  }

  // Keyed by config, not directory: every package name reaches here, from every folder of the project.
  const aliases = new Map<string, string | undefined>()
  const viaTsconfig = (fromFile: string, specifier: string): string | undefined => {
    const tsconfig = tsconfigFor(dirname(fromFile))
    if (tsconfig === undefined) return undefined
    const key = `${tsconfig}\0${specifier}`
    if (aliases.has(key)) return aliases.get(key)
    const found = aliasTarget(tsconfig, specifier)
    aliases.set(key, found)
    return found
  }
  const aliasTarget = (tsconfig: string, specifier: string): string | undefined =>
    pathsRule(tsconfig, specifier)?.found

  /** The nearest package.json at or above `dir`: the package scope Node reads `imports` from. */
  const packageFor = (dir: string): string | undefined => {
    if (packageByDir.has(dir)) return packageByDir.get(dir)
    const own = join(dir, "package.json")
    const parent = dirname(dir)
    const found = isFile(own) ? own : parent === dir ? undefined : packageFor(parent)
    packageByDir.set(dir, found)
    return found
  }

  const importTarget = (target: unknown, star: string | undefined): string | undefined => {
    if (typeof target === "string")
      return target.startsWith("./") ? target.replaceAll("*", star ?? "") : undefined
    if (Array.isArray(target)) {
      for (const entry of target) {
        const found = importTarget(entry, star)
        if (found !== undefined) return found
      }
      return undefined
    }
    const conditions = record(target)
    if (conditions === undefined) return undefined
    for (const [condition, value] of Object.entries(conditions)) {
      if (CONDITIONS.has(condition)) return importTarget(value, star)
    }
    return undefined
  }

  const importsRule = (fromFile: string, specifier: string): AliasRule | undefined => {
    const manifestPath = packageFor(dirname(fromFile))
    if (manifestPath === undefined) return undefined
    if (!manifests.has(manifestPath)) manifests.set(manifestPath, readJsonc(manifestPath))
    const imports = record(manifests.get(manifestPath)?.imports)
    if (imports === undefined) return undefined
    const keys = Object.keys(imports)
    const match = matchPattern(keys, specifier)
    if (match === undefined) return undefined
    const template = importTarget(imports[match.pattern], STAR)
    if (template === undefined) return undefined
    const base = dirname(manifestPath)
    const written = join(base, template.replaceAll(STAR, match.star ?? ""))
    const found = probe(written)
    return found === undefined
      ? undefined
      : { key: match.pattern, keys, base, templates: [template], written, found }
  }
  const viaImports = (fromFile: string, specifier: string): string | undefined =>
    importsRule(fromFile, specifier)?.found

  const tsconfigRule = (fromFile: string, specifier: string): AliasRule | undefined => {
    const tsconfig = tsconfigFor(dirname(fromFile))
    return tsconfig === undefined ? undefined : pathsRule(tsconfig, specifier)
  }
  const pathsRule = (tsconfig: string, specifier: string): AliasRule | undefined => {
    const config = pathsConfig(tsconfig)
    if (config === undefined) return undefined
    const keys = config.paths.map(([pattern]) => pattern)
    const match = matchPattern(keys, specifier)
    if (match === undefined) {
      if (config.baseUrl === undefined) return undefined
      const written = join(config.baseUrl, specifier)
      const found = probe(written)
      return found === undefined
        ? undefined
        : { key: undefined, keys, base: config.baseUrl, templates: [STAR], written, found }
    }
    // TypeScript permits at most one wildcard in each substitution, as in the alias key.
    const targets = (config.paths.find(([pattern]) => pattern === match.pattern)?.[1] ?? []).filter(
      (target) => target.indexOf("*") === target.lastIndexOf("*"),
    )
    for (const target of targets) {
      const written = join(config.pathsBase, target.replaceAll("*", match.star ?? ""))
      const found = probe(written)
      if (found === undefined) continue
      const templates = targets.map((t) => t.replaceAll("*", STAR))
      return { key: match.pattern, keys, base: config.pathsBase, templates, written, found }
    }
    return undefined
  }

  const respell = (fromFile: string, specifier: string, file: string): string | undefined => {
    if (/^\.\.?(?:\/|$)/.test(specifier) || isAbsolute(specifier)) return undefined
    const rule =
      (specifier.startsWith("#") ? importsRule(fromFile, specifier) : undefined) ??
      tsconfigRule(fromFile, specifier)
    if (rule === undefined) return undefined
    const spelled = sameStyle(rule.written, rule.found, file)
    for (const template of rule.templates) {
      const at = template.indexOf(STAR)
      if (at === -1) continue
      // An empty head still ends at a folder boundary: `src2/x` is not under a `baseUrl` of `src`.
      const prefix = join(rule.base, template.slice(0, at) || "./")
      const suffix = template.slice(at + STAR.length)
      if (!spelled.startsWith(prefix) || !spelled.endsWith(suffix)) continue
      if (spelled.length < prefix.length + suffix.length) continue
      const star = spelled
        .slice(prefix.length, spelled.length - suffix.length)
        .replaceAll("\\", "/")
      if (star === "" || star.startsWith("/")) continue
      const keyAt = rule.key?.indexOf("*") ?? 0
      if (keyAt === -1) continue
      const next =
        rule.key === undefined
          ? star
          : `${rule.key.slice(0, keyAt)}${star}${rule.key.slice(keyAt + 1)}`
      // The rewritten name must take the same route: another, longer pattern would claim it.
      if (matchPattern(rule.keys, next)?.pattern !== rule.key) continue
      return next
    }
    return undefined
  }

  const resolved = new Map<string, string | undefined>()
  const resolve: SpecifierResolver = (fromFile, specifier) => {
    // Every rule below reads only the importing file's directory, so the answer is the directory's.
    const key = `${dirname(fromFile)}\0${specifier}`
    if (resolved.has(key)) return resolved.get(key)
    const path = resolveFrom(fromFile, specifier)
    resolved.set(key, path)
    return path
  }
  const pathPatterns = (dir: string): readonly string[] => {
    const tsconfig = tsconfigFor(dir)
    const config = tsconfig === undefined ? undefined : pathsConfig(tsconfig)
    return (config?.paths ?? []).map(([pattern]) => pattern)
  }

  return Object.assign(resolve, { respell, pathPatterns })

  function resolveFrom(fromFile: string, specifier: string): string | undefined {
    let found: string | undefined
    if (
      specifier.startsWith("./") ||
      specifier.startsWith("../") ||
      specifier === "." ||
      specifier === ".."
    )
      found = probe(join(dirname(fromFile), specifier))
    else if (isAbsolute(specifier)) found = probe(specifier)
    // A `#` name is a package.json import first; a tsconfig may still map it.
    else if (specifier.startsWith("#"))
      found = viaImports(fromFile, specifier) ?? viaTsconfig(fromFile, specifier)
    else found = viaTsconfig(fromFile, specifier)
    if (found === undefined) return undefined
    const path = real(found)
    return /[\\/]node_modules[\\/]/.test(path) ? undefined : path
  }
}

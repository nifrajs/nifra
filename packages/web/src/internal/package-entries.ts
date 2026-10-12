/**
 * Per-entry package sides: `"nifra": { "environment": { ".": "backend", "./react": "frontend" } }`.
 *
 * An import names an entry, and that entry's side decides it. A path names no entry, so a file is owned
 * by every mapped entry that reaches it inside the package: the entry's targets under any export
 * condition, followed through relative imports. A stage that sees only paths decides by those owners;
 * which entry an import may name is decided where the import is written, from its specifier.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { dirname, extname, join, relative } from "node:path"
import type { PackageEnvironment } from "../zones.ts"
import { type Token, tokenize } from "./private-env.ts"
import { withoutQuery } from "./without-query.ts"

export type EnvironmentDeclaration =
  | { readonly kind: "none" }
  | { readonly kind: "package"; readonly side: PackageEnvironment }
  | { readonly kind: "entries"; readonly entries: Readonly<Record<string, PackageEnvironment>> }
  | { readonly kind: "invalid"; readonly problem: string }

const SIDES: ReadonlySet<string> = new Set(["frontend", "backend", "shared", "library"])
const isSide = (value: unknown): value is PackageEnvironment =>
  typeof value === "string" && SIDES.has(value)

/** A manifest's `nifra.environment`. A string naming no side declares nothing, as it always has. */
export function parseEnvironment(value: unknown): EnvironmentDeclaration {
  if (isSide(value)) return { kind: "package", side: value }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { kind: "none" }
  const entries: Record<string, PackageEnvironment> = {}
  for (const [key, side] of Object.entries(value)) {
    if (key !== "." && !key.startsWith("./"))
      return {
        kind: "invalid",
        problem: `key "${key}" must be "." or a subpath starting with "./"`,
      }
    if (key.indexOf("*") !== key.lastIndexOf("*"))
      return { kind: "invalid", problem: `key "${key}" may hold one "*"` }
    if (!isSide(side))
      return {
        kind: "invalid",
        problem: `"${key}" must be one of frontend, backend, shared, library`,
      }
    entries[key] = side
  }
  return Object.keys(entries).length === 0
    ? {
        kind: "invalid",
        problem: 'maps no entry; give each export subpath (".", "./react") a side',
      }
    : { kind: "entries", entries }
}

/**
 * The mapped key that decides `subpath`: the exact key, else the `*` pattern with the longest prefix,
 * then the longest key, where `*` matches at least one character - as Node matches `exports`.
 */
export function entryKey(
  entries: Readonly<Record<string, PackageEnvironment>>,
  subpath: string,
): string | undefined {
  if (Object.hasOwn(entries, subpath)) return subpath
  let best: string | undefined
  for (const key of Object.keys(entries)) {
    const star = key.indexOf("*")
    if (star === -1 || subpath.length < key.length) continue
    if (!subpath.startsWith(key.slice(0, star)) || !subpath.endsWith(key.slice(star + 1))) continue
    const bestStar = best?.indexOf("*") ?? -1
    if (best === undefined || star > bestStar || (star === bestStar && key.length > best.length))
      best = key
  }
  return best
}

export interface EntryOwnership {
  /** Each file a mapped entry reaches, by real path, with the sides of every entry that reaches it. */
  readonly owners: ReadonlyMap<string, ReadonlySet<PackageEnvironment>>
  /** Export subpaths the map gives no side. */
  readonly unmapped: readonly string[]
}

const isFile = (path: string): boolean =>
  statSync(path, { throwIfNoEntry: false })?.isFile() ?? false

const real = (path: string): string => {
  try {
    return realpathSync.native(path).replaceAll("\\", "/")
  } catch {
    return path.replaceAll("\\", "/")
  }
}

const SCRIPT = /\.(?:[cm]?[jt]sx?|svelte|vue)$/
const STYLESHEET = /\.(?:css|scss|sass|less|styl)$/
const DECLARATION = /\.d\.[cm]?ts$/
const PROBE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"]
/** A TypeScript source imports its sibling by the extension it compiles to. */
const SOURCE_TWINS: Readonly<Record<string, readonly string[]>> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
}

function probe(base: string): string | undefined {
  if (isFile(base)) return base
  const extension = extname(base)
  for (const twin of SOURCE_TWINS[extension] ?? []) {
    const candidate = `${base.slice(0, -extension.length)}${twin}`
    if (isFile(candidate)) return candidate
  }
  for (const candidate of PROBE_EXTENSIONS.map((ext) => `${base}${ext}`)) {
    if (isFile(candidate)) return candidate
  }
  for (const candidate of PROBE_EXTENSIONS.map((ext) => join(base, `index${ext}`))) {
    if (isFile(candidate)) return candidate
  }
  return undefined
}

const CLAUSE_PUNCT: ReadonlySet<string> = new Set(["{", "}", ",", "*"])
const isPunct = (token: Token | undefined, value: string): boolean =>
  token?.kind === "punct" && token.value === value
const isId = (token: Token | undefined, value: string): boolean =>
  token?.kind === "id" && token.value === value

/**
 * Whether the `import`/`export` clause ending at the `from` token `at` binds only types: `import type`,
 * `export type`, or a `{ }` list whose every specifier is `type`. Such an edge grants no ownership - a
 * backend file a frontend entry merely types against stays backend. `import { type A }` survives as
 * `import {}` under Vite with `verbatimModuleSyntax`; dropping it then fails closed, since the guard
 * judges that load by the file's remaining owners.
 */
function typeOnlyClause(tokens: readonly Token[], at: number): boolean {
  let start = at - 1
  for (; start >= 0; start--) {
    const token = tokens[start]
    if (isId(token, "import") || isId(token, "export")) break
    if (token?.kind !== "id" && !(token?.kind === "punct" && CLAUSE_PUNCT.has(token.value)))
      return false
  }
  if (start < 0) return false
  const clause = tokens.slice(start + 1, at)
  // `import type from "./x"` and `import type, { a } from` bind a default import named `type`.
  if (isId(clause[0], "type")) return clause.length > 1 && !isPunct(clause[1], ",")
  if (!isPunct(clause[0], "{") || !isPunct(clause.at(-1), "}")) return false
  const specifiers: Token[][] = [[]]
  for (const token of clause.slice(1, -1)) {
    if (isPunct(token, ",")) specifiers.push([])
    else specifiers.at(-1)?.push(token)
  }
  const named = specifiers.filter((specifier) => specifier.length > 0)
  // `{ type as x }` imports a value named `type`; `{ type A }` and `{ type A as B }` import types.
  return (
    named.length > 0 &&
    named.every(
      (specifier) =>
        isId(specifier[0], "type") &&
        (specifier.length === 2 || (specifier.length === 4 && isId(specifier[2], "as"))),
    )
  )
}

/** The relative specifiers a module loads: imports, re-exports, `import()`s, `require`s and
 * `new URL()`s (a worker or an asset beside it). A clause binding only types loads nothing. */
function relativeImports(code: string): string[] {
  const tokens = tokenize(code)
  const found: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token?.kind !== "id") continue
    const previous = tokens[i - 1]
    if (previous?.kind === "punct" && previous.value === ".") continue
    let next = tokens[i + 1]
    const call = next?.kind === "punct" && next.value === "("
    const url = token.value === "URL" && previous?.kind === "id" && previous.value === "new"
    if (token.value === "require" || url || (token.value === "import" && call)) {
      if (!call) continue
      next = tokens[i + 2]
    } else if (token.value !== "from" && token.value !== "import") continue
    if (next?.kind !== "string" || !/^\.\.?\//.test(next.value)) continue
    if (token.value === "from" && typeOnlyClause(tokens, i)) continue
    found.push(next.value)
  }
  return found
}

/** What a stylesheet pulls in beside it: `@import`s and `url()`s that name no scheme or root. */
function stylesheetImports(code: string): string[] {
  const text = code.replace(/\/\*[\s\S]*?\*\//g, "")
  const found: string[] = []
  for (const match of text.matchAll(
    /@import\s+(?:url\(\s*)?["']?([^"'()\s;]+)|url\(\s*["']?([^"'()\s]+)/g,
  )) {
    const reference = match[1] ?? match[2] ?? ""
    if (reference !== "" && !/^(?:[a-z][\w+.-]*:|\/|#|~)/i.test(reference)) found.push(reference)
  }
  return found
}

/** Every string target of an export value, under every condition. */
function targetsOf(value: unknown): string[] {
  if (typeof value === "string") return value.startsWith("./") ? [value] : []
  if (Array.isArray(value)) return value.flatMap(targetsOf)
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(targetsOf)
  return []
}

/** `exports` as subpath entries; without it, the root is `main`/`module`/`browser` and any file a subpath. */
function exportEntries(
  manifest: Readonly<Record<string, unknown>>,
  entries: Readonly<Record<string, PackageEnvironment>>,
): Array<readonly [string, readonly string[]]> {
  const exports = manifest.exports
  if (exports === undefined || exports === null) {
    const roots = [manifest.main, manifest.module, manifest.browser]
      .filter((root): root is string => typeof root === "string")
      .map((root) => (root.startsWith("./") ? root : `./${root}`))
    return [
      [".", roots.length > 0 ? roots : ["./index.js"]],
      ...Object.keys(entries)
        .filter((key) => key !== ".")
        .map((key) => [key, [key]] as const),
    ]
  }
  if (typeof exports !== "object" || Array.isArray(exports)) return [[".", targetsOf(exports)]]
  const keys = Object.keys(exports)
  if (keys.length === 0 || !keys.every((key) => key.startsWith(".")))
    return [[".", targetsOf(exports)]]
  return Object.entries(exports).map(([key, value]) => [key, targetsOf(value)] as const)
}

/** Every file under `dir`, outside `node_modules`. */
function filesUnder(dir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(dir, { recursive: true, encoding: "utf8" })
  } catch {
    return []
  }
  return names
    .filter((name) => !/(?:^|[\\/])node_modules(?:[\\/]|$)/.test(name))
    .map((name) => join(dir, name))
    .filter(isFile)
}

/** Which mapped entries reach each file of the package at `dir` (a real path). */
export function entryOwnership(
  dir: string,
  manifest: Readonly<Record<string, unknown>>,
  entries: Readonly<Record<string, PackageEnvironment>>,
): EntryOwnership {
  const owners = new Map<string, Set<PackageEnvironment>>()
  const unmapped = new Set<string>()
  const queue: Array<readonly [string, PackageEnvironment]> = []
  const reach = (path: string, side: PackageEnvironment): void => {
    const file = real(path)
    if (!file.startsWith(`${dir}/`) || file.slice(dir.length).includes("/node_modules/")) return
    const sides = owners.get(file) ?? new Set<PackageEnvironment>()
    if (sides.has(side)) return
    sides.add(side)
    owners.set(file, sides)
    queue.push([file, side])
  }
  const sideOf = (subpath: string, exportKey = subpath): PackageEnvironment | undefined => {
    const key = entryKey(entries, subpath)
    if (key === undefined) unmapped.add(exportKey)
    return key === undefined ? undefined : entries[key]
  }
  for (const [key, targets] of exportEntries(manifest, entries)) {
    const star = key.indexOf("*")
    if (star === -1) {
      const side = sideOf(key)
      if (side === undefined) continue
      for (const target of targets) {
        const file = target.includes("*") ? undefined : probe(join(dir, target))
        if (file !== undefined) reach(file, side)
      }
      continue
    }
    // A pattern entry: each file a target pattern matches is the subpath its `*` spells.
    for (const target of targets) {
      const at = target.indexOf("*")
      if (at === -1) continue
      const prefix = target.slice(0, at)
      const suffix = target.slice(at + 1)
      for (const file of filesUnder(join(dir, prefix.slice(0, prefix.lastIndexOf("/") + 1)))) {
        const path = `./${relative(dir, file).replaceAll("\\", "/")}`
        if (path.length <= prefix.length + suffix.length) continue
        if (!path.startsWith(prefix) || !path.endsWith(suffix)) continue
        const matched = path.slice(prefix.length, path.length - suffix.length)
        const side = sideOf(`${key.slice(0, star)}${matched}${key.slice(star + 1)}`, key)
        if (side !== undefined) reach(file, side)
      }
    }
  }
  const imports = new Map<string, readonly string[]>()
  for (const [file, side] of queue) {
    const script = SCRIPT.test(file) && !DECLARATION.test(file)
    if (!script && !STYLESHEET.test(file)) continue
    let specifiers = imports.get(file)
    if (specifiers === undefined) {
      try {
        const code = readFileSync(file, "utf8")
        specifiers = script ? relativeImports(code) : stylesheetImports(code)
      } catch {
        specifiers = []
      }
      imports.set(file, specifiers)
    }
    for (const specifier of specifiers) {
      const found = probe(join(dirname(file), withoutQuery(specifier)))
      if (found !== undefined) reach(found, side)
    }
  }
  return { owners, unmapped: [...unmapped].sort() }
}

/**
 * The `package.json` of the installed package `name`, as Node finds it: the nearest
 * `node_modules/<name>` at or above `fromDir`.
 */
export function installedManifest(fromDir: string, name: string): string | undefined {
  let dir = fromDir
  for (;;) {
    const manifest = join(dir, "node_modules", name, "package.json")
    if (isFile(manifest)) return manifest
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

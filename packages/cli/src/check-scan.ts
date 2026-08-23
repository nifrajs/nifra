/**
 * Pure source scanners for the nifra verification pipeline.
 *
 * This module deliberately has no CLI, policy, or diagnostic-view dependencies. Its interface is
 * source text plus injected module/type resolvers, which keeps the scanner seam independently testable.
 */

import { readFileSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import { Glob } from "bun"
import type * as TSApi from "typescript"
import type { SourceFacts } from "./internal/source-facts.ts"
import { importProjectTypeScript, type TypeScriptApi } from "./internal/typescript-import.ts"
import { commentBlockMarkerReason } from "./rules/comment-markers.ts"

export interface SourceFinding {
  readonly file: string
  readonly line: number
  readonly snippet: string
}
/** A server-only-import finding, carrying the offending module specifier on top of the base location so
 * the diagnostic can show the import chain `routeFile → specifier` (the direct edge the regex scan sees). */
export interface ServerImportFinding extends SourceFinding {
  /** The server-only module specifier the route top-level-imports (e.g. `pg`, `node:fs`, `../db`). */
  readonly specifier: string
}

// `fetch( <ws> ('|"|`) / (not /)` - a string/template arg starting with a single `/` is a relative URL,
// i.e. same-origin = this app's own API. `(?<![.\w])` skips `.fetch(` (a method) and `prefetch(`; the
// `(?!\/)` skips protocol-relative `//host` (an external origin). A variable arg (`fetch(url)`) is left
// alone on purpose - undecidable from source, and flagging it would punish legitimate external calls.
const GLOBAL_FETCH_CALL = /(?<![.\w])fetch\s*\(/g
const FETCH_CALL = /(?<![.\w])fetch\s*\(/g
const HTTP_VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
export const SIMPLE_REWRITE_METHODS = new Set(["GET", "DELETE", "HEAD", "OPTIONS"])

// Don't scan deps, build output, or generated client entries. `dist(-<runtime>)?` also covers
// per-runtime output dirs (dist-bun/dist-node/dist-deno/dist-vercel). Never source, for any scan.
const IGNORED_DIR =
  /(^|\/)(node_modules|dist(-[a-z0-9]+)?|build|\.nifra|\.git|\.wrangler|coverage)\//
// A test/spec module. Excluded from `nifra check`'s scans, which are about what SHIPS - a test
// legitimately drives `fetch`, hand-rolls a client, and calls a route directly. It is NOT excluded from
// `nifra doctor`: tsc typechecks tests, so an import a test declares nowhere is a real broken build.
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/
const IGNORED = new RegExp(`${IGNORED_DIR.source}|${TEST_FILE.source}`)

/** Paths crossing the scanner boundary are project-relative identifiers, not filesystem paths. Keep
 * them stable across runtimes so rules, diagnostics, ignore globs, and import chains have one shape. */
const normalizeProjectPath = (path: string): string => path.replaceAll("\\", "/")

// A file under `routes/` - a page module bundled for the browser, where a server-only import is unsafe.
const ROUTE_FILE = /(^|\/)routes\//

// Module specifiers that must never be VALUE-imported into a route module: node:/bun: builtins, common
// DB drivers/ORМ server entrypoints, and the conventional `./db` module the scaffold generates.
const SERVER_ONLY =
  /^(?:node:|bun:)|^(?:postgres|pg|mysql2|ioredis|redis|better-sqlite3|mongodb|@libsql\/client)$|^drizzle-orm\/(?:node-postgres|postgres-js|bun-sqlite|libsql|mysql2|pglite)\b|^(?:\.\.?\/)+db(?:\.[cm]?[jt]sx?)?$/

// A static, non-type import with a string specifier. `import type …` is erased at build, so it's safe
// and skipped. Dynamic `import(…)` (the correct way to lazy-load server code in a loader) has `(` right
// after `import`, so `import\s+` never matches it.
const STATIC_IMPORT = /\bimport\s+(?!type\b)(?:[^'"();]*?\bfrom\s+)?['"]([^'"]+)['"]/g

const ROUTE_REGISTRATION_DQ = /\.([A-Za-z]+)\s*\(\s*"((?:\\.|[^"\\])*)"/g
const ROUTE_REGISTRATION_SQ = /\.([A-Za-z]+)\s*\(\s*'((?:\\.|[^'\\])*)'/g
export const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

export interface StaticRouteFinding extends SourceFinding {
  readonly method: string
  readonly path: string
}

interface SimpleFetchCall {
  readonly path: string
  readonly method: string
  readonly start: number
  readonly end: number
}

/** Line number (1-based) of a match index within `content`. */
const lineAt = (content: string, index: number): number =>
  content.slice(0, index).split("\n").length

function parseQuotedLiteral(raw: string): string | undefined {
  try {
    return JSON.parse(raw) as string
  } catch {
    if (!raw.startsWith("'") || !raw.endsWith("'")) return undefined
    try {
      // Convert the single-quoted body to a JSON string body by scan, handling backslash pairs
      // atomically: `\'` becomes `'`, other escapes pass through untouched, and a bare `"` is
      // escaped. A quote-only `replace` mis-handles content with backslashes (double-escaping
      // an already-escaped quote, or letting a trailing backslash swallow the added escape).
      const inner = raw.slice(1, -1)
      let body = ""
      for (let i = 0; i < inner.length; i++) {
        const ch = inner[i] as string
        if (ch === "\\" && i + 1 < inner.length) {
          const next = inner[i + 1] as string
          body += next === "'" ? "'" : ch + next
          i++
        } else if (ch === '"') {
          body += '\\"'
        } else {
          body += ch
        }
      }
      return JSON.parse(`"${body}"`) as string
    } catch {
      return undefined
    }
  }
}

function findMatchingParen(src: string, openIndex: number): number | undefined {
  let depth = 0
  let quote: '"' | "'" | "`" | undefined
  for (let i = openIndex; i < src.length; i++) {
    const c = src[i]
    if (quote !== undefined) {
      if (c === "\\") {
        i++
        continue
      }
      if (c === quote) quote = undefined
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c
      continue
    }
    if (c === "(") depth++
    else if (c === ")") {
      depth--
      if (depth === 0) return i
    }
  }
  return undefined
}

function splitTopLevelArgs(src: string): string[] | undefined {
  const args: string[] = []
  let start = 0
  let depth = 0
  let quote: '"' | "'" | "`" | undefined
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quote !== undefined) {
      if (c === "\\") {
        i++
        continue
      }
      if (c === quote) quote = undefined
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c
      continue
    }
    if (c === "(" || c === "{" || c === "[") depth++
    else if (c === ")" || c === "}" || c === "]") depth--
    else if (c === "," && depth === 0) {
      args.push(src.slice(start, i).trim())
      start = i + 1
    }
  }
  if (quote !== undefined || depth !== 0) return undefined
  const tail = src.slice(start).trim()
  if (tail !== "") args.push(tail)
  return args
}

function parseMethodOnlyInit(raw: string | undefined): string | undefined {
  if (raw === undefined) return "GET"
  const init = raw.trim()
  if (!/^\{[\s\S]*\}$/.test(init)) return undefined
  const body = init.slice(1, -1).trim()
  if (body === "") return "GET"
  const m = /^(?:"method"|'method'|method)\s*:\s*(["'])([A-Za-z]+)\1\s*,?$/.exec(body)
  if (!m) return undefined
  const method = (m[2] ?? "").toUpperCase()
  return HTTP_VERBS.has(method) ? method : undefined
}

export function parseSimpleFetchCall(snippet: string): SimpleFetchCall | undefined {
  FETCH_CALL.lastIndex = 0
  const matches = [...snippet.matchAll(FETCH_CALL)]
  if (matches.length !== 1) return undefined
  const match = matches[0]
  if (match === undefined || match.index === undefined) return undefined
  const open = match.index + match[0].lastIndexOf("(")
  const close = findMatchingParen(snippet, open)
  if (close === undefined) return undefined

  const args = splitTopLevelArgs(snippet.slice(open + 1, close))
  if (args === undefined || args.length === 0 || args.length > 2) return undefined
  const first = args[0] ?? ""
  const quote = first[0]
  if ((quote !== '"' && quote !== "'") || first[first.length - 1] !== quote) return undefined
  const path = parseQuotedLiteral(first)
  if (
    path === undefined ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("?") ||
    path.includes("#")
  ) {
    return undefined
  }
  const method = parseMethodOnlyInit(args[1])
  if (method === undefined) return undefined
  return { path, method, start: match.index, end: close + 1 }
}

function isPotentialBackendSource(code: string): boolean {
  return (
    code.includes("@nifrajs/core") ||
    /(?<![.\w])server\s*\(/.test(code) ||
    /(?:from\s*|import\s*)["']hono["']/.test(code) ||
    /new\s+Hono(?:<[^>]+>)?\s*\(/.test(code)
  )
}

function scanRoutePattern(
  file: string,
  content: string,
  code: string,
  pattern: RegExp,
  facts?: SourceFacts,
): StaticRouteFinding[] {
  const out: StaticRouteFinding[] = []
  const lines = content.split("\n")
  pattern.lastIndex = 0
  for (let m = pattern.exec(code); m !== null; m = pattern.exec(code)) {
    const method = (m[1] ?? "").toUpperCase()
    if (!HTTP_VERBS.has(method)) continue
    const path = parseQuotedLiteral(
      `${pattern === ROUTE_REGISTRATION_DQ ? '"' : "'"}${m[2] ?? ""}${pattern === ROUTE_REGISTRATION_DQ ? '"' : "'"}`,
    )
    if (path === undefined || !path.startsWith("/") || path.startsWith("//")) continue
    if (facts !== undefined) {
      const source = facts.parse(file, content)
      // A parseable source model is authoritative for candidate locations. If parsing is unavailable
      // or the source is malformed, retain the lexical finding and fail closed.
      if (
        source !== undefined &&
        facts.isRouteRegistrationAt(source, m.index, method, path) !== true
      )
        continue
    }
    const line = lineAt(content, m.index)
    out.push({ file, line, snippet: (lines[line - 1] ?? "").trim(), method, path })
  }
  return out
}

/**
 * Blank, with spaces (newlines preserved, so every byte offset - and line number - is unchanged):
 *   - `//` line comments and block comments;
 *   - the CONTENTS of backtick template literals - code-as-text (doc `CodeBlock` examples, code
 *     generators), never a real statement to lint.
 * Single/double-quoted strings are KEPT (a real import/Response specifier lives in one). A small
 * char-state machine, not a full lexer: it doesn't model regex literals, so a regex containing a quote
 * could mis-skip - in practice the constructs these scanners look for sit before any such regex.
 * Shared by the source scanners here and by `nifra doctor` ({@link ./doctor.ts}).
 */
export function stripComments(src: string): string {
  const out = src.split("")
  const n = src.length
  let i = 0
  const blank = (a: number, b: number): void => {
    for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " "
  }
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === "/" && d === "/") {
      let j = i + 2
      while (j < n && src[j] !== "\n") j++
      blank(i, j)
      i = j
    } else if (c === "/" && d === "*") {
      let j = i + 2
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++
      j = Math.min(j + 2, n)
      blank(i, j)
      i = j
    } else if (c === "`") {
      let j = i + 1
      while (j < n && src[j] !== "`") {
        if (src[j] === "\\") j++
        j++
      }
      blank(i + 1, j) // keep the backticks, blank the code-as-text inside
      i = j + 1
    } else if (c === "'" || c === '"') {
      let j = i + 1
      while (j < n && src[j] !== c) {
        if (src[j] === "\\") j++ // skip the escaped char
        j++
      }
      i = j + 1
    } else {
      i++
    }
  }
  return out.join("")
}

/** Blank comments and every quoted/template literal while preserving offsets. Unlike
 * {@link stripComments}, this is a code-position mask: scanners use it to find a call expression in
 * executable code, then inspect the original source for the call's literal argument. That prevents
 * documentation strings such as `const example = 'client("/")'` from becoming diagnostics. */
export function codePositionMask(src: string): string {
  const out = src.split("")
  const n = src.length
  let i = 0
  const blank = (a: number, b: number): void => {
    for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " "
  }
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === "/" && d === "/") {
      let j = i + 2
      while (j < n && src[j] !== "\n") j++
      blank(i, j)
      i = j
    } else if (c === "/" && d === "*") {
      let j = i + 2
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++
      j = Math.min(j + 2, n)
      blank(i, j)
      i = j
    } else if (c === "'" || c === '"' || c === "`") {
      const quote = c
      let j = i + 1
      while (j < n && src[j] !== quote) {
        if (src[j] === "\\") j++
        j++
      }
      j = Math.min(j + 1, n)
      blank(i, j)
      i = j
    } else {
      i++
    }
  }
  return out.join("")
}

const firstArgumentIndex = (content: string, callEnd: number): number => {
  let index = callEnd
  while (/\s/.test(content[index] ?? "")) index++
  return index
}

// Read the literal URL path of a `fetch("/…")` call starting at `start` (the index of the leading `/`),
// stopping at the first quote / query / hash / template-expression boundary, and test it against the
// allowlist. A template like `/auth/${id}` matches on its literal head (`/auth`), so a dynamic sign-in URL
// is covered too. Match is segment-anchored - `/auth` blesses `/auth` and `/auth/**`, never `/authors`.
function matchesExternalMount(content: string, start: number, mounts: readonly string[]): boolean {
  let end = start
  while (end < content.length) {
    const ch = content[end]
    if (ch === "'" || ch === '"' || ch === "`" || ch === "?" || ch === "#") break
    if (ch === "$" && content[end + 1] === "{") break
    end++
  }
  const path = content.slice(start, end)
  // A `..` segment means the runtime path escapes the literal prefix (`/auth/../api/admin` resolves to
  // `/api/admin`), so it must NOT be blessed by an `/auth` mount - never let traversal hide a real own-API
  // fetch. Match is otherwise segment-anchored (`/auth` blesses `/auth` and `/auth/**`, never `/authors`).
  try {
    if (path.split("/").some((segment) => decodeURIComponent(segment) === "..")) return false
  } catch {
    // A malformed escape is not a prefix we can prove stays inside the external mount.
    return false
  }
  return mounts.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

function findTopLevelPropertyColon(src: string): number | undefined {
  let depth = 0
  let quote: '"' | "'" | "`" | undefined
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quote !== undefined) {
      if (c === "\\") {
        i++
        continue
      }
      if (c === quote) quote = undefined
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c
      continue
    }
    if (c === "(" || c === "{" || c === "[") depth++
    else if (c === ")" || c === "}" || c === "]") depth--
    else if (c === ":" && depth === 0) return i
  }
  return undefined
}

function parseStaticPropertyName(raw: string): string | undefined {
  const name = raw.trim()
  if (IDENT.test(name)) return name
  const quoted = parseQuotedLiteral(name)
  if (quoted !== undefined) return quoted
  if (name.startsWith("[") && name.endsWith("]")) {
    return parseQuotedLiteral(name.slice(1, -1).trim())
  }
  return undefined
}

/** Return a statically named property from a plain object literal. Deliberately does not follow
 * spreads, identifiers, or helper calls: only an inline literal proves this fetch is Nifra's page-data
 * transport rather than an arbitrary same-origin API request. */
function staticObjectProperty(raw: string | undefined, name: string): string | undefined {
  if (raw === undefined) return undefined
  const object = raw.trim()
  if (!object.startsWith("{") || !object.endsWith("}")) return undefined
  const properties = splitTopLevelArgs(object.slice(1, -1))
  if (properties === undefined) return undefined
  for (const property of properties) {
    const colon = findTopLevelPropertyColon(property)
    if (colon === undefined || parseStaticPropertyName(property.slice(0, colon)) !== name) continue
    return property.slice(colon + 1).trim()
  }
  return undefined
}

function hasLiteralNifraDataHeader(content: string, openParen: number): boolean {
  const closeParen = findMatchingParen(content, openParen)
  if (closeParen === undefined) return false
  const args = splitTopLevelArgs(content.slice(openParen + 1, closeParen))
  if (args === undefined || args.length !== 2) return false
  const headers = staticObjectProperty(args[1], "headers")
  return staticObjectProperty(headers, "x-nifra-data") !== undefined
}

/** Scan one file's text for hand-rolled own-API `fetch()` calls. Pure + line-accurate. `externalMounts`
 * are intentional non-typed mount prefixes (from `nifra.check.json`, e.g. a mounted better-auth owning
 * `/auth/**`) - a relative fetch into one is deliberate, not drift, so it's skipped. A fetch with an
 * inline literal `x-nifra-data` header is Nifra's page-loader transport, not a backend API call, and is
 * skipped too. */
export function scanFetchText(
  file: string,
  content: string,
  externalMounts: readonly string[] = [],
): SourceFinding[] {
  const out: SourceFinding[] = []
  const lines = content.split("\n")
  const code = codePositionMask(content)
  GLOBAL_FETCH_CALL.lastIndex = 0
  for (let m = GLOBAL_FETCH_CALL.exec(code); m !== null; m = GLOBAL_FETCH_CALL.exec(code)) {
    const argument = firstArgumentIndex(content, m.index + m[0].length)
    const quote = content[argument]
    if (quote !== "'" && quote !== '"' && quote !== "`") continue
    if (content[argument + 1] !== "/" || content[argument + 2] === "/") continue
    const openParen = m.index + m[0].lastIndexOf("(")
    if (hasLiteralNifraDataHeader(content, openParen)) continue
    if (externalMounts.length > 0 && matchesExternalMount(content, argument + 1, externalMounts))
      continue
    const line = lineAt(content, m.index)
    out.push({ file, line, snippet: (lines[line - 1] ?? "").trim() })
  }
  return out
}

/** Statically collect simple Nifra route registrations from source, without importing app code. */
export function scanStaticRouteText(
  file: string,
  content: string,
  facts?: SourceFacts,
): StaticRouteFinding[] {
  const code = stripComments(content)
  if (!isPotentialBackendSource(code)) return []
  return [
    ...scanRoutePattern(file, content, code, ROUTE_REGISTRATION_DQ, facts),
    ...scanRoutePattern(file, content, code, ROUTE_REGISTRATION_SQ, facts),
  ].sort(bySite)
}

/**
 * SQL built by interpolating a value into the statement text. The value is not a parameter, it is
 * STATEMENT, so anything the caller controls can end the literal and continue as SQL.
 *
 * Two things this deliberately does not flag, because both are safe and flagging them would train
 * people to ignore the rule:
 *
 * - A TAGGED template - ``sql`... ${id} ...` `` in postgres.js, drizzle or kysely. The tag receives the
 *   substitutions separately and binds them; that is the parameterised form, not a bypass of it.
 * - A literal with no substitution at all. `db.query("SELECT … WHERE id = ?")` is the shape being
 *   argued for.
 *
 * A SQL keyword is required in the literal, so `cache.query(`user:${id}`)` stays quiet. The named
 * escape hatches (`$queryRawUnsafe`, `sql.unsafe`) are flagged on the call alone: their whole purpose
 * is to take a statement as text, and a substitution in one is the exact thing the name warns about.
 */
const SQL_METHODS = new Set([
  "query",
  "queryRaw",
  "prepare",
  "exec",
  "execute",
  "run",
  "unsafe",
  "$queryRawUnsafe",
  "$executeRawUnsafe",
  "raw",
])
const SQL_KEYWORD =
  /\b(select|insert\s+into|update|delete\s+from|drop\s+table|create\s+table|alter\s+table|truncate|from|where|values|set|join|union)\b/i
const ALWAYS_UNSAFE = new Set(["unsafe", "$queryRawUnsafe", "$executeRawUnsafe", "raw"])

interface SqlExpressionShape {
  readonly staticText: string
  readonly dynamic: boolean
  readonly concatenated: boolean
  readonly literal: boolean
  readonly parameterizedTag: boolean
}

/** Module-scope `const` initializers by name - the one binding form the SQL scanner resolves. */
type ModuleConsts = ReadonlyMap<string, TSApi.Expression>

/** A name some other module exports, named exactly as the edge that reaches it writes it. */
interface ExportEdge {
  readonly specifier: string
  readonly exported: string
}

/**
 * One module's provable module-scope bindings: its top-level `const` initializers plus the exact
 * import/export edges this scan is allowed to follow.
 *
 * Everything absent from these maps stays unresolved, and an unresolved interpolation keeps flagging.
 * That is the whole safety argument: resolution can only ever make this rule QUIETER, so a form the
 * scan cannot prove must fall out as "unknown" rather than be guessed at. Deliberately absent:
 * `export default`, `export let`/`var`, destructured or computed names, default and namespace imports,
 * `export * as ns`, `require`, and dynamic `import()`.
 */
interface SqlModuleScope {
  /** The module's identity - an absolute path from the loader, or the entry file's path as given. Keys
   * the parsed-scope cache and the cycle guard, and is the base its own specifiers resolve against. */
  readonly id: string
  readonly consts: ModuleConsts
  /** Local name bound by `import { X as local }` → the edge that provides it. */
  readonly imports: ReadonlyMap<string, ExportEdge>
  /** Exported name → the local name it reads (`export { a as b }` → `b` → `a`). */
  readonly localExports: ReadonlyMap<string, string>
  /** Exported name → another module's export (`export { a as b } from "./m"`). */
  readonly reExports: ReadonlyMap<string, ExportEdge>
  /** `export * from "./m"` specifiers, in source order. */
  readonly starExports: readonly string[]
}

/** Read one module's top-level `const` bindings and its import/export edges. Pure syntax - no checker,
 * no filesystem. Destructured names, `let`, `var`, and anything nested stay out on purpose: a
 * module-scope `const` is the only form that provably cannot carry request data. */
function sqlModuleScope(ts: TypeScriptApi, id: string, source: TSApi.SourceFile): SqlModuleScope {
  const consts = new Map<string, TSApi.Expression>()
  const imports = new Map<string, ExportEdge>()
  const localExports = new Map<string, string>()
  const reExports = new Map<string, ExportEdge>()
  const starExports: string[] = []
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue
      const exported =
        statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue
        consts.set(declaration.name.text, declaration.initializer)
        if (exported) localExports.set(declaration.name.text, declaration.name.text)
      }
      continue
    }
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause
      if (clause === undefined || clause.isTypeOnly) continue
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
      const bindings = clause.namedBindings
      // Only `import { X }` / `import { X as local }`. A default or namespace import binds a value
      // whose contents this scan cannot prove, so it stays unbound and every use of it flags.
      if (bindings === undefined || !ts.isNamedImports(bindings)) continue
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue
        imports.set(element.name.text, {
          specifier: statement.moduleSpecifier.text,
          exported: element.propertyName?.text ?? element.name.text,
        })
      }
      continue
    }
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue
    const from = statement.moduleSpecifier
    if (from !== undefined && !ts.isStringLiteral(from)) continue
    const clause = statement.exportClause
    if (clause === undefined) {
      // No clause and a specifier is `export * from "./m"`. `export * as ns from "./m"` carries a
      // NamespaceExport clause instead and falls out below, unresolved, which is what we want.
      if (from !== undefined) starExports.push(from.text)
      continue
    }
    if (!ts.isNamedExports(clause)) continue
    for (const element of clause.elements) {
      if (element.isTypeOnly) continue
      const local = element.propertyName?.text ?? element.name.text
      if (from === undefined) localExports.set(element.name.text, local)
      else reExports.set(element.name.text, { specifier: from.text, exported: local })
    }
  }
  return { id, consts, imports, localExports, reExports, starExports }
}

/** A module's identity + source, as resolved from a specifier. `id` must be stable and absolute: it
 * keys the parsed-scope cache, seeds the cycle guard, and is what the module's own relative specifiers
 * resolve against. */
export interface SqlModuleSource {
  readonly id: string
  readonly content: string
}

/**
 * Resolves a specifier written in the module `fromModule` to the target's identity + source, or
 * `undefined` when it cannot be resolved, read, or proved to be in-project source.
 *
 * Injected rather than built in, for the same reason {@link ModuleResolver} is: it keeps
 * {@link scanInterpolatedSql} pure and filesystem-free, so the resolution rules can be unit-tested
 * against a virtual module graph. {@link createProjectSqlImports} is the on-disk implementation.
 */
export type SqlModuleLoader = (fromModule: string, specifier: string) => SqlModuleSource | undefined

/** Cross-module resolution state for one run: the loader plus a parsed-scope cache, so a fragments
 * module imported by fifty callers is read and parsed once. A cached `undefined` is a REFUSAL (the
 * module did not parse), cached so it is not re-attempted. Build with {@link createSqlImports}. */
export interface SqlImports {
  readonly load: SqlModuleLoader
  readonly scopes: Map<string, SqlModuleScope | undefined>
}

export const createSqlImports = (load: SqlModuleLoader): SqlImports => ({
  load,
  scopes: new Map(),
})

/** Where an expression's identifiers are read: the module the expression physically lives in, plus the
 * run's cross-module state. `imports === undefined` is same-file-only resolution - the behavior before
 * imported fragments were followed, and still what an unconfigured `scanInterpolatedSql` call does. */
interface SqlScope {
  readonly module: SqlModuleScope
  readonly imports: SqlImports | undefined
}

/** Parse a module for the SQL scan, or `undefined` when it does not parse. Malformed source is already
 * a typecheck failure; parser recovery nodes are not evidence of anything, so a file that fails to
 * parse contributes no findings and proves no constant. */
function parseSqlSource(
  ts: TypeScriptApi,
  file: string,
  content: string,
): TSApi.SourceFile | undefined {
  const kind = /\.[cm]?tsx?$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.JS
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind)
  const parseDiagnostics = (
    source as TSApi.SourceFile & { readonly parseDiagnostics?: readonly TSApi.Diagnostic[] }
  ).parseDiagnostics
  return parseDiagnostics !== undefined && parseDiagnostics.length > 0 ? undefined : source
}

/** Module-boundary hops one name may cross. Barrels are why it is not 1: `route → index → fragments`
 * already spends two, and the third leaves room for one more layer without letting the scan wander the
 * module graph. Past the cap the name is unresolved, so the interpolation flags. */
const SQL_IMPORT_HOPS = 3

/** Load + parse the module a specifier names, through the run's cache. */
function loadSqlModuleScope(
  ts: TypeScriptApi,
  imports: SqlImports,
  fromModule: string,
  specifier: string,
): SqlModuleScope | undefined {
  const loaded = imports.load(fromModule, specifier)
  if (loaded === undefined) return undefined
  if (imports.scopes.has(loaded.id)) return imports.scopes.get(loaded.id)
  const source = parseSqlSource(ts, loaded.id, loaded.content)
  const scope = source === undefined ? undefined : sqlModuleScope(ts, loaded.id, source)
  imports.scopes.set(loaded.id, scope)
  return scope
}

/** One exported name resolved to the `const` initializer behind it, together with the scope that
 * initializer's OWN identifiers must be read in. */
interface ResolvedExport {
  readonly expression: TSApi.Expression
  readonly scope: SqlModuleScope
}

/**
 * Follow an exported name to its `const` initializer, across re-export hops.
 *
 * Handles the three forms a fragments module actually uses: `export const NAME = …`, the two-statement
 * `const NAME = …; export { NAME }` (including the pass-through `import { A } …; export { A }`), and
 * barrels - `export { X } from "./m"` and `export * from "./m"`. Bounded by {@link SQL_IMPORT_HOPS} and
 * a per-chain visited set, so a cyclic barrel terminates instead of recursing.
 *
 * Two `export *` sources providing the same name is a conflict, and the scan refuses rather than
 * picking one: guessing here would silence a real finding.
 */
function resolveExportedConst(
  ts: TypeScriptApi,
  imports: SqlImports,
  scope: SqlModuleScope,
  name: string,
  hops: number,
  seen: ReadonlySet<string>,
): ResolvedExport | undefined {
  if (hops > SQL_IMPORT_HOPS) return undefined
  const key = `${scope.id}#${name}`
  if (seen.has(key)) return undefined
  const nextSeen = new Set(seen).add(key)
  const follow = (edge: ExportEdge): ResolvedExport | undefined => {
    const target = loadSqlModuleScope(ts, imports, scope.id, edge.specifier)
    return target === undefined
      ? undefined
      : resolveExportedConst(ts, imports, target, edge.exported, hops + 1, nextSeen)
  }
  const local = scope.localExports.get(name)
  if (local !== undefined) {
    const initializer = scope.consts.get(local)
    if (initializer !== undefined) return { expression: initializer, scope }
    // `import { A } from "./a"; export { A }` - the same pass-through as `export { A } from "./a"`,
    // written in two statements. Anything else the name could be (a `let`, a function, a class) has no
    // initializer in `consts` and no import edge, so it lands on `undefined` and flags.
    const via = scope.imports.get(local)
    return via === undefined ? undefined : follow(via)
  }
  const reExported = scope.reExports.get(name)
  if (reExported !== undefined) return follow(reExported)
  let found: ResolvedExport | undefined
  for (const specifier of scope.starExports) {
    const hit = follow({ specifier, exported: name })
    if (hit === undefined) continue
    if (found !== undefined) return undefined
    found = hit
  }
  return found
}

/** Whether `name`, read at `at`, might be re-declared by anything between the read and module scope.
 * Conservative on purpose: the OUTERMOST enclosing function/block subtree is scanned for ANY binding
 * of the name (parameter, `var`/`let`/`const`, catch, local function, destructuring element) - so a
 * hoisted `var` in a sibling block, or a binding in a branch that never runs, still refuses
 * resolution. Over-refusal flags a safe line (the pre-feature behavior); under-refusal would resolve
 * the wrong binding, which is why the cheap-and-broad scan wins over scope simulation. A use with no
 * enclosing function or block reads module scope directly and cannot be shadowed. */
function isShadowedAt(ts: TypeScriptApi, at: TSApi.Node, name: string): boolean {
  let scope: TSApi.Node | undefined
  for (let node: TSApi.Node | undefined = at.parent; node !== undefined; node = node.parent) {
    if (ts.isSourceFile(node)) break
    if (ts.isFunctionLike(node) || ts.isBlock(node)) scope = node
  }
  if (scope === undefined) return false
  const bindsName = (binding: TSApi.BindingName): boolean =>
    ts.isIdentifier(binding)
      ? binding.text === name
      : binding.elements.some(
          (element) =>
            !ts.isOmittedExpression(element) &&
            (ts.isIdentifier(element.name) ? element.name.text === name : bindsName(element.name)),
        )
  let found = false
  const scan = (node: TSApi.Node): void => {
    if (found) return
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      bindsName(node.name as TSApi.BindingName)
    ) {
      found = true
      return
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = true
      return
    }
    ts.forEachChild(node, scan)
  }
  scan(scope)
  return found
}

const CONST_RESOLUTION_DEPTH = 5

/**
 * Resolve an interpolated expression to compile-time text, or `undefined` when it can carry runtime
 * data. Pure syntax, no type checker - the same honest limit the rule already documents. What
 * resolves: string/number literals, no-substitution templates, templates whose every span resolves,
 * ternaries with both branches resolvable (BOTH branch texts are returned, so a hostile keyword in
 * either still feeds the keyword scan), `as`/`satisfies` wrappers, a module-scope `const` whose
 * initializer resolves (recursively, depth-capped), and - when `scope.imports` is configured - such a
 * `const` imported by name from another in-project module. Everything else - `let`, a parameter, a
 * call, a member access, a shadowed name, a bare-specifier import - stays unresolved and the
 * interpolation is flagged exactly as before.
 */
function resolveStaticSqlText(
  ts: TypeScriptApi,
  node: TSApi.Expression,
  scope: SqlScope,
  depth: number,
): string | undefined {
  if (depth > CONST_RESOLUTION_DEPTH) return undefined
  if (ts.isParenthesizedExpression(node)) {
    return resolveStaticSqlText(ts, node.expression, scope, depth)
  }
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return resolveStaticSqlText(ts, node.expression, scope, depth)
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isNumericLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text
    for (const span of node.templateSpans) {
      const part = resolveStaticSqlText(ts, span.expression, scope, depth + 1)
      if (part === undefined) return undefined
      text += part + span.literal.text
    }
    return text
  }
  if (ts.isConditionalExpression(node)) {
    const whenTrue = resolveStaticSqlText(ts, node.whenTrue, scope, depth + 1)
    const whenFalse = resolveStaticSqlText(ts, node.whenFalse, scope, depth + 1)
    if (whenTrue === undefined || whenFalse === undefined) return undefined
    return `${whenTrue} ${whenFalse}`
  }
  if (ts.isIdentifier(node)) {
    const initializer = scope.module.consts.get(node.text)
    const edge = initializer === undefined ? scope.module.imports.get(node.text) : undefined
    // Membership first: `isShadowedAt` walks a subtree, and most identifiers in a query are neither a
    // module const nor an import binding.
    if (initializer === undefined && edge === undefined) return undefined
    // Shadowing is a property of where the identifier is WRITTEN, so one check is right on both sides
    // of an import hop: an initializer in the imported module sits at module scope with nothing above
    // it to shadow it, while a use inside a function in this file is still refused.
    if (isShadowedAt(ts, node, node.text)) return undefined
    if (initializer !== undefined) return resolveStaticSqlText(ts, initializer, scope, depth + 1)
    if (edge === undefined || scope.imports === undefined) return undefined
    const target = loadSqlModuleScope(ts, scope.imports, scope.module.id, edge.specifier)
    if (target === undefined) return undefined
    const exported = resolveExportedConst(ts, scope.imports, target, edge.exported, 1, new Set())
    if (exported === undefined) return undefined
    // The imported initializer's own identifiers read THAT module's consts, never this file's. A
    // caller that happens to have its own `const DIR` must not silently supply the fragment's `DIR`,
    // which is the one way cross-module resolution could resolve to text nobody wrote.
    return resolveStaticSqlText(
      ts,
      exported.expression,
      { module: exported.scope, imports: scope.imports },
      depth + 1,
    )
  }
  return undefined
}

/** A template's contribution to the shape: resolved span texts fold into `staticText` (so the
 * keyword scan still sees what a `const` carries); any unresolvable span keeps it `dynamic`. */
function templateShape(
  ts: TypeScriptApi,
  template: TSApi.TemplateExpression,
  scope: SqlScope | undefined,
): { staticText: string; dynamic: boolean } {
  let staticText = template.head.text
  let dynamic = false
  for (const span of template.templateSpans) {
    const resolved =
      scope === undefined ? undefined : resolveStaticSqlText(ts, span.expression, scope, 0)
    if (resolved === undefined) dynamic = true
    else staticText += resolved
    staticText += span.literal.text
  }
  return { staticText, dynamic }
}

/** A same-file binding the argument resolver proved holds one expression: a `const`, or a `let` the
 * whole file never reassigns. `"shadow"` marks a nearer binding of the name we can NOT read through (a
 * parameter, `var`, destructured, uninitialized, reassigned `let`) - it stops the outward walk so a
 * farther, resolvable const of the same name is never read in its place. */
type ResolvableBinding = { readonly initializer: TSApi.Expression } | "shadow"

/** Whether `name` is written to anywhere in the file - a plain, compound, or `++`/`--` assignment to a
 * bare identifier of that name. A `let` that is is over-cautiously refused (it might be reassigned from
 * request data); a `const` never needs this. Over-refusal only ever leaves an interpolation flagged as
 * before, never the reverse. */
function isReassignedInFile(ts: TypeScriptApi, source: TSApi.SourceFile, name: string): boolean {
  let found = false
  const visit = (node: TSApi.Node): void => {
    if (found) return
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(node.left) &&
      node.left.text === name
    ) {
      found = true
      return
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(node.operand) &&
      node.operand.text === name
    ) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** Does `binding` bind `name` (as a plain identifier or nested inside a destructuring pattern)? Mirrors
 * the pattern walk in {@link isShadowedAt}. */
function bindingNameCovers(ts: TypeScriptApi, binding: TSApi.BindingName, name: string): boolean {
  return ts.isIdentifier(binding)
    ? binding.text === name
    : binding.elements.some(
        (element) =>
          !ts.isOmittedExpression(element) &&
          (ts.isIdentifier(element.name)
            ? element.name.text === name
            : bindingNameCovers(ts, element.name, name)),
      )
}

/** Inspect the bindings a single scope node introduces DIRECTLY (not nested) for `name`: parameters and
 * catch variables of a function/catch, `var`/`let`/`const` and function/class declarations of a
 * statement list. Returns the readable initializer, `"shadow"` for a form we cannot read through, or
 * `undefined` when this scope does not bind the name at all. */
function directBinding(
  ts: TypeScriptApi,
  source: TSApi.SourceFile,
  scope: TSApi.Node,
  name: string,
): ResolvableBinding | undefined {
  if (ts.isFunctionLike(scope)) {
    for (const parameter of scope.parameters) {
      if (bindingNameCovers(ts, parameter.name, name)) return "shadow"
    }
  }
  if (ts.isCatchClause(scope)) {
    const declared = scope.variableDeclaration
    if (declared !== undefined && bindingNameCovers(ts, declared.name, name)) return "shadow"
  }
  const statements: readonly TSApi.Statement[] | undefined = ts.isSourceFile(scope)
    ? scope.statements
    : ts.isBlock(scope) || ts.isModuleBlock(scope)
      ? scope.statements
      : ts.isCaseClause(scope) || ts.isDefaultClause(scope)
        ? scope.statements
        : undefined
  const lists: TSApi.VariableDeclarationList[] = []
  if (statements !== undefined) {
    for (const statement of statements) {
      if (ts.isVariableStatement(statement)) lists.push(statement.declarationList)
      if (
        (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
        statement.name?.text === name
      ) {
        return "shadow"
      }
    }
  }
  if (
    (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) &&
    scope.initializer !== undefined &&
    ts.isVariableDeclarationList(scope.initializer)
  ) {
    lists.push(scope.initializer)
  }
  for (const list of lists) {
    for (const declaration of list.declarations) {
      if (!bindingNameCovers(ts, declaration.name, name)) continue
      // A destructured or uninitialized binding, or a `var` (hoisting + reassignment risk), is not a
      // value we can read one expression out of.
      if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined)
        return "shadow"
      const isConst = (list.flags & ts.NodeFlags.Const) !== 0
      const isLet = (list.flags & ts.NodeFlags.Let) !== 0
      if (isConst) return { initializer: declaration.initializer }
      if (isLet && !isReassignedInFile(ts, source, name))
        return { initializer: declaration.initializer }
      return "shadow"
    }
  }
  return undefined
}

/**
 * Resolve a query-call ARGUMENT identifier to the expression it was initialized from, so a statement
 * parked in a variable is scanned as if it had been written inline at the call. This is the counterpart
 * to {@link resolveStaticSqlText}: that folds a const's text INTO a template's shape; this unfolds the
 * whole statement back out of the variable it was lifted into. Without it, ANY interpolated-SQL finding
 * could be silenced, invisibly, by hoisting the statement to `const q = …` first.
 *
 * Same-file only. Nearest enclosing declaration wins, so a shadowing local is read and never a
 * same-named module const. Reads through a `const`, or a `let` the file never reassigns, at function or
 * module scope; transitive through an identifier-valued initializer; depth-capped. A parameter, an
 * imported or destructured binding, a reassigned `let`, a `var`, or a name with no same-file
 * declaration returns `undefined` - which leaves the argument scanned as itself (unflagged unless it is
 * a module const that resolves to static text: exactly the pre-feature behavior).
 */
function resolveArgumentInitializer(
  ts: TypeScriptApi,
  node: TSApi.Identifier,
  depth: number,
): TSApi.Expression | undefined {
  if (depth > CONST_RESOLUTION_DEPTH) return undefined
  const source = node.getSourceFile()
  const name = node.text
  for (let scope: TSApi.Node | undefined = node.parent; scope !== undefined; scope = scope.parent) {
    const binding = directBinding(ts, source, scope, name)
    if (binding === "shadow") return undefined
    if (binding !== undefined) {
      let init = binding.initializer
      while (ts.isParenthesizedExpression(init)) init = init.expression
      return ts.isIdentifier(init) ? resolveArgumentInitializer(ts, init, depth + 1) : init
    }
    if (ts.isSourceFile(scope)) break
  }
  return undefined
}

/** Describe only the first argument's syntax; comments/strings elsewhere cannot influence the result. */
function sqlExpressionShape(
  ts: TypeScriptApi,
  node: TSApi.Expression,
  scope?: SqlScope,
): SqlExpressionShape {
  if (ts.isParenthesizedExpression(node)) return sqlExpressionShape(ts, node.expression, scope)
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return {
      staticText: node.text,
      dynamic: false,
      concatenated: false,
      literal: true,
      parameterizedTag: false,
    }
  }
  if (ts.isTaggedTemplateExpression(node)) {
    const tag = node.tag
    const parameterizedTag =
      (ts.isIdentifier(tag) && tag.text === "sql") ||
      (ts.isPropertyAccessExpression(tag) && tag.getText() === "Prisma.sql")
    const template = node.template
    const templated = ts.isTemplateExpression(template)
      ? templateShape(ts, template, parameterizedTag ? undefined : scope)
      : { staticText: template.text, dynamic: false }
    const staticText = templated.staticText
    // Only the ecosystem's binding tags are trusted, by NAME - which is the honest limit of a scanner
    // that reads syntax and runs no type checker. `sql` is what postgres.js, drizzle, slonik and Bun's
    // own driver all call theirs, and `Prisma.sql` is Prisma's; taking those at their word is a
    // deliberate trade, and it is worth stating what it costs: a no-op function named `sql` in the
    // same file is trusted too, so this rule finds mistakes, not an adversary who reads it first.
    //
    // Trusting anything else widens that for no gain. This list briefly also held `sqlIdentifiers`,
    // a name invented for Nifra's own adapters - a second forgeable name that no user has a
    // convention for, added so Nifra's source would pass its own rule. Names earn their place here by
    // being what drivers already call the thing, not by being convenient for the framework.
    //
    // Everything else - `String.raw`, an identity tag, a member access that merely ends in `.sql` -
    // is treated as plain interpolation.
    return {
      staticText,
      dynamic: templated.dynamic && !parameterizedTag,
      concatenated: false,
      literal: !ts.isTemplateExpression(template),
      parameterizedTag,
    }
  }
  if (ts.isTemplateExpression(node)) {
    const templated = templateShape(ts, node, scope)
    return {
      staticText: templated.staticText,
      dynamic: templated.dynamic,
      concatenated: false,
      literal: false,
      parameterizedTag: false,
    }
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = sqlExpressionShape(ts, node.left, scope)
    const right = sqlExpressionShape(ts, node.right, scope)
    return {
      staticText: left.staticText + right.staticText,
      // A resolved const operand is static text, not a dynamic part - so the old `!literal` test
      // narrows to what it always actually meant: an operand that carries runtime data (dynamic) or
      // a binding tag being concatenated into plain text (which un-parameterizes it).
      dynamic: left.dynamic || right.dynamic || left.parameterizedTag || right.parameterizedTag,
      concatenated: true,
      literal: left.literal && right.literal,
      parameterizedTag: false,
    }
  }
  // A resolvable expression (a module-`const` name, a literal ternary) contributes its compile-time
  // text and stays non-dynamic - this is what lets `"SELECT " + COLS + " FROM t"` and
  // `db.query(`${COLS} FROM t WHERE id = $1`)` pass while a mutable or unprovable name still flags.
  // `literal` stays false: the named escape hatches (`unsafe`, `$queryRawUnsafe`) keep flagging a
  // resolved const, because taking statement text from ANY variable is what their rule warns about.
  if (scope !== undefined) {
    const resolved = resolveStaticSqlText(ts, node, scope, 0)
    if (resolved !== undefined) {
      return {
        staticText: resolved,
        dynamic: false,
        concatenated: false,
        literal: false,
        parameterizedTag: false,
      }
    }
  }
  // A bare name that did not resolve to compile-time text. If it is a same-file binding we can prove
  // holds one expression, scan THAT expression's shape - so a statement hoisted into `const q = …` is
  // read exactly as if it were written inline at the call, closing the "extract a variable to launder
  // the finding" hole. `literal` is forced false: the value arrived through a variable, which is the
  // property the `unsafe`/`$queryRawUnsafe` hatch rule keys on.
  if (ts.isIdentifier(node)) {
    const initializer = resolveArgumentInitializer(ts, node, 0)
    if (initializer !== undefined) {
      return { ...sqlExpressionShape(ts, initializer, scope), literal: false }
    }
  }
  return {
    staticText: "",
    dynamic: true,
    concatenated: false,
    literal: false,
    parameterizedTag: false,
  }
}

function sqlMethod(
  ts: TypeScriptApi,
  call: TSApi.CallExpression,
): { method: string; receiver: string } | undefined {
  if (ts.isPropertyAccessExpression(call.expression)) {
    const method = call.expression.name.text
    return SQL_METHODS.has(method)
      ? { method, receiver: call.expression.expression.getText() }
      : undefined
  }
  if (
    ts.isElementAccessExpression(call.expression) &&
    call.expression.argumentExpression !== undefined &&
    ts.isStringLiteral(call.expression.argumentExpression)
  ) {
    const method = call.expression.argumentExpression.text
    return SQL_METHODS.has(method)
      ? { method, receiver: call.expression.expression.getText() }
      : undefined
  }
  return undefined
}

const SQL_RECEIVER = /(?:^|\.)(?:db|sql|prisma|drizzle|database|conn|connection|client|tx)$/i

/** The opt-out pragma that silences one interpolated-SQL finding. Written `// nifra-expect sql-dynamic:
 * <reason>` on the flagged line or in the comment block directly above it; the reason after the colon
 * is mandatory (see {@link commentBlockMarkerReason}). Scoped to the single statement it sits on. */
const SQL_DYNAMIC_PRAGMA = "nifra-expect sql-dynamic"

/**
 * Scan one file's text for SQL assembled by interpolation. Pure + line-accurate.
 *
 * `imports` opts into following a fragment `const` into another module. Without it the scan is
 * same-file only, which is what the unit tests exercise and what any caller that has no module graph
 * to offer gets. With it, only what {@link createProjectSqlImports} will hand back is followed.
 */
export function scanInterpolatedSql(
  file: string,
  content: string,
  ts: TypeScriptApi,
  imports?: SqlImports,
): SourceFinding[] {
  const out: SourceFinding[] = []
  const lines = content.split("\n")
  // Malformed source is already a typecheck failure. Do not turn parser recovery nodes into a second,
  // misleading SQL diagnostic (notably an unterminated template recovered as an interpolation).
  const source = parseSqlSource(ts, file, content)
  if (source === undefined) return out
  // Module-scope bindings, read once per file: an interpolated `const` that resolves to compile-time
  // text cannot carry request data, so the shared-projection idiom (`const COLS = "id, name"` …
  // `${COLS}`) stays quiet while mutable, parameter, shadowed, and unprovable names flag as before.
  const scope: SqlScope = { module: sqlModuleScope(ts, file, source), imports }
  const visit = (node: TSApi.Node): void => {
    if (ts.isCallExpression(node)) {
      const sink = sqlMethod(ts, node)
      const argument = node.arguments[0]
      if (sink !== undefined && argument !== undefined) {
        const shape = sqlExpressionShape(ts, argument, scope)
        const unsafeEscape =
          ALWAYS_UNSAFE.has(sink.method) && !shape.literal && !shape.parameterizedTag
        const assembledSql =
          shape.dynamic &&
          (SQL_KEYWORD.test(shape.staticText) ||
            (shape.concatenated && SQL_RECEIVER.test(sink.receiver)))
        if (unsafeEscape || assembledSql) {
          const index = node.getStart(source)
          const line = source.getLineAndCharacterOfPosition(index).line + 1
          // Sanctioned escape hatch for genuinely-dynamic-but-bound SQL (batch VALUES placeholder
          // generation, an allowlisted identifier). The reason is mandatory: a bare `// nifra-expect
          // sql-dynamic` with no reason after the colon does NOT silence, so the hatch always leaves a
          // greppable audit trail instead of becoming a second laundering trick.
          const silenced = commentBlockMarkerReason(lines, line, SQL_DYNAMIC_PRAGMA) !== undefined
          if (!silenced) out.push({ file, line, snippet: (lines[line - 1] ?? "").trim() })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

/**
 * Collect interpolated-SQL findings across the project.
 *
 * Returns `undefined` - not an empty array - when TypeScript is not installed. The rule parses source
 * with the compiler, so without it there is nothing to report and, more to the point, no basis for
 * reporting nothing. An empty result would read as "no interpolated SQL found", which is the one
 * answer a security rule must never give when it did not run.
 */
export async function scanProjectSql(cwd: string): Promise<SourceFinding[] | undefined> {
  const ts = await importProjectTypeScript(cwd)
  if (ts === undefined) return undefined
  const out: SourceFinding[] = []
  const imports = createProjectSqlImports(cwd)
  await walkSource(cwd, (rel, content) =>
    out.push(...scanInterpolatedSql(rel, content, ts, imports)),
  )
  return out.sort(bySite)
}

/** A declaration file. Excluded from cross-module resolution: `declare const X: string` has no
 * initializer to read, so following one could only ever produce a "proved" the source never wrote. */
const SQL_DECLARATION_FILE = /\.d\.[cm]?ts$/
/** The extensions the SQL scan will parse - the same set {@link walkSource} globs. */
const SQL_SOURCE_FILE = /\.[cm]?tsx?$/

/**
 * The on-disk loader for cross-module `const` resolution, scoped to one project.
 *
 * Deliberately narrow, because every widening here is a way for a real finding to go quiet:
 *
 * - **Relative specifiers only.** A bare specifier names a dependency whose exports can change without
 *   this project changing, so "provably a `const` string" is not a property the project owns.
 * - **Inside `cwd`, outside the ignored trees.** The resolved path is realpath'd and must still sit
 *   under the project root: a symlink pointing out of the tree is not source this scan reads. The
 *   `node_modules` / `dist` / build exclusions are the same ones the walk applies.
 * - **Real source only.** A `.d.ts` carries no initializer, and a non-TS file is not parsed.
 *
 * A miss on any of those returns `undefined`, which leaves the name unresolved and the interpolation
 * flagged - the pre-feature answer.
 */
export function createProjectSqlImports(cwd: string): SqlImports {
  const root = (() => {
    try {
      return realpathSync(resolve(cwd))
    } catch {
      return resolve(cwd)
    }
  })()
  return createSqlImports((fromModule, specifier) => {
    if (!isRelativeSpecifier(specifier)) return undefined
    try {
      // `fromModule` is the cwd-RELATIVE path the walk supplies for an entry file, and ABSOLUTE for
      // every module reached through a hop (their ids are the resolved paths).
      const fromAbs = isAbsolute(fromModule) ? fromModule : join(root, fromModule)
      const resolved = realpathSync(Bun.resolveSync(specifier, dirname(fromAbs)))
      if (!resolved.startsWith(root + sep)) return undefined
      const rel = resolved.slice(root.length + 1)
      if (IGNORED_DIR.test(rel)) return undefined
      if (SQL_DECLARATION_FILE.test(resolved) || !SQL_SOURCE_FILE.test(resolved)) return undefined
      return { id: resolved, content: readFileSync(resolved, "utf8") }
    } catch {
      return undefined // unresolvable, unreadable, or outside the project
    }
  })
}

// `client("` / `client('` / `client(\`` - a URL-first call WITHOUT the `<typeof app>` generic:
// the compiler has nothing to derive types from, so the anti-drift guarantee silently vanishes.
// `client<typeof app>("…")` has `<…>` between the name and `(` so it never matches; the published-
// contract form `client(contract, url)` starts with an identifier, not a quote - also unmatched.
const CLIENT_CALL = /(?<![.\w])client\s*\(/g

/** Scan one file's text for untyped `client("…")` calls. Pure + line-accurate. */
export function scanUntypedClient(file: string, content: string): SourceFinding[] {
  const out: SourceFinding[] = []
  const lines = content.split("\n")
  const code = codePositionMask(content)
  CLIENT_CALL.lastIndex = 0
  for (let m = CLIENT_CALL.exec(code); m !== null; m = CLIENT_CALL.exec(code)) {
    const argument = firstArgumentIndex(content, m.index + m[0].length)
    const quote = content[argument]
    if (quote !== "'" && quote !== '"' && quote !== "`") continue
    const line = lineAt(content, m.index)
    out.push({ file, line, snippet: (lines[line - 1] ?? "").trim() })
  }
  return out
}

/**
 * Specifiers that no longer exist, and what replaced them.
 *
 * These are the breaks a typecheck does not catch and a test suite does not either. `@nifrajs/core/ws`
 * was a side-effect import removed in 2.0 in favour of `.use(websocket())`; a consuming package kept
 * the import and a 533-test suite stayed green while the app could not boot. `@nifrajs/budget` folded
 * into core with no npm deprecation, so `bun install` fails workspace-wide with a resolution error
 * that names neither the cause nor the replacement.
 *
 * A lint is the right shape for this: it runs before boot, names the file and line, and states the
 * replacement - which is what neither the resolver error nor the runtime failure does.
 */
export const REMOVED_IMPORTS: ReadonlyArray<{
  readonly specifier: string
  readonly since: string
  readonly replacement: string
  /** Flag ONLY the bare side-effect form (`import "x"`). A module that still exports values is not
   * removed - only its install-by-import behaviour is - so flagging every import of it would be
   * wrong and would train people to ignore the rule. */
  readonly sideEffectOnly?: boolean
}> = [
  {
    specifier: "@nifrajs/budget",
    since: "2.0",
    replacement:
      'import from "@nifrajs/core/budget" - the package folded into core and npm `latest` is still 1.13.0, so a `^2` range resolves to nothing',
  },
  {
    specifier: "@nifrajs/core/ws",
    since: "2.0",
    sideEffectOnly: true,
    replacement:
      'a bare `import "@nifrajs/core/ws"` no longer installs the runtime - register it explicitly with `.use(websocket())`, importing `websocket` from the same module',
  },
]

/** Whether the import statement at `index` is the bare side-effect form (`import "x"`), rather than
 * one with bindings (`import { y } from "x"`). */
function isSideEffectImport(content: string, index: number): boolean {
  // `staticImportEdges` reports the index of the STATEMENT, not of the specifier, so read forward:
  // a side-effect import is `import` followed directly by the quoted specifier, with no bindings and
  // no `from` in between.
  return /^import\s*["'`]/.test(content.slice(index, index + 32))
}

/** Flag an import of a specifier that no longer exists. Pure; matches the exact specifier or a subpath
 * of it, so `@nifrajs/budget/x` is caught alongside `@nifrajs/budget`. */
export function scanRemovedImports(file: string, content: string): SourceFinding[] {
  const out: SourceFinding[] = []
  const lines = content.split("\n")
  for (const edge of staticImportEdges(content)) {
    const removed = REMOVED_IMPORTS.find(
      (entry) =>
        edge.specifier === entry.specifier || edge.specifier.startsWith(`${entry.specifier}/`),
    )
    if (removed === undefined) continue
    if (removed.sideEffectOnly === true && !isSideEffectImport(content, edge.index)) continue
    const line = lineAt(content, edge.index)
    out.push({ file, line, snippet: (lines[line - 1] ?? "").trim() })
  }
  return out
}

/** Scan a route module for top-level server-only imports. Returns `[]` for non-route files (only
 * `routes/` modules are browser-bundled, so a server-only import elsewhere is fine). Each finding carries
 * the offending `specifier` so the diagnostic can render the `routeFile → specifier` chain. Pure. */
export function scanServerOnlyImports(
  file: string,
  content: string,
  facts?: SourceFacts,
): ServerImportFinding[] {
  if (!ROUTE_FILE.test(file)) return []
  const out: ServerImportFinding[] = []
  const lines = content.split("\n")
  const code = stripComments(content)
  const positions = codePositionMask(content)
  STATIC_IMPORT.lastIndex = 0
  for (let m = STATIC_IMPORT.exec(code); m !== null; m = STATIC_IMPORT.exec(code)) {
    if (positions[m.index] === " ") continue
    const specifier = m[1] ?? ""
    if (!SERVER_ONLY.test(specifier)) continue
    if (facts !== undefined) {
      const source = facts.parse(file, content)
      // Inline `import { type X } from "…"` is erased just like `import type`; don't call it a
      // runtime leak. A parse failure keeps the old lexical finding so the security rule fails closed.
      if (source !== undefined && facts.isValueImportAt(source, m.index, specifier) === false)
        continue
    }
    const line = lineAt(content, m.index)
    out.push({ file, line, snippet: (lines[line - 1] ?? "").trim(), specifier })
  }
  return out
}

// ---------------------------------------------------------------------------------------------------
// #4.4 - TRANSITIVE import-chain resolution for `server-only-import`. `scanServerOnlyImports` above is a
// pure per-file regex scan: it sees only the route's DIRECT `import` line, so it reports the direct edge
// `routes/x → ../db`. The build leak-guard, which has the real module graph, reports the full transitive
// `route → ../data → ../db → pg`. These helpers give `nifra check` the same depth via a BOUNDED
// import-resolution walk: from a flagged route, resolve its local imports (`Bun.resolveSync`), BFS the
// local module graph, and build the shortest chain to a server-only SINK. It's best-effort: an import
// that can't be precisely resolved (a bare pkg, a tsconfig path alias) falls back to the direct edge.
// ---------------------------------------------------------------------------------------------------

// Server-only specifiers that are TERMINAL sinks - a bare `node:`/`bun:` builtin or a known server-only
// npm package. These are never local source we can walk into, so the chain ends here. (Same vocabulary
// as SERVER_ONLY, minus the relative `../db` arm - a relative `db` module IS local source we resolve.)
const SERVER_ONLY_SINK =
  /^(?:node:|bun:)|^(?:postgres|pg|mysql2|ioredis|redis|better-sqlite3|mongodb|@libsql\/client)$|^drizzle-orm\/(?:node-postgres|postgres-js|bun-sqlite|libsql|mysql2|pglite)\b/
// The `.server` convention: a module named `*.server.ts(x)` is server-only (the client build empties it).
const SERVER_MODULE_FILE = /\.server(\.[cm]?[jt]sx?)?$/
// The explicit poison-import marker (`@nifrajs/web/server-only`) - a module opting into the client-leak
// guard. A resolved file whose source carries this side-effect import is a server-only sink.
const SERVER_ONLY_MARKER_IMPORT = /import\s+["']@nifrajs\/web\/server-only["']/
// Depth/visited caps keep the walk linear + cycle-safe. A route's server-only dependency sits within a
// few hops in practice; the bound stops a pathological graph from blowing up the per-file scan.
const TRANSITIVE_MAX_DEPTH = 8
const TRANSITIVE_MAX_VISITED = 200

/** A relative module specifier (`./x`, `../y`) - the only kind we resolve + walk into (a bare specifier
 * is either a sink we recognise by name or a third-party dep we don't follow into node_modules). */
const isRelativeSpecifier = (spec: string): boolean =>
  spec.startsWith("./") || spec.startsWith("../")

// A FRESH copy of the static-import regex per scan. The transitive walk is REENTRANT - the outer
// per-route loop and the inner BFS both scan imports - and a single shared global-flag regex carries
// `lastIndex` state, so reusing the module-level `STATIC_IMPORT` across nested calls corrupts the outer
// loop's position (it restarts forever). A fresh instance per call keeps each scan's state private.
const staticImportRegex = (): RegExp => new RegExp(STATIC_IMPORT.source, STATIC_IMPORT.flags)

/** Extract the static, non-type import specifiers from a module's source (the edges to follow/inspect),
 * each with the match index (for line attribution). Mirrors {@link STATIC_IMPORT}, so `import type` +
 * dynamic `import()` are already excluded. Uses a fresh regex instance, so it's safe under the reentrant
 * transitive walk. Pure. */
function staticImportEdges(
  content: string,
  facts?: SourceFacts,
  file?: string,
): Array<{ specifier: string; index: number }> {
  const edges: Array<{ specifier: string; index: number }> = []
  const re = staticImportRegex()
  const code = stripComments(content)
  const positions = codePositionMask(content)
  for (let m = re.exec(code); m !== null; m = re.exec(code)) {
    if (positions[m.index] === " ") continue
    if (m[1] === undefined) continue
    if (facts !== undefined && file !== undefined) {
      const source = facts.parse(file, content)
      if (source !== undefined && facts.isValueImportAt(source, m.index, m[1]) === false) continue
    }
    edges.push({ specifier: m[1], index: m.index })
  }
  return edges
}

/** Extract the static, non-type import specifiers from a module's source (the edges to follow/inspect).
 * Mirrors {@link STATIC_IMPORT}, so `import type` + dynamic `import()` are already excluded. Pure. */
export function parseStaticImports(content: string, facts?: SourceFacts, file?: string): string[] {
  return staticImportEdges(content, facts, file).map((e) => e.specifier)
}

/** The server-only SINK an import specifier names directly (a `node:`/`bun:` builtin or a known
 * server-only package), or `undefined` if it isn't a by-name sink. Pure - the label is the specifier
 * itself (it's already the actionable name). */
export function directSinkSpecifier(spec: string): string | undefined {
  return SERVER_ONLY_SINK.test(spec) ? spec : undefined
}

/** One transitive server-only finding: the route module, the route's offending top-level import (the
 * first hop / `specifier`), the line + snippet of that import, and the FULL chain to the sink. */
export interface TransitiveServerImportFinding extends ServerImportFinding {
  /** `[routeFile, ...as-written specifiers…, sink]` - the shortest path the walk found. Length 2 means
   * the route imports the sink directly (same as the regex scan's direct edge). */
  readonly chain: readonly string[]
  /** True when a precise transitive resolve wasn't possible for the first hop (a bare pkg / path alias),
   * so the chain is the honest direct edge rather than a fabricated deeper path. */
  readonly fallback: boolean
}

/** A resolver from `(fromFile, specifier)` to an absolute module path, or `undefined` when it can't be
 * resolved precisely (bare pkg, path alias, missing file). Abstracted so the BFS is unit-testable with a
 * fake graph (no real fs). The production resolver wraps `Bun.resolveSync`. */
export type ModuleResolver = (fromFile: string, specifier: string) => string | undefined
/** Reads a resolved module's source, or `undefined` if unreadable. Abstracted for the same reason. */
export type ModuleReader = (absPath: string) => string | undefined

/**
 * BFS the LOCAL module graph from a route file for the SHORTEST import chain that reaches a server-only
 * sink, returning `[routeFile, …as-written specifiers…, sink]` or `undefined` if none is reachable. A
 * node's outgoing edges are its static imports; an edge is followed only when it's a RELATIVE specifier
 * that `resolve` maps to a readable local file (so the walk never descends into node_modules or chases an
 * unresolvable alias). At each node, a by-name sink import (`node:fs`, `postgres`) OR a resolved
 * `*.server` / `server-only`-marked dependency terminates the chain. Bounded by depth + a visited set, so
 * it's linear and cycle-free. `routeFile`/`routeContent` seed the walk; `resolve`/`read` supply the graph
 * - pure given those, so it's unit-testable with a fake graph.
 */
export function walkServerOnlyChain(
  routeFile: string,
  routeContent: string,
  resolve: ModuleResolver,
  read: ModuleReader,
  facts?: SourceFacts,
): readonly string[] | undefined {
  // Frontier nodes carry the absolute file to inspect, the source to scan, the display chain so far
  // (route + the as-written specifier of each hop), and the file the imports resolve relative to.
  interface Node {
    readonly abs: string
    readonly content: string
    readonly chain: readonly string[]
    readonly depth: number
  }
  const seen = new Set<string>([routeFile])
  let frontier: Node[] = [{ abs: routeFile, content: routeContent, chain: [routeFile], depth: 0 }]
  let visited = 0
  while (frontier.length > 0) {
    const next: Node[] = []
    for (const node of frontier) {
      if (node.depth >= TRANSITIVE_MAX_DEPTH) continue
      for (const spec of parseStaticImports(node.content, facts, node.abs)) {
        // (a) A by-name sink (builtin / known server-only pkg) → the chain ends here (shortest first,
        // since BFS reaches the nearest sink before any deeper one).
        const sink = directSinkSpecifier(spec)
        if (sink !== undefined) return [...node.chain, sink]
        // (b) Only relative specifiers are local source we resolve + walk into. A bare third-party
        // specifier that isn't a known sink is a leaf - don't follow it into node_modules.
        if (!isRelativeSpecifier(spec)) continue
        const abs = resolve(node.abs, spec)
        if (abs === undefined || seen.has(abs)) continue
        // (c) A resolved `*.server` module is a server-only sink by the `.server` convention - the chain
        // ends at it (named by the as-written specifier).
        if (SERVER_MODULE_FILE.test(abs)) return [...node.chain, spec]
        const content = read(abs)
        if (content === undefined) continue // unreadable → can't walk; treat as a leaf
        // (d) A resolved module that opts into the `server-only` marker is a sink too.
        if (SERVER_ONLY_MARKER_IMPORT.test(content)) return [...node.chain, spec]
        if (visited >= TRANSITIVE_MAX_VISITED) continue
        visited++
        seen.add(abs)
        next.push({ abs, content, chain: [...node.chain, spec], depth: node.depth + 1 })
      }
    }
    frontier = next
  }
  return undefined
}

/**
 * Resolve the FULL transitive server-only chain(s) for a route module, given a real fs-backed resolver +
 * reader. For each of the route's top-level imports, if a precise transitive walk finds a sink, the
 * finding carries the full chain; otherwise - when the first hop is itself a direct by-name sink the
 * regex scan already flags, or when a relative import can't be resolved - it falls back to the DIRECT
 * edge (`fallback: true`), never a fabricated chain. Returns one finding per offending top-level import,
 * de-duplicated to the shortest chain per first-hop specifier. Non-route files yield `[]`.
 */
export function resolveServerOnlyChains(
  file: string,
  content: string,
  resolve: ModuleResolver,
  read: ModuleReader,
  facts?: SourceFacts,
): TransitiveServerImportFinding[] {
  if (!ROUTE_FILE.test(file)) return []
  const lines = content.split("\n")
  const out: TransitiveServerImportFinding[] = []
  const flaggedSpecifiers = new Set<string>()
  // Collect the route's import edges up front (fresh-regex scan) so the per-edge logic below can call
  // the REENTRANT transitive walk without corrupting a shared regex's `lastIndex` (the walk also scans
  // imports). Driving `STATIC_IMPORT.exec` here directly would restart this loop forever.
  for (const { specifier, index } of staticImportEdges(content, facts, file)) {
    if (flaggedSpecifiers.has(specifier)) continue
    const line = lineAt(content, index)
    const snippet = (lines[line - 1] ?? "").trim()
    // (1) A direct by-name sink (`node:fs`, `postgres`) - the route imports it itself; chain is the
    // direct edge. (Length-2 chain == the regex scan's existing `[route, specifier]`.)
    if (directSinkSpecifier(specifier) !== undefined) {
      flaggedSpecifiers.add(specifier)
      out.push({ file, line, snippet, specifier, chain: [file, specifier], fallback: false })
      continue
    }
    // (2) A relative local import - try the transitive walk from the resolved dependency. If it reaches
    // a sink, emit the full chain rooted at THIS route's import line.
    if (isRelativeSpecifier(specifier)) {
      const abs = resolve(file, specifier)
      if (abs === undefined) {
        // Unresolvable relative import. If it's the known server-only `../db` convention the regex scan
        // flags directly, fall back to the direct edge (precise resolve impossible - say so via
        // `fallback`). Any other unresolvable relative import we can't assert is server-only - skip it.
        if (SERVER_ONLY.test(specifier)) {
          flaggedSpecifiers.add(specifier)
          out.push({ file, line, snippet, specifier, chain: [file, specifier], fallback: true })
        }
        continue
      }
      // The `.server` / marker sink can be the first hop itself.
      if (SERVER_MODULE_FILE.test(abs)) {
        flaggedSpecifiers.add(specifier)
        out.push({ file, line, snippet, specifier, chain: [file, specifier], fallback: false })
        continue
      }
      const depContent = read(abs)
      if (depContent === undefined) continue
      if (SERVER_ONLY_MARKER_IMPORT.test(depContent)) {
        flaggedSpecifiers.add(specifier)
        out.push({ file, line, snippet, specifier, chain: [file, specifier], fallback: false })
        continue
      }
      // Walk INTO the dependency: build the chain `[depAbs, …]` then re-root it at the route's import.
      const subChain = walkServerOnlyChain(abs, depContent, resolve, read, facts)
      if (subChain !== undefined) {
        flaggedSpecifiers.add(specifier)
        // subChain is `[depAbs, …hops…, sink]`; replace its head (the resolved dep path) with the
        // route's as-written specifier so the chain reads `routes/x → ../data → ../db → node:crypto`.
        const chain = [file, specifier, ...subChain.slice(1)]
        out.push({ file, line, snippet, specifier, chain, fallback: false })
        continue
      }
      // (3) The relative `../db`-style convention the regex scan flags directly, but where the walk
      // found no deeper sink (e.g. the file wasn't readable past the first hop) - fall back to the
      // direct edge so we still surface the known-server-only convention rather than going silent.
      if (SERVER_ONLY.test(specifier)) {
        flaggedSpecifiers.add(specifier)
        out.push({ file, line, snippet, specifier, chain: [file, specifier], fallback: true })
      }
    }
  }
  return out
}

// A route handler returning a raw `Response` (`=> new Response(`, `return Response.json(`, …) makes the
// typed client infer `data: never` (`Jsonify<Response>` is `never`) - so frontend/backend drift detection
// silently vanishes for that route. Advisory, not a failure: a raw Response is sometimes intended
// (redirects, files, streams). Fix is to return a plain object, or declare `{ response: t.… }` to type it.
const RESPONSE_RETURN = /(?:=>\s*|return\s+)(?:new\s+Response|Response\s*\.\s*json)\s*\(/g

/** Scan a backend module (one that calls `server(`) for handlers returning a raw `Response`, which collapses
 * the typed client's `data` to `never`. Pure + line-accurate; returns `[]` for files with no `server(` call. */
export function scanResponseRoutes(
  file: string,
  content: string,
  facts?: SourceFacts,
): SourceFinding[] {
  // Strip comments + template literals first: a commented-out or doc-example `return new Response(`
  // must not raise a spurious advisory. Lengths are preserved, so lineAt + the raw-line snippet align.
  const code = stripComments(content)
  if (!/(?<![.\w])server\s*\(/.test(code)) return []
  const out: SourceFinding[] = []
  const lines = content.split("\n")
  RESPONSE_RETURN.lastIndex = 0
  for (let m = RESPONSE_RETURN.exec(code); m !== null; m = RESPONSE_RETURN.exec(code)) {
    if (facts !== undefined) {
      const source = facts.parse(file, content)
      // A parseable AST rejects `return new Response(` text that only lives in a normal string. On
      // malformed source we keep the lexical candidate; the typecheck gate will report the syntax error.
      if (source !== undefined && facts.isResponseSyntaxAt(source, m.index) !== true) continue
    }
    const line = lineAt(content, m.index)
    // A `// nifra-expect raw-response` pragma marks an intentional raw Response (a file/redirect that can't
    // be a typed route), silencing this advisory. Honor it on the return line itself, OR on the line above
    // ONLY when that line is a standalone comment - so a TRAILING pragma on one route's return line can't
    // leak down and suppress the very next route's genuine advisory. `stripComments` blanks the pragma in
    // `code` (so it never affects the match); the raw `lines` still carry it.
    const thisLine = lines[line - 1] ?? ""
    const aboveLine = lines[line - 2] ?? ""
    const aboveSuppresses =
      aboveLine.trimStart().startsWith("//") && aboveLine.includes(RAW_RESPONSE_PRAGMA)
    if (thisLine.includes(RAW_RESPONSE_PRAGMA) || aboveSuppresses) continue
    out.push({ file, line, snippet: thisLine.trim() })
  }
  return out
}

/** The opt-out pragma that suppresses the {@link scanResponseRoutes} advisory for an intentional raw Response. */
const RAW_RESPONSE_PRAGMA = "nifra-expect raw-response"

/** Walk the project's `.ts`/`.tsx` source (skipping deps and build output), calling `visit` per file.
 * Exported so `nifra doctor` ({@link ./doctor.ts}) scans the same source surface as `nifra check`.
 *
 * `includeTests` widens the surface to `*.test.ts`/`*.spec.ts`, which the default excludes. It exists
 * for `nifra doctor`: `tsc` compiles tests, so a test importing a package no manifest declares is a
 * build that a clean install cannot produce - the exact false confidence doctor is for. */
/**
 * Paths git considers ignored under `cwd`, in ONE batched `git check-ignore` call - so `.gitignore`
 * (root + nested + the global excludesfile) is honoured, not just the built-in {@link IGNORED} list. This
 * is what keeps the scan out of generated/build trees that live under a repo but aren't source: a monorepo
 * that gitignores, say, `builder/projects/` (238 generated apps) would otherwise be walked in full - 40k+
 * findings, a 50 MB+ result that overwhelms the caller. Returns an EMPTY set when there's no git / not a
 * repo / git errors, so the scan simply degrades to the {@link IGNORED} regex - never throws, never blocks.
 */
async function gitIgnored(cwd: string, rels: readonly string[]): Promise<Set<string>> {
  if (rels.length === 0) return new Set()
  try {
    const proc = Bun.spawn(["git", "check-ignore", "--stdin"], {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    })
    proc.stdin.write(`${rels.join("\n")}\n`)
    await proc.stdin.end()
    // git echoes back each ignored path exactly as fed on stdin (one per line); exit 1 = none matched.
    const out = await new Response(proc.stdout).text()
    await proc.exited
    return new Set(
      out
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    )
  } catch {
    return new Set()
  }
}

export async function walkSource(
  cwd: string,
  visit: (rel: string, content: string) => void,
  opts: { readonly includeTests?: boolean } = {},
): Promise<void> {
  const skip = opts.includeTests === true ? IGNORED_DIR : IGNORED
  // List candidates first (cheap - no reads), drop the built-in ignores, then exclude gitignored paths in
  // one batch before the (expensive) reads. So a gitignored generated/build tree is never read or scanned.
  const rels: string[] = []
  for await (const rawRel of new Glob("**/*.{ts,tsx,mts,cts}").scan({ cwd, dot: false })) {
    const rel = normalizeProjectPath(rawRel)
    if (!skip.test(rel)) rels.push(rel)
  }
  const ignored = await gitIgnored(cwd, rels)
  for (const rel of rels) {
    if (ignored.has(rel)) continue
    visit(rel, await Bun.file(join(cwd, rel)).text())
  }
}

const bySite = (a: SourceFinding, b: SourceFinding): number =>
  a.file.localeCompare(b.file) || a.line - b.line

/** Collect own-API `fetch()` findings across the project. */
export async function scanProject(cwd: string): Promise<SourceFinding[]> {
  const out: SourceFinding[] = []
  await walkSource(cwd, (rel, content) => out.push(...scanFetchText(rel, content)))
  return out.sort(bySite)
}

// #7 - server-manifest drift. `server-manifest.ts` is a COMMITTED generated file (it bakes the route
// list + client-entry hash for a disk-less worker). If `routes/` changes but the manifest isn't
// regenerated, the worker serves a stale route table - a silent edge break that no other check catches.
// We diff each committed manifest's imported route files against the live `routes/` tree.

// The marker comment `generateServerManifest` emits at the top of the file - identifies a generated
// manifest unambiguously (so a user file merely named `server-manifest.ts` isn't mistaken for one).
const GENERATED_MARKER = "GENERATED by @nifrajs/web generateServerManifest"
// The first route-import specifier's prefix up to `routes/` (e.g. `./`, `../`, `./src/`) - used to
// locate the routes dir relative to the manifest, and to strip to route-relative keys.
const ROUTES_PREFIX = /["'](\.{1,2}(?:\/[^"'/]+)*?\/routes\/)[^"']+["']/
// Route file extensions discovery recognises (mirrors `@nifrajs/web/fs`'s filter).
const ROUTE_FILE_EXT = /\.(tsx|jsx|svelte|vue|mdx)$/

export interface ManifestDriftFinding {
  /** The committed server-manifest file (relative to cwd). */
  readonly file: string
  /** Route files in `routes/` missing from the manifest (stale manifest - these routes won't serve). */
  readonly missing: readonly string[]
  /** Route files the manifest imports that no longer exist in `routes/` (a dangling import). */
  readonly extra: readonly string[]
}

/**
 * Scan the project for committed, generated `server-manifest.ts` files and report any that have drifted
 * from the live `routes/` tree. For each, the routes dir is derived from the manifest's own import
 * prefix (so a manifest that imports `../routes/x` is checked against the sibling `routes/`), its route
 * imports are parsed (`parseManifestRouteFiles`), and the set is diffed against the actual route files
 * on disk. A clean manifest yields no finding. Returns one finding per drifted manifest. Never throws on
 * a per-manifest miss (an unreadable routes dir is simply skipped).
 */
export async function scanServerManifestDrift(cwd: string): Promise<ManifestDriftFinding[]> {
  const { parseManifestRouteFiles, diffManifestRoutes, isManifestInSync } = await import(
    "@nifrajs/web/build"
  )
  const findings: ManifestDriftFinding[] = []
  for await (const rawRel of new Glob("**/server-manifest.ts").scan({ cwd, dot: false })) {
    const rel = normalizeProjectPath(rawRel)
    if (IGNORED.test(rel)) continue
    const source = await Bun.file(join(cwd, rel)).text()
    if (!source.includes(GENERATED_MARKER)) continue // not a generated manifest - skip
    const prefixMatch = ROUTES_PREFIX.exec(source)
    if (prefixMatch?.[1] === undefined) continue // no `routes/` imports → nothing to diff (empty app)
    const routesPrefix = prefixMatch[1]
    const manifestFiles = parseManifestRouteFiles(source, routesPrefix)
    // The routes dir sits at `<manifest dir>/<prefix>` - resolve it relative to the manifest file.
    const manifestDir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ""
    const routesDir = join(cwd, manifestDir, routesPrefix)
    let discovered: string[]
    try {
      discovered = (
        await Array.fromAsync(new Glob("**/*.{tsx,jsx,svelte,vue,mdx}").scan({ cwd: routesDir }))
      )
        .map((f) => f.replaceAll("\\", "/"))
        .filter((f) => ROUTE_FILE_EXT.test(f))
    } catch {
      continue // routes dir gone/unreadable - not a drift we can assess
    }
    const drift = diffManifestRoutes(manifestFiles, discovered)
    if (!isManifestInSync(drift)) {
      findings.push({ file: rel, missing: drift.missing, extra: drift.extra })
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file))
}

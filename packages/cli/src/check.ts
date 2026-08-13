/**
 * `nifra check` - the agent's (and CI's) definition of done. It makes the guarantees that keep a nifra
 * app drift-proof actually *fire*, instead of relying on the agent to remember them:
 *
 *   1. **typecheck** (`tsc --noEmit`) - the frontend↔backend contract is compiler-enforced. The typed
 *      client derives request + response types from the routes, so a shape mismatch is a type error.
 *   2. **typed-client lint** - flags hand-rolled `fetch()` to this app's *own* API (a relative URL),
 *      which bypasses `client<typeof app>` so the compiler can't see the drift.
 *   3. **server-only-import lint** - flags a top-level import of server-only code (a DB driver, `node:`/
 *      `bun:` builtins, the `./db` module) into a `routes/` page module. Those modules are bundled for
 *      the browser too, so the import ships server code to the client and breaks the build - the #1
 *      full-stack footgun. Reach server resources via `c.db` / `ctx.api`, never a top-level import.
 *
 * `collectCheckResult` returns a structured, machine-readable result (consumed by `--json` and the
 * `nifra_check` MCP tool, so an agent acts on diagnostics instead of scraping prose). Exits non-zero if
 * anything fails. Pure scanners (`scanFetchText`, `scanServerOnlyImports`) are unit-tested.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import type { AssuranceConfig, AssuranceReport } from "@nifrajs/core/assurance"
import { type ProjectEvidenceSnapshot, snapshotProjectEvidence } from "@nifrajs/core/evidence"
import { Glob } from "bun"
import type * as TSApi from "typescript"
import type { CapabilityProjectReport } from "./capabilities-tool.ts"
import { type Diagnostic, diagnostic } from "./diagnostics.ts"
import { createSourceFacts, type SourceFacts } from "./internal/source-facts.ts"
import { importProjectTypeScript, type TypeScriptApi } from "./internal/typescript-import.ts"
// Type-only: `pipeline-report.ts` imports this module's source scanners, so a value import here would
// close a cycle. Doctor is what actually runs the collector (see the `pipeline` rule below).
import type { PipelineReport } from "./pipeline-report.ts"
import { RULE_CODES } from "./rules/codes.ts"
import { parseRulePacks, type RuleContext, runRuleRegistry, sourceIndex } from "./rules/index.ts"
import { LEGACY_RULE_CODES, legacyRules } from "./rules/legacy.ts"
import { routeRules } from "./rules/routes.ts"
import { securityRules } from "./rules/security.ts"

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
const SIMPLE_REWRITE_METHODS = new Set(["GET", "DELETE", "HEAD", "OPTIONS"])

// Don't scan deps, build output, or generated client entries. `dist(-<runtime>)?` also covers
// per-runtime output dirs (dist-bun/dist-node/dist-deno/dist-vercel). Never source, for any scan.
const IGNORED_DIR =
  /(^|\/)(node_modules|dist(-[a-z0-9]+)?|build|\.nifra|\.git|\.wrangler|coverage)\//
// A test/spec module. Excluded from `nifra check`'s scans, which are about what SHIPS - a test
// legitimately drives `fetch`, hand-rolls a client, and calls a route directly. It is NOT excluded from
// `nifra doctor`: tsc typechecks tests, so an import a test declares nowhere is a real broken build.
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/
const IGNORED = new RegExp(`${IGNORED_DIR.source}|${TEST_FILE.source}`)

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
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

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

function parseSimpleFetchCall(snippet: string): SimpleFetchCall | undefined {
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
          out.push({ file, line, snippet: (lines[line - 1] ?? "").trim() })
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
const REMOVED_IMPORTS: ReadonlyArray<{
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
  for await (const rel of new Glob("**/*.{ts,tsx,mts,cts}").scan({ cwd, dot: false })) {
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
  for await (const rel of new Glob("**/server-manifest.ts").scan({ cwd, dot: false })) {
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

interface TypecheckResult {
  readonly ran: boolean
  readonly ok: boolean
  readonly note?: string
  readonly output?: string
  readonly cancelled?: boolean
  /** tsconfig.json exists but no `typescript` install was found walking up from cwd. The contract
   * gate could not run - the caller surfaces this as a FAILING diagnostic, never a silent skip. */
  readonly missingTypeScript?: boolean
}

/**
 * Find the project's `tsc` the way module resolution would: `node_modules/typescript/bin/tsc` in
 * cwd, then each parent directory up to the filesystem root. A workspace package in a monorepo has
 * its TypeScript hoisted to the workspace root, so the literal `join(cwd, "node_modules", …)` probe
 * this replaces reported "typescript not installed" - and silently skipped the gate - whenever
 * `nifra check` ran from the package directory instead of the repo root.
 */
function resolveTscBin(cwd: string): string | undefined {
  let dir = cwd
  while (true) {
    const candidate = join(dir, "node_modules", "typescript", "bin", "tsc")
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Run the project's own `tsc --noEmit`, if TypeScript + a tsconfig are present. Never auto-installs. */
async function typecheck(cwd: string, signal?: AbortSignal): Promise<TypecheckResult> {
  const tsconfig = join(cwd, "tsconfig.json")
  if (!(await Bun.file(tsconfig).exists()))
    return { ran: false, ok: true, note: "no tsconfig.json" }
  const tscBin = resolveTscBin(cwd)
  if (tscBin === undefined) {
    return {
      ran: false,
      ok: false,
      missingTypeScript: true,
      note: "typescript not installed (run: bun add -d typescript)",
    }
  }
  if (signal?.aborted) return { ran: true, ok: false, cancelled: true, output: "cancelled" }
  const proc = Bun.spawn(["bun", tscBin, "--noEmit", "-p", tsconfig], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  let cancelled = false
  const abort = (): void => {
    cancelled = true
    proc.kill()
  }
  signal?.addEventListener("abort", abort, { once: true })
  let out = ""
  let err = ""
  let code: number | null = null
  try {
    const result = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    out = result[0]
    err = result[1]
    code = result[2]
  } finally {
    signal?.removeEventListener("abort", abort)
  }
  return {
    ran: true,
    ok: code === 0 && !cancelled,
    output: cancelled ? "cancelled" : `${out}${err}`.trim(),
    ...(cancelled ? { cancelled: true } : {}),
  }
}

// `src/x.tsx(12,5): error TS2322: <message>` → one structured diagnostic.
const TSC_LINE = /^(.+?)\((\d+),\d+\):\s*(?:error|warning)\s+TS\d+:\s*(.+)$/

/** A single machine-readable check failure - the unit an agent (or CI) acts on. */
export interface CheckDiagnostic {
  readonly rule: string
  /** `error` fails the gate (a real contract break); `warning` is advisory - surfaced to the agent but
   * does NOT fail `nifra check`, for patterns that are sometimes intentional (a route returning a raw
   * `Response`, which silently drops the typed client to `data: never` but is valid for files/redirects). */
  readonly severity: "error" | "warning" | "info"
  /** Stable diagnostic protocol code. The legacy `rule` remains for compatibility. */
  readonly code?: string
  readonly file?: string
  readonly line?: number
  readonly message: string
  /** The canonical, rule-level fix - clean of the per-occurrence snippet, so an agent can apply it
   * directly. Set for the lint rules (they have one correct fix); omitted for `typecheck` (the fix is
   * specific to each type error). */
  readonly fix?: string
  /** A richer, agent-oriented fix hint. Diffs are only emitted when the edit is mechanical and local;
   * ambiguous cases give concrete steps instead of pretending the checker can safely rewrite code. */
  readonly suggestion?: CheckSuggestion
  /**
   * The import chain that pulls server-only code into the browser bundle, as display labels
   * `[routeFile, …as-written specifiers…, sink]`. Set only on `server-only-import`.
   *
   * #4.4: this is now the FULL **transitive** chain - a bounded import-resolution walk (`Bun.resolveSync`
   * from each file's dir, BFS the local module graph) follows `route → ../data → ../db → node:crypto`,
   * matching the build leak-guard's depth (`detectNodeBuiltinsInClient` in `@nifrajs/web/build`). A
   * length-2 chain (`[routeFile, specifier]`) means the route imports the sink directly. When a hop can't
   * be resolved precisely (a bare pkg, a tsconfig path alias), the walk degrades to the honest direct
   * edge rather than fabricating a deeper path - never a lie.
   */
  readonly chain?: readonly string[]
  readonly evidence?: readonly string[]
  readonly verify?: string
}

export interface CheckSuggestion {
  readonly kind: "edit" | "command" | "manual"
  readonly title: string
  readonly diff?: string
  /** argv array, not a shell string, so MCP clients can run it without quoting hazards. */
  readonly command?: readonly string[]
  readonly steps?: readonly string[]
}

/** The structured result of a full check - what `--json` prints and the `nifra_check` MCP tool returns. */
export interface CheckResult {
  readonly ok: boolean
  readonly typecheck: "pass" | "fail" | "skipped"
  /** Why `typecheck` is `"skipped"` (no tsconfig.json, typescript not installed, lints-only mode).
   * Absent when the typecheck ran. Echoed in the human report so a skip is never a dim mystery. */
  readonly typecheckNote?: string
  readonly diagnostics: readonly CheckDiagnostic[]
  /** Normalized diagnostics with stable codes for agents and external renderers. */
  readonly structuredDiagnostics?: readonly Diagnostic[]
  /**
   * Which bundler this app's phases run on, read statically from the config, and how nifra concluded
   * it. Returned even when nothing is wrong: an agent reading this project has to know which plugin
   * slot is live and which toolchain compiles a component before its next edit, and every `pipeline`
   * diagnostic below is only interpretable against it. Absent when the directory is not a nifra app.
   */
  readonly pipeline?: PipelineReport
  /** Intentional non-typed mount prefixes declared in `nifra.check.json` (e.g. `/auth` for a mounted
   * better-auth). Echoed here so `--json` / the MCP tool / the report can show what the typed-client scan
   * deliberately skipped - a suppressed prefix stays auditable instead of silently hiding real drift. */
  readonly externalMounts?: readonly string[]
  /** Active per-rule overrides from `nifra.check.json` `rules`, echoed verbatim so a retagged or
   * suppressed finding stays auditable in `--json`, the MCP tool, and the human report - config can
   * lower (or raise) the gate, but never invisibly. */
  readonly ruleOverrides?: Readonly<Record<string, RuleOverride>>
  /** Set only when the caller passed `maxDiagnostics` and there were more - `diagnostics` then holds the
   * first `shown` of `total`. It caps the serialized size so the `nifra_check` MCP tool can't emit a
   * message large enough to break the stdio transport; fix the shown diagnostics and re-run for the rest. */
  readonly truncated?: { readonly shown: number; readonly total: number }
}

/**
 * Pre-resolved route-assurance inputs, so the same reflection that `nifra assure` / `nifra levels`
 * already ran can feed `check`'s capability + trust-manifest diagnostics instead of a second pass.
 * Supplied by {@link collectProjectVerification}. When omitted, `collectCheckResult` loads and computes
 * these itself (the standalone `nifra_check` MCP path); the two routes produce byte-identical results.
 */
export interface CheckAssuranceContext {
  /** Whether `nifra.assurance.ts` exists: the gate for running the assurance-fed diagnostics at all. */
  readonly present: boolean
  /** The loaded config, when it loaded. Absent when the file is missing or {@link error} is set. */
  readonly config?: AssuranceConfig
  /** The failure from loading/evaluating the config, surfaced as a `capability-config` diagnostic. */
  readonly error?: unknown
  /** `evaluateRouteAssurance` over the config's source + policy (drives the trust-manifest check). */
  readonly routeAssurance?: AssuranceReport
  /** Static capability provenance, when the config declares a capabilities policy. */
  readonly capability?: CapabilityProjectReport
  /** Canonical token-only evidence reused by manifest and other offline projections. */
  readonly evidence?: ProjectEvidenceSnapshot
}

/** Optional per-project `nifra.check.json` - pure data (no code execution), so it's safe to read before
 * the app is built or even importable, preserving check's pre-`loadApp` invariant. */
interface CheckConfig {
  readonly externalMounts: readonly string[]
  readonly rules: Readonly<Record<string, RuleOverride>>
}

/**
 * One entry of `nifra.check.json` `rules`, keyed by legacy rule name (`response-route`) or stable
 * NF- code (`NF-S002`) - one key retags the finding in both diagnostic views. `severity: "off"`
 * drops the rule's findings; `ignore` drops findings whose file matches any of the globs. Overrides
 * are applied centrally BEFORE `ok` is computed and echoed in the result and the human report -
 * configuration can lower (or raise) the gate, but never invisibly.
 */
export interface RuleOverride {
  readonly severity?: "error" | "warn" | "info" | "off"
  readonly ignore?: readonly string[]
}

const OVERRIDE_SEVERITIES: readonly string[] = ["error", "warn", "info", "off"]

/** Load `nifra.check.json` if present. Fail-open + total: absent → empty; malformed JSON → empty plus a
 * parse `error`; an invalid entry → skipped plus a `warnings` note the caller surfaces as a `warning`
 * diagnostic (never throws, never blocks the gate). Mount entries are normalized to bare path prefixes
 * (`/auth/**` and `/auth/` both become `/auth`). */
async function loadCheckConfig(
  cwd: string,
): Promise<{ config: CheckConfig; error?: string; warnings: readonly string[] }> {
  const path = join(cwd, "nifra.check.json")
  const empty: CheckConfig = { externalMounts: [], rules: {} }
  if (!existsSync(path)) return { config: empty, warnings: [] }
  try {
    const parsed = JSON.parse(await Bun.file(path).text()) as {
      externalMounts?: unknown
      rules?: unknown
    }
    const raw = Array.isArray(parsed.externalMounts) ? parsed.externalMounts : []
    const externalMounts = raw
      .filter((m): m is string => typeof m === "string" && m.startsWith("/"))
      .map((m) => m.replace(/\/\*+$/, "").replace(/\/+$/, "") || "/")
    const warnings: string[] = []
    const rules: Record<string, RuleOverride> = {}
    if (parsed.rules !== undefined) {
      if (
        typeof parsed.rules !== "object" ||
        parsed.rules === null ||
        Array.isArray(parsed.rules)
      ) {
        warnings.push('`rules` must be an object of { "<rule>": { severity?, ignore? } } - ignored')
      } else {
        for (const [rule, value] of Object.entries(parsed.rules)) {
          if (typeof value !== "object" || value === null || Array.isArray(value)) {
            warnings.push(`rules["${rule}"] must be an object - ignored`)
            continue
          }
          const entry = value as { severity?: unknown; ignore?: unknown }
          const override: {
            severity?: NonNullable<RuleOverride["severity"]>
            ignore?: readonly string[]
          } = {}
          if (entry.severity !== undefined) {
            if (
              typeof entry.severity === "string" &&
              OVERRIDE_SEVERITIES.includes(entry.severity)
            ) {
              override.severity = entry.severity as NonNullable<RuleOverride["severity"]>
            } else {
              warnings.push(
                `rules["${rule}"].severity must be "error" | "warn" | "info" | "off" - ignored`,
              )
            }
          }
          if (entry.ignore !== undefined) {
            if (
              Array.isArray(entry.ignore) &&
              entry.ignore.every((g): g is string => typeof g === "string")
            ) {
              if (entry.ignore.length > 0) override.ignore = entry.ignore
            } else {
              warnings.push(`rules["${rule}"].ignore must be an array of file globs - ignored`)
            }
          }
          if (override.severity !== undefined || override.ignore !== undefined)
            rules[rule] = override
        }
      }
    }
    return { config: { externalMounts, rules }, warnings }
  } catch (error) {
    return {
      config: empty,
      error: error instanceof Error ? error.message : String(error),
      warnings: [],
    }
  }
}

const UNTYPED_CLIENT_HINT =
  'client("…") without a type argument - write client<typeof app>("…") (or client(contract, url)) so the compiler can catch drift'
const FETCH_HINT =
  "hand-rolled fetch() to your own API - call it through client<typeof app> (from @nifrajs/client) so the compiler catches drift"
const SERVER_IMPORT_HINT =
  "server-only import in a route module (bundled for the browser) - reach it via c.db / ctx.api inside a loader, never a top-level import"
const RESPONSE_ROUTE_HINT =
  "route handler returns a raw Response - the typed client infers `data: never`, so drift detection is lost for this route. Return a plain object (it's serialized for you); for a stream use a typed SSE route (`app.sse(...)`), which keeps typed events; or, if a raw Response is intended (file/redirect), add `{ response: t.… }` or a `// nifra-expect raw-response` comment to mark it and silence this"
const PIPELINE_DOC_HINT =
  "nifra runs one bundler per phase - `vitePlugins` feed Vite, `clientPlugins`/`serverPlugins` feed Bun, and the file `nifra build` imports the adapter from is bundled into the server. See the Gotchas section of the Dev & HMR guide."
const UNDECLARED_DEP_HINT =
  "imported package is not declared in package.json dependencies - run bun add to declare it"
const SQL_COMPILER_MISSING_HINT =
  "the interpolated-SQL rule did NOT run - it parses source with the TypeScript compiler, which is an optional peer and is not installed here. This report says nothing about SQL injection either way. Install it with `bun add -d typescript`"
const SQL_INTERPOLATION_EXAMPLE = "$" + "{value}"
const INTERPOLATED_SQL_HINT = `SQL built by interpolating a value into the statement text - the value becomes statement, not a parameter, so anything the caller controls can end the literal and continue as SQL. Pass it as a bound parameter (\`?\` / \`$1\` and an argument), or use your driver's tagged template (sql\`… ${SQL_INTERPOLATION_EXAMPLE} …\`), which binds the substitutions for you`
const MANIFEST_DRIFT_HINT =
  "server-manifest.ts is out of sync with routes/ - re-run the build to regenerate it (a disk-less worker bakes this route table, so the drift is a silent edge break), then commit it"
const TRUST_MANIFEST_DRIFT_HINT =
  "nifra.manifest.json is missing, invalid, or out of sync - run `nifra manifest emit`, review it, and commit the regenerated trust artifact"
const CAPABILITY_HINT =
  "effect/capability assurance failed - align the route declaration with approved adapter provenance; never bypass an owned effect seam"

function oneLineDiff(file: string, line: number, before: string, after: string): string {
  return `--- ${file}:${line}\n+++ ${file}:${line}\n@@\n-${before}\n+${after}`
}

function untypedClientSuggestion(f: SourceFinding): CheckSuggestion {
  const replacement = f.snippet.replace(/(?<![.\w])client\s*\(/, "client<typeof app>(")
  return replacement === f.snippet
    ? {
        kind: "manual",
        title: "Add the app type argument to the client factory",
        steps: [
          'Change `client("...")` to `client<typeof app>("...")`.',
          "Make sure the backend app type is imported or otherwise in scope.",
        ],
      }
    : {
        kind: "edit",
        title: "Insert `<typeof app>` into the client factory call",
        diff: oneLineDiff(f.file, f.line, f.snippet, replacement),
        steps: ["Make sure the backend app type is imported or otherwise in scope."],
      }
}

function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`
}

function typedClientCall(method: string, path: string): string {
  const segs = path.split("/").filter((seg) => seg !== "")
  let chain = "api"
  if (segs.length === 0) chain += ".index"
  else {
    for (const seg of segs) {
      chain += IDENT.test(seg) ? `.${seg}` : `[${JSON.stringify(seg)}]`
    }
  }
  return `${chain}.${method.toLowerCase()}()`
}

function staticRouteMap(routes: readonly StaticRouteFinding[]): Map<string, StaticRouteFinding[]> {
  const out = new Map<string, StaticRouteFinding[]>()
  for (const route of routes) {
    if (route.path.includes(":") || route.path.includes("*")) continue
    const key = routeKey(route.method, route.path)
    const bucket = out.get(key)
    if (bucket === undefined) out.set(key, [route])
    else bucket.push(route)
  }
  return out
}

function ownFetchEditSuggestion(
  f: SourceFinding,
  routes: Map<string, StaticRouteFinding[]>,
): CheckSuggestion | undefined {
  const call = parseSimpleFetchCall(f.snippet)
  if (call === undefined || !SIMPLE_REWRITE_METHODS.has(call.method)) return undefined
  const matches = routes.get(routeKey(call.method, call.path))
  if (matches === undefined || matches.length !== 1) return undefined
  const replacementCall = typedClientCall(call.method, call.path)
  const replacement = `${f.snippet.slice(0, call.start)}${replacementCall}${f.snippet.slice(call.end)}`
  if (replacement === f.snippet) return undefined
  const route = matches[0]
  if (route === undefined) return undefined
  return {
    kind: "edit",
    title: "Rewrite simple own-API fetch to the typed nifra client",
    diff: oneLineDiff(f.file, f.line, f.snippet, replacement),
    steps: [
      `Matched ${route.method} ${route.path} at ${route.file}:${route.line}.`,
      "Use an in-scope typed client named `api` (`client<typeof app>(baseUrl)` or the route loader/action `api`).",
      "Update downstream `Response` handling to branch on `{ ok, data, error }` if this variable is used later.",
    ],
  }
}

function ownFetchSuggestion(
  f: SourceFinding,
  routes: Map<string, StaticRouteFinding[]>,
): CheckSuggestion {
  const exact = ownFetchEditSuggestion(f, routes)
  if (exact !== undefined) return exact
  return {
    kind: "manual",
    title: "Replace own-API fetch with the typed nifra client",
    steps: [
      "Call `nifra_routes` or read `nifra://routes` for the exact typed-client call form.",
      "Create `const api = client<typeof app>(baseUrl)` from `@nifrajs/client`.",
      "Replace the relative `fetch()` call with the generated `api...get/post/...` call and branch on `{ ok, data, error }`.",
    ],
  }
}

function serverImportSuggestion(
  specifier: string,
  chain: readonly string[],
  fallback: boolean,
): CheckSuggestion {
  const sink = chain[chain.length - 1] ?? specifier
  // Surface the resolved chain in the fix steps so the agent sees the full path (`route → ../data →
  // ../db → node:crypto`) and which module to cut - not just the route's own top-level import.
  const chainStep =
    chain.length > 2
      ? fallback
        ? `Server-only code reaches this route through \`${chain.join(" → ")}\` (the deeper chain couldn't be resolved precisely - trace it from \`${specifier}\`).`
        : `Server-only code reaches this route transitively: \`${chain.join(" → ")}\`. The sink is \`${sink}\`; break the chain at the first hop (\`${specifier}\`) or move the sink behind the server boundary.`
      : undefined
  return {
    kind: "manual",
    title: "Move server-only code behind the route server boundary",
    steps: [
      ...(chainStep !== undefined ? [chainStep] : []),
      `Remove the top-level \`import … from "${specifier}"\` from this route module (it's bundled for the browser).`,
      "Access backend/data work through the route `loader`/`action` context (`api`, `env`, or project server context).",
      `If a direct module import is unavoidable, lazy-load it (\`await import("${specifier}")\`) inside the server-only loader/action path.`,
    ],
  }
}

function responseRouteSuggestion(): CheckSuggestion {
  return {
    kind: "manual",
    title: "Preserve typed-client response inference",
    steps: [
      "Prefer returning a plain object from JSON routes; nifra serializes it for you.",
      "For a stream, use a typed SSE route - `app.sse(...)` (or `sse(c, run)` from `@nifrajs/core/server`) - which keeps typed events instead of collapsing the client to `data: never`.",
      "If this route must return a raw Response (redirect, file), declare an explicit response schema, or add a `// nifra-expect raw-response` comment above the return to mark it intentional and silence this advisory.",
    ],
  }
}

/** Run the three checks and assemble a structured, machine-readable result. The single source the CLI
 * report, `--json`, and the MCP tool all render from. */
export async function collectCheckResult(
  cwd: string,
  opts: {
    readonly lintsOnly?: boolean
    readonly signal?: AbortSignal
    /** Cap the returned `diagnostics` to this many (adds {@link CheckResult.truncated}). The MCP tool sets
     * it so a huge project can't produce a transport-breaking result; the CLI leaves it unset (all shown). */
    readonly maxDiagnostics?: number
    /** How the interpolated-SQL rule gets its compiler. Injectable so the "not installed" path - the
     * one where a security rule reports that it did not run - is testable on a machine that has it. */
    readonly loadTypeScript?: () => Promise<TypeScriptApi | undefined>
    /** Route-assurance inputs already computed by {@link collectProjectVerification}. When present,
     * the capability + trust-manifest diagnostics reuse them instead of loading/reflecting a second
     * time; when absent, they are computed here (unchanged standalone behavior). */
    readonly assurance?: CheckAssuranceContext
  } = {},
): Promise<CheckResult> {
  const fetches: SourceFinding[] = []
  const staticRoutes: StaticRouteFinding[] = []
  const untypedClients: SourceFinding[] = []
  const removedImports: SourceFinding[] = []
  const serverImports: TransitiveServerImportFinding[] = []
  const responseRoutes: SourceFinding[] = []
  const interpolatedSql: SourceFinding[] = []
  // Route modules (rel + content) collected during the walk, so the TRANSITIVE server-only resolution
  // (#4.4) - which needs fs-backed import resolution, not just per-file text - runs after the walk.
  const routeModules: Array<{ rel: string; content: string }> = []
  const sourceFiles: Array<{ file: string; content: string }> = []
  // Load the optional check config first - the typed-client scan needs the external-mount allowlist as it
  // walks. It's a tiny pure-JSON read; a malformed file surfaces as a warning below, never blocking.
  const {
    config: checkConfig,
    error: checkConfigError,
    warnings: checkConfigWarnings,
  } = await loadCheckConfig(cwd)
  // The interpolated-SQL rule parses with the TypeScript compiler, which is an optional peer. Resolved
  // once, before the walk, so a project without it is told the rule did not run rather than being
  // handed a clean report the rule never produced.
  const sqlCompiler = await (opts.loadTypeScript ?? (() => importProjectTypeScript(cwd)))()
  // AST facts are a lazy refinement of lexical candidates. The parser is not invoked for a file until
  // one of the route/import/response scanners finds something worth disambiguating, and the cache is
  // shared across those rules for this check run.
  const sourceFacts = sqlCompiler === undefined ? undefined : createSourceFacts(sqlCompiler)
  // One loader + parse cache for the whole walk, so a shared `sql-fragments.ts` is read once no matter
  // how many route modules import a fragment out of it.
  const sqlImports = sqlCompiler === undefined ? undefined : createProjectSqlImports(cwd)
  // lintsOnly: skip the tsc pass (seconds on a big project) and run just the near-instant source
  // lints - the agent inner-loop mode; the full gate stays the definition of done.
  const [tc, _, dr, manifestDrift] = await Promise.all([
    opts.lintsOnly
      ? Promise.resolve<TypecheckResult>({ ran: false, ok: true, note: "lints-only mode" })
      : typecheck(cwd, opts.signal),
    walkSource(cwd, (rel, content) => {
      sourceFiles.push({ file: rel, content })
      fetches.push(...scanFetchText(rel, content, checkConfig.externalMounts))
      staticRoutes.push(...scanStaticRouteText(rel, content, sourceFacts))
      untypedClients.push(...scanUntypedClient(rel, content))
      removedImports.push(...scanRemovedImports(rel, content))
      if (ROUTE_FILE.test(rel)) routeModules.push({ rel, content })
      responseRoutes.push(...scanResponseRoutes(rel, content, sourceFacts))
      if (sqlCompiler !== undefined)
        interpolatedSql.push(...scanInterpolatedSql(rel, content, sqlCompiler, sqlImports))
    }),
    import("./doctor.ts").then((m) => m.collectDoctorResult(cwd)),
    scanServerManifestDrift(cwd),
  ])

  // #4.4: resolve the FULL transitive server-only chain per route. The resolver/reader are fs-backed
  // (`Bun.resolveSync` from the importing file's dir + a sync read), so the walk follows the real local
  // module graph (`route → ../data → ../db → node:crypto`). Both are best-effort + total: a resolve/read
  // miss returns `undefined`, and the walk falls back to the direct edge. The whole walk is bounded
  // (depth + visited caps), so a deep/cyclic graph can't blow up the check.
  const resolveModule: ModuleResolver = (fromFile, specifier) => {
    try {
      // `fromFile` is a cwd-RELATIVE route path on the first hop (`routes/x.tsx`) but ABSOLUTE on the
      // deeper hops the walk takes (it carries resolved absolute paths) - resolve the dir for each.
      const fromAbs = isAbsolute(fromFile) ? fromFile : join(cwd, fromFile)
      return Bun.resolveSync(specifier, dirname(fromAbs))
    } catch {
      return undefined // unresolvable (bare pkg without install, tsconfig path alias, missing file)
    }
  }
  const readModule: ModuleReader = (absPath) => {
    try {
      return readFileSync(absPath, "utf8")
    } catch {
      return undefined
    }
  }
  for (const { rel, content } of routeModules) {
    serverImports.push(
      ...resolveServerOnlyChains(rel, content, resolveModule, readModule, sourceFacts),
    )
  }

  const diagnostics: CheckDiagnostic[] = []
  const structuredExtras: Diagnostic[] = []
  if (checkConfigError !== undefined) {
    diagnostics.push({
      rule: "check-config",
      severity: "warning",
      file: "nifra.check.json",
      message: `nifra.check.json could not be parsed (${checkConfigError}) - its external-mount allowlist was ignored`,
      fix: "Fix the JSON syntax in nifra.check.json",
    })
  }
  for (const warning of checkConfigWarnings) {
    diagnostics.push({
      rule: "check-config",
      severity: "warning",
      file: "nifra.check.json",
      message: `nifra.check.json: ${warning}`,
      fix: "Fix the entry in nifra.check.json",
    })
  }
  if (tc.missingTypeScript === true) {
    // A tsconfig with no reachable `typescript` install is a broken gate, not a benign skip: the
    // contract check the project asked for (by having a tsconfig) silently didn't run. Fail closed.
    diagnostics.push({
      rule: "typecheck",
      severity: "error",
      file: "tsconfig.json",
      message:
        "tsconfig.json is present but no `typescript` install was found from this directory upward - the typecheck gate did NOT run",
      fix: "bun add -d typescript",
      suggestion: {
        kind: "command",
        title: "Install TypeScript so the contract gate can run",
        command: ["bun", "add", "-d", "typescript"],
      },
    })
  }
  if (tc.ran && !tc.ok) {
    const lines = (tc.output ?? "").split("\n")
    let matched = false
    for (const l of lines) {
      const m = TSC_LINE.exec(l.trim())
      if (m) {
        matched = true
        diagnostics.push({
          rule: "typecheck",
          severity: "error",
          file: m[1] as string,
          line: Number(m[2]),
          message: m[3] as string,
          suggestion: {
            kind: "manual",
            title: "Fix the TypeScript contract error",
            steps: [
              "Open the reported file and line.",
              "Align the handler, route schema, or typed-client call with the compiler error.",
              "Run `nifra_check` again after the edit.",
            ],
          },
        })
      }
    }
    if (!matched)
      diagnostics.push({
        rule: "typecheck",
        severity: "error",
        message: tc.output || "typecheck failed",
        suggestion: {
          kind: "manual",
          title: "Fix the TypeScript contract error",
          steps: ["Run `tsc --noEmit` locally for the full compiler output."],
        },
      })
  }
  const routes = staticRouteMap(staticRoutes)
  for (const f of fetches.sort(bySite)) {
    diagnostics.push({
      rule: "typed-client",
      severity: "error",
      file: f.file,
      line: f.line,
      message: `${f.snippet} - ${FETCH_HINT}`,
      fix: FETCH_HINT,
      suggestion: ownFetchSuggestion(f, routes),
    })
  }
  for (const f of removedImports.sort(bySite)) {
    const entry = REMOVED_IMPORTS.find(
      (candidate) =>
        f.snippet.includes(`"${candidate.specifier}`) ||
        f.snippet.includes(`'${candidate.specifier}`),
    )
    diagnostics.push({
      rule: "removed-import",
      severity: "error",
      file: f.file,
      line: f.line,
      message: `${f.snippet} - removed in nifra ${entry?.since ?? "2.0"}: ${entry?.replacement ?? "see the changelog"}`,
      fix: entry?.replacement ?? "see the changelog",
    })
  }
  for (const f of untypedClients.sort(bySite)) {
    diagnostics.push({
      rule: "untyped-client",
      severity: "error",
      file: f.file,
      line: f.line,
      message: `${f.snippet} - ${UNTYPED_CLIENT_HINT}`,
      fix: UNTYPED_CLIENT_HINT,
      suggestion: untypedClientSuggestion(f),
    })
  }
  for (const f of serverImports.sort(bySite)) {
    // #4.4: the FULL transitive chain the import-resolution walk found - `route → ../data → ../db →
    // node:crypto`, matching the build leak-guard's depth - instead of just the direct edge. The chain's
    // tail is the actual server-only sink; the head is the route. When a precise resolve wasn't possible
    // (a bare pkg / path alias), `fallback` is set and the chain degrades to the honest direct edge.
    const chain = f.chain
    const sink = chain[chain.length - 1] ?? f.specifier
    diagnostics.push({
      rule: "server-only-import",
      severity: "error",
      file: f.file,
      line: f.line,
      message: `${f.snippet} - server-only "${sink}" reaches the browser bundle via ${chain.join(" → ")}${f.fallback ? " (direct edge - couldn't resolve the transitive chain precisely)" : ""}; ${SERVER_IMPORT_HINT}`,
      fix: SERVER_IMPORT_HINT,
      chain,
      suggestion: serverImportSuggestion(f.specifier, chain, f.fallback),
    })
  }
  if (sqlCompiler === undefined) {
    // A security rule that could not run must say so. Silence here is indistinguishable from a clean
    // result, and this is the one rule whose clean result means "no SQL injection was found".
    diagnostics.push({
      rule: "interpolated-sql",
      severity: "warning",
      message: SQL_COMPILER_MISSING_HINT,
      fix: SQL_COMPILER_MISSING_HINT,
      suggestion: {
        kind: "command",
        title: "Install TypeScript so the SQL rule can run",
        command: ["bun add -d typescript"],
      },
    })
  }
  for (const f of interpolatedSql.sort(bySite)) {
    diagnostics.push({
      rule: "interpolated-sql",
      severity: "error",
      file: f.file,
      line: f.line,
      message: `${f.snippet} - ${INTERPOLATED_SQL_HINT}`,
      fix: "bind the value as a parameter instead of interpolating it into the statement",
      suggestion: {
        kind: "manual",
        title: "Bind the value instead of interpolating it",
        steps: [
          "Replace the interpolation with a placeholder your driver understands (`?` for SQLite/MySQL, `$1` for Postgres).",
          "Pass the value as an argument alongside the statement, so the driver binds it.",
          `Or switch to the driver's tagged template (sql\`… ${SQL_INTERPOLATION_EXAMPLE} …\`): the tag receives substitutions separately and binds them.`,
          "An identifier that genuinely cannot be bound (a table or column name) must be checked against an allowlist you control, never taken from the request.",
        ],
      },
    })
  }
  // Advisory - surfaced but NOT folded into `ok`, so it never fails the gate (a raw Response is valid).
  for (const f of responseRoutes.sort(bySite)) {
    diagnostics.push({
      rule: "response-route",
      severity: "warning",
      file: f.file,
      line: f.line,
      message: `${f.snippet} - ${RESPONSE_ROUTE_HINT}`,
      fix: RESPONSE_ROUTE_HINT,
      suggestion: responseRouteSuggestion(),
    })
  }
  if (dr.ran) {
    for (const f of dr.findings) {
      diagnostics.push({
        rule: "undeclared-dependency",
        severity: "error",
        file: f.file,
        line: f.line,
        message: `imports ${f.package} which is not declared in package.json - ${UNDECLARED_DEP_HINT}`,
        fix: `add ${f.package} to package.json dependencies`,
        suggestion: {
          kind: "command",
          title: `Declare ${f.package} in package.json`,
          command: ["bun", "add", f.package],
        },
      })
    }
    for (const finding of dr.duplicateInstalls) {
      const copies = finding.copies.map((copy) => `${copy.version} at ${copy.path}`).join("; ")
      diagnostics.push({
        rule: "duplicate-install",
        severity: "error",
        message: `${finding.package} resolves to multiple physical copies (${copies}) - ${finding.explanation}`,
        fix: finding.remediation,
        suggestion: {
          kind: "manual",
          title: `Deduplicate ${finding.package}`,
          steps: [
            "Align workspace dependency and peer ranges on one compatible version.",
            "Remove stale nested installs and run the package manager from the workspace root.",
            "Run `nifra doctor` again; do not suppress same-version duplicate paths.",
          ],
        },
      })
    }
    // Advisory (never fails the gate): while actively editing a linked package its dist is always
    // momentarily behind. The finding earns its keep when a dev server is about to start against it -
    // Bun reads live `src` while Vite's SSR runner reads the artifact, so a stale one 500s inside
    // framework/shared-package code and reads exactly like an upstream regression.
    for (const f of dr.staleDists) {
      diagnostics.push({
        rule: "stale-workspace-dist",
        severity: "warning",
        message: f.missing
          ? `${f.package} was never built - ${f.distFile} is missing, but its export map serves it to Vite SSR/node consumers while Bun reads src - rebuild ${f.package}`
          : `${f.package} has a stale build artifact - ${f.distFile} is ${f.behindSeconds}s older than ${f.sourceFile}, and Vite SSR/node consumers read the artifact while Bun reads src - rebuild ${f.package}`,
        fix: `rebuild ${f.package}`,
        evidence: [f.package, f.distFile, f.sourceFile],
        suggestion: {
          kind: "manual",
          title: `Rebuild ${f.package}`,
          steps: [
            `Run the package's build (usually \`bun run build\` in its directory) so ${f.distFile} matches its source again.`,
            "Only workspace-linked installs drift; npm tarballs are immutable and never flagged.",
          ],
        },
      })
    }
  }
  // The two-pipeline rule, read from the config as TEXT (doctor collects it - see ./pipeline-report.ts).
  // `loadApp` already refuses a misplaced plugin, but only when something loads the app; a check that
  // never executes project code, and CI that never starts a dev server, would otherwise meet these for
  // the first time as a production server that built cleanly and died at startup.
  for (const f of dr.pipeline?.findings ?? []) {
    diagnostics.push({
      rule: "pipeline",
      severity: f.severity,
      file: f.file,
      ...(f.line !== undefined ? { line: f.line } : {}),
      message: f.message,
      fix: f.fix,
      suggestion: { kind: "manual", title: f.fix, steps: [PIPELINE_DOC_HINT] },
    })
  }
  // #7: a committed server-manifest.ts that drifted from routes/ - name the exact missing/extra routes.
  for (const f of manifestDrift) {
    const parts: string[] = []
    if (f.missing.length > 0) parts.push(`missing from manifest: ${f.missing.join(", ")}`)
    if (f.extra.length > 0) parts.push(`stale in manifest: ${f.extra.join(", ")}`)
    diagnostics.push({
      rule: "server-manifest-drift",
      severity: "error",
      file: f.file,
      message: `${f.file} drifted from routes/ (${parts.join("; ")}) - ${MANIFEST_DRIFT_HINT}`,
      fix: MANIFEST_DRIFT_HINT,
      evidence: [...f.missing, ...f.extra],
      suggestion: {
        kind: "manual",
        title: "Regenerate the committed server manifest",
        steps: [
          "Re-run your build (`nifra build --target <t>` or your build script) - it regenerates server-manifest.ts from the current routes/.",
          "Commit the updated server-manifest.ts.",
        ],
      },
    })
  }

  // G+B+D+F: when the project opts into capability assurance, `nifra check` becomes the static
  // provenance firewall as well as the typed-contract gate. Loading is explicit/config-owned; projects
  // without nifra.assurance.ts retain the historical scan and hot path unchanged.
  const provided = opts.assurance
  let applicationRulePacks: readonly import("./rules/index.ts").RulePack[] = []
  const assuranceConfigPath = join(cwd, "nifra.assurance.ts")
  if (provided !== undefined ? provided.present : existsSync(assuranceConfigPath)) {
    try {
      // Either the shared reflection from `collectProjectVerification` (no second pass) or, on the
      // standalone path, loaded + reflected here. Both branches yield the same config + evidence.
      let config: AssuranceConfig
      let project: CapabilityProjectReport | undefined
      let routeAssurance: AssuranceReport | undefined
      let evidence: ProjectEvidenceSnapshot | undefined
      if (provided !== undefined) {
        // A load/evaluate failure travels as `provided.error`; re-throwing lands it in the same
        // capability-config diagnostic the standalone catch produces.
        if (provided.error !== undefined) throw provided.error
        config = provided.config as AssuranceConfig
        project = provided.capability
        routeAssurance = provided.routeAssurance
        evidence = provided.evidence
      } else {
        const { loadAssuranceConfig } = await import("./assure.ts")
        config = await loadAssuranceConfig(cwd)
        if (config.capabilities !== undefined) {
          const { collectCapabilityProjectReport } = await import("./capabilities-tool.ts")
          project = await collectCapabilityProjectReport(cwd, config.source, config.capabilities)
        }
      }
      applicationRulePacks = parseRulePacks(config.rulePacks)
      const capabilityReport = project?.report
      if (config.capabilities !== undefined && project !== undefined) {
        for (const finding of project.report.findings) {
          const violation =
            finding.code === "forbidden-effect-import"
              ? project.violations.find(
                  (candidate) =>
                    candidate.method === finding.method && candidate.path === finding.path,
                )
              : undefined
          const truncation =
            finding.code === "provenance-truncated"
              ? project.truncations.find(
                  (candidate) =>
                    candidate.method === finding.method && candidate.path === finding.path,
                )
              : undefined
          // An unmatched seam is a policy defect, not a route defect: the fix is in the policy file,
          // so it gets its own steps instead of the route-side provenance guidance.
          const seamFix =
            finding.code === "unmatched-provenance-seam"
              ? "Write the seam exactly as the code imports it, or delete the rule."
              : undefined
          diagnostics.push({
            rule: "capability-assurance",
            severity: "error",
            ...(violation !== undefined
              ? { file: violation.module, chain: violation.chain }
              : truncation !== undefined
                ? { chain: truncation.chain }
                : {}),
            message: `${finding.message}${seamFix === undefined ? ` - ${CAPABILITY_HINT}` : ""}`,
            fix: seamFix ?? CAPABILITY_HINT,
            suggestion:
              seamFix === undefined
                ? {
                    kind: "manual",
                    title: "Restore declared effect provenance",
                    steps: [
                      "Route effectful work through an import listed in capabilities.provenance.imports.",
                      "Declare the exact capability token on the route; do not widen unrelated routes in the same file.",
                      "For domain writes, add the adapter the capability definition requires: `schema.idempotency` for the `request` tier, `.use(durableCommand({ journal }))` from @nifrajs/middleware for the `durable` tier.",
                      "Run `nifra capabilities snapshot` only after assurance passes, then review the lockfile diff.",
                    ],
                  }
                : {
                    kind: "manual",
                    title: "Point the provenance rule at a module that exists",
                    steps: [
                      "Copy the specifier from the import statement itself - it is matched as written, with no extension or index resolution.",
                      "Use a trailing `/*` when the seam is a directory of modules (`@myorg/db/*`).",
                      "For a routeModules entry, give the project-relative path of the file that implements the route.",
                      "Delete the rule if the seam it governed is gone; leaving it in place proves nothing.",
                    ],
                  },
          })
        }
      }
      if (config.manifest !== undefined) {
        const { buildNifraManifest, parseNifraManifest, serializeNifraManifest } = await import(
          "@nifrajs/core/manifest"
        )
        const assurance =
          routeAssurance ??
          (await import("@nifrajs/core/assurance")).evaluateRouteAssurance(
            config.source,
            config.policy,
            {
              ...(config.capabilities !== undefined
                ? { definitions: config.capabilities.definitions }
                : {}),
            },
          )
        evidence ??= snapshotProjectEvidence(config.source, {
          assurance,
          ...(capabilityReport !== undefined ? { capabilities: capabilityReport } : {}),
        })
        const path = resolve(cwd, config.manifest.path ?? "nifra.manifest.json")
        let message: string | undefined
        if (!assurance.ok || (capabilityReport !== undefined && !capabilityReport.ok)) {
          message =
            "the configured assurance policy is failing, so a trusted manifest cannot be built"
        } else if (!existsSync(path)) {
          message = "the configured trust manifest is missing"
        } else {
          try {
            const current = await buildNifraManifest({
              evidence,
              assurance,
              ...(capabilityReport !== undefined ? { capabilities: capabilityReport } : {}),
            })
            const storedText = await Bun.file(path).text()
            const stored = await parseNifraManifest(storedText, path)
            const expectedText = `${serializeNifraManifest(current)}\n`
            if (storedText !== expectedText || stored.contentHash !== current.contentHash) {
              message = "the configured trust manifest does not match live route reflection"
            }
          } catch (error) {
            message = `the configured trust manifest is invalid: ${error instanceof Error ? error.message : String(error)}`
          }
        }
        if (message !== undefined) {
          diagnostics.push({
            rule: "manifest-drift",
            severity: "error",
            file: path,
            message: `${message} - ${TRUST_MANIFEST_DRIFT_HINT}`,
            fix: TRUST_MANIFEST_DRIFT_HINT,
            suggestion: {
              kind: "command",
              title: "Regenerate the signed-manifest input artifact",
              command: ["nifra", "manifest", "emit"],
              steps: [
                "Review the route, assurance, capability, and classification delta before committing it.",
              ],
            },
          })
        }
      }
    } catch (err) {
      diagnostics.push({
        rule: "capability-config",
        severity: "error",
        file: "nifra.assurance.ts",
        message: `capability assurance config could not be evaluated: ${err instanceof Error ? err.message : String(err)}`,
        suggestion: {
          kind: "manual",
          title: "Repair the assurance config",
          steps: [
            "Ensure nifra.assurance.ts default-exports defineAssuranceConfig({ source, policy, capabilities }).",
            "Fix configuration/import errors; the provenance firewall fails closed when its policy cannot load.",
          ],
        },
      })
    }
  }

  try {
    const { checkContractsLock } = await import("./contracts.ts")
    if (!existsSync(join(cwd, "backend.ts")) && !existsSync(join(cwd, "contracts.lock.json"))) {
      throw new Error("contract source not configured")
    }
    const contract = await checkContractsLock(cwd)
    if (!contract.present) {
      structuredExtras.push(
        diagnostic({
          code: "NF-K001",
          severity: "info",
          message: "no contract lock; run `nifra contracts snapshot` to enable drift detection",
          verify: "nifra contracts snapshot",
        }),
      )
    } else {
      for (const finding of contract.diagnostics) {
        diagnostics.push({
          rule: "contract-drift",
          severity: "error",
          code: "NF-K001",
          ...(finding.route !== undefined ? { evidence: [finding.route] } : {}),
          message: finding.message,
          fix: "run `nifra contracts snapshot` after reviewing the contract change",
          verify: "nifra check --lints-only",
        })
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message === "contract source not configured") {
      // API-only source scans have no contract surface to snapshot.
    } else {
      diagnostics.push({
        rule: "contract-drift",
        severity: "error",
        code: "NF-K001",
        message: `contract lock could not be checked: ${error instanceof Error ? error.message : String(error)}`,
        verify: "nifra contracts snapshot",
      })
    }
  }

  const ruleContext: RuleContext = {
    root: cwd,
    sources: sourceIndex(sourceFiles),
    project: {
      legacyDiagnostics: diagnostics,
      assurance: opts.assurance,
      // Route registrations collected during the source walk, so the route-table rules
      // (rules/routes.ts) lint them without a second scan.
      staticRoutes,
    },
  }
  const structuredDiagnostics = [...structuredExtras]
  let registryDiagnostics: Diagnostic[] = []
  try {
    registryDiagnostics = await runRuleRegistry(
      ruleContext,
      [...legacyRules, ...securityRules, ...routeRules],
      applicationRulePacks,
    )
    structuredDiagnostics.push(...registryDiagnostics)
  } catch (error) {
    registryDiagnostics = [
      diagnostic({
        code: "NF-C017",
        severity: "error",
        message: `rule registry failed closed: ${error instanceof Error ? error.message : String(error)}`,
        fix: { recipe: "rule-pack.repair", command: "nifra check --lints-only" },
        verify: "nifra check --lints-only",
      }),
    ]
    structuredDiagnostics.push(...registryDiagnostics)
  }
  for (const item of registryDiagnostics) {
    // The legacy adapters publish stable structured findings; the human compatibility view already
    // contains their original rule names. Security rules and application packs still need a legacy-view
    // row because they have no pre-registry diagnostic.
    if (legacyRules.some((rule) => rule.code === item.code)) continue
    diagnostics.push({
      rule: item.code,
      severity: item.severity === "error" ? "error" : "warning",
      code: item.code,
      ...(item.file !== undefined ? { file: item.file } : {}),
      ...(item.line !== undefined ? { line: item.line } : {}),
      message: item.message,
      ...(item.evidence !== undefined ? { evidence: item.evidence } : {}),
      ...(item.verify !== undefined ? { verify: item.verify } : {}),
    })
  }

  // Per-rule overrides from `nifra.check.json` `rules`, applied centrally to BOTH diagnostic views
  // before `ok` is computed - never inside individual rules, so no rule can dodge (or double-apply)
  // them. A key matches the legacy rule name or the stable NF- code.
  const overrideFor = (...keys: (string | undefined)[]): RuleOverride | undefined => {
    for (const key of keys) {
      if (key !== undefined && checkConfig.rules[key] !== undefined) return checkConfig.rules[key]
    }
    return undefined
  }
  const ignoreGlobs = new Map<RuleOverride, Glob[]>()
  const dropped = (override: RuleOverride, file: string | undefined): boolean => {
    if (override.severity === "off") return true
    if (override.ignore === undefined || file === undefined) return false
    let globs = ignoreGlobs.get(override)
    if (globs === undefined) {
      globs = override.ignore.map((pattern) => new Glob(pattern))
      ignoreGlobs.set(override, globs)
    }
    return globs.some((glob) => glob.match(file))
  }
  const codeToLegacy = new Map(
    Object.entries(LEGACY_RULE_CODES).map(([name, code]) => [code, name]),
  )
  const finalDiagnostics = diagnostics.flatMap<CheckDiagnostic>((d) => {
    const override = overrideFor(d.rule, d.code, LEGACY_RULE_CODES[d.rule])
    if (override === undefined) return [d]
    if (dropped(override, d.file)) return []
    // "off" is fully handled by `dropped` above - only real severities reach the retag.
    if (override.severity === undefined || override.severity === "off") return [d]
    return [{ ...d, severity: override.severity === "warn" ? "warning" : override.severity }]
  })
  const finalStructured = structuredDiagnostics.flatMap<Diagnostic>((d) => {
    const override = overrideFor(d.code, codeToLegacy.get(d.code))
    if (override === undefined) return [d]
    if (dropped(override, d.file)) return []
    if (override.severity === undefined || override.severity === "off") return [d]
    return [Object.freeze({ ...d, severity: override.severity })]
  })

  // Cap the diagnostics when asked (the MCP path), so a project with thousands of findings can't return a
  // message that breaks the stdio transport. `ok` reflects the FULL set - truncation never flips it.
  const total = finalDiagnostics.length
  const max = opts.maxDiagnostics
  const shown = max !== undefined && total > max ? finalDiagnostics.slice(0, max) : finalDiagnostics
  const result: CheckResult = {
    ok: !finalDiagnostics.some((diagnostic) => diagnostic.severity === "error"),
    typecheck: tc.ran ? (tc.ok ? "pass" : "fail") : "skipped",
    ...(!tc.ran && tc.note !== undefined ? { typecheckNote: tc.note } : {}),
    diagnostics: shown,
    ...(dr.pipeline !== undefined ? { pipeline: dr.pipeline } : {}),
    ...(checkConfig.externalMounts.length > 0
      ? { externalMounts: checkConfig.externalMounts }
      : {}),
    ...(Object.keys(checkConfig.rules).length > 0 ? { ruleOverrides: checkConfig.rules } : {}),
    ...(shown.length < total ? { truncated: { shown: shown.length, total } } : {}),
  }
  Object.defineProperty(result, "structuredDiagnostics", {
    value: finalStructured.slice(0, shown.length + structuredExtras.length),
    enumerable: false,
  })
  return result
}

/** The named rule sections of the human report, in print order. A rule absent from this list is NOT
 * dropped: {@link renderCheckReport} renders every remaining diagnostic in a generic section keyed by
 * its rule code, so a finding that can flip the exit code is never invisible in the default output. */
const REPORT_SECTIONS = [
  ["typecheck", "typecheck"],
  ["typed-client", "hand-rolled fetch() to your own API"],
  ["untyped-client", 'client("…") missing its <typeof app> type argument'],
  ["server-only-import", "server-only import in a route module"],
  ["interpolated-sql", "SQL built by interpolating a value into the statement"],
  ["response-route", "route returns a raw Response (typed client → data: never)"],
  ["undeclared-dependency", "undeclared dependency in package.json"],
  ["duplicate-install", "duplicate identity-sensitive dependency install"],
  ["stale-workspace-dist", "workspace-linked dist older than its source"],
  ["pipeline", "bundler pipeline (Vite/Bun) config"],
  ["server-manifest-drift", "server-manifest.ts drifted from routes/"],
  ["manifest-drift", "versioned trust manifest drift"],
  ["capability-assurance", "effect/capability assurance"],
  ["capability-config", "capability assurance config"],
  ["check-config", "nifra.check.json"],
] as const

/**
 * Render the human-readable check report as lines. Pure (no I/O, no cwd) so tests can assert
 * report/exit-code parity: every diagnostic in `result.diagnostics` appears in the output, and the
 * trailer states the error/advisory counts that produced `ok`.
 */
export function renderCheckReport(result: CheckResult): string[] {
  const lines: string[] = []
  lines.push("nifra check", "")
  lines.push(
    result.typecheck === "pass"
      ? "✓ typecheck passed"
      : result.typecheck === "fail"
        ? "✗ typecheck failed - the frontend/backend contract is broken"
        : `⚠ typecheck SKIPPED - ${result.typecheckNote ?? "no tsconfig / typescript not installed"} (the contract gate did not run)`,
  )
  // Stated on every run, passing or not. "Which bundler is this app on" decides which plugin slot is
  // live and which toolchain compiles a component, so it belongs in the report rather than only in the
  // dev server's banner - where CI never sees it.
  if (result.pipeline !== undefined) {
    lines.push(
      result.pipeline.pipeline === "unknown"
        ? `• bundler: not readable from ${result.pipeline.configFile} - ${result.pipeline.reason}`
        : `• bundler: ${result.pipeline.pipeline} (${result.pipeline.reason})`,
    )
  }
  if (result.externalMounts !== undefined && result.externalMounts.length > 0) {
    lines.push(
      `• intentional external mounts (not typed-client checked): ${result.externalMounts.join(", ")}`,
    )
  }
  if (result.ruleOverrides !== undefined) {
    const active = Object.entries(result.ruleOverrides).map(([rule, override]) => {
      const parts: string[] = []
      if (override.severity !== undefined) parts.push(`severity=${override.severity}`)
      if (override.ignore !== undefined) parts.push(`ignore=${override.ignore.join(",")}`)
      return `${rule} (${parts.join(", ")})`
    })
    lines.push(`• rule overrides from nifra.check.json: ${active.join("; ")}`)
  }
  const renderSection = (rule: string, label: string, ds: readonly CheckDiagnostic[]): void => {
    if (rule !== "typecheck") {
      // Marked by SEVERITY, not by rule name. `response-route` and `stale-workspace-dist` are advisory
      // in whole; `pipeline` is the first rule that is advisory in part (a misplaced plugin fails, a
      // resolve condition the Bun dev bundler can't take does not), so the counts are split rather than
      // rounded up to the worse of the two.
      const errors = ds.filter((d) => d.severity === "error").length
      const advisory = ds.length - errors
      lines.push(
        ds.length === 0
          ? `✓ ${label}: none`
          : errors === 0
            ? `⚠ ${label}: ${advisory} (advisory)`
            : `✗ ${label}: ${errors}${advisory > 0 ? ` (+${advisory} advisory)` : ""}`,
      )
    }
    for (const d of ds) {
      lines.push(`    ${d.file ?? ""}${d.line ? `:${d.line}` : ""}  ${d.message}`)
      if (d.suggestion !== undefined) {
        lines.push(`      fix: ${d.suggestion.title}`)
        if (d.suggestion.command !== undefined) {
          lines.push(`      command: ${d.suggestion.command.join(" ")}`)
        }
        if (d.suggestion.diff !== undefined) {
          for (const line of d.suggestion.diff.split("\n")) lines.push(`      ${line}`)
        }
        for (const step of d.suggestion.steps ?? []) lines.push(`      - ${step}`)
      }
    }
  }
  for (const [rule, label] of REPORT_SECTIONS) {
    renderSection(
      rule,
      label,
      result.diagnostics.filter((d) => d.rule === rule),
    )
  }
  // Generic section: diagnostics whose rule has no named section above (registry rules publishing
  // under their NF- code, application rule packs). These count toward `ok` exactly like the named
  // ones, so they get the same severity-marked rendering - only "✓ …: none" is skipped, because
  // the set of possible unlisted rules is open-ended.
  const named = new Set<string>(REPORT_SECTIONS.map(([rule]) => rule))
  const extraRules: string[] = []
  for (const d of result.diagnostics) {
    if (!named.has(d.rule) && !extraRules.includes(d.rule)) extraRules.push(d.rule)
  }
  for (const rule of extraRules) {
    const title = (RULE_CODES as Record<string, string | undefined>)[rule]
    renderSection(
      rule,
      title !== undefined ? `${title} (${rule})` : rule,
      result.diagnostics.filter((d) => d.rule === rule),
    )
  }
  if (result.truncated !== undefined) {
    lines.push(
      `• showing ${result.truncated.shown} of ${result.truncated.total} diagnostics (truncated)`,
    )
  }
  const errors = result.diagnostics.filter((d) => d.severity === "error").length
  const advisory = result.diagnostics.length - errors
  lines.push(
    "",
    result.ok
      ? advisory > 0
        ? `✓ check passed (${advisory} advisory)`
        : "✓ check passed"
      : `✗ check failed: ${errors} error${errors === 1 ? "" : "s"}${advisory > 0 ? ` (+${advisory} advisory)` : ""}`,
  )
  return lines
}

/** Run the full check; print a report (`--json` for machine output) and return whether it passed. */
export async function runCheck(
  cwd: string,
  opts: {
    readonly json?: boolean
    readonly lintsOnly?: boolean
    readonly structured?: boolean
  } = {},
): Promise<boolean> {
  // The check view over the one project verification: the same collector `assure` and `levels` read.
  const { collectProjectVerification } = await import("./verification.ts")
  const verification = await collectProjectVerification(cwd, { lintsOnly: opts.lintsOnly ?? false })
  const result = await verification.check()
  if (opts.json) {
    console.log(
      JSON.stringify(
        opts.structured === true && result.structuredDiagnostics !== undefined
          ? { ...result, diagnostics: result.structuredDiagnostics }
          : result,
        null,
        2,
      ),
    )
    return result.ok
  }

  console.log(renderCheckReport(result).join("\n"))
  // Discoverability nudge: a project with no `.mcp.json` hasn't wired its nifra MCP for coding agents.
  // `nifra init-agents` writes it (+ .cursor/mcp.json + a CLAUDE.md preamble), no-clobber. A non-fatal
  // one-line tip in the human report only (the `--json` path returns above, unaffected).
  if (!existsSync(join(cwd, ".mcp.json"))) {
    console.log(
      "\ntip: no .mcp.json here - run `nifra init-agents` to wire this project's MCP + agent files (no-clobber).",
    )
  }
  // `public/` used to be served in dev (inherited from Vite) and not in production, so every app
  // hand-rolled static serving in its own server entry - or shipped a file that 404'd only once
  // deployed. `@nifrajs/web` owns it now, so an app carrying the workaround can delete it. A tip
  // rather than a finding: a hand-rolled handler still works (it simply runs first), so this is
  // not a failure, and telling an app it can delete code is the entire point.
  if (existsSync(join(cwd, "public"))) {
    console.log(
      '\ntip: `public/` is now served by @nifrajs/web in dev AND production (publicDir, default "public"). If your server entry hand-rolls static serving, you can delete it.',
    )
  }
  return result.ok
}

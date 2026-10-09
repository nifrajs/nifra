/**
 * Pure source scanners for the nifra verification pipeline.
 *
 * This module deliberately has no CLI, policy, or diagnostic-view dependencies. Its interface is
 * source text plus injected module/type resolvers, which keeps the scanner seam independently testable.
 */

import { readFileSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, posix, resolve, sep } from "node:path"
import { isServerPackageSpecifier } from "@nifrajs/web/zones"
import { Glob } from "bun"
import type * as TSApi from "typescript"
import { codeUnitOrder } from "./internal/code-unit-order.ts"
import { scriptKindOf } from "./internal/script-kind.ts"
import type { SourceFacts } from "./internal/source-facts.ts"
import {
  loadProjectTypeScript,
  type TypeScriptApi,
  type TypeScriptSourceIndex,
} from "./internal/typescript-import.ts"
import { commentBlockExpectation } from "./rules/comment-markers.ts"

export interface SourceFinding {
  readonly file: string
  readonly line: number
  readonly snippet: string
}
/** An interpolated-SQL site, with the reason a `nifra-expect NF-C006: <reason>` comment gives for it. */
export interface SqlFinding extends SourceFinding {
  readonly expected?: string
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
const SOCKET_VERB: ReadonlySet<string> = new Set(["WS"])
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

// Browser code by path, mirroring `@nifrajs/web/zones`: a suffix decides first, then the folder. A
// route's backend half (`x.backend.ts`), `backend/` and `*.fn.ts` run on the server only.
const BACKEND_SUFFIX = /\.backend\.[cm]?[jt]sx?$/
const BROWSER_SUFFIX = /\.(?:frontend|shared)\.[^/]+$/
const BROWSER_FOLDER = /(^|\/)(?:routes|frontend|shared)\//
const BACKEND_FOLDER = /(^|\/)backend\//
const SERVER_FN_FILE = /\.fn\.[cm]?[jt]sx?$/

/** Whether a project file is browser code: a route's frontend half, `frontend/` or `shared/`. Pure. */
export function isBrowserSource(file: string): boolean {
  const path = normalizeProjectPath(file)
  if (BACKEND_SUFFIX.test(path) || SERVER_FN_FILE.test(path)) return false
  if (BROWSER_SUFFIX.test(path)) return true
  return BROWSER_FOLDER.test(path) && !BACKEND_FOLDER.test(path)
}

/** Whether a resolved module is backend code a browser import may not reach (a `*.fn.ts` module ships
 * as its generated stub, so it is not). A legacy `*.server` module counts: the build refuses it. */
function isBackendModule(file: string): boolean {
  const path = normalizeProjectPath(file)
  if (SERVER_FN_FILE.test(path)) return false
  return (
    BACKEND_SUFFIX.test(path) ||
    LEGACY_SERVER_FILE.test(path) ||
    (BACKEND_FOLDER.test(path) && !BROWSER_SUFFIX.test(path))
  )
}

// Node builtins that have no browser counterpart, imported bare. Bare `events`, `buffer`, `path`, `util`
// and the like stay out: each also names an npm polyfill a browser bundle may legitimately carry.
const SERVER_BUILTINS: ReadonlySet<string> = new Set([
  "async_hooks",
  "child_process",
  "cluster",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "dns/promises",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "perf_hooks",
  "readline",
  "readline/promises",
  "repl",
  "tls",
  "trace_events",
  "tty",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
])
// The conventional `./db` module the scaffold generates.
const DB_MODULE = /^(?:\.\.?\/)+db(?:\.[cm]?[jt]sx?)?$/

/**
 * Whether a specifier names server-only code by name, so the chain ends there: a `node:`/`bun:`
 * module, a bare builtin with no browser counterpart, or a package the browser build refuses
 * (`SERVER_PACKAGES` and the driver entries of `@nifrajs/web/zones`).
 */
function isServerOnlySink(specifier: string): boolean {
  return (
    /^(?:node:|bun:)/.test(specifier) ||
    SERVER_BUILTINS.has(specifier) ||
    isServerPackageSpecifier(specifier)
  )
}

/** A specifier no route module may value-import: a {@link isServerOnlySink} name, or the `./db` module. */
const isServerOnly = (specifier: string): boolean =>
  isServerOnlySink(specifier) || DB_MODULE.test(specifier)

// A static, non-type import with a string specifier, or a re-export (`export … from "x"`), which
// pulls its module into the bundle the same way. `import type …` and `export type …` are erased at
// build, so they're safe and skipped. Dynamic `import(…)` has `(` right after `import`, so `import\s+`
// never matches it; it is read by DYNAMIC_IMPORT below.
// The clause between the keyword and `from` is spelled out (a default binding, then `* as ns` or a
// `{ … }` list) rather than scanned lazily: a lazy scan restarts at every `export const` line and is
// quadratic on a long semicolon-free module.
const STATIC_IMPORT =
  /\b(?:import\s*(?!type\b)(?:(?:[\w$]+\s*,?\s*)?(?:\*\s*(?:as\b\s*[\w$]+\s*)?|\{[^{}'"]*\}\s*)?from\s*)?|export\s*(?!type\b)(?:\*\s*(?:as\b\s*[\w$]+\s*)?|\{[^{}'"]*\}\s*)from\s*)['"]([^'"]+)['"]/g
// A dynamic `import("x")` whose specifier is one string literal. The client build bundles its target
// as a lazy chunk, so it reaches the browser bundle like a static import does - also from inside a
// loader, which ships with the route module. A computed specifier cannot be followed and is skipped.
const DYNAMIC_IMPORT = /(?<![\w$.])import\s*\(\s*(["'`])([^"'`$\\\r\n]+)\1\s*[,)]/g
// Without a parser: `typeof import("x")` and `import("x").Name` are type positions, erased at build.
// A runtime `import("x")` is a promise, so the only members read straight off it are its methods.
const TYPE_QUERY_BEFORE = /\btypeof\s*$/
// `require("x")` and `import x = require("x")` pull a module into a bundle as `import` does; the
// `import type x = require("x")` form is erased.
const REQUIRE_CALL = /(?<![\w$.])require\s*\(\s*(["'])([^"'\\\r\n]+)\1\s*\)/g
const TYPE_ALIAS_BEFORE = /\bimport\s+type\s+[\w$]+\s*=\s*$/
const TYPE_QUALIFIER_AFTER = /^\s*\.\s*(?!(?:then|catch|finally)\b)[A-Za-z_$]/

const ROUTE_REGISTRATION_DQ = /\.([A-Za-z]+)\s*\(\s*"((?:\\.|[^"\\])*)"/g
const ROUTE_REGISTRATION_SQ = /\.([A-Za-z]+)\s*\(\s*'((?:\\.|[^'\\])*)'/g
// `all("/path", ...)` and `method("PURGE", "/path", ...)` / `method(["GET", "PURGE"], "/path", ...)`
// from `@nifrajs/core/methods`. They are free function calls, so the member-call patterns above do
// not see them.
const METHODS_SUBPATH = "@nifrajs/core/methods"
const ALL_ROUTES = /(?<![\w$.])all\s*\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/g
const METHOD_ROUTES =
  /(?<![\w$.])method\s*\(\s*(\[[^\]]*\]|"[^"\\]*"|'[^'\\]*')\s*,\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/g
const METHOD_NAME_LITERAL = /(["'])([A-Za-z][A-Za-z0-9-]{0,31})\1/g
export const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

export interface StaticRouteFinding extends SourceFinding {
  readonly method: string
  readonly path: string
}

/** A route registration whose path argument the static scan cannot read, with that argument's text. */
export interface UnresolvedRoutePathFinding extends SourceFinding {
  readonly method: string
  readonly expression: string
}

// `.get(NAME, …)` or `` .get(`…`, …) ``: a path that is not a quoted literal. The comma is required:
// a registration always has a handler after its path, while `map.get(key)` has nothing.
const ROUTE_ARGUMENT = /\.([A-Za-z]+)\s*\(\s*([A-Za-z_$][\w$]*|`(?:\\.|[^`\\])*`)\s*,/g
const NAMED_IMPORTS = /(?<![\w$.])import\s*\{([^}]*)\}\s*from\s*(["'])([^"'\r\n]+)\2/g

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
  verbs: ReadonlySet<string> = HTTP_VERBS,
): StaticRouteFinding[] {
  const out: StaticRouteFinding[] = []
  const lines = content.split("\n")
  pattern.lastIndex = 0
  for (let m = pattern.exec(code); m !== null; m = pattern.exec(code)) {
    const method = (m[1] ?? "").toUpperCase()
    if (!verbs.has(method)) continue
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

// Punctuators after which a `/` opens a regex literal rather than dividing. A `)` `]` or `}` is read
// as the end of an operand, so `/` after it divides - the rare statement-leading regex after a block
// is the cost of not tracking parser context.
const REGEX_AFTER = new Set([
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  ";",
  "+",
  "-",
  "*",
  "%",
  "<",
  ">",
  "~",
  "^",
])
const REGEX_AFTER_WORD = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
  "instanceof",
])
const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\w$]/.test(c)

/** Where a regex literal opened by the `/` at `i` ends (after its flags), or `undefined` when the
 * literal does not close on its line - then the slash was division after all. */
function regexLiteralEnd(src: string, i: number): number | undefined {
  const n = src.length
  let j = i + 1
  let inClass = false
  while (j < n) {
    const c = src[j]
    if (c === "\n" || c === "\r") return undefined
    if (c === "\\") {
      j += 2
      continue
    }
    if (inClass) {
      if (c === "]") inClass = false
    } else if (c === "[") {
      inClass = true
    } else if (c === "/") {
      break
    }
    j++
  }
  if (j >= n) return undefined
  j++
  while (j < n && isWordChar(src[j])) j++
  return j
}

/**
 * Blank comments, template-literal contents and regex-literal contents (and, with `quoted: "blank"`,
 * single/double-quoted strings and every delimiter) while preserving every offset and newline.
 * A small lexer, not a parser: a `/` opens a regex where an operand may start - after a punctuator,
 * an operator keyword, or at the start of the file - so a quote inside a regex no longer derails
 * the string state that follows.
 */
function maskSource(src: string, quoted: "keep" | "blank"): string {
  const out = src.split("")
  const n = src.length
  const blank = (a: number, b: number): void => {
    for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " "
  }
  // The last significant code token: a punctuator character, or a whole identifier/keyword.
  let previous = ""
  let i = 0
  while (i < n) {
    const c = src.charAt(i)
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
      if (quoted === "keep")
        blank(i + 1, j) // keep the backticks, blank the code-as-text inside
      else blank(i, Math.min(j + 1, n))
      i = j + 1
      previous = "`"
    } else if (c === "'" || c === '"') {
      let j = i + 1
      while (j < n && src[j] !== c) {
        if (src[j] === "\\") j++ // skip the escaped char
        j++
      }
      if (quoted === "blank") blank(i, Math.min(j + 1, n))
      i = j + 1
      previous = c
    } else if (
      c === "/" &&
      (previous === "" || REGEX_AFTER.has(previous) || REGEX_AFTER_WORD.has(previous))
    ) {
      const end = regexLiteralEnd(src, i)
      if (end === undefined) {
        previous = c
        i++
      } else {
        if (quoted === "keep") blank(i + 1, end)
        else blank(i, end)
        previous = "/regex"
        i = end
      }
    } else if (isWordChar(c)) {
      let j = i + 1
      while (j < n && isWordChar(src[j])) j++
      previous = src.slice(i, j)
      i = j
    } else {
      if (!/\s/.test(c)) previous = c
      i++
    }
  }
  return out.join("")
}

/**
 * Blank, with spaces (newlines preserved, so every byte offset - and line number - is unchanged):
 *   - `//` line comments and block comments;
 *   - the CONTENTS of backtick template literals - code-as-text (doc `CodeBlock` examples, code
 *     generators), never a real statement to lint.
 * Single/double-quoted strings are KEPT (a real import/Response specifier lives in one); a regex
 * literal keeps its slashes and loses its contents, so a quote inside one cannot open a string.
 * Shared by the source scanners here and by `nifra doctor` ({@link ./doctor.ts}).
 */
export function stripComments(src: string): string {
  return maskSource(src, "keep")
}

/** Blank comments and every quoted/template/regex literal while preserving offsets. Unlike
 * {@link stripComments}, this is a code-position mask: scanners use it to find a call expression in
 * executable code, then inspect the original source for the call's literal argument. That prevents
 * documentation strings such as `const example = 'client("/")'` from becoming diagnostics. */
export function codePositionMask(src: string): string {
  return maskSource(src, "blank")
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

// `new EventSource(` / `new WebSocket(` - a hand-rolled subscription to this app's own streaming
// surface. `new` is required so a local binding named `WebSocket` (a wrapper, a mock) stays quiet;
// The word boundary excludes member calls and identifiers such as `renew WebSocket(`; `new` keeps
// local wrapper bindings quiet while still matching the platform constructors.
const STREAM_CONSTRUCT = /(?<![\w$])new\s+(?:EventSource|WebSocket)\s*\(/g

/** Scan one file's text for hand-rolled own-API `EventSource`/`WebSocket` constructions. Pure +
 * line-accurate. Same contract as {@link scanFetchText}: only a relative-path first argument
 * (`"/…"` not `"//…"`, no scheme) is this app's API, so absolute `ws(s)://` / `http(s)://` URLs
 * stay quiet exactly like absolute fetch URLs do. `externalMounts` and the relative-URL rule behave
 * identically. A relative `new WebSocket("/…")` throws in browsers (the WS constructor needs an
 * absolute URL), so a hit is either broken or bypassing `api.*.ws()` - either way the typed call
 * (`api.*.subscribe()` for `app.sse()` routes, `api.*.ws()` for `app.ws()` routes) is the fix, and
 * it keeps the compiler catching drift. */
export function scanStreamText(
  file: string,
  content: string,
  externalMounts: readonly string[] = [],
): SourceFinding[] {
  const out: SourceFinding[] = []
  const lines = content.split("\n")
  const code = codePositionMask(content)
  STREAM_CONSTRUCT.lastIndex = 0
  for (let m = STREAM_CONSTRUCT.exec(code); m !== null; m = STREAM_CONSTRUCT.exec(code)) {
    const argument = firstArgumentIndex(content, m.index + m[0].length)
    const quote = content[argument]
    if (quote !== "'" && quote !== '"' && quote !== "`") continue
    if (content[argument + 1] !== "/" || content[argument + 2] === "/") continue
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
  /** Project files by forward-slash relative path, to resolve a path constant imported from one. */
  project?: ReadonlyMap<string, string>,
): StaticRouteFinding[] {
  const code = stripComments(content)
  if (!isPotentialBackendSource(code)) return []
  return [
    ...scanRoutePattern(file, content, code, ROUTE_REGISTRATION_DQ, facts),
    ...scanRoutePattern(file, content, code, ROUTE_REGISTRATION_SQ, facts),
    ...(code.includes(METHODS_SUBPATH) ? scanMethodRoutes(file, content, code, facts) : []),
    ...scanRouteArguments(file, content, facts, project).routes,
  ].sort(bySite)
}

/** A module-level `const`: its value when the initializer is one string literal, else `undefined`. */
interface ModuleConstant {
  readonly exported: boolean
  readonly value: string | undefined
}

/** The end of the quoted literal opening `text`, or -1 when it does not close on this line. */
function literalEnd(text: string): number {
  const quote = text[0]
  for (let i = 1; i < text.length; i++) {
    if (text[i] === "\\") i++
    else if (text[i] === quote) return i + 1
  }
  return -1
}

/** The index after the whitespace run at `from`. */
function skipSpace(text: string, from: number): number {
  let i = from
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i++
  return i
}

/**
 * Read `[export ]const NAME[: T] = <init>` written at column 0, so a function-local `const`, which is
 * indented, never stands in for a module-level one. The shape is read from the comment-stripped
 * line; the literal itself from the source line, since stripping blanks template contents.
 */
function moduleConstantOn(code: string, source: string): [string, ModuleConstant] | undefined {
  const exported = code.startsWith("export ")
  let i = exported ? skipSpace(code, 7) : 0
  if (!code.startsWith("const ", i)) return undefined
  i = skipSpace(code, i + 6)
  const name = /^[A-Za-z_$][\w$]*/.exec(code.slice(i))?.[0]
  if (name === undefined) return undefined
  i = skipSpace(code, i + name.length)
  if (code[i] === ":") i = code.indexOf("=", i)
  if (i === -1 || code[i] !== "=" || code[i + 1] === "=") return undefined
  i = skipSpace(code, i + 1)
  const opener = code[i]
  const end = opener === '"' || opener === "'" || opener === "`" ? literalEnd(source.slice(i)) : -1
  const tail = end === -1 ? undefined : code.slice(i + end).trim()
  const literal = source.slice(i, i + end)
  const value =
    tail === undefined || !["", ";", "as const", "as const;"].includes(tail)
      ? undefined
      : opener === "`"
        ? /[$\\]/.test(literal)
          ? undefined
          : literal.slice(1, -1)
        : parseQuotedLiteral(literal)
  return [name, { exported, value }]
}

function moduleConstants(code: string, source: string): ReadonlyMap<string, ModuleConstant> {
  const constants = new Map<string, ModuleConstant>()
  const sourceLines = source.split("\n")
  code.split("\n").forEach((line, index) => {
    const constant = moduleConstantOn(line, sourceLines[index] ?? "")
    if (constant !== undefined) constants.set(constant[0], constant[1])
  })
  return constants
}

/** Local name → the export it imports and from where, for value imports only. */
function namedImports(
  code: string,
): ReadonlyMap<string, { readonly specifier: string; readonly name: string }> {
  const imports = new Map<string, { readonly specifier: string; readonly name: string }>()
  NAMED_IMPORTS.lastIndex = 0
  for (let m = NAMED_IMPORTS.exec(code); m !== null; m = NAMED_IMPORTS.exec(code)) {
    if (/\btype\s*$/.test(code.slice(Math.max(0, m.index - 12), m.index + 6))) continue
    for (const element of (m[1] ?? "").split(",")) {
      const parts = element.trim().split(/\s+/)
      if (parts[0] === "type" || parts[0] === undefined || parts[0] === "") continue
      const local = parts[1] === "as" ? parts[2] : parts[0]
      if (local !== undefined) imports.set(local, { specifier: m[3] ?? "", name: parts[0] })
    }
  }
  return imports
}

/** The project file a relative import names, tried the way a TypeScript-aware bundler resolves it. */
function projectModule(
  project: ReadonlyMap<string, string>,
  fromFile: string,
  specifier: string,
): string | undefined {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined
  const base = posix.normalize(posix.join(posix.dirname(fromFile.replaceAll("\\", "/")), specifier))
  const stem = base.replace(/\.(?:m?js|jsx)$/, "")
  return [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${base}/index.ts`].find((candidate) =>
    project.has(candidate),
  )
}

/**
 * Route registrations whose path is a name or a template rather than a quoted literal. A name bound
 * to a module-level string `const`, here or imported from a project file, and a template with no
 * substitution resolve to routes; any other template, and a module-level or imported name nifra
 * cannot read, is unresolved. A name bound anywhere else (a parameter, a local) is not reported:
 * nothing marks such a call as a route rather than a `map.get(key, fallback)`.
 */
function scanRouteArguments(
  file: string,
  content: string,
  facts: SourceFacts | undefined,
  project: ReadonlyMap<string, string> | undefined,
  verbs: ReadonlySet<string> = HTTP_VERBS,
): { routes: StaticRouteFinding[]; unresolved: UnresolvedRoutePathFinding[] } {
  const routes: StaticRouteFinding[] = []
  const unresolved: UnresolvedRoutePathFinding[] = []
  const code = stripComments(content)
  if (!isPotentialBackendSource(code)) return { routes, unresolved }
  const lines = content.split("\n")
  const constants = moduleConstants(code, content)
  const imports = namedImports(code)
  const importedFiles = new Map<string, ReadonlyMap<string, ModuleConstant>>()
  const imported = (specifier: string, name: string): ModuleConstant | undefined => {
    const target = project === undefined ? undefined : projectModule(project, file, specifier)
    if (target === undefined) return undefined
    let found = importedFiles.get(target)
    if (found === undefined) {
      const text = project?.get(target) ?? ""
      found = moduleConstants(stripComments(text), text)
      importedFiles.set(target, found)
    }
    const constant = found.get(name)
    return constant?.exported === true ? constant : undefined
  }
  ROUTE_ARGUMENT.lastIndex = 0
  for (let m = ROUTE_ARGUMENT.exec(code); m !== null; m = ROUTE_ARGUMENT.exec(code)) {
    const method = (m[1] ?? "").toUpperCase()
    if (!verbs.has(method)) continue
    const at = m.index + m[0].lastIndexOf(m[2] ?? "")
    const argument = content.slice(at, at + (m[2] ?? "").length)
    let path: string | undefined
    if (argument.startsWith("`")) {
      path = /[$\\]/.test(argument) ? undefined : argument.slice(1, -1)
    } else {
      const binding = imports.get(argument)
      const constant =
        binding === undefined ? constants.get(argument) : imported(binding.specifier, binding.name)
      if (binding === undefined && constant === undefined) continue
      path = constant?.value
    }
    // A name that reads as something other than a path (`settings.get(KEY, fallback)`) is no route.
    if (path !== undefined && (!path.startsWith("/") || path.startsWith("//"))) continue
    if (facts !== undefined) {
      const source = facts.parse(file, content)
      if (
        source !== undefined &&
        facts.isRouteArgumentAt(source, m.index, method, argument) !== true
      )
        continue
    }
    const line = lineAt(content, m.index)
    const snippet = (lines[line - 1] ?? "").trim()
    if (path !== undefined) routes.push({ file, line, snippet, method, path })
    else unresolved.push({ file, line, snippet, method, expression: argument.slice(0, 120) })
  }
  return { routes, unresolved }
}

/** Route registrations whose path the static scan cannot resolve - see {@link scanRouteArguments}. */
export function scanUnresolvedRoutePaths(
  file: string,
  content: string,
  project?: ReadonlyMap<string, string>,
  facts?: SourceFacts,
): UnresolvedRoutePathFinding[] {
  return [
    ...scanRouteArguments(file, content, facts, project).unresolved,
    ...scanRouteArguments(file, content, facts, project, SOCKET_VERB).unresolved,
  ].sort(bySite)
}

/** `app.ws("/path", ...)` registrations, as routes under the pseudo-method `"WS"` reflection uses. */
export function scanStaticSocketText(
  file: string,
  content: string,
  facts?: SourceFacts,
  /** Project files by forward-slash relative path, to resolve a path constant imported from one. */
  project?: ReadonlyMap<string, string>,
): StaticRouteFinding[] {
  const code = stripComments(content)
  if (!isPotentialBackendSource(code)) return []
  return [
    ...scanRoutePattern(file, content, code, ROUTE_REGISTRATION_DQ, facts, SOCKET_VERB),
    ...scanRoutePattern(file, content, code, ROUTE_REGISTRATION_SQ, facts, SOCKET_VERB),
    ...scanRouteArguments(file, content, facts, project, SOCKET_VERB).routes,
  ].sort(bySite)
}

/** Routes from `all()` and `method()`, one per literal method name; a computed name is not guessed. */
function scanMethodRoutes(
  file: string,
  content: string,
  code: string,
  facts?: SourceFacts,
): StaticRouteFinding[] {
  const out: StaticRouteFinding[] = []
  const lines = content.split("\n")
  const collect = (
    index: number,
    callee: string,
    pathIndex: number,
    rawPath: string | undefined,
    quote: string,
    methods: readonly string[],
  ): void => {
    const path = parseQuotedLiteral(`${quote}${rawPath ?? ""}${quote}`)
    if (path === undefined || !path.startsWith("/") || path.startsWith("//")) return
    if (facts !== undefined) {
      const source = facts.parse(file, content)
      // Same contract as a member-call registration: a parsed source is authoritative, an
      // unparseable one keeps the lexical finding.
      if (
        source !== undefined &&
        facts.isFunctionRouteCallAt(source, index, callee, pathIndex, path) !== true
      )
        return
    }
    const line = lineAt(content, index)
    const snippet = (lines[line - 1] ?? "").trim()
    for (const method of methods) out.push({ file, line, snippet, method, path })
  }

  ALL_ROUTES.lastIndex = 0
  for (let m = ALL_ROUTES.exec(code); m !== null; m = ALL_ROUTES.exec(code)) {
    const double = m[1] !== undefined
    collect(m.index, "all", 0, double ? m[1] : m[2], double ? '"' : "'", [...HTTP_VERBS])
  }
  METHOD_ROUTES.lastIndex = 0
  for (let m = METHOD_ROUTES.exec(code); m !== null; m = METHOD_ROUTES.exec(code)) {
    const names = new Set<string>()
    METHOD_NAME_LITERAL.lastIndex = 0
    for (
      let name = METHOD_NAME_LITERAL.exec(m[1] ?? "");
      name !== null;
      name = METHOD_NAME_LITERAL.exec(m[1] ?? "")
    ) {
      names.add((name[2] ?? "").toUpperCase())
    }
    const double = m[2] !== undefined
    collect(m.index, "method", 1, double ? m[2] : m[3], double ? '"' : "'", [...names])
  }
  return out
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
/** Driver calls that take a statement under names that are everyday words elsewhere (`map.get`,
 * `client.get("/users/update")`): node-sqlite3's `all`/`get`/`each` and pg-promise's result-shaping
 * calls. One of these, and any bare call, is judged by whether its text starts like a statement. */
const DRIVER_READ_METHODS = new Set([
  "all",
  "get",
  "each",
  "any",
  "one",
  "none",
  "many",
  "oneOrNone",
  "manyOrNone",
  "result",
  "multi",
  "multiResult",
])
const STATEMENT_START =
  /^\s*\(?\s*(?:select|insert|update|delete|with|replace|merge|create|drop|alter|truncate|pragma)\s/i

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
  const kind = scriptKindOf(ts, file)
  let source: TSApi.SourceFile
  try {
    source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind)
  } catch {
    // TypeScript 7 parses only the files its session preloaded; an imported module outside that set
    // proves no constant, like one that does not parse.
    return undefined
  }
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
 * either still feeds the keyword scan), `as`/`satisfies` wrappers, a `const` whose initializer
 * resolves (the nearest binding: function or block scope, then module scope; recursively,
 * depth-capped), `.join(sep?)` over an array {@link staticArrayItems} proves, and - when
 * `scope.imports` is configured - a module `const` imported by name from another in-project module.
 * Everything else - `let`, a parameter, any other call, a member access, a shadowed name, a
 * bare-specifier import - stays unresolved and the interpolation is flagged exactly as before.
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
      const part =
        placeholderNumber(ts, text, span.expression, depth) ??
        resolveStaticSqlText(ts, span.expression, scope, depth + 1)
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
  if (ts.isCallExpression(node)) return resolveStaticJoin(ts, node, scope, depth)
  if (ts.isIdentifier(node)) {
    const local = localConstInitializer(ts, node)
    if (local === "shadow") return undefined
    if (local !== undefined) return resolveStaticSqlText(ts, local, scope, depth + 1)
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

/**
 * The initializer of the `const` a function or block scope binds `node` to, `"shadow"` when the
 * nearest such binding is anything else (a parameter, `let`, `var`, destructuring), or `undefined`
 * when no scope below the module binds it - the module-scope lookup applies then.
 */
function localConstInitializer(
  ts: TypeScriptApi,
  node: TSApi.Identifier,
): TSApi.Expression | "shadow" | undefined {
  const source = node.getSourceFile()
  for (let scope: TSApi.Node | undefined = node.parent; scope !== undefined; scope = scope.parent) {
    if (ts.isSourceFile(scope)) return undefined
    const binding = directBinding(ts, source, scope, node.text)
    if (binding === "shadow") return "shadow"
    if (binding !== undefined) return binding.constant ? binding.initializer : "shadow"
  }
  return undefined
}

const unwrapExpression = (ts: TypeScriptApi, node: TSApi.Expression): TSApi.Expression => {
  let current = node
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression
  }
  return current
}

/** `Object.freeze([...])` with `Object` unshadowed: the one array form no later code can change. */
function frozenArrayLiteral(
  ts: TypeScriptApi,
  node: TSApi.Expression,
): TSApi.ArrayLiteralExpression | undefined {
  const call = unwrapExpression(ts, node)
  if (!ts.isCallExpression(call) || call.arguments.length !== 1) return undefined
  const callee = call.expression
  if (
    !ts.isPropertyAccessExpression(callee) ||
    callee.name.text !== "freeze" ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== "Object" ||
    isShadowedAt(ts, callee.expression, "Object")
  ) {
    return undefined
  }
  const array = unwrapExpression(ts, call.arguments[0]!)
  return ts.isArrayLiteralExpression(array) ? array : undefined
}

const ARRAY_READS: ReadonlySet<string> = new Set(["join", "includes", "indexOf"])

/**
 * Whether every use of `name` in `source` other than its declaration is a call of `.join(`,
 * `.includes(` or `.indexOf(`, or a `.length` read: then nothing pushes to, sorts, exports or hands
 * away the array, so it still holds its literal elements. With `pushed`, a `.push(...)` is accepted
 * too and its arguments collected, for the caller to prove (the `where.push(...)` builder). A
 * same-named binding elsewhere only adds uses, so the answer can only err toward refusing.
 */
function onlyReadsArray(
  ts: TypeScriptApi,
  source: TSApi.SourceFile,
  name: string,
  declaration: TSApi.Node,
  pushed?: TSApi.Expression[],
): boolean {
  let ok = true
  const visit = (node: TSApi.Node): void => {
    if (!ok) return
    if (ts.isIdentifier(node) && node.text === name && node !== declaration) {
      const access = node.parent
      const call =
        ts.isPropertyAccessExpression(access) &&
        access.expression === node &&
        ts.isCallExpression(access.parent) &&
        access.parent.expression === access
          ? access.parent
          : undefined
      if (
        pushed !== undefined &&
        call !== undefined &&
        ts.isPropertyAccessExpression(access) &&
        access.name.text === "push"
      ) {
        if (call.arguments.some((argument) => ts.isSpreadElement(argument))) ok = false
        else pushed.push(...call.arguments)
        // An argument can mention the array again; those uses are checked as well.
        for (const argument of call.arguments) visit(argument)
        return
      }
      const read =
        ts.isPropertyAccessExpression(access) &&
        access.expression === node &&
        (access.name.text === "length"
          ? !isWrittenTo(ts, access)
          : ARRAY_READS.has(access.name.text) && call !== undefined)
      if (!read) ok = false
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return ok
}

/** `node` as the target of an assignment, `++`/`--`, or `delete`. */
function isWrittenTo(ts: TypeScriptApi, node: TSApi.Node): boolean {
  const parent = node.parent
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === node &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return true
  }
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) {
    return (
      parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken
    )
  }
  return ts.isDeleteExpression(parent)
}

/**
 * The element texts of an array `receiver` names, when the array provably still holds them: an
 * inline literal, `Object.freeze([...])` anywhere it is bound or imported from, or a `const` array
 * literal bound in this file, not exported, and only ever read ({@link onlyReadsArray}). `as const`
 * is type-only and proves nothing.
 */
function staticArrayItems(
  ts: TypeScriptApi,
  receiver: TSApi.Expression,
  scope: SqlScope,
  depth: number,
): readonly string[] | undefined {
  const node = unwrapExpression(ts, receiver)
  let array = ts.isArrayLiteralExpression(node) ? node : frozenArrayLiteral(ts, node)
  let itemScope = scope
  const pushed: TSApi.Expression[] = []
  if (array === undefined && ts.isIdentifier(node)) {
    const local = localConstInitializer(ts, node)
    if (local === "shadow") return undefined
    let initializer = local
    let exported = false
    if (initializer === undefined && !isShadowedAt(ts, node, node.text)) {
      initializer = scope.module.consts.get(node.text)
      exported = [...scope.module.localExports.values()].includes(node.text)
      const edge = initializer === undefined ? scope.module.imports.get(node.text) : undefined
      if (edge !== undefined && scope.imports !== undefined) {
        const target = loadSqlModuleScope(ts, scope.imports, scope.module.id, edge.specifier)
        const found =
          target === undefined
            ? undefined
            : resolveExportedConst(ts, scope.imports, target, edge.exported, 1, new Set())
        if (found === undefined) return undefined
        // Another module's array is accepted only frozen: its own file may mutate it.
        array = frozenArrayLiteral(ts, found.expression)
        itemScope = { module: found.scope, imports: scope.imports }
      }
    }
    if (array === undefined && initializer !== undefined) {
      array = frozenArrayLiteral(ts, initializer)
      const literal = unwrapExpression(ts, initializer)
      if (
        array === undefined &&
        !exported &&
        ts.isArrayLiteralExpression(literal) &&
        ts.isVariableDeclaration(initializer.parent) &&
        onlyReadsArray(ts, node.getSourceFile(), node.text, initializer.parent.name, pushed)
      ) {
        array = literal
      }
    }
  }
  if (array === undefined) return undefined
  const items: string[] = []
  // What the array may hold: its literal elements, and anything pushed onto it in any order.
  for (const element of [...array.elements, ...pushed]) {
    if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) return undefined
    const text = resolveStaticSqlText(ts, element, itemScope, depth + 1)
    if (text === undefined) return undefined
    items.push(text)
  }
  return items
}

/** `items.join(sep?)` over a {@link staticArrayItems} array with a literal or absent separator. */
function resolveStaticJoin(
  ts: TypeScriptApi,
  call: TSApi.CallExpression,
  scope: SqlScope,
  depth: number,
): string | undefined {
  const callee = call.expression
  if (
    !ts.isPropertyAccessExpression(callee) ||
    callee.questionDotToken !== undefined ||
    callee.name.text !== "join" ||
    call.arguments.length > 1
  ) {
    return undefined
  }
  const separatorArg = call.arguments[0]
  const separator =
    separatorArg === undefined
      ? ","
      : ts.isStringLiteral(separatorArg) || ts.isNoSubstitutionTemplateLiteral(separatorArg)
        ? separatorArg.text
        : undefined
  if (separator === undefined) return undefined
  const items =
    staticArrayItems(ts, callee.expression, scope, depth + 1) ??
    mappedItem(ts, callee.expression, scope, depth + 1)
  return items?.join(separator)
}

/**
 * `xs.map(fn)`, `xs.flatMap(fn)` or `Array.from(src, fn)` whose callback returns text that resolves
 * for every element - `(_, i) => \`($${i * 2 + 1}, $${i * 2 + 2})\``, the batch `VALUES` idiom. How
 * many items there are is runtime data, what each one says is not, so one item stands for all.
 */
function mappedItem(
  ts: TypeScriptApi,
  receiver: TSApi.Expression,
  scope: SqlScope,
  depth: number,
): readonly string[] | undefined {
  const call = unwrapExpression(ts, receiver)
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression))
    return undefined
  // Only these return what the callback returns; `filter` and the rest hand back the elements.
  const method = call.expression.name.text
  const argument = indexCallbackArgument(ts, call)
  if (argument === undefined || !(method === "map" || method === "flatMap" || argument === 1))
    return undefined
  const fn = call.arguments[argument]
  if (fn === undefined || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return undefined
  const only =
    ts.isBlock(fn.body) && fn.body.statements.length === 1 ? fn.body.statements[0] : undefined
  const body = ts.isBlock(fn.body)
    ? only !== undefined && ts.isReturnStatement(only)
      ? only.expression
      : undefined
    : fn.body
  const text = body === undefined ? undefined : resolveStaticSqlText(ts, body, scope, depth + 1)
  return text === undefined ? undefined : [text]
}

/** Array methods whose callback receives the element's index, and where in the callback it is. */
const INDEX_PARAMETER: ReadonlyMap<string, number> = new Map([
  ["map", 1],
  ["flatMap", 1],
  ["forEach", 1],
  ["filter", 1],
  ["some", 1],
  ["every", 1],
  ["find", 1],
  ["findIndex", 1],
  ["reduce", 2],
  ["reduceRight", 2],
])

/** Which argument of `call` is a callback handed an array index: the first for `xs.map(fn)` and its
 * kin, the second for an unshadowed `Array.from(src, fn)`. */
function indexCallbackArgument(ts: TypeScriptApi, call: TSApi.CallExpression): number | undefined {
  const callee = call.expression
  if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken !== undefined)
    return undefined
  if (INDEX_PARAMETER.has(callee.name.text)) return 0
  return callee.name.text === "from" &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "Array" &&
    !isShadowedAt(ts, callee.expression, "Array")
    ? 1
    : undefined
}

/**
 * `"1"` for a span written right after a `$` whose expression provably evaluates to a number: a
 * Postgres placeholder index (`$${i + 1}`), which binds a parameter and can carry no SQL. Any string
 * there could, so anything not proved numeric stays unresolved.
 */
function placeholderNumber(
  ts: TypeScriptApi,
  before: string,
  node: TSApi.Expression,
  depth: number,
): string | undefined {
  return before.endsWith("$") && isNumericExpression(ts, node, depth) ? "1" : undefined
}

const NUMERIC_OPERATORS = (ts: TypeScriptApi): ReadonlySet<TSApi.SyntaxKind> =>
  new Set([
    ts.SyntaxKind.MinusToken,
    ts.SyntaxKind.AsteriskToken,
    ts.SyntaxKind.AsteriskAsteriskToken,
    ts.SyntaxKind.SlashToken,
    ts.SyntaxKind.PercentToken,
    ts.SyntaxKind.AmpersandToken,
    ts.SyntaxKind.BarToken,
    ts.SyntaxKind.CaretToken,
    ts.SyntaxKind.LessThanLessThanToken,
    ts.SyntaxKind.GreaterThanGreaterThanToken,
    ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  ])
const NUMBER_FUNCTIONS: ReadonlySet<string> = new Set(["Number", "parseInt", "parseFloat"])

/**
 * Whether an expression evaluates to a number whatever its inputs hold. Every arithmetic operator but
 * `+` converts its operands, so `i * 2` is a number even if `i` were a string; `+` is one only when
 * both sides are. A name proves it when it is a callback's array index, or a `const`, never-reassigned
 * `let` or `for` counter bound to a number and only ever updated by arithmetic. Also `xs.push(...)`
 * (the new length), `Number`/`parseInt`/`parseFloat`/`Math.*` calls, and `.length` of an array a
 * nearby binding builds from a literal. A type annotation proves nothing: it does not run.
 */
function isNumericExpression(ts: TypeScriptApi, node: TSApi.Expression, depth: number): boolean {
  if (depth > CONST_RESOLUTION_DEPTH) return false
  const expression = unwrapExpression(ts, node)
  if (ts.isNumericLiteral(expression)) return true
  if (ts.isPrefixUnaryExpression(expression))
    return expression.operator !== ts.SyntaxKind.ExclamationToken
  if (ts.isPostfixUnaryExpression(expression)) return true
  if (ts.isBinaryExpression(expression)) {
    const operator = expression.operatorToken.kind
    if (operator === ts.SyntaxKind.PlusToken) {
      return (
        isNumericExpression(ts, expression.left, depth + 1) &&
        isNumericExpression(ts, expression.right, depth + 1)
      )
    }
    return NUMERIC_OPERATORS(ts).has(operator)
  }
  if (ts.isIdentifier(expression)) return isNumericName(ts, expression, depth)
  if (ts.isCallExpression(expression)) {
    const callee = expression.expression
    if (ts.isIdentifier(callee))
      return NUMBER_FUNCTIONS.has(callee.text) && !isShadowedAt(ts, callee, callee.text)
    if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken !== undefined)
      return false
    if (callee.name.text === "push") return true
    return (
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "Math" &&
      !isShadowedAt(ts, callee.expression, "Math")
    )
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "length" &&
    ts.isIdentifier(expression.expression)
  ) {
    const binding = nameBinding(ts, expression.expression)
    return (
      binding.kind === "value" &&
      ts.isArrayLiteralExpression(unwrapExpression(ts, binding.initializer))
    )
  }
  return false
}

/** How the nearest scope binds a name: a readable value ({@link directBinding}), a parameter, a `let`
 * counter a `for` statement declares and updates, or nothing this walk can read. */
type NameBinding =
  | { readonly kind: "value"; readonly initializer: TSApi.Expression }
  | {
      readonly kind: "parameter"
      readonly fn: TSApi.SignatureDeclaration
      readonly position: number
    }
  | { readonly kind: "counter"; readonly initializer: TSApi.Expression }
  | { readonly kind: "unknown" }

function nameBinding(ts: TypeScriptApi, node: TSApi.Identifier): NameBinding {
  const source = node.getSourceFile()
  for (let scope: TSApi.Node | undefined = node.parent; scope !== undefined; scope = scope.parent) {
    if (ts.isFunctionLike(scope)) {
      const position = scope.parameters.findIndex((p) => bindingNameCovers(ts, p.name, node.text))
      if (position !== -1) {
        return ts.isIdentifier(scope.parameters[position]?.name ?? node)
          ? { kind: "parameter", fn: scope, position }
          : { kind: "unknown" }
      }
    }
    const binding = directBinding(ts, source, scope, node.text)
    if (binding === "shadow") {
      // `for (let i = 0; ...; i++)`: the one reassigned `let` worth reading, checked by the caller.
      const list = ts.isForStatement(scope) ? scope.initializer : undefined
      const declaration =
        list !== undefined && ts.isVariableDeclarationList(list)
          ? list.declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === node.text)
          : undefined
      return declaration?.initializer === undefined
        ? { kind: "unknown" }
        : { kind: "counter", initializer: declaration.initializer }
    }
    if (binding !== undefined) return { kind: "value", initializer: binding.initializer }
    if (ts.isSourceFile(scope)) break
  }
  return { kind: "unknown" }
}

function isNumericName(ts: TypeScriptApi, node: TSApi.Identifier, depth: number): boolean {
  const source = node.getSourceFile()
  const binding = nameBinding(ts, node)
  if (binding.kind === "value") return isNumericExpression(ts, binding.initializer, depth + 1)
  if (binding.kind === "counter") {
    return (
      isNumericExpression(ts, binding.initializer, depth + 1) &&
      onlyNumericWrites(ts, source, node.text, depth)
    )
  }
  if (binding.kind !== "parameter") return false
  // An array callback's index parameter, never reassigned.
  const call = binding.fn.parent
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return false
  const argument = indexCallbackArgument(ts, call)
  const position = argument === 1 ? 1 : INDEX_PARAMETER.get(call.expression.name.text)
  return (
    argument !== undefined &&
    call.arguments[argument] === binding.fn &&
    binding.position === position &&
    !isReassignedInFile(ts, source, node.text)
  )
}

/** Compound assignments that always store a number. */
const NUMERIC_ASSIGNMENTS = (ts: TypeScriptApi): ReadonlySet<TSApi.SyntaxKind> =>
  new Set([
    ts.SyntaxKind.MinusEqualsToken,
    ts.SyntaxKind.AsteriskEqualsToken,
    ts.SyntaxKind.AsteriskAsteriskEqualsToken,
    ts.SyntaxKind.SlashEqualsToken,
    ts.SyntaxKind.PercentEqualsToken,
    ts.SyntaxKind.AmpersandEqualsToken,
    ts.SyntaxKind.BarEqualsToken,
    ts.SyntaxKind.CaretEqualsToken,
    ts.SyntaxKind.LessThanLessThanEqualsToken,
    ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
    ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ])

/** Every write to `name` in the file is `++`/`--`, or an assignment that stores a number. */
function onlyNumericWrites(
  ts: TypeScriptApi,
  source: TSApi.SourceFile,
  name: string,
  depth: number,
): boolean {
  let ok = true
  const visit = (node: TSApi.Node): void => {
    if (!ok) return
    if (ts.isIdentifier(node) && node.text === name && isWrittenTo(ts, node)) {
      const parent = node.parent
      if (ts.isBinaryExpression(parent)) {
        const operator = parent.operatorToken.kind
        ok =
          operator === ts.SyntaxKind.EqualsToken || operator === ts.SyntaxKind.PlusEqualsToken
            ? isNumericExpression(ts, parent.right, depth + 1)
            : NUMERIC_ASSIGNMENTS(ts).has(operator)
      } else ok = !ts.isDeleteExpression(parent)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return ok
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
      scope === undefined
        ? undefined
        : (placeholderNumber(ts, staticText, span.expression, 0) ??
          resolveStaticSqlText(ts, span.expression, scope, 0))
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
type ResolvableBinding =
  | { readonly initializer: TSApi.Expression; readonly constant: boolean }
  | "shadow"

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
  for (const statement of scopeStatements(ts, scope) ?? []) {
    if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name?.text === name
    ) {
      return "shadow"
    }
  }
  for (const list of scopeDeclarationLists(ts, scope)) {
    for (const declaration of list.declarations) {
      if (!bindingNameCovers(ts, declaration.name, name)) continue
      // A destructured or uninitialized binding, or a `var` (hoisting + reassignment risk), is not a
      // value we can read one expression out of.
      if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined)
        return "shadow"
      const isConst = (list.flags & ts.NodeFlags.Const) !== 0
      const isLet = (list.flags & ts.NodeFlags.Let) !== 0
      if (isConst) return { initializer: declaration.initializer, constant: true }
      if (isLet && !isReassignedInFile(ts, source, name))
        return { initializer: declaration.initializer, constant: false }
      return "shadow"
    }
  }
  return undefined
}

function scopeStatements(
  ts: TypeScriptApi,
  scope: TSApi.Node,
): readonly TSApi.Statement[] | undefined {
  return ts.isSourceFile(scope) ||
    ts.isBlock(scope) ||
    ts.isModuleBlock(scope) ||
    ts.isCaseClause(scope) ||
    ts.isDefaultClause(scope)
    ? scope.statements
    : undefined
}

/** The `var`/`let`/`const` lists a scope node declares directly: its statements' and a `for` head's. */
function scopeDeclarationLists(
  ts: TypeScriptApi,
  scope: TSApi.Node,
): TSApi.VariableDeclarationList[] {
  const lists: TSApi.VariableDeclarationList[] = []
  for (const statement of scopeStatements(ts, scope) ?? []) {
    if (ts.isVariableStatement(statement)) lists.push(statement.declarationList)
  }
  if (
    (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) &&
    scope.initializer !== undefined &&
    ts.isVariableDeclarationList(scope.initializer)
  ) {
    lists.push(scope.initializer)
  }
  return lists
}

/** The `var` or `let` a scope declares `name` with by a plain identifier, if any. */
function mutableDeclaration(
  ts: TypeScriptApi,
  scope: TSApi.Node,
  name: string,
): TSApi.VariableDeclaration | undefined {
  for (const list of scopeDeclarationLists(ts, scope)) {
    if ((list.flags & ts.NodeFlags.Const) !== 0) continue
    for (const declaration of list.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration
    }
  }
  return undefined
}

interface SqlWrite {
  readonly value: TSApi.Expression
  /** `+=`: the value is glued onto what the variable already holds. */
  readonly appends: boolean
}

/**
 * Every value a statement variable may hold where the query reads it, so a statement parked in a
 * variable is scanned as if it had been written inline at the call. This is the counterpart to
 * {@link resolveStaticSqlText}: that folds a const's text INTO a template's shape; this unfolds the
 * statement back out of the variable it was lifted into. Without it, ANY interpolated-SQL finding
 * could be silenced, invisibly, by hoisting the statement to `const q = …` first, or by building it
 * in steps (`let q = "SELECT …"; q += …`).
 *
 * Same-file only. Nearest enclosing declaration wins, so a shadowing local is read and never a
 * same-named module const. A `const`, or a `let` the file never reassigns, holds its initializer. A
 * `var` or reassigned `let` holds its initializer and every value assigned to the name anywhere in
 * the function (or module) that declares it: over-collected rather than scope-simulated, which only
 * ever adds a value to check. `key` names the binding, so a value that reads the variable it is
 * assigned to is recognised. A parameter, an imported or destructured binding, or a name with no
 * same-file declaration returns `undefined` - which leaves the argument scanned as itself.
 */
function variableWrites(
  ts: TypeScriptApi,
  node: TSApi.Identifier,
): { readonly key: TSApi.Node; readonly writes: readonly SqlWrite[] } | undefined {
  const source = node.getSourceFile()
  const name = node.text
  for (let scope: TSApi.Node | undefined = node.parent; scope !== undefined; scope = scope.parent) {
    const binding = directBinding(ts, source, scope, name)
    if (binding === "shadow") {
      const declaration = mutableDeclaration(ts, scope, name)
      if (declaration === undefined) return undefined
      let owner: TSApi.Node = declaration
      while (!ts.isFunctionLike(owner) && !ts.isSourceFile(owner)) owner = owner.parent
      const writes = writesTo(ts, owner, name)
      return {
        key: declaration,
        writes:
          declaration.initializer === undefined
            ? writes
            : [{ value: declaration.initializer, appends: false }, ...writes],
      }
    }
    if (binding !== undefined) {
      return { key: binding.initializer, writes: [{ value: binding.initializer, appends: false }] }
    }
    if (ts.isSourceFile(scope)) break
  }
  return undefined
}

/** The values assigned to `name` under `root`. A numeric compound assignment stores no text. */
function writesTo(ts: TypeScriptApi, root: TSApi.Node, name: string): SqlWrite[] {
  const writes: SqlWrite[] = []
  const visit = (node: TSApi.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) {
      const parent = node.parent
      if (ts.isBinaryExpression(parent) && parent.left === node) {
        const operator = parent.operatorToken.kind
        if (operator === ts.SyntaxKind.PlusEqualsToken) {
          writes.push({ value: parent.right, appends: true })
        } else if (
          operator === ts.SyntaxKind.EqualsToken ||
          operator === ts.SyntaxKind.QuestionQuestionEqualsToken ||
          operator === ts.SyntaxKind.BarBarEqualsToken ||
          operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken
        ) {
          writes.push({ value: parent.right, appends: false })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return writes
}

function mentionsName(ts: TypeScriptApi, node: TSApi.Node, name: string): boolean {
  if (ts.isIdentifier(node)) return node.text === name
  return ts.forEachChild(node, (child) => mentionsName(ts, child, name) || undefined) === true
}

const UNKNOWN_SQL: SqlExpressionShape = {
  staticText: "",
  dynamic: true,
  concatenated: false,
  literal: false,
  parameterizedTag: false,
}

function textShape(text: string): SqlExpressionShape {
  return {
    staticText: text,
    dynamic: false,
    concatenated: false,
    literal: true,
    parameterizedTag: false,
  }
}

function joinShapes(shapes: readonly SqlExpressionShape[]): SqlExpressionShape {
  return {
    staticText: shapes.map((shape) => shape.staticText).join(""),
    // As with `+`: text glued onto a binding tag's output un-parameterizes it.
    dynamic: shapes.some((shape) => shape.dynamic || shape.parameterizedTag),
    concatenated: true,
    literal: false,
    parameterizedTag: false,
  }
}

/** Orders a variable's candidate statements by how surely {@link scanInterpolatedSql} would flag
 * them: dynamic SQL text, then dynamic glued text, then any dynamic text; outside a binding tag
 * before inside one. */
function sqlRisk(shape: SqlExpressionShape): number {
  const dynamic = !shape.dynamic
    ? 0
    : SQL_KEYWORD.test(shape.staticText) || STATEMENT_START.test(shape.staticText)
      ? 3
      : shape.concatenated
        ? 2
        : 1
  return dynamic * 2 + (shape.parameterizedTag ? 0 : 1)
}

/**
 * The riskiest statement a variable may hold. Each value that replaces the text is one candidate.
 * The values that build on it (`+=`, or `q = q + more`) are glued onto every replacing value at
 * once, as a builder that takes each branch would, so a static `SELECT … WHERE 1=1` followed by an
 * interpolated `AND …` reads as the one statement it becomes.
 */
function writtenShape(
  ts: TypeScriptApi,
  name: string,
  writes: readonly SqlWrite[],
  scope: SqlScope | undefined,
  trail: readonly TSApi.Node[],
): SqlExpressionShape {
  const replacing: SqlExpressionShape[] = []
  const building: SqlExpressionShape[] = []
  for (const write of writes) {
    const shape = sqlExpressionShape(ts, write.value, scope, trail)
    if (write.appends || mentionsName(ts, write.value, name)) building.push(shape)
    else replacing.push(shape)
  }
  const candidates =
    building.length === 0 ? replacing : [...replacing, joinShapes([...replacing, ...building])]
  let worst: SqlExpressionShape | undefined
  for (const candidate of candidates) {
    if (worst === undefined || sqlRisk(candidate) > sqlRisk(worst)) worst = candidate
  }
  return worst ?? UNKNOWN_SQL
}

const TEXT_METHODS = new Set([
  "toString",
  "valueOf",
  "trim",
  "trimStart",
  "trimEnd",
  "toLowerCase",
  "toUpperCase",
])

/** The value a text-preserving call returns: `String(x)`, `x.toString()`, `x.trim()`. */
function passedThrough(
  ts: TypeScriptApi,
  call: TSApi.CallExpression,
): TSApi.Expression | undefined {
  const callee = call.expression
  if (ts.isIdentifier(callee) && callee.text === "String" && call.arguments.length === 1) {
    return call.arguments[0]
  }
  if (
    ts.isPropertyAccessExpression(callee) &&
    TEXT_METHODS.has(callee.name.text) &&
    call.arguments.length === 0
  ) {
    return callee.expression
  }
  return undefined
}

/** The parts `[a, b].join(sep)` and `a.concat(b)` glue together, a separator as its text. */
function joinedParts(
  ts: TypeScriptApi,
  call: TSApi.CallExpression,
): readonly (TSApi.Expression | string)[] | undefined {
  const callee = call.expression
  if (!ts.isPropertyAccessExpression(callee)) return undefined
  if (callee.name.text === "concat") return [callee.expression, ...call.arguments]
  const items = unwrapExpression(ts, callee.expression)
  if (callee.name.text !== "join" || !ts.isArrayLiteralExpression(items)) return undefined
  const separator = call.arguments[0]
  const glue: TSApi.Expression | string =
    separator === undefined ? "," : ts.isStringLiteralLike(separator) ? separator.text : separator
  const parts: (TSApi.Expression | string)[] = []
  items.elements.forEach((element, index) => {
    if (index > 0) parts.push(glue)
    if (ts.isSpreadElement(element)) parts.push(element.expression)
    else if (!ts.isOmittedExpression(element)) parts.push(element)
  })
  return parts
}

/** Whether the `sql` a tag names is a function this file defines (`const sql = (s, ...v) => …`),
 * which is plain interpolation whatever its name. A parameter, an import, or a driver instance
 * (`const sql = postgres(url)`) keeps the name's trust. */
function definesSqlFunction(ts: TypeScriptApi, tag: TSApi.Identifier): boolean {
  for (let scope: TSApi.Node | undefined = tag.parent; scope !== undefined; scope = scope.parent) {
    if (
      ts.isFunctionLike(scope) &&
      scope.parameters.some((parameter) => bindingNameCovers(ts, parameter.name, tag.text))
    ) {
      return false
    }
    for (const statement of scopeStatements(ts, scope) ?? []) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === tag.text) return true
    }
    for (const list of scopeDeclarationLists(ts, scope)) {
      for (const declaration of list.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== tag.text) continue
        const value =
          declaration.initializer === undefined
            ? undefined
            : unwrapExpression(ts, declaration.initializer)
        return value !== undefined && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))
      }
    }
  }
  return false
}

/** Describe only the statement's syntax; comments/strings elsewhere cannot influence the result.
 * `trail` holds the variables being read through, innermost last. */
function sqlExpressionShape(
  ts: TypeScriptApi,
  expression: TSApi.Expression,
  scope?: SqlScope,
  trail: readonly TSApi.Node[] = [],
): SqlExpressionShape {
  let node = unwrapExpression(ts, expression)
  while (ts.isNonNullExpression(node)) node = unwrapExpression(ts, node.expression)
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
      (ts.isIdentifier(tag) && tag.text === "sql" && !definesSqlFunction(ts, tag)) ||
      (ts.isPropertyAccessExpression(tag) && tag.getText() === "Prisma.sql")
    const template = node.template
    const templated = ts.isTemplateExpression(template)
      ? templateShape(ts, template, parameterizedTag ? undefined : scope)
      : { staticText: template.text, dynamic: false }
    const staticText = templated.staticText
    // Only the ecosystem's binding tags are trusted, by NAME - which is the honest limit of a scanner
    // that reads syntax and runs no type checker. `sql` is what postgres.js, drizzle, slonik and Bun's
    // own driver all call theirs, and `Prisma.sql` is Prisma's; taking those at their word is a
    // deliberate trade, and it is worth stating what it costs: a `sql` this file defines as a
    // function is read as the interpolation it is, but one imported from anywhere is trusted, so
    // this rule finds mistakes, not an adversary who reads it first.
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
      // `${a} ${b}` writes no text of its own; it only glues values together.
      concatenated: [node.head, ...node.templateSpans.map((span) => span.literal)].every(
        (part) => part.text.trim() === "",
      ),
      literal: false,
      parameterizedTag: false,
    }
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = sqlExpressionShape(ts, node.left, scope, trail)
    const right = sqlExpressionShape(ts, node.right, scope, trail)
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
  if (ts.isCallExpression(node)) {
    const inner = passedThrough(ts, node)
    if (inner !== undefined)
      return { ...sqlExpressionShape(ts, inner, scope, trail), literal: false }
    const parts = joinedParts(ts, node)
    if (parts !== undefined) {
      return joinShapes(
        parts.map((part) =>
          typeof part === "string" ? textShape(part) : sqlExpressionShape(ts, part, scope, trail),
        ),
      )
    }
  }
  // A bare name that did not resolve to compile-time text. If it is a same-file binding, scan the
  // shapes of what it may hold - so a statement hoisted into `const q = …` or built up in a `let` is
  // read exactly as if it were written inline at the call, closing the "extract a variable to launder
  // the finding" hole. `literal` is forced false: the value arrived through a variable, which is the
  // property the `unsafe`/`$queryRawUnsafe` hatch rule keys on.
  if (ts.isIdentifier(node)) {
    const read = variableWrites(ts, node)
    // Read inside one of its own writes (`q = q + more`), the variable is the text the other writes
    // already account for.
    if (read !== undefined && trail.includes(read.key)) return { ...textShape(""), literal: false }
    if (read !== undefined && trail.length <= CONST_RESOLUTION_DEPTH) {
      const written = writtenShape(ts, node.text, read.writes, scope, [...trail, read.key])
      return { ...written, literal: false }
    }
  }
  return UNKNOWN_SQL
}

interface SqlSink {
  readonly method: string
  /** `undefined` for a bare call: `const { query } = db` and then `query(…)`. */
  readonly receiver: string | undefined
}

function sqlMethod(ts: TypeScriptApi, call: TSApi.CallExpression): SqlSink | undefined {
  const sink = (method: string, receiver: TSApi.Expression | undefined): SqlSink | undefined =>
    SQL_METHODS.has(method) || DRIVER_READ_METHODS.has(method)
      ? { method, receiver: receiver?.getText() }
      : undefined
  const callee = call.expression
  if (ts.isIdentifier(callee)) return sink(callee.text, undefined)
  if (ts.isPropertyAccessExpression(callee)) return sink(callee.name.text, callee.expression)
  if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) {
    return sink(callee.argumentExpression.text, callee.expression)
  }
  return undefined
}

const SQL_RECEIVER = /(?:^|\.)(?:db|sql|prisma|drizzle|database|conn|connection|client|tx)$/i

/** Whether a statement is SQL assembled from runtime values, judged by where it is sent. */
function isAssembledSql(sink: SqlSink, shape: SqlExpressionShape): boolean {
  if (!shape.dynamic) return false
  if (sink.receiver === undefined || DRIVER_READ_METHODS.has(sink.method)) {
    return STATEMENT_START.test(shape.staticText)
  }
  return (
    SQL_KEYWORD.test(shape.staticText) || (shape.concatenated && SQL_RECEIVER.test(sink.receiver))
  )
}

/** The statement a call passes: the argument itself, or the `text`/`sql` of a config object
 * (`{ text, values }` in pg, `{ sql, values }` in mysql2). */
function statementArgument(
  ts: TypeScriptApi,
  argument: TSApi.Expression,
): TSApi.Expression | undefined {
  const node = unwrapExpression(ts, argument)
  if (!ts.isObjectLiteralExpression(node)) return argument
  for (const property of node.properties) {
    if (ts.isShorthandPropertyAssignment(property) && STATEMENT_KEYS.has(property.name.text)) {
      return property.name
    }
    if (
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      STATEMENT_KEYS.has(property.name.text)
    ) {
      return property.initializer
    }
  }
  return undefined
}

const STATEMENT_KEYS = new Set(["text", "sql"])

interface StatementHelper {
  readonly position: number
  readonly sink: SqlSink
}

/** Same-file functions that send one of their parameters as a statement - `run(db, q)` calling
 * `db.query(q)` - by name, with the parameter's position and the sink it reaches. A call to one is
 * scanned as a call to that sink. One level deep. */
function statementHelpers(
  ts: TypeScriptApi,
  source: TSApi.SourceFile,
): ReadonlyMap<string, StatementHelper> {
  const helpers = new Map<string, StatementHelper>()
  const visit = (node: TSApi.Node): void => {
    const sink = ts.isCallExpression(node) ? sqlMethod(ts, node) : undefined
    const passed = sink !== undefined && ts.isCallExpression(node) ? node.arguments[0] : undefined
    const argument = passed === undefined ? undefined : statementArgument(ts, passed)
    const statement = argument === undefined ? undefined : unwrapExpression(ts, argument)
    if (sink !== undefined && statement !== undefined && ts.isIdentifier(statement)) {
      const binding = nameBinding(ts, statement)
      const name = binding.kind === "parameter" ? functionName(ts, binding.fn) : undefined
      if (binding.kind === "parameter" && name !== undefined && !helpers.has(name)) {
        helpers.set(name, { position: binding.position, sink })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return helpers
}

function functionName(ts: TypeScriptApi, fn: TSApi.SignatureDeclaration): string | undefined {
  if (ts.isFunctionDeclaration(fn)) return fn.name?.text
  if (
    (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
    ts.isVariableDeclaration(fn.parent) &&
    ts.isIdentifier(fn.parent.name)
  ) {
    return fn.parent.name.text
  }
  return undefined
}

/** `content` with every string, template and regex literal blanked, line breaks kept. */
function literalsBlanked(ts: TypeScriptApi, source: TSApi.SourceFile, content: string): string {
  const out = content.split("")
  const visit = (node: TSApi.Node): void => {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isRegularExpressionLiteral(node) ||
      ts.isJsxText(node)
    ) {
      for (let i = node.getStart(source); i < node.end; i++) if (out[i] !== "\n") out[i] = " "
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out.join("")
}

/** What silences one interpolated-SQL finding: `// nifra-expect NF-C006: <reason>` (or the
 * `sql-dynamic` slug) on the flagged line or in the comment block directly above it. The reason after
 * the colon is mandatory (see {@link commentBlockExpectation}). Scoped to the single statement it sits on. */
const SQL_DYNAMIC_EXPECTATION = ["NF-C006", "sql-dynamic"]

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
  return scanSqlSites(file, content, ts, imports).filter((site) => site.expected === undefined)
}

/** {@link scanInterpolatedSql}, keeping the sites an expectation comment silences, with its reason. */
export function scanSqlSites(
  file: string,
  content: string,
  ts: TypeScriptApi,
  imports?: SqlImports,
): SqlFinding[] {
  const out: SqlFinding[] = []
  const lines = content.split("\n")
  // Malformed source is already a typecheck failure. Do not turn parser recovery nodes into a second,
  // misleading SQL diagnostic (notably an unterminated template recovered as an interpolation).
  const source = parseSqlSource(ts, file, content)
  if (source === undefined) return out
  // Module-scope bindings, read once per file: an interpolated `const` that resolves to compile-time
  // text cannot carry request data, so the shared-projection idiom (`const COLS = "id, name"` …
  // `${COLS}`) stays quiet while mutable, parameter, shadowed, and unprovable names flag as before.
  const scope: SqlScope = { module: sqlModuleScope(ts, file, source), imports }
  const helpers = statementHelpers(ts, source)
  // A marker counts only in a comment: one inside a string the call passes is data, not a reason.
  let markerLines: readonly string[] | undefined
  const visit = (node: TSApi.Node): void => {
    if (ts.isCallExpression(node)) {
      const helper = ts.isIdentifier(node.expression)
        ? helpers.get(node.expression.text)
        : undefined
      const sink = helper?.sink ?? sqlMethod(ts, node)
      const passed = node.arguments[helper?.position ?? 0]
      const argument = passed === undefined ? undefined : statementArgument(ts, passed)
      if (sink !== undefined && argument !== undefined) {
        const shape = sqlExpressionShape(ts, argument, scope)
        // A helper's own hatch call already answers for passing it a variable.
        const unsafeEscape =
          helper === undefined &&
          sink.receiver !== undefined &&
          ALWAYS_UNSAFE.has(sink.method) &&
          !shape.literal &&
          !shape.parameterizedTag
        if (unsafeEscape || isAssembledSql(sink, shape)) {
          const index = node.getStart(source)
          const line = source.getLineAndCharacterOfPosition(index).line + 1
          // Sanctioned escape hatch for genuinely-dynamic-but-bound SQL (an allowlisted identifier,
          // placeholders numbered from data the scan cannot prove numeric). The reason is mandatory: a bare `// nifra-expect
          // NF-C006` with no reason after the colon does NOT silence, so the hatch always leaves a
          // greppable audit trail instead of becoming a second laundering trick.
          markerLines ??= literalsBlanked(ts, source, content).split("\n")
          const reason = commentBlockExpectation(markerLines, line, SQL_DYNAMIC_EXPECTATION)?.reason
          const site = { file, line, snippet: (lines[line - 1] ?? "").trim() }
          out.push(reason === undefined ? site : { ...site, expected: reason })
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
  const sourceFiles: Array<{ readonly file: string; readonly content: string }> = []
  await walkSource(cwd, (file, content) => sourceFiles.push({ file, content }))
  const contents = new Map(sourceFiles.map(({ file, content }) => [file, content]))
  const sourceIndex: TypeScriptSourceIndex = {
    files: sourceFiles.map(({ file }) => file),
    read: (file) => contents.get(file),
  }
  const loaded = await loadProjectTypeScript(cwd, undefined, sourceIndex)
  if (loaded.compiler === undefined) return undefined
  const out: SourceFinding[] = []
  const imports = createProjectSqlImports(cwd)
  try {
    for (const { file, content } of sourceFiles) {
      out.push(...scanInterpolatedSql(file, content, loaded.compiler, imports))
    }
    return out.sort(bySite)
  } finally {
    await loaded.session?.close()
  }
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
    specifier: "@nifrajs/web/server-only",
    since: "4.0",
    replacement:
      'import "@nifrajs/web/backend-only" - and keep backend code under backend/ or in a route\'s x.backend.ts, where no browser build reaches it',
  },
  {
    specifier: "@nifrajs/web/plugins/vite-server-only",
    since: "4.0",
    replacement:
      "nothing - buildClientVite and the Vite dev server enforce the frontend/backend zones themselves; for a hand-built Vite config use viteLeakGuard from @nifrajs/web/plugins/vite-leak-guard",
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

/** Flag an import of a specifier that no longer exists, or of a name that moved to a subpath
 * ({@link MOVED_EXPORTS}). Pure; matches the exact specifier or a subpath of it, so `@nifrajs/budget/x`
 * is caught alongside `@nifrajs/budget`. */
export function scanRemovedImports(file: string, content: string): SourceFinding[] {
  const out: SourceFinding[] = []
  const lines = content.split("\n")
  for (const edge of importEdges(content)) {
    const removed = REMOVED_IMPORTS.find(
      (entry) =>
        edge.specifier === entry.specifier || edge.specifier.startsWith(`${entry.specifier}/`),
    )
    if (removed === undefined) continue
    if (removed.sideEffectOnly === true && !isSideEffectImport(content, edge.index)) continue
    const line = lineAt(content, edge.index)
    out.push({ file, line, snippet: (lines[line - 1] ?? "").trim() })
  }
  // A moved name's snippet is the whole statement on one line: the rule re-reads the site from it.
  for (const site of movedExportSites(content)) {
    const snippet = content.slice(site.index, site.end).replace(/\s+/g, " ")
    out.push({ file, line: lineAt(content, site.index), snippet })
  }
  return out
}

/**
 * Named exports that left a module for one of its subpaths, and where they went.
 *
 * Unlike a removed specifier, a moved name does fail the typecheck - but that error names neither the
 * new home nor a fix. Listing it here gives the diagnostic both, and `nifra fix --code NF-C005`
 * rewrites the import ({@link rewriteMovedExports}).
 */
export const MOVED_EXPORTS: ReadonlyArray<{
  readonly from: string
  readonly names: readonly string[]
  readonly to: string
}> = [
  // Compiler plugins sit on their own subpath so the adapter root, which every server and edge bundle
  // links, never pulls in build-time code.
  { from: "@nifrajs/web-solid", names: ["solidBunPlugin"], to: "@nifrajs/web-solid/plugin" },
  { from: "@nifrajs/web-svelte", names: ["svelteBunPlugin"], to: "@nifrajs/web-svelte/plugin" },
]

/** `import { a, b as c } from "x"` and `export { a } from "x"` - the forms a moved name is reached by.
 * `import type` / `export type` never match, so a type-only import is left to tsc as elsewhere here. */
const NAMED_FROM = /\b(import|export)\s*\{([^{}]*)\}\s*from\s*(["'])([^"'\n]+)\3;?/g

export interface MovedExportSite {
  /** Statement span in the scanned source, `end` exclusive (a trailing `;` included). */
  readonly index: number
  readonly end: number
  readonly keyword: string
  readonly quote: string
  readonly from: string
  readonly to: string
  /** Binding texts as written (`a`, `a as b`), split by whether they move. */
  readonly kept: readonly string[]
  readonly moved: readonly string[]
}

/** Every import/re-export statement naming a {@link MOVED_EXPORTS} binding, in source order. Pure. */
export function movedExportSites(content: string): MovedExportSite[] {
  const positions = codePositionMask(content)
  const sites: MovedExportSite[] = []
  const re = new RegExp(NAMED_FROM.source, NAMED_FROM.flags)
  for (let m = re.exec(content); m !== null; m = re.exec(content)) {
    if (positions[m.index] === " ") continue
    const entry = MOVED_EXPORTS.find((candidate) => candidate.from === m?.[4])
    if (entry === undefined) continue
    const bindings = (m[2] ?? "")
      .split(",")
      .map((binding) => binding.trim())
      .filter((binding) => binding !== "")
    const moves = (binding: string): boolean =>
      !binding.startsWith("type ") && entry.names.includes(binding.split(/\s+/)[0] ?? "")
    const moved = bindings.filter(moves)
    if (moved.length === 0) continue
    sites.push({
      index: m.index,
      end: m.index + m[0].length,
      keyword: m[1] ?? "import",
      quote: m[3] ?? '"',
      from: entry.from,
      to: entry.to,
      kept: bindings.filter((binding) => !moves(binding)),
      moved,
    })
  }
  return sites
}

/** Point every moved binding at the module it moved to, leaving the rest of its statement in place.
 * Returns `content` unchanged when nothing moved, so applying it twice is a no-op. Pure. */
export function rewriteMovedExports(content: string): string {
  let out = content
  for (const site of movedExportSites(content).reverse()) {
    const semicolon = content[site.end - 1] === ";" ? ";" : ""
    const statement = (bindings: readonly string[], from: string): string =>
      `${site.keyword} { ${bindings.join(", ")} } from ${site.quote}${from}${site.quote}${semicolon}`
    const replacement =
      site.kept.length === 0
        ? statement(site.moved, site.to)
        : `${statement(site.kept, site.from)}\n${statement(site.moved, site.to)}`
    out = out.slice(0, site.index) + replacement + out.slice(site.end)
  }
  return out
}

/** Scan a browser module for server-only imports, static or a literal dynamic `import()`. Returns `[]`
 * for server code ({@link isBrowserSource}), where a server-only import is fine. Each finding carries
 * the offending `specifier` so the diagnostic can render the `file → specifier` chain. Pure. */
export function scanServerOnlyImports(
  file: string,
  content: string,
  facts?: SourceFacts,
): ServerImportFinding[] {
  if (!isBrowserSource(file)) return []
  const out: ServerImportFinding[] = []
  const lines = content.split("\n")
  // Inline `import { type X } from "…"` is erased just like `import type` and is not an edge; a parse
  // failure keeps the lexical edge so the security rule fails closed.
  for (const { specifier, index } of importEdges(content, facts, file)) {
    if (!isServerOnly(specifier)) continue
    const line = lineAt(content, index)
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

// The retired `*.server` convention. Builds refuse such a module in browser code rather than empty it.
const LEGACY_SERVER_FILE = /\.server(\.[cm]?[jt]sx?)?$/
// The explicit poison-import marker (`@nifrajs/web/backend-only`, or its retired `server-only` name) - a
// module opting into the client-leak guard. A resolved file carrying this side-effect import is a sink.
const BACKEND_ONLY_MARKER_IMPORT = /import\s+["']@nifrajs\/web\/(?:backend|server)-only["']/g

/** Whether `content` imports the backend-only marker in code. A mention in a comment or a string,
 * such as a note on how to opt in, marks nothing. */
function hasBackendOnlyMarker(content: string): boolean {
  if (!content.includes("-only")) return false
  const positions = codePositionMask(content)
  for (const match of content.matchAll(BACKEND_ONLY_MARKER_IMPORT)) {
    if (positions[match.index] !== " ") return true
  }
  return false
}

/** A relative module specifier (`./x`, `../y`) - the only kind the SQL import lookup follows. */
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
  positions: string = codePositionMask(content),
): Array<{ specifier: string; index: number }> {
  const edges: Array<{ specifier: string; index: number }> = []
  const re = staticImportRegex()
  const code = stripComments(content)
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

/** The literal dynamic `import("x")` calls in executable code, skipping type positions. With `facts`
 * the parser decides; without it (or when it cannot tell) the lexical rule does. Pure. */
function dynamicImportEdges(
  content: string,
  facts?: SourceFacts,
  file?: string,
  positions: string = codePositionMask(content),
): Array<{ specifier: string; index: number }> {
  const edges: Array<{ specifier: string; index: number }> = []
  const re = new RegExp(DYNAMIC_IMPORT.source, DYNAMIC_IMPORT.flags)
  for (let m = re.exec(content); m !== null; m = re.exec(content)) {
    if (positions[m.index] === " ") continue // inside a comment or a string
    const specifier = m[2]
    if (specifier === undefined) continue
    const source =
      facts !== undefined && file !== undefined ? facts.parse(file, content) : undefined
    const verdict =
      source === undefined || facts === undefined
        ? undefined
        : facts.isDynamicImportAt(source, m.index, specifier)
    if (verdict === false) continue
    if (verdict === undefined) {
      if (TYPE_QUERY_BEFORE.test(content.slice(Math.max(0, m.index - 16), m.index))) continue
      const end = m.index + m[0].length
      if (m[0].endsWith(")") && TYPE_QUALIFIER_AFTER.test(content.slice(end, end + 64))) continue
    }
    edges.push({ specifier, index: m.index })
  }
  return edges
}

/** The literal `require("x")` calls in executable code. Pure. */
function requireEdges(
  content: string,
  positions: string,
): Array<{ specifier: string; index: number }> {
  const edges: Array<{ specifier: string; index: number }> = []
  const re = new RegExp(REQUIRE_CALL.source, REQUIRE_CALL.flags)
  for (let m = re.exec(content); m !== null; m = re.exec(content)) {
    if (positions[m.index] === " ") continue // inside a comment or a string
    const specifier = m[2]
    if (specifier === undefined) continue
    if (TYPE_ALIAS_BEFORE.test(content.slice(Math.max(0, m.index - 80), m.index))) continue
    edges.push({ specifier, index: m.index })
  }
  return edges
}

/** Every import a module's runtime code makes - static, literal dynamic and `require` - in source
 * order. Pure. */
function importEdges(
  content: string,
  facts?: SourceFacts,
  file?: string,
): Array<{ specifier: string; index: number }> {
  const positions = codePositionMask(content)
  const edges = staticImportEdges(content, facts, file, positions)
  // Without an `import(` or a `require` there is nothing for the other passes to find; skip them.
  const dynamic = content.includes("import(") || /import\s+\(/.test(content)
  const required = content.includes("require")
  if (!dynamic && !required) return edges
  if (dynamic) edges.push(...dynamicImportEdges(content, facts, file, positions))
  if (required) edges.push(...requireEdges(content, positions))
  return edges.sort((a, b) => a.index - b.index)
}

/** The runtime imports of a module with the line each sits on, in source order. Pure. */
export function importSites(
  content: string,
  file?: string,
): Array<{ readonly specifier: string; readonly line: number }> {
  return importEdges(content, undefined, file).map(({ specifier, index }) => ({
    specifier,
    line: lineAt(content, index),
  }))
}

/** The specifiers {@link importEdges} finds, static and literal dynamic, in source order. Pure. */
export function parseImports(content: string, facts?: SourceFacts, file?: string): string[] {
  return importEdges(content, facts, file).map((e) => e.specifier)
}

/** The server-only SINK an import specifier names directly (a `node:`/`bun:` builtin or a known
 * server-only package), or `undefined` if it isn't a by-name sink. Pure - the label is the specifier
 * itself (it's already the actionable name). */
export function directSinkSpecifier(spec: string): string | undefined {
  return isServerOnlySink(spec) ? spec : undefined
}

/** One transitive server-only finding: the route module, the route's offending top-level import (the
 * first hop / `specifier`), the line + snippet of that import, and the FULL chain to the sink. */
export interface TransitiveServerImportFinding extends ServerImportFinding {
  /** `[routeFile, ...as-written specifiers…, sink]` - the shortest path the walk found. Length 2 means
   * the route imports the sink directly (same as the regex scan's direct edge). */
  readonly chain: readonly string[]
  /** The project files the chain runs through, as `resolve` named them: the route, each module the
   * walk entered, and the sink when it is a project file. A change to any of them can make the chain. */
  readonly modules: readonly string[]
  /** True when a precise transitive resolve wasn't possible for the first hop (a bare pkg / path alias),
   * so the chain is the honest direct edge rather than a fabricated deeper path. */
  readonly fallback: boolean
}

/** A resolver from `(fromFile, specifier)` to a project module path, or `undefined` when it names no
 * project file (a package, a missing file). Abstracted so the BFS is unit-testable with a fake graph (no
 * real fs). The production resolver follows relative paths, tsconfig `paths` and package.json `imports`. */
export type ModuleResolver = (fromFile: string, specifier: string) => string | undefined
/** Reads a resolved module's source, or `undefined` if unreadable. Abstracted for the same reason. */
export type ModuleReader = (absPath: string) => string | undefined

/** What a server-only chain search reads the project through. */
export interface ServerOnlyChainSource {
  readonly resolve: ModuleResolver
  readonly read: ModuleReader
  readonly facts?: SourceFacts | undefined
  readonly componentReceipts?: ReadonlySet<string>
  /** Whether a bare specifier `resolve` leaves unanswered names an installed package that declares
   * `"nifra": { "environment": "backend" }`, which the browser build refuses. */
  readonly backendPackage?: (fromFile: string, specifier: string) => boolean
}

/** A chain from a module to a sink: `[start, ...as-written specifiers, sink]`, and the project files
 * it runs through (see {@link TransitiveServerImportFinding.modules}). */
interface ChainWalk {
  readonly chain: readonly string[]
  readonly modules: readonly string[]
}

/** The chain searches of one check, sharing what they learn about each module. */
interface ChainGraph {
  /** The shortest chain from `start` to a sink. */
  walk(start: string, content: string): ChainWalk | undefined
  read(abs: string): string | undefined
  resolve(from: string, specifier: string): string | undefined
  backendPackage(from: string, specifier: string): boolean
  readonly componentReceipts: ReadonlySet<string>
  readonly facts: SourceFacts | undefined
}

/**
 * Every module is read, parsed and resolved at most once, and the chain from a module is searched at
 * most once, however many routes reach it: per-route searches repeated all of that for every route
 * that shared a module, which made a check quadratic in the size of a shared graph.
 */
function chainGraph(source: ServerOnlyChainSource): ChainGraph {
  const { facts } = source
  const componentReceipts = source.componentReceipts ?? new Set<string>()
  const contents = new Map<string, string | undefined>()
  const imports = new Map<string, readonly string[]>()
  const resolutions = new Map<string, string | undefined>()
  const walks = new Map<string, ChainWalk | undefined>()
  const packages = new Map<string, boolean>()
  const read = (abs: string): string | undefined => {
    if (!contents.has(abs)) contents.set(abs, source.read(abs))
    return contents.get(abs)
  }
  const resolve = (from: string, specifier: string): string | undefined => {
    const key = `${from}\0${specifier}`
    if (!resolutions.has(key)) resolutions.set(key, source.resolve(from, specifier))
    return resolutions.get(key)
  }
  const backendPackage = (from: string, specifier: string): boolean => {
    if (source.backendPackage === undefined || /^[./#]/.test(specifier)) return false
    const key = `${from}\0${specifier}`
    let found = packages.get(key)
    if (found === undefined) {
      found = source.backendPackage(from, specifier)
      packages.set(key, found)
    }
    return found
  }
  const importsOf = (abs: string, content: string): readonly string[] => {
    let found = imports.get(abs)
    if (found === undefined) {
      found = parseImports(content, facts, abs)
      imports.set(abs, found)
    }
    return found
  }
  /**
   * Breadth-first, so the first sink found is the nearest. A node's edges are its static and literal
   * dynamic imports; an edge is followed only into a project file `resolve` names, an alias included,
   * never into node_modules. A by-name sink import (`node:fs`, `postgres`), backend code, or a module
   * importing the `backend-only` marker ends the chain; a `*.fn.ts` module ships as its stub and is not
   * entered. The visited set keeps it cycle-free; there is no depth or size cap to cut a chain short.
   */
  const search = (start: string, startContent: string): ChainWalk | undefined => {
    interface Node extends ChainWalk {
      readonly abs: string
      readonly content: string
    }
    const seen = new Set<string>([start])
    let frontier: Node[] = [{ abs: start, content: startContent, chain: [start], modules: [start] }]
    while (frontier.length > 0) {
      const next: Node[] = []
      for (const node of frontier) {
        const { chain, modules } = node
        for (const spec of importsOf(node.abs, node.content)) {
          const sink = directSinkSpecifier(spec)
          if (sink !== undefined) return { chain: [...chain, sink], modules }
          const abs = resolve(node.abs, spec)
          if (abs === undefined) {
            if (backendPackage(node.abs, spec)) return { chain: [...chain, spec], modules }
            continue
          }
          if (seen.has(abs)) continue
          if (componentReceipts.has(abs)) continue
          if (isBackendModule(abs)) return { chain: [...chain, spec], modules: [...modules, abs] }
          if (SERVER_FN_FILE.test(abs)) continue
          const content = read(abs)
          if (content === undefined) continue
          if (hasBackendOnlyMarker(content)) {
            return { chain: [...chain, spec], modules: [...modules, abs] }
          }
          seen.add(abs)
          next.push({ abs, content, chain: [...chain, spec], modules: [...modules, abs] })
        }
      }
      frontier = next
    }
    return undefined
  }
  return {
    walk(start, content) {
      if (!walks.has(start)) walks.set(start, search(start, content))
      return walks.get(start)
    },
    read,
    resolve,
    backendPackage,
    componentReceipts,
    facts,
  }
}

/**
 * The shortest import chain from `routeFile` to a server-only sink, `[routeFile, ...as-written
 * specifiers, sink]`, or `undefined` when none is reachable. Pure given `resolve`/`read`, so a fake
 * graph tests it.
 */
export function walkServerOnlyChain(
  routeFile: string,
  routeContent: string,
  resolve: ModuleResolver,
  read: ModuleReader,
  facts?: SourceFacts,
  componentReceipts: ReadonlySet<string> = new Set(),
): readonly string[] | undefined {
  return chainGraph({
    resolve,
    read,
    facts,
    componentReceipts,
  }).walk(routeFile, routeContent)?.chain
}

/**
 * The server-only chain finder for one check: called per browser module, it returns that module's
 * findings, reusing every module and chain an earlier call already searched.
 */
export function createServerOnlyChains(
  source: ServerOnlyChainSource,
): (file: string, content: string, browserRoot?: boolean) => TransitiveServerImportFinding[] {
  const graph = chainGraph(source)
  return (file, content, browserRoot = false) => serverOnlyChains(graph, file, content, browserRoot)
}

/**
 * Resolve the FULL transitive server-only chain(s) for a route module, given a real fs-backed resolver +
 * reader. For each of the route's top-level imports, if a precise transitive walk finds a sink, the
 * finding carries the full chain; otherwise - when the first hop is itself a direct by-name sink the
 * regex scan already flags, or when a relative import can't be resolved - it falls back to the DIRECT
 * edge (`fallback: true`), never a fabricated chain. Returns one finding per offending top-level import,
 * de-duplicated to the shortest chain per first-hop specifier. A file that is not browser source
 * yields `[]`, unless `browserRoot` says the browser bundle loads it anyway (an app's `clientModule`).
 * One check should use {@link createServerOnlyChains}, which shares the work across modules.
 */
export function resolveServerOnlyChains(
  file: string,
  content: string,
  resolve: ModuleResolver,
  read: ModuleReader,
  facts?: SourceFacts,
  componentReceipts: ReadonlySet<string> = new Set(),
  browserRoot = false,
): TransitiveServerImportFinding[] {
  return createServerOnlyChains({
    resolve,
    read,
    facts,
    componentReceipts,
  })(file, content, browserRoot)
}

function serverOnlyChains(
  graph: ChainGraph,
  file: string,
  content: string,
  browserRoot: boolean,
): TransitiveServerImportFinding[] {
  if (!browserRoot && !isBrowserSource(file)) return []
  const lines = content.split("\n")
  const out: TransitiveServerImportFinding[] = []
  const flaggedSpecifiers = new Set<string>()
  for (const { specifier, index } of importEdges(content, graph.facts, file)) {
    if (flaggedSpecifiers.has(specifier)) continue
    const line = lineAt(content, index)
    const snippet = (lines[line - 1] ?? "").trim()
    const flag = (
      chain: readonly string[],
      fallback: boolean,
      modules: readonly string[] = [file],
    ): void => {
      flaggedSpecifiers.add(specifier)
      out.push({ file, line, snippet, specifier, chain, modules, fallback })
    }
    // (1) A direct by-name sink (`node:fs`, `postgres`): the route imports it itself.
    if (directSinkSpecifier(specifier) !== undefined) {
      flag([file, specifier], false)
      continue
    }
    // (2) A project import, relative or through an alias: walk from the resolved dependency and, if
    // it reaches a sink, report the full chain rooted at THIS route's import line.
    const abs = graph.resolve(file, specifier)
    if (abs === undefined) {
      // An installed package that declares itself backend is a sink. Any other name no project file
      // answers to can't be called server-only, except the `../db` convention, reported as the direct
      // edge with `fallback` saying the resolve was impossible.
      if (graph.backendPackage(file, specifier)) flag([file, specifier], false)
      else if (isServerOnly(specifier)) flag([file, specifier], true)
      continue
    }
    if (graph.componentReceipts.has(abs)) continue
    // A backend first hop and a marked module are sinks; a `*.fn.ts` hop ships as its stub.
    if (isBackendModule(abs)) {
      flag([file, specifier], false, [file, abs])
      continue
    }
    if (SERVER_FN_FILE.test(abs)) continue
    const depContent = graph.read(abs)
    if (depContent === undefined) continue
    if (hasBackendOnlyMarker(depContent)) {
      flag([file, specifier], false, [file, abs])
      continue
    }
    const sub = graph.walk(abs, depContent)
    if (sub !== undefined) {
      // `sub` starts at the resolved dependency; the route names it by its as-written specifier.
      flag([file, specifier, ...sub.chain.slice(1)], false, [file, ...sub.modules])
      continue
    }
    // (3) The `../db` convention with no deeper sink found: still surface the direct edge.
    if (isServerOnly(specifier)) flag([file, specifier], true)
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
    // A `// nifra-expect NF-C007` comment (or the `raw-response` slug) marks an intentional raw Response
    // (a file/redirect that can't be a typed route), silencing this advisory with or without a reason.
    // It counts on the return line or in the comment block directly above, so a TRAILING comment on one
    // route's return line can't leak down onto the next route. `stripComments` blanks it in `code` (so it
    // never affects the match); the raw `lines` still carry it.
    if (commentBlockExpectation(lines, line, RAW_RESPONSE_EXPECTATION) !== undefined) continue
    out.push({ file, line, snippet: (lines[line - 1] ?? "").trim() })
  }
  return out
}

/** What suppresses the {@link scanResponseRoutes} advisory for an intentional raw Response. */
const RAW_RESPONSE_EXPECTATION = ["NF-C007", "raw-response"]

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
  opts: {
    readonly includeTests?: boolean
    /** Additional project-relative paths to exclude from this scan. */
    readonly ignore?: (relativePath: string) => boolean
    /**
     * Also visit the other files a build loads: every `.jsx`, `.svelte` and `.vue` file, and `.js`
     * files in a zone. A `.svelte`/`.vue` file is visited as {@link componentScripts}.
     */
    readonly scripts?: boolean
  } = {},
): Promise<void> {
  const skip = opts.includeTests === true ? IGNORED_DIR : IGNORED
  const pattern =
    opts.scripts === true
      ? "**/*.{ts,tsx,mts,cts,jsx,js,mjs,cjs,svelte,vue}"
      : "**/*.{ts,tsx,mts,cts}"
  // List candidates first (cheap - no reads), drop the built-in ignores, then exclude gitignored paths in
  // one batch before the (expensive) reads. So a gitignored generated/build tree is never read or scanned.
  const rels: string[] = []
  for await (const rawRel of new Glob(pattern).scan({ cwd, dot: false })) {
    const rel = normalizeProjectPath(rawRel)
    // A `.js` file outside a zone is tooling (a bundler config, a script, a vendored asset), not app code.
    if (PLAIN_SCRIPT_FILE.test(rel) && !ZONED_PATH.test(rel)) continue
    if (!skip.test(rel) && (opts.ignore === undefined || !opts.ignore(rel))) rels.push(rel)
  }
  const ignored = await gitIgnored(cwd, rels)
  // Glob order is the filesystem's, so findings would come out in a different order on each platform.
  for (const rel of rels.sort(codeUnitOrder)) {
    if (ignored.has(rel)) continue
    const text = await Bun.file(join(cwd, rel)).text()
    visit(rel, COMPONENT_FILE.test(rel) ? componentScripts(text) : text)
  }
}

const PLAIN_SCRIPT_FILE = /\.[cm]?js$/
const ZONED_PATH =
  /(^|\/)(?:routes|frontend|shared|backend)\/|\.(?:frontend|shared|backend|fn)\.[^/]+$/
/** A single-file component: its `<script>` blocks are the code a build compiles. */
export const COMPONENT_FILE = /\.(?:svelte|vue)$/

/**
 * A `.svelte` or `.vue` file as the source scanners read it: the text of its `<script>` blocks where
 * they stand, and every other character blanked to a space with line breaks kept, so a finding's line
 * and column are the file's own. An unclosed `<script>` runs to the end of the file. Pure.
 */
export function componentScripts(text: string): string {
  const blank = (part: string): string => part.replace(/[^\n]/g, " ")
  let out = ""
  let at = 0
  for (;;) {
    const open = text.indexOf("<script", at)
    if (open === -1) break
    const close = text.indexOf(">", open)
    if (close === -1) break
    // `<scripts>` or `<script-x>` is another element.
    if (!/[\s>]/.test(text[open + 7] ?? "")) {
      out += blank(text.slice(at, close + 1))
      at = close + 1
      continue
    }
    const end = text.indexOf("</script", close + 1)
    const stop = end === -1 ? text.length : end
    out += blank(text.slice(at, close + 1)) + text.slice(close + 1, stop)
    at = stop
    if (end === -1) break
  }
  return out + blank(text.slice(at))
}

const bySite = (a: SourceFinding, b: SourceFinding): number =>
  codeUnitOrder(a.file, b.file) || a.line - b.line

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
// The files route discovery collects (mirrors `@nifrajs/web/fs`'s filter): route files by extension,
// each route's backend half, and `_middleware` modules.
const ROUTE_FILE_EXT = /\.(tsx|jsx|svelte|vue|mdx)$/
const ROUTE_BACKEND_HALF = /\.backend\.(?:[cm]?[jt]s)$/
const MIDDLEWARE_FILE = /(?:^|\/)_middleware\.(?:ts|js)$/

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
        await Array.fromAsync(
          new Glob("**/*.{tsx,jsx,svelte,vue,mdx,ts,js}").scan({ cwd: routesDir }),
        )
      )
        .map((f) => f.replaceAll("\\", "/"))
        .filter(
          (f) => ROUTE_FILE_EXT.test(f) || ROUTE_BACKEND_HALF.test(f) || MIDDLEWARE_FILE.test(f),
        )
    } catch {
      continue // routes dir gone/unreadable - not a drift we can assess
    }
    const drift = diffManifestRoutes(manifestFiles, discovered)
    if (!isManifestInSync(drift)) {
      findings.push({ file: rel, missing: drift.missing, extra: drift.extra })
    }
  }
  return findings.sort((a, b) => codeUnitOrder(a.file, b.file))
}

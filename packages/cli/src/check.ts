/**
 * `nifra check` — the agent's (and CI's) definition of done. It makes the guarantees that keep a nifra
 * app drift-proof actually *fire*, instead of relying on the agent to remember them:
 *
 *   1. **typecheck** (`tsc --noEmit`) — the frontend↔backend contract is compiler-enforced. The typed
 *      client derives request + response types from the routes, so a shape mismatch is a type error.
 *   2. **typed-client lint** — flags hand-rolled `fetch()` to this app's *own* API (a relative URL),
 *      which bypasses `client<typeof app>` so the compiler can't see the drift.
 *   3. **server-only-import lint** — flags a top-level import of server-only code (a DB driver, `node:`/
 *      `bun:` builtins, the `./db` module) into a `routes/` page module. Those modules are bundled for
 *      the browser too, so the import ships server code to the client and breaks the build — the #1
 *      full-stack footgun. Reach server resources via `c.db` / `ctx.api`, never a top-level import.
 *
 * `collectCheckResult` returns a structured, machine-readable result (consumed by `--json` and the
 * `nifra_check` MCP tool, so an agent acts on diagnostics instead of scraping prose). Exits non-zero if
 * anything fails. Pure scanners (`scanFetchText`, `scanServerOnlyImports`) are unit-tested.
 */

import { readFileSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import { Glob } from "bun"

export interface SourceFinding {
  readonly file: string
  readonly line: number
  readonly snippet: string
}
/** @deprecated kept for back-compat with existing tests; prefer {@link SourceFinding}. */
export type FetchFinding = SourceFinding

/** A server-only-import finding, carrying the offending module specifier on top of the base location so
 * the diagnostic can show the import chain `routeFile → specifier` (the direct edge the regex scan sees). */
export interface ServerImportFinding extends SourceFinding {
  /** The server-only module specifier the route top-level-imports (e.g. `pg`, `node:fs`, `../db`). */
  readonly specifier: string
}

// `fetch( <ws> ('|"|`) / (not /)` — a string/template arg starting with a single `/` is a relative URL,
// i.e. same-origin = this app's own API. `(?<![.\w])` skips `.fetch(` (a method) and `prefetch(`; the
// `(?!\/)` skips protocol-relative `//host` (an external origin). A variable arg (`fetch(url)`) is left
// alone on purpose — undecidable from source, and flagging it would punish legitimate external calls.
const OWN_API_FETCH = /(?<![.\w])fetch\s*\(\s*['"`]\/(?!\/)/g
const FETCH_CALL = /(?<![.\w])fetch\s*\(/g
const HTTP_VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
const SIMPLE_REWRITE_METHODS = new Set(["GET", "DELETE", "HEAD", "OPTIONS"])

// Don't scan deps, build output, generated client entries, or tests (which legitimately drive `fetch`).
// `dist(-<runtime>)?` also covers per-runtime output dirs (dist-bun/dist-node/dist-deno/dist-vercel).
const IGNORED =
  /(^|\/)(node_modules|dist(-[a-z0-9]+)?|build|\.nifra|\.git|\.wrangler|coverage)\/|\.(test|spec)\.[cm]?[jt]sx?$/

// A file under `routes/` — a page module bundled for the browser, where a server-only import is unsafe.
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
      return JSON.parse(`"${raw.slice(1, -1).replace(/"/g, '\\"')}"`) as string
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

function isPotentialNifraBackendSource(code: string): boolean {
  return code.includes("@nifrajs/core") || /(?<![.\w])server\s*\(/.test(code)
}

function scanRoutePattern(
  file: string,
  content: string,
  code: string,
  pattern: RegExp,
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
    const line = lineAt(content, m.index)
    out.push({ file, line, snippet: (lines[line - 1] ?? "").trim(), method, path })
  }
  return out
}

/**
 * Blank, with spaces (newlines preserved, so every byte offset — and line number — is unchanged):
 *   - `//` line comments and block comments;
 *   - the CONTENTS of backtick template literals — code-as-text (doc `CodeBlock` examples, code
 *     generators), never a real statement to lint.
 * Single/double-quoted strings are KEPT (a real import/Response specifier lives in one). A small
 * char-state machine, not a full lexer: it doesn't model regex literals, so a regex containing a quote
 * could mis-skip — in practice the constructs these scanners look for sit before any such regex.
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

/** Scan one file's text for hand-rolled own-API `fetch()` calls. Pure + line-accurate. */
export function scanFetchText(file: string, content: string): SourceFinding[] {
  const out: SourceFinding[] = []
  const lines = content.split("\n")
  OWN_API_FETCH.lastIndex = 0
  for (let m = OWN_API_FETCH.exec(content); m !== null; m = OWN_API_FETCH.exec(content)) {
    const line = lineAt(content, m.index)
    out.push({ file, line, snippet: (lines[line - 1] ?? "").trim() })
  }
  return out
}

/** Statically collect simple Nifra route registrations from source, without importing app code. */
export function scanStaticRouteText(file: string, content: string): StaticRouteFinding[] {
  const code = stripComments(content)
  if (!isPotentialNifraBackendSource(code)) return []
  return [
    ...scanRoutePattern(file, content, code, ROUTE_REGISTRATION_DQ),
    ...scanRoutePattern(file, content, code, ROUTE_REGISTRATION_SQ),
  ].sort(bySite)
}

// `client("` / `client('` / `client(\`` — a URL-first call WITHOUT the `<typeof app>` generic:
// the compiler has nothing to derive types from, so the anti-drift guarantee silently vanishes.
// `client<typeof app>("…")` has `<…>` between the name and `(` so it never matches; the published-
// contract form `client(contract, url)` starts with an identifier, not a quote — also unmatched.
const UNTYPED_CLIENT = /(?<![.\w])client\s*\(\s*['"`]/g

/** Scan one file's text for untyped `client("…")` calls. Pure + line-accurate. */
export function scanUntypedClient(file: string, content: string): SourceFinding[] {
  const out: SourceFinding[] = []
  const lines = content.split("\n")
  UNTYPED_CLIENT.lastIndex = 0
  for (let m = UNTYPED_CLIENT.exec(content); m !== null; m = UNTYPED_CLIENT.exec(content)) {
    const line = lineAt(content, m.index)
    out.push({ file, line, snippet: (lines[line - 1] ?? "").trim() })
  }
  return out
}

/** Scan a route module for top-level server-only imports. Returns `[]` for non-route files (only
 * `routes/` modules are browser-bundled, so a server-only import elsewhere is fine). Each finding carries
 * the offending `specifier` so the diagnostic can render the `routeFile → specifier` chain. Pure. */
export function scanServerOnlyImports(file: string, content: string): ServerImportFinding[] {
  if (!ROUTE_FILE.test(file)) return []
  const out: ServerImportFinding[] = []
  const lines = content.split("\n")
  STATIC_IMPORT.lastIndex = 0
  for (let m = STATIC_IMPORT.exec(content); m !== null; m = STATIC_IMPORT.exec(content)) {
    const specifier = m[1] ?? ""
    if (!SERVER_ONLY.test(specifier)) continue
    const line = lineAt(content, m.index)
    out.push({ file, line, snippet: (lines[line - 1] ?? "").trim(), specifier })
  }
  return out
}

// ---------------------------------------------------------------------------------------------------
// #4.4 — TRANSITIVE import-chain resolution for `server-only-import`. `scanServerOnlyImports` above is a
// pure per-file regex scan: it sees only the route's DIRECT `import` line, so it reports the direct edge
// `routes/x → ../db`. The build leak-guard, which has the real module graph, reports the full transitive
// `route → ../data → ../db → pg`. These helpers give `nifra check` the same depth via a BOUNDED
// import-resolution walk: from a flagged route, resolve its local imports (`Bun.resolveSync`), BFS the
// local module graph, and build the shortest chain to a server-only SINK. It's best-effort: an import
// that can't be precisely resolved (a bare pkg, a tsconfig path alias) falls back to the direct edge.
// ---------------------------------------------------------------------------------------------------

// Server-only specifiers that are TERMINAL sinks — a bare `node:`/`bun:` builtin or a known server-only
// npm package. These are never local source we can walk into, so the chain ends here. (Same vocabulary
// as SERVER_ONLY, minus the relative `../db` arm — a relative `db` module IS local source we resolve.)
const SERVER_ONLY_SINK =
  /^(?:node:|bun:)|^(?:postgres|pg|mysql2|ioredis|redis|better-sqlite3|mongodb|@libsql\/client)$|^drizzle-orm\/(?:node-postgres|postgres-js|bun-sqlite|libsql|mysql2|pglite)\b/
// The `.server` convention: a module named `*.server.ts(x)` is server-only (the client build empties it).
const SERVER_MODULE_FILE = /\.server(\.[cm]?[jt]sx?)?$/
// The explicit poison-import marker (`@nifrajs/web/server-only`) — a module opting into the client-leak
// guard. A resolved file whose source carries this side-effect import is a server-only sink.
const SERVER_ONLY_MARKER_IMPORT = /import\s+["']@nifrajs\/web\/server-only["']/
// Depth/visited caps keep the walk linear + cycle-safe. A route's server-only dependency sits within a
// few hops in practice; the bound stops a pathological graph from blowing up the per-file scan.
const TRANSITIVE_MAX_DEPTH = 8
const TRANSITIVE_MAX_VISITED = 200

/** A relative module specifier (`./x`, `../y`) — the only kind we resolve + walk into (a bare specifier
 * is either a sink we recognise by name or a third-party dep we don't follow into node_modules). */
const isRelativeSpecifier = (spec: string): boolean =>
  spec.startsWith("./") || spec.startsWith("../")

// A FRESH copy of the static-import regex per scan. The transitive walk is REENTRANT — the outer
// per-route loop and the inner BFS both scan imports — and a single shared global-flag regex carries
// `lastIndex` state, so reusing the module-level `STATIC_IMPORT` across nested calls corrupts the outer
// loop's position (it restarts forever). A fresh instance per call keeps each scan's state private.
const staticImportRegex = (): RegExp => new RegExp(STATIC_IMPORT.source, STATIC_IMPORT.flags)

/** Extract the static, non-type import specifiers from a module's source (the edges to follow/inspect),
 * each with the match index (for line attribution). Mirrors {@link STATIC_IMPORT}, so `import type` +
 * dynamic `import()` are already excluded. Uses a fresh regex instance, so it's safe under the reentrant
 * transitive walk. Pure. */
function staticImportEdges(content: string): Array<{ specifier: string; index: number }> {
  const edges: Array<{ specifier: string; index: number }> = []
  const re = staticImportRegex()
  for (let m = re.exec(content); m !== null; m = re.exec(content)) {
    if (m[1] !== undefined) edges.push({ specifier: m[1], index: m.index })
  }
  return edges
}

/** Extract the static, non-type import specifiers from a module's source (the edges to follow/inspect).
 * Mirrors {@link STATIC_IMPORT}, so `import type` + dynamic `import()` are already excluded. Pure. */
export function parseStaticImports(content: string): string[] {
  return staticImportEdges(content).map((e) => e.specifier)
}

/** The server-only SINK an import specifier names directly (a `node:`/`bun:` builtin or a known
 * server-only package), or `undefined` if it isn't a by-name sink. Pure — the label is the specifier
 * itself (it's already the actionable name). */
export function directSinkSpecifier(spec: string): string | undefined {
  return SERVER_ONLY_SINK.test(spec) ? spec : undefined
}

/** One transitive server-only finding: the route module, the route's offending top-level import (the
 * first hop / `specifier`), the line + snippet of that import, and the FULL chain to the sink. */
export interface TransitiveServerImportFinding extends ServerImportFinding {
  /** `[routeFile, ...as-written specifiers…, sink]` — the shortest path the walk found. Length 2 means
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
 * — pure given those, so it's unit-testable with a fake graph.
 */
export function walkServerOnlyChain(
  routeFile: string,
  routeContent: string,
  resolve: ModuleResolver,
  read: ModuleReader,
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
      for (const spec of parseStaticImports(node.content)) {
        // (a) A by-name sink (builtin / known server-only pkg) → the chain ends here (shortest first,
        // since BFS reaches the nearest sink before any deeper one).
        const sink = directSinkSpecifier(spec)
        if (sink !== undefined) return [...node.chain, sink]
        // (b) Only relative specifiers are local source we resolve + walk into. A bare third-party
        // specifier that isn't a known sink is a leaf — don't follow it into node_modules.
        if (!isRelativeSpecifier(spec)) continue
        const abs = resolve(node.abs, spec)
        if (abs === undefined || seen.has(abs)) continue
        // (c) A resolved `*.server` module is a server-only sink by the `.server` convention — the chain
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
 * finding carries the full chain; otherwise — when the first hop is itself a direct by-name sink the
 * regex scan already flags, or when a relative import can't be resolved — it falls back to the DIRECT
 * edge (`fallback: true`), never a fabricated chain. Returns one finding per offending top-level import,
 * de-duplicated to the shortest chain per first-hop specifier. Non-route files yield `[]`.
 */
export function resolveServerOnlyChains(
  file: string,
  content: string,
  resolve: ModuleResolver,
  read: ModuleReader,
): TransitiveServerImportFinding[] {
  if (!ROUTE_FILE.test(file)) return []
  const lines = content.split("\n")
  const out: TransitiveServerImportFinding[] = []
  const flaggedSpecifiers = new Set<string>()
  // Collect the route's import edges up front (fresh-regex scan) so the per-edge logic below can call
  // the REENTRANT transitive walk without corrupting a shared regex's `lastIndex` (the walk also scans
  // imports). Driving `STATIC_IMPORT.exec` here directly would restart this loop forever.
  for (const { specifier, index } of staticImportEdges(content)) {
    if (flaggedSpecifiers.has(specifier)) continue
    const line = lineAt(content, index)
    const snippet = (lines[line - 1] ?? "").trim()
    // (1) A direct by-name sink (`node:fs`, `postgres`) — the route imports it itself; chain is the
    // direct edge. (Length-2 chain == the regex scan's existing `[route, specifier]`.)
    if (directSinkSpecifier(specifier) !== undefined) {
      flaggedSpecifiers.add(specifier)
      out.push({ file, line, snippet, specifier, chain: [file, specifier], fallback: false })
      continue
    }
    // (2) A relative local import — try the transitive walk from the resolved dependency. If it reaches
    // a sink, emit the full chain rooted at THIS route's import line.
    if (isRelativeSpecifier(specifier)) {
      const abs = resolve(file, specifier)
      if (abs === undefined) {
        // Unresolvable relative import. If it's the known server-only `../db` convention the regex scan
        // flags directly, fall back to the direct edge (precise resolve impossible — say so via
        // `fallback`). Any other unresolvable relative import we can't assert is server-only — skip it.
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
      const subChain = walkServerOnlyChain(abs, depContent, resolve, read)
      if (subChain !== undefined) {
        flaggedSpecifiers.add(specifier)
        // subChain is `[depAbs, …hops…, sink]`; replace its head (the resolved dep path) with the
        // route's as-written specifier so the chain reads `routes/x → ../data → ../db → node:crypto`.
        const chain = [file, specifier, ...subChain.slice(1)]
        out.push({ file, line, snippet, specifier, chain, fallback: false })
        continue
      }
      // (3) The relative `../db`-style convention the regex scan flags directly, but where the walk
      // found no deeper sink (e.g. the file wasn't readable past the first hop) — fall back to the
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
// typed client infer `data: never` (`Jsonify<Response>` is `never`) — so frontend/backend drift detection
// silently vanishes for that route. Advisory, not a failure: a raw Response is sometimes intended
// (redirects, files, streams). Fix is to return a plain object, or declare `{ response: t.… }` to type it.
const RESPONSE_RETURN = /(?:=>\s*|return\s+)(?:new\s+Response|Response\s*\.\s*json)\s*\(/g

/** Scan a backend module (one that calls `server(`) for handlers returning a raw `Response`, which collapses
 * the typed client's `data` to `never`. Pure + line-accurate; returns `[]` for files with no `server(` call. */
export function scanResponseRoutes(file: string, content: string): SourceFinding[] {
  // Strip comments + template literals first: a commented-out or doc-example `return new Response(`
  // must not raise a spurious advisory. Lengths are preserved, so lineAt + the raw-line snippet align.
  const code = stripComments(content)
  if (!/(?<![.\w])server\s*\(/.test(code)) return []
  const out: SourceFinding[] = []
  const lines = content.split("\n")
  RESPONSE_RETURN.lastIndex = 0
  for (let m = RESPONSE_RETURN.exec(code); m !== null; m = RESPONSE_RETURN.exec(code)) {
    const line = lineAt(content, m.index)
    out.push({ file, line, snippet: (lines[line - 1] ?? "").trim() })
  }
  return out
}

/** Walk the project's `.ts`/`.tsx` source (skipping deps/build/tests), calling `visit` per file.
 * Exported so `nifra doctor` ({@link ./doctor.ts}) scans the same source surface as `nifra check`. */
export async function walkSource(
  cwd: string,
  visit: (rel: string, content: string) => void,
): Promise<void> {
  for await (const rel of new Glob("**/*.{ts,tsx,mts,cts}").scan({ cwd, dot: false })) {
    if (IGNORED.test(rel)) continue
    visit(rel, await Bun.file(join(cwd, rel)).text())
  }
}

const bySite = (a: SourceFinding, b: SourceFinding): number =>
  a.file.localeCompare(b.file) || a.line - b.line

/** Collect own-API `fetch()` findings across the project (kept for back-compat + reuse). */
export async function scanProject(cwd: string): Promise<SourceFinding[]> {
  const out: SourceFinding[] = []
  await walkSource(cwd, (rel, content) => out.push(...scanFetchText(rel, content)))
  return out.sort(bySite)
}

// #7 — server-manifest drift. `server-manifest.ts` is a COMMITTED generated file (it bakes the route
// list + client-entry hash for a disk-less worker). If `routes/` changes but the manifest isn't
// regenerated, the worker serves a stale route table — a silent edge break that no other check catches.
// We diff each committed manifest's imported route files against the live `routes/` tree.

// The marker comment `generateServerManifest` emits at the top of the file — identifies a generated
// manifest unambiguously (so a user file merely named `server-manifest.ts` isn't mistaken for one).
const GENERATED_MARKER = "GENERATED by @nifrajs/web generateServerManifest"
// The first route-import specifier's prefix up to `routes/` (e.g. `./`, `../`, `./src/`) — used to
// locate the routes dir relative to the manifest, and to strip to route-relative keys.
const ROUTES_PREFIX = /["'](\.{1,2}(?:\/[^"'/]+)*?\/routes\/)[^"']+["']/
// Route file extensions discovery recognises (mirrors `@nifrajs/web/fs`'s filter).
const ROUTE_FILE_EXT = /\.(tsx|jsx|svelte|vue|mdx)$/

export interface ManifestDriftFinding {
  /** The committed server-manifest file (relative to cwd). */
  readonly file: string
  /** Route files in `routes/` missing from the manifest (stale manifest — these routes won't serve). */
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
    if (!source.includes(GENERATED_MARKER)) continue // not a generated manifest — skip
    const prefixMatch = ROUTES_PREFIX.exec(source)
    if (prefixMatch?.[1] === undefined) continue // no `routes/` imports → nothing to diff (empty app)
    const routesPrefix = prefixMatch[1]
    const manifestFiles = parseManifestRouteFiles(source, routesPrefix)
    // The routes dir sits at `<manifest dir>/<prefix>` — resolve it relative to the manifest file.
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
      continue // routes dir gone/unreadable — not a drift we can assess
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
}

/** Run the project's own `tsc --noEmit`, if TypeScript + a tsconfig are present. Never auto-installs. */
async function typecheck(cwd: string, signal?: AbortSignal): Promise<TypecheckResult> {
  const tsconfig = join(cwd, "tsconfig.json")
  const tscBin = join(cwd, "node_modules", "typescript", "bin", "tsc")
  if (!(await Bun.file(tsconfig).exists()))
    return { ran: false, ok: true, note: "no tsconfig.json" }
  if (!(await Bun.file(tscBin).exists())) {
    return { ran: false, ok: true, note: "typescript not installed (run: bun add -d typescript)" }
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

/** A single machine-readable check failure — the unit an agent (or CI) acts on. */
export interface CheckDiagnostic {
  readonly rule:
    | "typecheck"
    | "typed-client"
    | "untyped-client"
    | "server-only-import"
    | "response-route"
    | "undeclared-dependency"
    | "server-manifest-drift"
  /** `error` fails the gate (a real contract break); `warning` is advisory — surfaced to the agent but
   * does NOT fail `nifra check`, for patterns that are sometimes intentional (a route returning a raw
   * `Response`, which silently drops the typed client to `data: never` but is valid for files/redirects). */
  readonly severity: "error" | "warning"
  readonly file?: string
  readonly line?: number
  readonly message: string
  /** The canonical, rule-level fix — clean of the per-occurrence snippet, so an agent can apply it
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
   * #4.4: this is now the FULL **transitive** chain — a bounded import-resolution walk (`Bun.resolveSync`
   * from each file's dir, BFS the local module graph) follows `route → ../data → ../db → node:crypto`,
   * matching the build leak-guard's depth (`detectNodeBuiltinsInClient` in `@nifrajs/web/build`). A
   * length-2 chain (`[routeFile, specifier]`) means the route imports the sink directly. When a hop can't
   * be resolved precisely (a bare pkg, a tsconfig path alias), the walk degrades to the honest direct
   * edge rather than fabricating a deeper path — never a lie.
   */
  readonly chain?: readonly string[]
}

export interface CheckSuggestion {
  readonly kind: "edit" | "command" | "manual"
  readonly title: string
  readonly diff?: string
  /** argv array, not a shell string, so MCP clients can run it without quoting hazards. */
  readonly command?: readonly string[]
  readonly steps?: readonly string[]
}

/** The structured result of a full check — what `--json` prints and the `nifra_check` MCP tool returns. */
export interface CheckResult {
  readonly ok: boolean
  readonly typecheck: "pass" | "fail" | "skipped"
  readonly diagnostics: readonly CheckDiagnostic[]
}

const UNTYPED_CLIENT_HINT =
  'client("…") without a type argument — write client<typeof app>("…") (or client(contract, url)) so the compiler can catch drift'
const FETCH_HINT =
  "hand-rolled fetch() to your own API — call it through client<typeof app> (from @nifrajs/client) so the compiler catches drift"
const SERVER_IMPORT_HINT =
  "server-only import in a route module (bundled for the browser) — reach it via c.db / ctx.api inside a loader, never a top-level import"
const RESPONSE_ROUTE_HINT =
  "route handler returns a raw Response — the typed client infers `data: never`, so drift detection is lost for this route. Return a plain object (it's serialized for you), or add `{ response: t.… }` to the route if a raw Response is intended (file/redirect/stream)"
const UNDECLARED_DEP_HINT =
  "imported package is not declared in package.json dependencies — run bun add to declare it"
const MANIFEST_DRIFT_HINT =
  "server-manifest.ts is out of sync with routes/ — re-run the build to regenerate it (a disk-less worker bakes this route table, so the drift is a silent edge break), then commit it"

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
  // ../db → node:crypto`) and which module to cut — not just the route's own top-level import.
  const chainStep =
    chain.length > 2
      ? fallback
        ? `Server-only code reaches this route through \`${chain.join(" → ")}\` (the deeper chain couldn't be resolved precisely — trace it from \`${specifier}\`).`
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
      "If this route must return a raw Response (redirect, file, stream), declare an explicit response schema or accept the warning.",
    ],
  }
}

/** Run the three checks and assemble a structured, machine-readable result. The single source the CLI
 * report, `--json`, and the MCP tool all render from. */
export async function collectCheckResult(
  cwd: string,
  opts: { readonly lintsOnly?: boolean; readonly signal?: AbortSignal } = {},
): Promise<CheckResult> {
  const fetches: SourceFinding[] = []
  const staticRoutes: StaticRouteFinding[] = []
  const untypedClients: SourceFinding[] = []
  const serverImports: TransitiveServerImportFinding[] = []
  const responseRoutes: SourceFinding[] = []
  // Route modules (rel + content) collected during the walk, so the TRANSITIVE server-only resolution
  // (#4.4) — which needs fs-backed import resolution, not just per-file text — runs after the walk.
  const routeModules: Array<{ rel: string; content: string }> = []
  // lintsOnly: skip the tsc pass (seconds on a big project) and run just the near-instant source
  // lints — the agent inner-loop mode; the full gate stays the definition of done.
  const [tc, _, dr, manifestDrift] = await Promise.all([
    opts.lintsOnly
      ? Promise.resolve<TypecheckResult>({ ran: false, ok: true, note: "skipped (lintsOnly)" })
      : typecheck(cwd, opts.signal),
    walkSource(cwd, (rel, content) => {
      fetches.push(...scanFetchText(rel, content))
      staticRoutes.push(...scanStaticRouteText(rel, content))
      untypedClients.push(...scanUntypedClient(rel, content))
      if (ROUTE_FILE.test(rel)) routeModules.push({ rel, content })
      responseRoutes.push(...scanResponseRoutes(rel, content))
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
      // deeper hops the walk takes (it carries resolved absolute paths) — resolve the dir for each.
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
    serverImports.push(...resolveServerOnlyChains(rel, content, resolveModule, readModule))
  }

  const diagnostics: CheckDiagnostic[] = []
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
      message: `${f.snippet} — ${FETCH_HINT}`,
      fix: FETCH_HINT,
      suggestion: ownFetchSuggestion(f, routes),
    })
  }
  for (const f of untypedClients.sort(bySite)) {
    diagnostics.push({
      rule: "untyped-client",
      severity: "error",
      file: f.file,
      line: f.line,
      message: `${f.snippet} — ${UNTYPED_CLIENT_HINT}`,
      fix: UNTYPED_CLIENT_HINT,
      suggestion: untypedClientSuggestion(f),
    })
  }
  for (const f of serverImports.sort(bySite)) {
    // #4.4: the FULL transitive chain the import-resolution walk found — `route → ../data → ../db →
    // node:crypto`, matching the build leak-guard's depth — instead of just the direct edge. The chain's
    // tail is the actual server-only sink; the head is the route. When a precise resolve wasn't possible
    // (a bare pkg / path alias), `fallback` is set and the chain degrades to the honest direct edge.
    const chain = f.chain
    const sink = chain[chain.length - 1] ?? f.specifier
    diagnostics.push({
      rule: "server-only-import",
      severity: "error",
      file: f.file,
      line: f.line,
      message: `${f.snippet} — server-only "${sink}" reaches the browser bundle via ${chain.join(" → ")}${f.fallback ? " (direct edge — couldn't resolve the transitive chain precisely)" : ""}; ${SERVER_IMPORT_HINT}`,
      fix: SERVER_IMPORT_HINT,
      chain,
      suggestion: serverImportSuggestion(f.specifier, chain, f.fallback),
    })
  }
  // Advisory — surfaced but NOT folded into `ok`, so it never fails the gate (a raw Response is valid).
  for (const f of responseRoutes.sort(bySite)) {
    diagnostics.push({
      rule: "response-route",
      severity: "warning",
      file: f.file,
      line: f.line,
      message: `${f.snippet} — ${RESPONSE_ROUTE_HINT}`,
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
        message: `imports ${f.package} which is not declared in package.json — ${UNDECLARED_DEP_HINT}`,
        fix: `add ${f.package} to package.json dependencies`,
        suggestion: {
          kind: "command",
          title: `Declare ${f.package} in package.json`,
          command: ["bun", "add", f.package],
        },
      })
    }
  }
  // #7: a committed server-manifest.ts that drifted from routes/ — name the exact missing/extra routes.
  for (const f of manifestDrift) {
    const parts: string[] = []
    if (f.missing.length > 0) parts.push(`missing from manifest: ${f.missing.join(", ")}`)
    if (f.extra.length > 0) parts.push(`stale in manifest: ${f.extra.join(", ")}`)
    diagnostics.push({
      rule: "server-manifest-drift",
      severity: "error",
      file: f.file,
      message: `${f.file} drifted from routes/ (${parts.join("; ")}) — ${MANIFEST_DRIFT_HINT}`,
      fix: MANIFEST_DRIFT_HINT,
      suggestion: {
        kind: "manual",
        title: "Regenerate the committed server manifest",
        steps: [
          "Re-run your build (`nifra build --target <t>` or your build script) — it regenerates server-manifest.ts from the current routes/.",
          "Commit the updated server-manifest.ts.",
        ],
      },
    })
  }

  return {
    ok:
      tc.ok &&
      fetches.length === 0 &&
      untypedClients.length === 0 &&
      serverImports.length === 0 &&
      manifestDrift.length === 0 &&
      (!dr.ran || dr.findings.length === 0),
    typecheck: tc.ran ? (tc.ok ? "pass" : "fail") : "skipped",
    diagnostics,
  }
}

/** Run the full check; print a report (`--json` for machine output) and return whether it passed. */
export async function runCheck(
  cwd: string,
  opts: { readonly json?: boolean; readonly lintsOnly?: boolean } = {},
): Promise<boolean> {
  const result = await collectCheckResult(cwd, { lintsOnly: opts.lintsOnly ?? false })
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2))
    return result.ok
  }

  console.log("nifra check\n")
  console.log(
    result.typecheck === "pass"
      ? "✓ typecheck passed"
      : result.typecheck === "fail"
        ? "✗ typecheck failed — the frontend/backend contract is broken"
        : "• typecheck skipped (no tsconfig / typescript not installed)",
  )
  const counts = (rule: CheckDiagnostic["rule"]): CheckDiagnostic[] =>
    result.diagnostics.filter((d) => d.rule === rule)
  for (const [rule, label] of [
    ["typecheck", "typecheck"],
    ["typed-client", "hand-rolled fetch() to your own API"],
    ["untyped-client", 'client("…") missing its <typeof app> type argument'],
    ["server-only-import", "server-only import in a route module"],
    ["response-route", "route returns a raw Response (typed client → data: never)"],
    ["undeclared-dependency", "undeclared dependency in package.json"],
    ["server-manifest-drift", "server-manifest.ts drifted from routes/"],
  ] as const) {
    const ds = counts(rule)
    if (rule === "response-route") {
      // Advisory: surfaced with ⚠, never folded into pass/fail.
      console.log(ds.length === 0 ? `✓ ${label}: none` : `⚠ ${label}: ${ds.length} (advisory)`)
    } else if (rule !== "typecheck") {
      console.log(ds.length === 0 ? `✓ ${label}: none` : `✗ ${label}: ${ds.length}`)
    }
    for (const d of ds) {
      console.log(`    ${d.file ?? ""}${d.line ? `:${d.line}` : ""}  ${d.message}`)
      if (d.suggestion !== undefined) {
        console.log(`      fix: ${d.suggestion.title}`)
        if (d.suggestion.command !== undefined) {
          console.log(`      command: ${d.suggestion.command.join(" ")}`)
        }
        if (d.suggestion.diff !== undefined) {
          console.log(
            d.suggestion.diff
              .split("\n")
              .map((line) => `      ${line}`)
              .join("\n"),
          )
        }
        for (const step of d.suggestion.steps ?? []) console.log(`      - ${step}`)
      }
    }
  }
  console.log(result.ok ? "\n✓ check passed" : "\n✗ check failed")
  return result.ok
}

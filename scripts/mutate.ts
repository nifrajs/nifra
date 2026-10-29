/**
 * Mutation testing for the workspace packages. Each mutant is one small deliberate break in a source
 * file; a mutant that no test notices (a survivor) marks behaviour the tests do not pin down.
 *
 *   bun scripts/mutate.ts --files packages/core/src/server/response-contract-lane.ts
 *   bun scripts/mutate.ts --changed origin/main
 *
 * `--changed [base]` mutates only the lines changed since the merge base with `base` (default
 * `origin/main`), including uncommitted edits. Other flags: `--out <dir>` (default `.mutation`),
 * `--equivalents <file>`, `--timeout <ms>` per test run, `--max-minutes <n>` (mutants left when it runs
 * out are reported as not run), `--bail` (stop each run at its first failing test; faster, but the kill
 * matrix then names only that test), `--dry-run` (list mutants and selected tests, run nothing).
 *
 * Tests are chosen by a static import scan: every test file of a `packages/<name>/test` suite that
 * `bun run test` runs and that imports the source file, directly or transitively. A test that reaches
 * the file another way, through a spawned process or a built `dist/`, is not selected.
 *
 * `--target <name>` mutates the whole files a `mutation-targets.json` entry lists against its own tests
 * instead (invariant suites included), and refuses to start while a variable its tests skip without is
 * unset. `--shard i/n` runs every n-th mutant from the i-th. `--gate` exits 1 on a survivor
 * `mutation-baseline.json` does not list, on a listed one a test now kills, on an entry that matches no
 * mutant, and on tests that fail with no mutant in place, so the baseline of known survivors only
 * shrinks. `--baseline-from <dir...>` writes that baseline from the `survivors.json` of earlier runs.
 *
 * A mutant judged equivalent (no observable change) goes in `mutation-equivalents.json`, keyed by file,
 * operator, enclosing function and source text rather than by line number, so it is triaged once and
 * stays triaged when the code above it moves. The score leaves equivalents out. A test run that times
 * out or crashes counts as a kill.
 *
 * The mutated file is restored after every run, in `finally` and on SIGINT/SIGTERM. The run exits 3 if
 * the git status at the end differs from the status at the start.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import ts from "typescript"
import { codeUnitOrder } from "./code-unit-order.ts"

export interface Mutant {
  readonly id: number
  readonly op: string
  readonly line: number
  readonly endLine: number
  readonly start: number
  readonly end: number
  readonly to: string
  /** Innermost named function, `Class.method` for a class member, `<module>` at top level. */
  readonly fn: string
  /** The trimmed source line the mutant starts on. */
  readonly code: string
  /** The replaced source text, whitespace collapsed and cut to `SNIPPET_MAX` characters. */
  readonly from: string
  /** Index among this file's mutants that share op, fn, code and from, in source order. */
  readonly nth: number
}

export interface EquivalentEntry {
  readonly op: string
  readonly fn: string
  readonly code: string
  readonly from: string
  readonly nth?: number
  readonly reason: string
}

export type Equivalents = Readonly<Record<string, readonly EquivalentEntry[]>>

/** A known survivor in `mutation-baseline.json`, keyed like an equivalent: a gap `--gate` tolerates until a test kills it. */
export type BaselineEntry = Omit<EquivalentEntry, "reason">

export type Baseline = Readonly<Record<string, readonly BaselineEntry[]>>

export type Status = "killed" | "timeout" | "error" | "survived" | "equivalent" | "not-run"

export interface MutantResult extends Mutant {
  readonly status: Status
  readonly killedBy: readonly string[]
  readonly ms?: number
  readonly reason?: string
}

const SNIPPET_MAX = 120

const BINARY: Readonly<Record<string, readonly string[]>> = {
  "===": ["!=="],
  "!==": ["==="],
  "==": ["!="],
  "!=": ["=="],
  "<": ["<="],
  "<=": ["<"],
  ">": [">="],
  ">=": [">"],
  "&&": ["||"],
  "||": ["&&"],
  "??": ["&&"],
  "+": ["-"],
  "-": ["+"],
  "*": ["/"],
  "/": ["*"],
}

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim()

// Postgres reads any run of these characters as one operator, so a comparison is swapped only where it
// stands alone: inside `@>`, `<@` or `~=` a swap makes SQL that does not parse.
const OPERATOR_CHARS = "-+*/<>=~!@#%^&|`?"
const alone = (op: string, alsoBefore = ""): RegExp =>
  new RegExp(`(?<![${OPERATOR_CHARS}${alsoBefore}])${op}(?![${OPERATOR_CHARS}])`, "g")

/**
 * Swaps in the SQL a tagged template sends, which the TypeScript operators above never reach: a
 * query's privilege checks and filters are its predicates, not the code around it.
 */
const SQL_RULES: ReadonlyArray<readonly [string, RegExp, (match: string) => string]> = [
  ["sql AND->OR", /\bAND\b/g, () => "OR"],
  ["sql OR->AND", /\bOR\b/g, () => "AND"],
  ["sql drop NOT", /\bNOT\s+/g, () => ""],
  ["sql =-><>", alone("=", ":"), () => "<>"],
  ["sql <>->=", alone("<>"), () => "="],
  ["sql IS DISTINCT->IS NOT DISTINCT", /\bIS DISTINCT FROM\b/g, () => "IS NOT DISTINCT FROM"],
  ["sql IN->NOT IN", /(?<!\bNOT\s)\bIN\s*\(/g, (match) => `NOT ${match}`],
  ["sql EXISTS->NOT EXISTS", /(?<!\bNOT\s)\bEXISTS\s*\(/g, (match) => `NOT ${match}`],
  ["sql >->>=", alone(">"), () => ">="],
  ["sql <-><=", alone("<"), () => "<="],
  ["sql flip boolean", /\b(?:true|false)\b/g, (match) => (match === "true" ? "false" : "true")],
  // A leading "~" changes the first character too, which is all a Postgres "char" keeps of a literal.
  ["sql literal", /'[^'\n]*'/g, (match) => `'~${match.slice(1)}`],
]
const SQL_TEXT = /\bSELECT\b/
// Quoted text and comments are left whole; only the literal rule edits a quoted string.
const SQL_OPAQUE = /'[^'\n]*'|"[^"\n]*"|--[^\n]*/g

function inType(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) if (ts.isTypeNode(p)) return true
  return false
}

function isFunctionValue(node: ts.Node | undefined): boolean {
  return node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
}

function scopeName(node: ts.Node, sf: ts.SourceFile): string | undefined {
  const member = (name: string) => {
    const owner = node.parent
    return ts.isClassLike(owner) && owner.name !== undefined ? `${owner.name.text}.${name}` : name
  }
  if (ts.isConstructorDeclaration(node)) return member("constructor")
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    node.name !== undefined
  )
    return member(node.name.getText(sf))
  if (
    (ts.isVariableDeclaration(node) ||
      ts.isPropertyAssignment(node) ||
      ts.isPropertyDeclaration(node)) &&
    isFunctionValue(node.initializer)
  )
    return member(node.name.getText(sf))
  return undefined
}

/**
 * Every mutant of one file, in source order: comparison, logical and arithmetic operator swaps, `!`
 * removal, `++`/`--` swaps, boolean flips, conditions forced true and false, statement deletion,
 * `return X` replaced by `return undefined`, and {@link SQL_RULES} inside a tagged template whose
 * text holds a `SELECT`.
 */
export function generateMutants(file: string, text: string): Mutant[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
  const lines = text.split("\n")
  const seen = new Map<string, number>()
  const mutants: Mutant[] = []
  let fn = "<module>"
  const span = (op: string, start: number, end: number, to: string) => {
    const original = text.slice(start, end)
    if (original === to) return
    const line = sf.getLineAndCharacterOfPosition(start).line + 1
    const code = collapse(lines[line - 1] ?? "")
    const from = collapse(original).slice(0, SNIPPET_MAX)
    const key = JSON.stringify([op, fn, code, from])
    const nth = seen.get(key) ?? 0
    seen.set(key, nth + 1)
    const endLine = sf.getLineAndCharacterOfPosition(end).line + 1
    mutants.push({ id: mutants.length, op, line, endLine, start, end, to, fn, code, from, nth })
  }
  const add = (op: string, node: ts.Node, to: string) =>
    span(op, node.getStart(sf), node.getEnd(), to)
  const sql = (template: ts.TemplateLiteral) => {
    const pieces = ts.isNoSubstitutionTemplateLiteral(template)
      ? [template]
      : [template.head, ...template.templateSpans.map((s) => s.literal)]
    if (!SQL_TEXT.test(pieces.map((piece) => piece.getText(sf)).join(" "))) return
    for (const piece of pieces) {
      const offset = piece.getStart(sf)
      const body = piece.getText(sf)
      const opaque = [...body.matchAll(SQL_OPAQUE)].map((m) => {
        const at = m.index ?? 0
        return { at, end: at + m[0].length, comment: m[0].startsWith("--") }
      })
      const found: Array<readonly [number, string, string, string]> = []
      for (const [op, pattern, to] of SQL_RULES) {
        for (const m of body.matchAll(pattern)) {
          const at = m.index ?? 0
          const inside = opaque.find((o) => at >= o.at && at < o.end)
          if (op === "sql literal" ? inside?.comment !== false : inside !== undefined) continue
          found.push([at, op, m[0], to(m[0])])
        }
      }
      found.sort((a, b) => a[0] - b[0])
      for (const [at, op, match, to] of found) span(op, offset + at, offset + at + match.length, to)
    }
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node)
    )
      return
    if (ts.isTaggedTemplateExpression(node)) sql(node.template)
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.getText(sf)
      for (const to of BINARY[op] ?? []) add(`binary ${op}->${to}`, node.operatorToken, to)
    }
    if (ts.isPrefixUnaryExpression(node)) {
      const operand = node.operand.getText(sf)
      if (node.operator === ts.SyntaxKind.ExclamationToken) add("drop !", node, operand)
      if (node.operator === ts.SyntaxKind.PlusPlusToken) add("++x->--x", node, `--${operand}`)
      if (node.operator === ts.SyntaxKind.MinusMinusToken) add("--x->++x", node, `++${operand}`)
    }
    if (ts.isPostfixUnaryExpression(node)) {
      const operand = node.operand.getText(sf)
      if (node.operator === ts.SyntaxKind.PlusPlusToken) add("x++->x--", node, `${operand}--`)
      if (node.operator === ts.SyntaxKind.MinusMinusToken) add("x--->x++", node, `${operand}++`)
    }
    if (
      (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) &&
      !inType(node)
    )
      add("flip boolean", node, node.kind === ts.SyntaxKind.TrueKeyword ? "false" : "true")
    const condition =
      ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)
        ? node.expression
        : ts.isConditionalExpression(node)
          ? node.condition
          : ts.isForStatement(node)
            ? node.condition
            : undefined
    if (condition !== undefined) {
      add("condition->true", condition, "true")
      add("condition->false", condition, "false")
    }
    if (ts.isExpressionStatement(node)) add("delete statement", node, ";")
    // A bare identifier is left alone: `return value` is as often `undefined` already as not.
    if (
      ts.isReturnStatement(node) &&
      node.expression !== undefined &&
      !ts.isIdentifier(node.expression)
    )
      add("return undefined", node, "return undefined")
    const outer = fn
    fn = scopeName(node, sf) ?? fn
    ts.forEachChild(node, visit)
    fn = outer
  }
  visit(sf)
  return mutants
}

/** The new-side line numbers each file gained or changed in a `git diff -U0` patch. */
export function parseChangedLines(diff: string): Map<string, Set<number>> {
  const changed = new Map<string, Set<number>>()
  let lines: Set<number> | undefined
  for (const row of diff.split("\n")) {
    if (row.startsWith("+++ ")) {
      const path = row.slice(4).replace(/^"(.*)"$/, "$1")
      lines = undefined
      if (!path.startsWith("b/")) continue
      lines = changed.get(path.slice(2)) ?? new Set()
      changed.set(path.slice(2), lines)
      continue
    }
    const hunk = lines === undefined ? null : /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(row)
    if (hunk === null || lines === undefined) continue
    const first = Number(hunk[1])
    const count = hunk[2] === undefined ? 1 : Number(hunk[2])
    for (let line = first; line < first + count; line++) lines.add(line)
  }
  for (const [path, set] of changed) if (set.size === 0) changed.delete(path)
  return changed
}

/** Mutants whose replaced text touches at least one of `lines`. */
export function onLines(mutants: readonly Mutant[], lines: ReadonlySet<number>): Mutant[] {
  return mutants.filter((m) => {
    for (let line = m.line; line <= m.endLine; line++) if (lines.has(line)) return true
    return false
  })
}

const keyOf = (
  entry: Pick<Mutant, "op" | "fn" | "code" | "from"> & { readonly nth?: number },
): string => JSON.stringify([entry.op, entry.fn, entry.code, entry.from, entry.nth ?? 0])

/** The entry each mutant matches, by mutant id; `unused` lists entries no mutant matched. */
export function matchEntries<T extends BaselineEntry>(
  mutants: readonly Mutant[],
  entries: readonly T[],
): { readonly matched: Map<number, T>; readonly unused: T[] } {
  const byKey = new Map(entries.map((entry) => [keyOf(entry), entry]))
  const matched = new Map<number, T>()
  const used = new Set<string>()
  for (const m of mutants) {
    const key = keyOf(m)
    const entry = byKey.get(key)
    if (entry === undefined) continue
    matched.set(m.id, entry)
    used.add(key)
  }
  return { matched, unused: entries.filter((entry) => !used.has(keyOf(entry))) }
}

/** The reason each equivalent mutant was recorded with, by mutant id; `unused` lists entries no mutant matched. */
export function matchEquivalents(
  mutants: readonly Mutant[],
  entries: readonly EquivalentEntry[],
): { readonly reasons: Map<number, string>; readonly unused: EquivalentEntry[] } {
  const { matched, unused } = matchEntries(mutants, entries)
  return { reasons: new Map([...matched].map(([id, entry]) => [id, entry.reason])), unused }
}

/** The `mutation-equivalents.json` entry a survivor would be recorded with, reason left to the triager. */
export function equivalentEntry(m: Mutant): EquivalentEntry {
  const { op, fn, code, from, nth } = m
  return nth === 0 ? { op, fn, code, from, reason: "" } : { op, fn, code, from, nth, reason: "" }
}

const fieldOf = (entry: unknown, name: string): unknown =>
  typeof entry === "object" && entry !== null ? Reflect.get(entry, name) : undefined

function textOf(entry: unknown, name: string, where: string): string {
  const value = fieldOf(entry, name)
  if (typeof value !== "string") throw new Error(`${where} lacks ${name}`)
  return value
}

function keyedEntryOf(entry: unknown, where: string): BaselineEntry {
  const text = (name: string) => textOf(entry, name, where)
  const parsed = { op: text("op"), fn: text("fn"), code: text("code"), from: text("from") }
  const nth = fieldOf(entry, "nth")
  if (nth === undefined) return parsed
  if (typeof nth !== "number" || !Number.isSafeInteger(nth) || nth < 1)
    throw new Error(`${where} has an nth that is not a positive integer`)
  return { ...parsed, nth }
}

function entryOf(entry: unknown, where: string): EquivalentEntry {
  const parsed = keyedEntryOf(entry, where)
  const reason = textOf(entry, "reason", where)
  if (reason.trim() === "") throw new Error(`${where} gives no reason`)
  return { ...parsed, reason }
}

function loadKeyed<T>(
  path: string,
  parse: (entry: unknown, where: string) => T,
): Record<string, T[]> {
  if (!existsSync(path)) return {}
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`${path}: expected an object keyed by file`)
  const keyed: Record<string, T[]> = {}
  for (const [file, entries] of Object.entries(parsed)) {
    if (!Array.isArray(entries)) throw new Error(`${path}: ${file} must list entries`)
    keyed[file] = entries.map((entry: unknown) => parse(entry, `${path}: an entry for ${file}`))
  }
  return keyed
}

export function loadEquivalents(path: string): Equivalents {
  return loadKeyed(path, entryOf)
}

export function loadBaseline(path: string): Baseline {
  return loadKeyed(path, keyedEntryOf)
}

/** One baseline from the `survivors.json` of every shard's run, files and entries in a stable order. */
export function mergeSurvivors(
  lists: readonly Readonly<
    Record<string, readonly (BaselineEntry & { readonly reason?: string })[]>
  >[],
): Baseline {
  const merged = new Map<string, Map<string, BaselineEntry>>()
  for (const list of lists)
    for (const [file, entries] of Object.entries(list)) {
      const byKey = merged.get(file) ?? new Map<string, BaselineEntry>()
      merged.set(file, byKey)
      for (const entry of entries) {
        const { op, fn, code, from, nth } = entry
        byKey.set(
          keyOf(entry),
          nth === undefined ? { op, fn, code, from } : { op, fn, code, from, nth },
        )
      }
    }
  return Object.fromEntries(
    [...merged]
      .sort(([a], [b]) => codeUnitOrder(a, b))
      .map(([file, byKey]) => [
        file,
        [...byKey].sort(([a], [b]) => codeUnitOrder(a, b)).map(([, entry]) => entry),
      ]),
  )
}

/** A nightly target in `mutation-targets.json`: whole files, the tests that guard them, and the variables those tests need. */
export interface MutationTarget {
  readonly files: readonly string[]
  readonly tests: readonly string[]
  /** Variables a test skips without, such as a live server's URL: the run refuses to start unset. */
  readonly env: readonly string[]
}

export function loadTargets(path: string): Readonly<Record<string, MutationTarget>> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`${path}: expected an object keyed by target`)
  const strings = (value: unknown, where: string): string[] => {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
      throw new Error(`${where} must list strings`)
    return value
  }
  const targets: Record<string, MutationTarget> = {}
  for (const [name, target] of Object.entries(parsed)) {
    const where = `${path}: ${name}`
    const files = strings(fieldOf(target, "files"), `${where} files`)
    const tests = strings(fieldOf(target, "tests"), `${where} tests`)
    if (files.length === 0 || tests.length === 0) throw new Error(`${where} needs files and tests`)
    const env = fieldOf(target, "env")
    targets[name] = { files, tests, env: env === undefined ? [] : strings(env, `${where} env`) }
  }
  return targets
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  quot: '"',
  lt: "<",
  gt: ">",
}
const decode = (text: string): string =>
  text.replace(/&(amp|apos|quot|lt|gt|#(\d+));/g, (_, name: string, code?: string) =>
    code === undefined ? (ENTITIES[name] ?? "") : String.fromCharCode(Number(code)),
  )

export interface TestCase {
  readonly id: string
  readonly failed: boolean
}

/** Test cases of a `bun test --reporter=junit` report, each `file:line name`. */
export function parseJunit(xml: string): TestCase[] {
  const cases: TestCase[] = []
  const pattern = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g
  for (const match of xml.matchAll(pattern)) {
    const attrs = match[1] ?? ""
    const attr = (name: string) => decode(new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? "")
    const body = match[3] ?? ""
    cases.push({
      id: `${attr("file")}:${attr("line")} ${attr("name")}`,
      failed: body.includes("<failure") || body.includes("<error"),
    })
  }
  return cases
}

/** The count in bun's `N errors` summary line: errors thrown outside any test, which junit does not list. */
export function errorCount(output: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes
  const plain = output.replace(/\u001b\[[0-9;]*m/g, "")
  return Number(/^\s*(\d+)\s+errors?\b/m.exec(plain)?.[1] ?? 0)
}

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"])

/** Module specifiers a file loads at runtime: static imports and re-exports, `import()` and `require()`. */
export function importsOf(file: string, text: string): string[] {
  const kind = /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind)
  const specifiers: string[] = []
  const literal = (node: ts.Node | undefined) => {
    if (
      node !== undefined &&
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    )
      specifiers.push(node.text)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      const typeOnly =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined &&
            clause.namedBindings !== undefined &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every((element) => element.isTypeOnly)))
      if (!typeOnly) literal(node.moduleSpecifier)
      return
    }
    if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly) literal(node.moduleSpecifier)
      return
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
      literal(node.moduleReference.expression)
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require")
      )
        literal(node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return specifiers
}

/** Runtime import edges from `entries` outward, limited to repo files outside `node_modules`. */
export function buildImportGraph(root: string, entries: readonly string[]): Map<string, string[]> {
  const graph = new Map<string, string[]>()
  const inRepo = `${root}${sep}`
  const pending = [...entries]
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (graph.has(file)) continue
    const edges: string[] = []
    graph.set(file, edges)
    if (!CODE_EXTENSIONS.has(extname(file)) || file.endsWith(".d.ts")) continue
    for (const specifier of new Set(importsOf(file, readFileSync(file, "utf8")))) {
      let target: string
      try {
        target = realpathSync(Bun.resolveSync(specifier, dirname(file)))
      } catch {
        continue
      }
      if (!target.startsWith(inRepo) || target.includes(`${sep}node_modules${sep}`)) continue
      edges.push(target)
      if (!graph.has(target)) pending.push(target)
    }
  }
  return graph
}

/** Tests that reach `target` through the graph, nearest import chain first. */
export function selectTests(
  graph: ReadonlyMap<string, readonly string[]>,
  tests: ReadonlySet<string>,
  target: string,
): Array<{ readonly file: string; readonly depth: number }> {
  const importers = new Map<string, string[]>()
  for (const [file, edges] of graph)
    for (const edge of edges) {
      const list = importers.get(edge)
      if (list === undefined) importers.set(edge, [file])
      else list.push(file)
    }
  const depth = new Map([[target, 0]])
  const queue = [target]
  // The array iterator reads the length on every step, so importers pushed here are visited too.
  for (const file of queue) {
    for (const importer of importers.get(file) ?? []) {
      if (depth.has(importer)) continue
      depth.set(importer, (depth.get(file) ?? 0) + 1)
      queue.push(importer)
    }
  }
  return [...depth]
    .filter(([file]) => tests.has(file))
    .map(([file, d]) => ({ file, depth: d }))
    .sort((a, b) => a.depth - b.depth || codeUnitOrder(a.file, b.file))
}

const TEST_FILE = /(\.|_)(test|spec)\.[cm]?[jt]sx?$/

/** Test files of the `packages/<name>/test` suites that the root `test` and `test:rest` scripts run. */
export function discoverTests(root: string): string[] {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  const scripts = [pkg.scripts?.test, pkg.scripts?.["test:rest"]]
    .filter((s) => typeof s === "string")
    .join(" ")
  const suites = new Set(
    scripts
      .split(/\s+/)
      .map((arg) => arg.replace(/\/$/, ""))
      .filter((arg) => /^packages\/[^/]+\/test(\/|$)/.test(arg)),
  )
  const bunfigPath = join(root, "bunfig.toml")
  const bunfig: unknown = existsSync(bunfigPath)
    ? Bun.TOML.parse(readFileSync(bunfigPath, "utf8"))
    : {}
  const section: unknown =
    typeof bunfig === "object" && bunfig !== null ? Reflect.get(bunfig, "test") : undefined
  const patterns: unknown =
    typeof section === "object" && section !== null
      ? Reflect.get(section, "pathIgnorePatterns")
      : []
  const ignored = (Array.isArray(patterns) ? patterns : [])
    .filter((pattern): pattern is string => typeof pattern === "string")
    .map((pattern) => new Bun.Glob(pattern))
  const found = new Set<string>()
  for (const suite of suites) {
    const files = TEST_FILE.test(suite)
      ? [suite]
      : [...new Bun.Glob(`${suite}/**/*`).scanSync({ cwd: root })].map((file) =>
          file.split(sep).join("/"),
        )
    for (const file of files) {
      if (!TEST_FILE.test(file) || file.includes("/node_modules/") || /\/\.tmp-/.test(file))
        continue
      if (ignored.some((glob) => glob.match(file))) continue
      if (existsSync(join(root, file))) found.add(join(root, file))
    }
  }
  return [...found].sort(codeUnitOrder)
}

const MUTABLE_SOURCE = /^packages\/[^/]+\/src\/.+\.(ts|tsx|mts)$/

interface Options {
  readonly files: readonly string[]
  readonly changed: string | undefined
  readonly target: string | undefined
  readonly targets: string
  readonly shard: { readonly index: number; readonly count: number } | undefined
  readonly out: string
  readonly equivalents: string
  readonly baseline: string
  readonly baselineFrom: readonly string[]
  readonly gate: boolean
  readonly timeout: number | undefined
  readonly maxMinutes: number | undefined
  readonly bail: boolean
  readonly dryRun: boolean
}

function usage(message: string): never {
  console.error(`mutate: ${message}`)
  console.error(
    "usage: bun scripts/mutate.ts (--files <path...> | --changed [base] | --target <name> [--shard i/n] [--gate] | --baseline-from <dir...>) [--out dir] [--bail] [--dry-run]",
  )
  process.exit(2)
}

export function parseArgs(argv: readonly string[]): Options {
  const files: string[] = []
  const baselineFrom: string[] = []
  let changed: string | undefined
  let target: string | undefined
  let targets = "mutation-targets.json"
  let shard: Options["shard"]
  let out = ".mutation"
  let equivalents = "mutation-equivalents.json"
  let baseline = "mutation-baseline.json"
  let gate = false
  let timeout: number | undefined
  let maxMinutes: number | undefined
  let bail = false
  let dryRun = false
  const value = (i: number, flag: string): string => {
    const next = argv[i + 1]
    if (next === undefined || next.startsWith("--")) usage(`${flag} needs a value`)
    return next
  }
  const positive = (text: string, flag: string): number => {
    const n = Number(text)
    if (!Number.isFinite(n) || n <= 0) usage(`${flag} must be a positive number`)
    return n
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--files") {
      for (
        let next = argv[i + 1];
        next !== undefined && !next.startsWith("--");
        next = argv[++i + 1]
      )
        files.push(next)
    } else if (arg === "--baseline-from") {
      for (
        let next = argv[i + 1];
        next !== undefined && !next.startsWith("--");
        next = argv[++i + 1]
      )
        baselineFrom.push(next)
    } else if (arg === "--target") target = value(i++, arg)
    else if (arg === "--targets") targets = value(i++, arg)
    else if (arg === "--shard") {
      const parsed = /^(\d+)\/(\d+)$/.exec(value(i++, arg))
      const index = Number(parsed?.[1])
      const count = Number(parsed?.[2])
      if (parsed === null || count < 1 || index >= count) usage("--shard takes i/n with 0 <= i < n")
      shard = { index, count }
    } else if (arg === "--baseline") baseline = value(i++, arg)
    else if (arg === "--gate") gate = true
    else if (arg === "--changed") {
      const next = argv[i + 1]
      changed = next !== undefined && !next.startsWith("--") ? argv[++i] : "origin/main"
    } else if (arg === "--out") out = value(i++, arg)
    else if (arg === "--equivalents") equivalents = value(i++, arg)
    else if (arg === "--timeout") timeout = positive(value(i++, arg), arg)
    else if (arg === "--max-minutes") maxMinutes = positive(value(i++, arg), arg)
    else if (arg === "--bail") bail = true
    else if (arg === "--dry-run") dryRun = true
    else usage(`unknown argument ${arg}`)
  }
  const modes = [
    files.length > 0,
    changed !== undefined,
    target !== undefined,
    baselineFrom.length > 0,
  ]
  if (modes.filter(Boolean).length !== 1)
    usage("pass one of --files, --changed, --target and --baseline-from")
  if (shard !== undefined && target === undefined) usage("--shard needs --target")
  if (gate && target === undefined) usage("--gate needs --target")
  return {
    files,
    changed,
    target,
    targets,
    shard,
    out,
    equivalents,
    baseline,
    baselineFrom,
    gate,
    timeout,
    maxMinutes,
    bail,
    dryRun,
  }
}

function git(root: string, args: readonly string[]): string {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`)
  return result.stdout
}

interface Run {
  readonly cases: readonly TestCase[] | undefined
  readonly errors: number
  readonly timedOut: boolean
  readonly ms: number
}

let child: ChildProcess | undefined

function killChild(): void {
  if (child?.pid === undefined) return
  try {
    // The test run leads its own process group, so servers and workers it spawned go with it.
    process.kill(-child.pid, "SIGKILL")
  } catch {
    child.kill("SIGKILL")
  }
}

async function runTests(
  root: string,
  tests: readonly string[],
  junit: string,
  timeout: number,
  bail: boolean,
): Promise<Run> {
  rmSync(junit, { force: true })
  const started = performance.now()
  const args = [
    "test",
    ...tests,
    "--reporter=junit",
    `--reporter-outfile=${junit}`,
    ...(bail ? ["--bail"] : []),
  ]
  const proc = spawn(process.execPath, args, {
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  child = proc
  let output = ""
  const keep = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-65_536)
  }
  proc.stdout?.on("data", keep)
  proc.stderr?.on("data", keep)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    killChild()
  }, timeout)
  const closed = new Promise<void>((done) => proc.on("close", () => done()))
  await new Promise<void>((done) => proc.on("exit", () => done()))
  clearTimeout(timer)
  // A server a test left running would hold the output pipes open; the group goes before reading on.
  killChild()
  await closed
  // A timed-out run can leave a report half written, so nothing from it is read.
  const cases = !timedOut && existsSync(junit) ? parseJunit(readFileSync(junit, "utf8")) : undefined
  return {
    cases,
    errors: errorCount(output),
    timedOut,
    ms: Math.round(performance.now() - started),
  }
}

/** What a mutant run says against the unmutated baseline: a test that already failed there cannot kill. */
export function classify(
  baseline: { readonly cases: readonly TestCase[]; readonly errors: number },
  run: Run,
  bail: boolean,
): { readonly status: Status; readonly killedBy: string[] } {
  if (run.timedOut) return { status: "timeout", killedBy: [] }
  if (run.cases === undefined) return { status: "error", killedBy: [] }
  const passing = new Set(baseline.cases.filter((c) => !c.failed).map((c) => c.id))
  const red = new Set(baseline.cases.filter((c) => c.failed).map((c) => c.id))
  const seen = new Set(run.cases.map((c) => c.id))
  // A case that failed with the mutant but not without it kills, one a hook broke (`beforeAll`, which
  // `--bail` stops on before later files run) included: it has no baseline entry of its own.
  const failed = run.cases.filter((c) => c.failed && !red.has(c.id)).map((c) => c.id)
  // A test that vanished was in a file that no longer loads; under --bail the rest never ran.
  const vanished = bail || run.cases.length === 0 ? [] : [...passing].filter((id) => !seen.has(id))
  const killedBy = [...new Set([...failed, ...vanished])]
  if (killedBy.length > 0) return { status: "killed", killedBy }
  if (run.errors > baseline.errors)
    return { status: "killed", killedBy: ["(error outside a test)"] }
  if (run.cases.length === 0 && passing.size > 0) return { status: "error", killedBy: [] }
  return { status: "survived", killedBy: [] }
}

export interface FileReport {
  readonly file: string
  readonly tests: ReadonlyArray<{ readonly file: string; readonly depth: number }>
  readonly baselineMs: number | undefined
  readonly baselineFailures: readonly string[] | undefined
  readonly mutants: readonly MutantResult[]
  readonly unusedEquivalents: readonly EquivalentEntry[]
  /** Ids of the mutants `mutation-baseline.json` lists as known survivors. */
  readonly baselined?: readonly number[]
  readonly unusedBaseline?: readonly BaselineEntry[]
}

/** Stands in for the baseline failures when the run without a mutant wrote no report. */
const NO_REPORT = "(no report)"

const DETECTED: ReadonlySet<Status> = new Set(["killed", "timeout", "error"])

/**
 * Why `--gate` fails a run: a survivor the baseline does not list, a listed one a test kills now (the
 * baseline only shrinks), an entry that matches no mutant, a mutant left unrun, or tests that fail with
 * no mutant in place.
 */
export function gateFailures(reports: readonly FileReport[]): string[] {
  const failures: string[] = []
  for (const r of reports) {
    const known = new Set(r.baselined ?? [])
    const broken = (r.baselineFailures ?? []).length > 0
    if (broken) failures.push(`${r.file}: the tests fail with no mutant in place`)
    for (const m of r.mutants) {
      const at = `${r.file}:${m.line} ${m.op} \`${m.from}\``
      if (m.status === "survived" && !known.has(m.id)) failures.push(`${at} survives`)
      else if (DETECTED.has(m.status) && known.has(m.id)) {
        const caught = m.status === "killed" ? "killed" : `caught (${m.status})`
        failures.push(`${at} is ${caught} now: drop it from the baseline`)
      } else if (m.status === "not-run" && !broken) failures.push(`${at} did not run`)
    }
    for (const e of r.unusedBaseline ?? [])
      failures.push(`${r.file}: baseline ${e.op} \`${e.from}\` in ${e.fn} matches no mutant`)
    for (const e of r.unusedEquivalents)
      failures.push(`${r.file}: equivalent ${e.op} \`${e.from}\` in ${e.fn} matches no mutant`)
  }
  return failures
}

export function scoreOf(mutants: readonly MutantResult[]): number | undefined {
  const graded = mutants.filter((m) => m.status !== "equivalent" && m.status !== "not-run")
  if (graded.length === 0) return undefined
  return graded.filter((m) => DETECTED.has(m.status)).length / graded.length
}

const cell = (text: string, max = 80): string => {
  const cut = text.length > max ? `${text.slice(0, max - 3)}...` : text
  const fence = cut.includes("`") ? "``" : "`"
  // A table splits cells on a pipe no backslash escapes, so a backslash of the source's own, left
  // as it is, would escape the backslash added for its pipe and end the cell there.
  const escaped = cut.replace(/\\/g, "\\\\").replace(/\|/g, "\\|")
  return `${fence}${fence === "``" ? " " : ""}${escaped}${fence === "``" ? " " : ""}${fence}`
}

const SURVIVOR_ROWS = 150

export function formatSummary(
  reports: readonly FileReport[],
  heading: string,
  changedOnly = false,
): string {
  const out = ["## Mutation testing", "", heading, ""]
  if (reports.length === 0) return [...out, "No mutable source lines changed.", ""].join("\n")
  out.push(
    "| File | Mutants | Killed | Survived | Equivalent | Not run | Score |",
    "|---|---|---|---|---|---|---|",
  )
  const count = (r: FileReport, ...statuses: Status[]) =>
    r.mutants.filter((m) => statuses.includes(m.status)).length
  for (const r of reports) {
    const score = scoreOf(r.mutants)
    out.push(
      `| ${cell(r.file, 200)} | ${r.mutants.length} | ${count(r, "killed", "timeout", "error")} | ${count(r, "survived")} | ${count(r, "equivalent")} | ${count(r, "not-run")} | ${score === undefined ? "-" : `${(score * 100).toFixed(1)}%`} |`,
    )
  }
  out.push(
    "",
    "Score = killed / (mutants - equivalent - not run). A timed-out or crashed test run counts as killed.",
  )
  const untested = reports.filter((r) => r.tests.length === 0).map((r) => cell(r.file, 200))
  if (untested.length > 0)
    out.push("", `No test imports ${untested.join(", ")}: every mutant there survives.`)
  for (const r of reports) {
    const failures = r.baselineFailures ?? []
    if (failures.includes(NO_REPORT))
      out.push(
        "",
        `The selected tests for ${cell(r.file, 200)} gave no report without a mutant, so none ran.`,
      )
    else if (failures.length > 0)
      out.push(
        "",
        `${failures.length} selected tests for ${cell(r.file, 200)} already fail without a mutant; they cannot kill one.`,
      )
  }
  const stale = reports.filter((r) => r.unusedEquivalents.length > 0)
  for (const r of stale)
    out.push(
      "",
      `${r.unusedEquivalents.length} \`mutation-equivalents.json\` entries for ${cell(r.file, 200)} match no mutant any more.`,
    )
  const survivors = reports.flatMap((r) =>
    r.mutants.filter((m) => m.status === "survived").map((m) => ({ r, m })),
  )
  if (survivors.length === 0) return [...out, ""].join("\n")
  const title = changedOnly ? "Surviving mutants on changed lines" : "Surviving mutants"
  out.push("", `### ${title}`, "", "| Location | Mutation | Line | Function |", "|---|---|---|---|")
  for (const { r, m } of survivors.slice(0, SURVIVOR_ROWS))
    out.push(
      `| ${cell(`${r.file}:${m.line}`, 200)} | ${cell(m.op)} | ${cell(m.code)} | ${cell(m.fn, 40)} |`,
    )
  if (survivors.length > SURVIVOR_ROWS)
    out.push("", `${survivors.length - SURVIVOR_ROWS} more in \`survivors.json\`.`)
  out.push(
    "",
    "A survivor is a change no selected test notices. If no test could notice it, record it in `mutation-equivalents.json` with a reason; `survivors.json` in the run's output holds each survivor as a ready entry.",
    "",
  )
  return out.join("\n")
}

const elapsed = (ms: number): string => {
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`
}

async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv)
  const root = realpathSync(git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim())
  if (options.baselineFrom.length > 0) {
    const lists = options.baselineFrom.map((dir) => loadBaseline(resolve(dir, "survivors.json")))
    const merged = mergeSurvivors(lists)
    writeFileSync(resolve(root, options.baseline), `${JSON.stringify(merged, null, 2)}\n`)
    const count = Object.values(merged).reduce((n, entries) => n + entries.length, 0)
    console.log(`${options.baseline}: ${count} known survivors from ${lists.length} runs`)
    return 0
  }
  const statusBefore = git(root, ["status", "--porcelain"])
  const out = resolve(root, options.out)
  mkdirSync(out, { recursive: true })

  let targets: Array<{ readonly file: string; readonly lines: ReadonlySet<number> | undefined }>
  let heading: string
  let fixedTests: string[] | undefined
  if (options.target !== undefined) {
    const target = loadTargets(resolve(root, options.targets))[options.target]
    if (target === undefined) usage(`${options.targets} has no target ${options.target}`)
    const unset = target.env.filter((name) => (process.env[name] ?? "") === "")
    if (unset.length > 0) usage(`target ${options.target} needs ${unset.join(", ")} set`)
    for (const file of [...target.files, ...target.tests])
      if (!existsSync(join(root, file))) usage(`target ${options.target} names a missing ${file}`)
    targets = target.files.map((file) => ({ file, lines: undefined }))
    fixedTests = [...target.tests]
    const shard = options.shard
    heading = `Target \`${options.target}\`${shard === undefined ? "" : `, shard ${shard.index + 1} of ${shard.count}`}: whole files.`
  } else if (options.changed !== undefined) {
    const base = git(root, ["merge-base", options.changed, "HEAD"]).trim()
    const diff = git(root, [
      "diff",
      "-U0",
      "--no-color",
      "--no-ext-diff",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      base,
      "--",
      "packages",
    ])
    targets = [...parseChangedLines(diff)]
      .filter(
        ([file]) =>
          MUTABLE_SOURCE.test(file) && !file.endsWith(".d.ts") && existsSync(join(root, file)),
      )
      .sort(([a], [b]) => codeUnitOrder(a, b))
      .map(([file, lines]) => ({ file, lines }))
    heading = `Lines changed since \`${options.changed}\` (merge base \`${base.slice(0, 10)}\`).`
  } else {
    targets = options.files.map((file) => {
      const path = isAbsolute(file) ? file : resolve(process.cwd(), file)
      if (!existsSync(path)) usage(`no such file ${file}`)
      return { file: relative(root, realpathSync(path)).split(sep).join("/"), lines: undefined }
    })
    heading = "Whole files."
  }

  const equivalents = loadEquivalents(resolve(root, options.equivalents))
  const knownSurvivors = loadBaseline(resolve(root, options.baseline))
  const tests = discoverTests(root)
  const graph =
    targets.length === 0 || fixedTests !== undefined ? new Map() : buildImportGraph(root, tests)
  const testSet = new Set(tests)
  const deadline =
    options.maxMinutes === undefined ? Infinity : Date.now() + options.maxMinutes * 60_000
  const junit = join(out, `junit-${process.pid}.xml`)
  const reports: FileReport[] = []
  const started = Date.now()
  let exitCode = 0

  let restore: (() => void) | undefined
  const onSignal = (signal: NodeJS.Signals) => {
    killChild()
    restore?.()
    console.error(`mutate: ${signal}, restored the mutated file`)
    process.exit(signal === "SIGINT" ? 130 : 143)
  }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)

  // Shards split the mutants of every file by their order across the run; stale entries are reported by
  // the first shard alone, since every shard matches them against the whole file.
  let ordinal = 0
  const owner = options.shard === undefined || options.shard.index === 0
  for (const target of targets) {
    const path = join(root, target.file)
    const original = readFileSync(path, "utf8")
    const all = generateMutants(target.file, original)
    const mutants = (target.lines === undefined ? all : onLines(all, target.lines)).filter(
      () => options.shard === undefined || ordinal++ % options.shard.count === options.shard.index,
    )
    const { reasons, unused } = matchEquivalents(all, equivalents[target.file] ?? [])
    const known = matchEntries(all, knownSurvivors[target.file] ?? [])
    const selected =
      fixedTests === undefined
        ? selectTests(graph, testSet, path)
        : fixedTests.map((file) => ({ file: join(root, file), depth: 0 }))
    const relTests = selected.map((t) => ({
      file: relative(root, t.file).split(sep).join("/"),
      depth: t.depth,
    }))
    console.log(`${target.file}: ${mutants.length} mutants, ${selected.length} test files`)
    if (options.dryRun) {
      for (const t of relTests) console.log(`  test ${t.depth} ${t.file}`)
      for (const m of mutants)
        console.log(
          `  ${m.line} ${m.op} ${m.from.slice(0, 60)}${reasons.has(m.id) ? " (equivalent)" : ""}`,
        )
      continue
    }
    const results: MutantResult[] = []
    const report = (baselineMs?: number, baselineFailures?: string[]): FileReport => ({
      file: target.file,
      tests: relTests,
      baselineMs,
      baselineFailures,
      mutants: results,
      unusedEquivalents: target.lines === undefined && owner ? unused : [],
      baselined: mutants.filter((m) => known.matched.has(m.id)).map((m) => m.id),
      unusedBaseline: owner ? known.unused : [],
    })
    const pending = mutants.filter((m) => {
      const reason = reasons.get(m.id)
      if (reason !== undefined) results.push({ ...m, status: "equivalent", killedBy: [], reason })
      return reason === undefined
    })
    if (selected.length === 0 || pending.length === 0 || Date.now() > deadline) {
      const status = selected.length === 0 ? "survived" : "not-run"
      for (const m of pending) results.push({ ...m, status, killedBy: [] })
      reports.push(report())
      continue
    }
    const files = relTests.map((t) => t.file)
    const baseline = await runTests(root, files, junit, 15 * 60_000, false)
    if (baseline.cases === undefined) {
      console.error(`${target.file}: the run without a mutant produced no report`)
      for (const m of pending) results.push({ ...m, status: "not-run", killedBy: [] })
      reports.push(report(baseline.ms, [NO_REPORT]))
      continue
    }
    const base = { cases: baseline.cases, errors: baseline.errors }
    const baselineFailures = baseline.cases.filter((c) => c.failed).map((c) => c.id)
    const timeout = options.timeout ?? Math.max(10_000, baseline.ms * 3)
    console.log(
      `  baseline ${baseline.cases.length} tests, ${baselineFailures.length} failing, ${baseline.ms} ms`,
    )
    restore = () => writeFileSync(path, original)
    try {
      for (const [i, m] of pending.entries()) {
        if (Date.now() > deadline) {
          results.push({ ...m, status: "not-run", killedBy: [] })
          continue
        }
        writeFileSync(path, original.slice(0, m.start) + m.to + original.slice(m.end))
        let run: Run
        try {
          run = await runTests(root, files, junit, timeout, options.bail)
        } finally {
          writeFileSync(path, original)
        }
        results.push({ ...m, ...classify(base, run, options.bail), ms: run.ms })
        if ((i + 1) % 25 === 0)
          console.log(`  ${i + 1}/${pending.length} ${elapsed(Date.now() - started)}`)
      }
    } finally {
      writeFileSync(path, original)
      restore = undefined
    }
    results.sort((a, b) => a.id - b.id)
    reports.push(report(baseline.ms, baselineFailures))
  }
  rmSync(junit, { force: true })

  if (!options.dryRun) {
    const summary = formatSummary(
      reports,
      `${heading} ${elapsed(Date.now() - started)}.`,
      options.changed !== undefined,
    )
    const survivors: Record<string, EquivalentEntry[]> = {}
    for (const r of reports) {
      const list = r.mutants.filter((m) => m.status === "survived").map(equivalentEntry)
      if (list.length > 0) survivors[r.file] = list
    }
    writeFileSync(
      join(out, "kill-matrix.json"),
      `${JSON.stringify({ heading, files: reports }, null, 1)}\n`,
    )
    writeFileSync(join(out, "survivors.json"), `${JSON.stringify(survivors, null, 2)}\n`)
    const failures = options.gate ? gateFailures(reports) : []
    const verdict = !options.gate
      ? ""
      : failures.length === 0
        ? "### Gate\n\nEvery survivor is in `mutation-baseline.json`, and every entry there still survives.\n"
        : [
            `### Gate: ${failures.length} failures`,
            "",
            ...failures.slice(0, SURVIVOR_ROWS).map((failure) => `- ${failure}`),
            ...(failures.length > SURVIVOR_ROWS
              ? ["", `${failures.length - SURVIVOR_ROWS} more in \`gate.json\`.`]
              : []),
            "",
            "Kill a new survivor with a test, or record it in `mutation-equivalents.json` with a reason if no test could notice it.",
            "",
          ].join("\n")
    if (options.gate)
      writeFileSync(join(out, "gate.json"), `${JSON.stringify(failures, null, 2)}\n`)
    writeFileSync(join(out, "summary.md"), `${summary}${verdict}`)
    const step = process.env.GITHUB_STEP_SUMMARY
    if (step !== undefined && step !== "")
      writeFileSync(step, `${summary}${verdict}`, { flag: "a" })
    console.log(`\n${summary}${verdict}`)
    if (failures.length > 0) exitCode = 1
  }

  const statusAfter = git(root, ["status", "--porcelain"])
  if (statusAfter !== statusBefore) {
    console.error(`mutate: the git status changed during the run:\n${statusAfter}`)
    return 3
  }
  return exitCode
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))

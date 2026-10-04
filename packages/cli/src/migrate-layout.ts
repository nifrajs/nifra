/**
 * `nifra migrate layout` - move an app onto the frontend/backend split.
 *
 * What it does, in order:
 *   1. splits every route file: the exports only the server reads (`loader`, `action`, ...) and the code
 *      only they use move to the route's `x.backend.ts`; the frontend file keeps the rest, plus an
 *      `import type` for any moved name it still mentions in a type;
 *   2. folds each `_middleware.ts` into its directory's `_layout.backend.ts` as `middleware`;
 *   3. moves `backend.ts` to `backend/app.ts` and `framework.ts` to `backend/framework.ts`;
 *   4. moves each `x.server.ts` under `backend/` without the retired suffix, and zones every other module
 *      by who imports it at runtime: only route frontends -> `frontend/`, only the server side ->
 *      `backend/`, both -> `shared/`;
 *   5. rewrites every relative import in the app to the new locations, `@nifrajs/web/server-only` to
 *      `@nifrajs/web/backend-only`, and `ServerOnly` to `BackendOnly`.
 *
 * It is a dry run unless `write` is set, and it reports what it could not decide (a frontend that uses
 * a moved name at runtime, a helper both halves need, a loader with no output schema) instead of
 * guessing.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, extname, join, posix, relative, resolve } from "node:path"
import { BACKEND_ROUTE_EXPORTS } from "@nifrajs/web/route-manifest"
import type * as TS from "typescript"
import { codeUnitOrder } from "./internal/code-unit-order.ts"
import { importTypeScript } from "./internal/typescript-import.ts"
import { missingOutputSchemas } from "./rules/data-guard.ts"

/** Exports only the server or the build reads: `@nifrajs/web`'s route-pair contract. */
const BACKEND_EXPORTS = BACKEND_ROUTE_EXPORTS

const ROUTE_FILE = /\.(?:tsx|jsx|svelte|vue|mdx)$/
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|svelte|vue|mdx)$/
const RESOLVE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".svelte",
  ".vue",
  ".mdx",
  ".css",
  ".json",
]
const LEGACY_SERVER = /\.server(\.(?:[cm]?[jt]sx?|svelte|vue|mdx))$/
const RETIRED_SPECIFIERS: Readonly<Record<string, string>> = {
  "@nifrajs/web/server-only": "@nifrajs/web/backend-only",
}
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git", ".vite", "public"])
const ZONE_DIRS = new Set(["frontend", "backend", "shared", "routes", "public"])

export interface LayoutMigrationIssue {
  readonly file: string
  readonly reason: string
}

export interface LayoutMigrationResult {
  readonly ok: boolean
  readonly write: boolean
  /** Route files whose backend exports moved, and where they went. */
  readonly splits: ReadonlyArray<{
    readonly file: string
    readonly backend: string
    readonly moved: readonly string[]
  }>
  /** Files that moved, app-relative. */
  readonly moves: ReadonlyArray<{ readonly from: string; readonly to: string }>
  /** Files whose imports were rewritten (and were not otherwise created). */
  readonly rewritten: readonly string[]
  readonly issues: readonly LayoutMigrationIssue[]
}

export interface LayoutMigrationOptions {
  readonly write?: boolean
  /** Inject the TypeScript compiler (tests); defaults to the CLI's own. */
  readonly typescript?: typeof TS
}

/** A file's text, as the migration sees it before writing. */
type Files = Map<string, string>

const toPosix = (path: string): string => path.replaceAll("\\", "/")

/** Every first-party file under `root`, app-relative and posix. */
function listFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) out.push(toPosix(relative(root, full)))
    }
  }
  walk(root)
  return out.sort()
}

// ---------------------------------------------------------------------------------------------------
// Route splitting
// ---------------------------------------------------------------------------------------------------

interface StatementInfo {
  readonly node: TS.Statement
  /** Text including leading comments. */
  readonly text: string
  readonly declares: ReadonlySet<string>
  /** Names this statement exports, local name -> exported names. */
  readonly exports: ReadonlyMap<string, readonly string[]>
  readonly valueRefs: ReadonlySet<string>
  readonly typeRefs: ReadonlySet<string>
}

export interface SplitResult {
  readonly frontend: string
  /** `undefined` when the file exports nothing for the server. */
  readonly backend: string | undefined
  readonly moved: readonly string[]
  readonly issues: readonly string[]
}

function bindingNames(ts: typeof TS, name: TS.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(name)) into.add(name.text)
  else
    for (const element of name.elements)
      if (!ts.isOmittedExpression(element)) bindingNames(ts, element.name, into)
}

const hasModifier = (ts: typeof TS, node: TS.Node, kind: TS.SyntaxKind): boolean =>
  (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []).some((m) => m.kind === kind)

/** Identifiers a statement reads, split into value and type positions. Over-approximates on purpose:
 * an extra name only keeps a declaration in a half that did not need it. */
function references(ts: typeof TS, node: TS.Node): { value: Set<string>; type: Set<string> } {
  const value = new Set<string>()
  const type = new Set<string>()
  const visit = (current: TS.Node, inType: boolean): void => {
    const typed =
      inType ||
      ts.isTypeNode(current) ||
      (ts.isHeritageClause(current) && current.token === ts.SyntaxKind.ImplementsKeyword)
    if (ts.isIdentifier(current)) {
      const parent = current.parent
      const isName =
        parent !== undefined &&
        ((ts.isPropertyAccessExpression(parent) && parent.name === current) ||
          (ts.isPropertyAssignment(parent) && parent.name === current) ||
          (ts.isPropertySignature(parent) && parent.name === current) ||
          (ts.isPropertyDeclaration(parent) && parent.name === current) ||
          (ts.isMethodDeclaration(parent) && parent.name === current) ||
          (ts.isMethodSignature(parent) && parent.name === current) ||
          (ts.isQualifiedName(parent) && parent.right === current) ||
          (ts.isJsxAttribute(parent) && parent.name === current) ||
          (ts.isBindingElement(parent) && parent.propertyName === current) ||
          ts.isImportSpecifier(parent) ||
          ts.isExportSpecifier(parent) ||
          ts.isImportClause(parent) ||
          ts.isNamespaceImport(parent))
      if (!isName) (typed ? type : value).add(current.text)
      return
    }
    if (ts.isShorthandPropertyAssignment(current)) value.add(current.name.text)
    ts.forEachChild(current, (child) => visit(child, typed))
  }
  visit(node, false)
  return { value, type }
}

function describeStatements(ts: typeof TS, sf: TS.SourceFile): StatementInfo[] {
  return sf.statements.map((node) => {
    const declares = new Set<string>()
    const exports = new Map<string, string[]>()
    const exported = hasModifier(ts, node, ts.SyntaxKind.ExportKeyword)
    const isDefault = hasModifier(ts, node, ts.SyntaxKind.DefaultKeyword)
    const addExport = (local: string, as: string): void => {
      exports.set(local, [...(exports.get(local) ?? []), as])
    }
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      if (clause?.name) declares.add(clause.name.text)
      const bindings = clause?.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) declares.add(bindings.name.text)
      if (bindings && ts.isNamedImports(bindings))
        for (const el of bindings.elements) declares.add(el.name.text)
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        const names = new Set<string>()
        bindingNames(ts, decl.name, names)
        for (const name of names) {
          declares.add(name)
          if (exported) addExport(name, name)
        }
      }
    } else if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)
    ) {
      const name = node.name?.text
      if (name !== undefined) declares.add(name)
      if (exported) addExport(name ?? "default", isDefault ? "default" : (name ?? "default"))
    } else if (ts.isExportAssignment(node)) {
      addExport("default", "default")
    } else if (
      ts.isExportDeclaration(node) &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const el of node.exportClause.elements) {
        addExport(
          node.moduleSpecifier ? `\0${el.name.text}` : (el.propertyName ?? el.name).text,
          el.name.text,
        )
      }
    }
    const refs = ts.isImportDeclaration(node)
      ? { value: new Set<string>(), type: new Set<string>() }
      : references(ts, node)
    for (const name of declares) {
      refs.value.delete(name)
      refs.type.delete(name)
    }
    return {
      node,
      text: node.getFullText(sf),
      declares,
      exports,
      valueRefs: refs.value,
      typeRefs: refs.type,
    }
  })
}

/** Rebuild an import keeping only the bindings `keep` names. `undefined` when none remain. */
function filterImport(
  ts: typeof TS,
  sf: TS.SourceFile,
  node: TS.ImportDeclaration,
  keep: (name: string) => boolean,
): string | undefined {
  const clause = node.importClause
  const spec = node.moduleSpecifier.getText(sf)
  const attributes = node.attributes ? ` ${node.attributes.getText(sf)}` : ""
  if (clause === undefined) return node.getFullText(sf)
  const parts: string[] = []
  if (clause.name && keep(clause.name.text)) parts.push(clause.name.text)
  const bindings = clause.namedBindings
  if (bindings && ts.isNamespaceImport(bindings) && keep(bindings.name.text))
    parts.push(`* as ${bindings.name.text}`)
  if (bindings && ts.isNamedImports(bindings)) {
    const named = bindings.elements.filter((el) => keep(el.name.text)).map((el) => el.getText(sf))
    if (named.length > 0) parts.push(`{ ${named.join(", ")} }`)
  }
  if (parts.length === 0) return undefined
  const typeOnly = clause.isTypeOnly ? "type " : ""
  const leading = node.getFullText(sf).slice(0, node.getStart(sf) - node.getFullStart())
  return `${leading}import ${typeOnly}${parts.join(", ")} from ${spec}${attributes}`
}

/** Rebuild `export { a, b as c }` keeping only the exported names `keep` accepts. */
function filterExportList(
  ts: typeof TS,
  sf: TS.SourceFile,
  node: TS.ExportDeclaration,
  keep: (exported: string) => boolean,
): string | undefined {
  const clause = node.exportClause
  if (!clause || !ts.isNamedExports(clause)) return node.getFullText(sf)
  const kept = clause.elements.filter((el) => keep(el.name.text)).map((el) => el.getText(sf))
  if (kept.length === 0) return undefined
  const from = node.moduleSpecifier ? ` from ${node.moduleSpecifier.getText(sf)}` : ""
  const leading = node.getFullText(sf).slice(0, node.getStart(sf) - node.getFullStart())
  return `${leading}export ${node.isTypeOnly ? "type " : ""}{ ${kept.join(", ")} }${from}`
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const joinStatements = (texts: readonly string[]): string => {
  const body = texts.join("").replace(/^\s*\n/, "")
  return body.endsWith("\n") ? body : `${body}\n`
}

/**
 * Split one route module's source into its frontend and backend halves. `backendSpecifier` is how the
 * frontend refers to the backend half in an `import type` (`./index.backend.ts`).
 */
export function splitRouteSource(
  ts: typeof TS,
  source: string,
  fileName: string,
  backendSpecifier: string,
): SplitResult {
  const kind = fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind)
  const statements = describeStatements(ts, sf)
  const issues: string[] = []
  const exportsOf = (info: StatementInfo): string[] => [...info.exports.values()].flat()
  const isBackendStatement = (info: StatementInfo): boolean =>
    exportsOf(info).some((name) => BACKEND_EXPORTS.has(name))
  const moved = statements.flatMap(exportsOf).filter((name) => BACKEND_EXPORTS.has(name))
  if (moved.length === 0) return { frontend: source, backend: undefined, moved: [], issues: [] }

  const declaredBy = new Map<string, StatementInfo>()
  for (const info of statements) {
    if (ts.isImportDeclaration(info.node)) continue
    for (const name of info.declares) declaredBy.set(name, info)
  }

  // The backend half: its export statements plus every top-level declaration they reach.
  const backendSet = new Set<StatementInfo>()
  const queue: StatementInfo[] = statements.filter(isBackendStatement)
  for (const info of queue) backendSet.add(info)
  while (queue.length > 0) {
    const info = queue.pop() as StatementInfo
    for (const name of [...info.valueRefs, ...info.typeRefs]) {
      const target = declaredBy.get(name)
      if (target !== undefined && !backendSet.has(target)) {
        backendSet.add(target)
        queue.push(target)
      }
    }
    // An exported-name statement (`export { loader }`) reaches the declaration it names.
    for (const local of info.exports.keys()) {
      const target = declaredBy.get(local)
      if (target !== undefined && !backendSet.has(target)) {
        backendSet.add(target)
        queue.push(target)
      }
    }
  }

  // The frontend half: everything that is not a backend export statement, minus declarations that only
  // the backend half needs.
  const movedLocals = new Set<string>()
  for (const info of statements) {
    for (const [local, names] of info.exports)
      if (names.some((name) => BACKEND_EXPORTS.has(name))) movedLocals.add(local)
  }
  const frontendCandidates = statements.filter((info) => !ts.isImportDeclaration(info.node))
  const frontendKeep = new Set<StatementInfo>()
  const seed = frontendCandidates.filter(
    (info) =>
      !backendSet.has(info) ||
      (!isBackendStatement(info) && exportsOf(info).length > 0) ||
      // a statement with no declaration (a side effect) stays where it ran
      (info.declares.size === 0 && info.exports.size === 0),
  )
  const fqueue = [...seed]
  for (const info of fqueue) frontendKeep.add(info)
  while (fqueue.length > 0) {
    const info = fqueue.pop() as StatementInfo
    for (const name of info.valueRefs) {
      if (movedLocals.has(name) && !info.declares.has(name)) continue
      const target = declaredBy.get(name)
      if (target !== undefined && !frontendKeep.has(target) && !isBackendStatement(target)) {
        frontendKeep.add(target)
        fqueue.push(target)
      }
    }
    for (const name of info.typeRefs) {
      if (movedLocals.has(name)) continue
      const target = declaredBy.get(name)
      if (target !== undefined && !frontendKeep.has(target) && !isBackendStatement(target)) {
        frontendKeep.add(target)
        fqueue.push(target)
      }
    }
  }

  // A moved name the frontend still mentions: in a type it becomes `import type`; at runtime it is an
  // error the author has to resolve.
  const typeImports = new Set<string>()
  for (const info of frontendKeep) {
    if (isBackendStatement(info)) continue
    for (const name of movedLocals) {
      if (info.declares.has(name)) continue
      if (info.valueRefs.has(name))
        issues.push(`the frontend uses "${name}" at runtime, but it runs on the server only`)
      if (info.typeRefs.has(name) || info.valueRefs.has(name)) typeImports.add(name)
    }
  }
  for (const info of frontendKeep) {
    if (!backendSet.has(info) || isBackendStatement(info) || info.declares.size === 0) continue
    const values = [...info.declares].filter(
      () => !ts.isInterfaceDeclaration(info.node) && !ts.isTypeAliasDeclaration(info.node),
    )
    if (values.length > 0)
      issues.push(
        `"${values.join(", ")}" is needed by both halves and was copied into each; consider moving it to shared/`,
      )
  }

  const used = (infos: Iterable<StatementInfo>): Set<string> => {
    const names = new Set<string>()
    for (const info of infos)
      for (const name of [...info.valueRefs, ...info.typeRefs]) names.add(name)
    return names
  }
  const backendUses = used(backendSet)
  const frontendUses = used([...frontendKeep].filter((info) => !isBackendStatement(info)))

  const backendTexts: string[] = []
  const frontendTexts: string[] = []
  let afterImports = 0
  for (const info of statements) {
    const node = info.node
    if (ts.isImportDeclaration(node)) {
      const back = filterImport(ts, sf, node, (name) => backendUses.has(name))
      if (back !== undefined) backendTexts.push(node.importClause ? back : "")
      const front = filterImport(ts, sf, node, (name) => frontendUses.has(name))
      if (front !== undefined) frontendTexts.push(front)
      afterImports = frontendTexts.length
      continue
    }
    if (isBackendStatement(info)) {
      if (
        ts.isExportDeclaration(node) &&
        exportsOf(info).some((name) => !BACKEND_EXPORTS.has(name))
      ) {
        backendTexts.push(filterExportList(ts, sf, node, (name) => BACKEND_EXPORTS.has(name)) ?? "")
        frontendTexts.push(
          filterExportList(ts, sf, node, (name) => !BACKEND_EXPORTS.has(name)) ?? "",
        )
        continue
      }
      if (exportsOf(info).some((name) => !BACKEND_EXPORTS.has(name))) {
        issues.push(
          `one statement exports both "${exportsOf(info).join('", "')}"; split it by hand`,
        )
      }
      backendTexts.push(info.text)
      continue
    }
    if (backendSet.has(info)) backendTexts.push(stripExport(ts, sf, info))
    if (frontendKeep.has(info)) frontendTexts.push(info.text)
  }
  // After the other imports: the nearest relative path sorts last.
  if (typeImports.size > 0) {
    frontendTexts.splice(
      afterImports,
      0,
      `\nimport type { ${[...typeImports].sort().join(", ")} } from "${backendSpecifier}"`,
    )
  }
  // A JSX pragma counts only in the file's leading comments, and the backend half has no JSX.
  const pragmas = (ts.getLeadingCommentRanges(source, 0) ?? [])
    .map((range) => source.slice(range.pos, range.end))
    .filter((comment) => /@jsx/.test(comment))
  const lift = (text: string): string =>
    pragmas.reduce(
      (out, pragma) => out.replace(new RegExp(`${escapeRegExp(pragma)}[ \\t]*\\n?`), ""),
      text,
    )
  const frontend = lift(joinStatements(frontendTexts))
  return {
    frontend: pragmas.length > 0 ? `${pragmas.join("\n")}\n${frontend}` : frontend,
    backend: lift(joinStatements(backendTexts)),
    moved: [...new Set(moved)].sort(),
    issues,
  }
}

/** A helper the backend half copies keeps its declaration; an `export` on it would add a backend export. */
function stripExport(ts: typeof TS, sf: TS.SourceFile, info: StatementInfo): string {
  if (info.exports.size === 0) return info.text
  const node = info.node
  const exportKeyword = (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []).find(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword,
  )
  if (exportKeyword === undefined) return info.text
  const start = exportKeyword.getStart(sf) - node.getFullStart()
  const end = exportKeyword.getEnd() - node.getFullStart()
  return info.text.slice(0, start) + info.text.slice(end).replace(/^\s+/, "")
}

/** `_middleware.ts`'s default export, as the `middleware` export of a `_layout.backend.ts`. */
export function middlewareSource(ts: typeof TS, source: string, fileName: string): string {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let out = source
  // Edit from the end so earlier offsets stay valid.
  for (const node of [...sf.statements].reverse()) {
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      out = `${out.slice(0, node.getStart(sf))}export const middleware = ${node.expression.getText(sf)}${out.slice(node.getEnd())}`
    } else if (
      ts.isFunctionDeclaration(node) &&
      hasModifier(ts, node, ts.SyntaxKind.DefaultKeyword)
    ) {
      const modifiers = (ts.getModifiers(node) ?? []).filter(
        (m) => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword,
      )
      const first = modifiers[0]
      const last = modifiers[modifiers.length - 1]
      if (first === undefined || last === undefined) continue
      if (node.name === undefined) {
        const text = out
          .slice(last.getEnd(), node.getEnd())
          .replace(/^(\s*(?:async\s+)?function\s*\*?)\s*/, "$1 middleware")
        out = `${out.slice(0, first.getStart(sf))}export${text}${out.slice(node.getEnd())}`
      } else {
        out = `${out.slice(0, first.getStart(sf))}${out.slice(last.getEnd()).replace(/^\s+/, "")}`
        out = `${out.trimEnd()}\nexport { ${node.name.text} as middleware }\n`
      }
    }
  }
  return out
}

/** Merge two backend modules: imports first (identical ones once), then the rest of each in order. */
function mergeModules(ts: typeof TS, first: string, second: string): string {
  if (first.trim() === "") return second
  const split = (text: string): { imports: string[]; body: string[] } => {
    const sf = ts.createSourceFile("merge.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const imports: string[] = []
    const body: string[] = []
    for (const node of sf.statements) {
      ;(ts.isImportDeclaration(node) ? imports : body).push(
        node.getFullText(sf).replace(/^\s*\n/, ""),
      )
    }
    return { imports, body }
  }
  const a = split(first)
  const b = split(second)
  const imports = [...new Set([...a.imports, ...b.imports].map((text) => text.trim()))]
  const body = [...a.body, ...b.body].map((text) => text.trim()).join("\n\n")
  return `${imports.join("\n")}${imports.length > 0 ? "\n\n" : ""}${body}\n`
}

// ---------------------------------------------------------------------------------------------------
// SFC script blocks
// ---------------------------------------------------------------------------------------------------

/** The `<script>` blocks of a Svelte/Vue file: their content range and whether it is the module script. */
function scriptBlocks(
  source: string,
): Array<{ start: number; end: number; module: boolean; setup: boolean }> {
  const blocks: Array<{ start: number; end: number; module: boolean; setup: boolean }> = []
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/g
  // A `<script>` written inside an HTML comment is prose, not a block; blank comments out, keeping offsets.
  const visible = source.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " "))
  for (const match of visible.matchAll(pattern)) {
    const attrs = match[1] ?? ""
    const start = (match.index ?? 0) + match[0].indexOf(">") + 1
    blocks.push({
      start,
      end: start + (match[2] ?? "").length,
      module: /\bmodule\b|context=["']module["']/.test(attrs),
      setup: /\bsetup\b/.test(attrs),
    })
  }
  return blocks
}

// ---------------------------------------------------------------------------------------------------
// Import graph + zoning
// ---------------------------------------------------------------------------------------------------

interface ImportRef {
  readonly specifier: string
  /** Erased at build time: `import type`, a type-only specifier list, `typeof import()`. */
  readonly typeOnly: boolean
}

function importsOf(ts: typeof TS, file: string, text: string): ImportRef[] {
  if (/\.(?:svelte|vue)$/.test(file)) {
    return scriptBlocks(text).flatMap((block) =>
      importsOf(ts, "block.ts", text.slice(block.start, block.end)),
    )
  }
  if (file.endsWith(".css")) {
    return [...text.matchAll(/@import\s+(?:url\()?["']([^"']+)["']/g)].map((m) => ({
      specifier: m[1] ?? "",
      typeOnly: false,
    }))
  }
  if (!/\.(?:[cm]?[jt]sx?|mdx)$/.test(file)) return []
  const code = file.endsWith(".mdx")
    ? text
        .split("\n")
        .filter((line) => /^(?:import|export)\s/.test(line))
        .join("\n")
    : text
  const sf = ts.createSourceFile(
    file,
    code,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const refs: ImportRef[] = []
  const visit = (node: TS.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause
      const named = clause?.namedBindings
      const typeOnly =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined &&
            named !== undefined &&
            ts.isNamedImports(named) &&
            named.elements.length > 0 &&
            named.elements.every((el) => el.isTypeOnly)))
      refs.push({ specifier: node.moduleSpecifier.text, typeOnly })
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      refs.push({ specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly })
    } else if (ts.isImportTypeNode(node)) {
      const arg = node.argument
      if (ts.isLiteralTypeNode(arg) && ts.isStringLiteral(arg.literal))
        refs.push({ specifier: arg.literal.text, typeOnly: true })
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const arg = node.arguments[0]
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require"
      if ((isImport || isRequire) && arg !== undefined && ts.isStringLiteralLike(arg))
        refs.push({ specifier: arg.text, typeOnly: false })
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const expr = node.moduleReference.expression
      if (ts.isStringLiteral(expr)) refs.push({ specifier: expr.text, typeOnly: node.isTypeOnly })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return refs
}

/** Resolve a relative specifier against the file map, the way a bundler would. */
function resolveIn(
  files: ReadonlySet<string>,
  from: string,
  specifier: string,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined
  const clean = specifier.replace(/[?#].*$/, "")
  const base = posix.normalize(posix.join(posix.dirname(from), clean))
  const candidates = [
    base,
    ...RESOLVE_EXTENSIONS.map((ext) => base + ext),
    ...RESOLVE_EXTENSIONS.map((ext) => `${base}/index${ext}`),
  ]
  // `./x.js` written for a `./x.ts` source.
  const js = /\.(?:[cm]?js|jsx)$/.exec(base)
  if (js !== null) {
    const stem = base.slice(0, -js[0].length)
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`)
  }
  return candidates.find((candidate) => files.has(candidate))
}

/** Rewrite one relative specifier from `from`'s new location to `target`'s new location, keeping the
 * author's style: extension kept when written, dropped when not, `/index` collapsed when it was. */
function respecify(
  original: string,
  oldTarget: string,
  newFrom: string,
  newTarget: string,
): string {
  const query = /[?#].*$/.exec(original)?.[0] ?? ""
  const clean = original.slice(0, original.length - query.length)
  let target = newTarget
  const writtenExt = extname(clean)
  const targetExt = extname(oldTarget)
  if (writtenExt === "" || (writtenExt !== targetExt && !RESOLVE_EXTENSIONS.includes(writtenExt))) {
    target = target.slice(0, target.length - extname(target).length)
    if (
      posix.basename(oldTarget).startsWith("index.") &&
      !posix.basename(clean).startsWith("index")
    ) {
      target = posix.dirname(target)
    }
  } else if (writtenExt !== targetExt) {
    target = target.slice(0, target.length - targetExt.length) + writtenExt
  }
  let rel = posix.relative(posix.dirname(newFrom), target)
  if (!rel.startsWith(".")) rel = `./${rel}`
  return rel + query
}

/** A relative specifier whose target does not move, rewritten for an importer that does. */
function rebase(specifier: string, from: string, newFrom: string): string | undefined {
  if (!specifier.startsWith(".") || from === newFrom) return undefined
  const target = posix.join(posix.dirname(from), specifier)
  const rel = posix.relative(posix.dirname(newFrom), target)
  return rel.startsWith(".") ? rel : `./${rel}`
}

function rewriteImports(
  ts: typeof TS,
  file: string,
  text: string,
  rewrite: (specifier: string) => string | undefined,
): string {
  const replace = (
    code: string,
    offset: number,
    out: Array<{ start: number; end: number; text: string }>,
    kind: TS.ScriptKind,
  ): void => {
    const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, kind)
    const visit = (node: TS.Node): void => {
      let literal: TS.StringLiteralLike | undefined
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        literal = node.moduleSpecifier
      else if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      )
        literal = node.argument.literal
      else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      ) {
        const arg = node.arguments[0]
        if (arg !== undefined && ts.isStringLiteralLike(arg)) literal = arg
      }
      if (literal !== undefined) {
        const next = rewrite(literal.text)
        if (next !== undefined && next !== literal.text) {
          out.push({
            start: offset + literal.getStart(sf) + 1,
            end: offset + literal.getEnd() - 1,
            text: next,
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  const edits: Array<{ start: number; end: number; text: string }> = []
  if (/\.(?:svelte|vue)$/.test(file)) {
    for (const block of scriptBlocks(text))
      replace(text.slice(block.start, block.end), block.start, edits, ts.ScriptKind.TS)
  } else if (file.endsWith(".css")) {
    for (const match of text.matchAll(/(@import\s+(?:url\()?["'])([^"']+)["']/g)) {
      const next = rewrite(match[2] ?? "")
      if (next !== undefined) {
        const start = (match.index ?? 0) + (match[1] ?? "").length
        edits.push({ start, end: start + (match[2] ?? "").length, text: next })
      }
    }
  } else if (file.endsWith(".mdx")) {
    for (const match of text.matchAll(/^((?:import|export)\s[^\n]*?from\s+["'])([^"']+)["']/gm)) {
      const next = rewrite(match[2] ?? "")
      if (next !== undefined) {
        const start = (match.index ?? 0) + (match[1] ?? "").length
        edits.push({ start, end: start + (match[2] ?? "").length, text: next })
      }
    }
  } else if (/\.[cm]?[jt]sx?$/.test(file)) {
    replace(text, 0, edits, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  }
  let out = text
  for (const edit of edits.sort((a, b) => b.start - a.start))
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  return out
}

/** `ServerOnly` imported from `@nifrajs/web` becomes `BackendOnly`, along with every use of it. */
function renameRetiredTypes(ts: typeof TS, file: string, text: string): string {
  if (!text.includes("ServerOnly")) return text
  const edits: Array<{ start: number; end: number; text: string }> = []
  const scan = (code: string, offset: number, kind: TS.ScriptKind): void => {
    const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, kind)
    const rename = (node: TS.Node): void => {
      edits.push({
        start: offset + node.getStart(sf),
        end: offset + node.getEnd(),
        text: "BackendOnly",
      })
    }
    let unaliased = false
    for (const statement of sf.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== "@nifrajs/web"
      )
        continue
      const bindings = statement.importClause?.namedBindings
      if (bindings === undefined || !ts.isNamedImports(bindings)) continue
      for (const element of bindings.elements) {
        if (element.propertyName?.text === "ServerOnly") rename(element.propertyName)
        else if (element.propertyName === undefined && element.name.text === "ServerOnly")
          unaliased = true
      }
    }
    if (!unaliased) return
    const visit = (node: TS.Node): void => {
      if (ts.isIdentifier(node) && node.text === "ServerOnly") rename(node)
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  if (/\.(?:svelte|vue)$/.test(file)) {
    for (const block of scriptBlocks(text))
      scan(text.slice(block.start, block.end), block.start, ts.ScriptKind.TS)
  } else if (/\.[cm]?[jt]sx?$/.test(file)) {
    scan(text, 0, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  }
  let out = text
  for (const edit of edits.sort((a, b) => b.start - a.start))
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  return out
}

// ---------------------------------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------------------------------

const ROOT_MOVES: Readonly<Record<string, string>> = {
  "backend.ts": "backend/app.ts",
  "framework.ts": "backend/framework.ts",
}
/** Root files that stay where they are: the CLI's config, and scripts no build loads. */
const isRootScript = (file: string): boolean =>
  !file.includes("/") && SOURCE_FILE.test(file) && ROOT_MOVES[file] === undefined
const isTestFile = (file: string): boolean =>
  /(?:^|\/)(?:test|tests|__tests__)\//.test(file) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)

export async function migrateLayout(
  appRoot: string,
  options: LayoutMigrationOptions = {},
): Promise<LayoutMigrationResult> {
  const ts = options.typescript ?? (await importTypeScript())
  if (ts === undefined)
    throw new Error("[nifra] `nifra migrate layout` needs TypeScript: bun add -d typescript")
  const root = resolve(appRoot)
  if (!existsSync(join(root, "routes"))) throw new Error(`[nifra] no routes/ directory in ${root}`)
  const original: Files = new Map()
  const everyFile = listFiles(root)
  for (const file of everyFile) {
    if (SOURCE_FILE.test(file) || file.endsWith(".css"))
      original.set(file, readFileSync(join(root, file), "utf8"))
  }
  const issues: LayoutMigrationIssue[] = []
  const splits: Array<{ file: string; backend: string; moved: string[] }> = []
  /** The app after the migration: new path -> text. */
  const next: Files = new Map(original)
  /** Old path -> new path, for every file that moves. */
  const moveMap = new Map<string, string>()

  // 1-2. Route halves and middleware.
  const backendHalves = new Map<string, string>()
  for (const [file, text] of original) {
    if (!file.startsWith("routes/") || file.includes(".backend.")) continue
    if (/(?:^|\/)_middleware\.[cm]?[jt]sx?$/.test(file)) {
      const target = posix.join(posix.dirname(file), "_layout.backend.ts")
      backendHalves.set(
        target,
        mergeModules(ts, backendHalves.get(target) ?? "", middlewareSource(ts, text, file)),
      )
      next.delete(file)
      splits.push({ file, backend: target, moved: ["middleware"] })
      continue
    }
    if (!ROUTE_FILE.test(file)) continue
    const backendFile = file.replace(ROUTE_FILE, ".backend.ts")
    const specifier = `./${posix.basename(backendFile)}`
    let result: SplitResult
    if (/\.(?:svelte|vue)$/.test(file)) {
      const blocks = scriptBlocks(text)
      const block =
        blocks.find((b) => b.module) ?? blocks.find((b) => !b.setup && file.endsWith(".vue"))
      if (block === undefined) continue
      const inner = splitRouteSource(ts, text.slice(block.start, block.end), "block.ts", specifier)
      result = {
        ...inner,
        frontend: `${text.slice(0, block.start)}\n${inner.frontend}${text.slice(block.end)}`,
      }
    } else if (file.endsWith(".mdx")) {
      if (
        /^export\s+(?:async\s+)?(?:const|function|let)\s+(?:loader|action|getStaticPaths|prerender|revalidate)\b/m.test(
          text,
        )
      ) {
        issues.push({
          file,
          reason: "an MDX route exports server code; move it to the route's .backend.ts by hand",
        })
      }
      continue
    } else {
      result = splitRouteSource(ts, text, file, specifier)
    }
    if (result.backend === undefined) continue
    next.set(file, result.frontend)
    backendHalves.set(
      backendFile,
      mergeModules(ts, backendHalves.get(backendFile) ?? "", result.backend),
    )
    splits.push({ file, backend: backendFile, moved: [...result.moved] })
    for (const reason of result.issues) issues.push({ file, reason })
  }
  for (const [file, text] of backendHalves) {
    const existing = next.get(file)
    next.set(file, existing === undefined ? text : mergeModules(ts, existing, text))
  }

  // 3-4. Zoning by runtime reachability, on the post-split graph.
  for (const [from, to] of Object.entries(ROOT_MOVES)) if (next.has(from)) moveMap.set(from, to)
  // Assets (images, fonts) resolve too, so they move with the modules that import them.
  const known = new Set([...next.keys(), ...everyFile])
  const edges = new Map<string, Array<{ target: string; typeOnly: boolean }>>()
  for (const [file, text] of next) {
    const refs: Array<{ target: string; typeOnly: boolean }> = []
    for (const ref of importsOf(ts, file, text)) {
      if (ref.specifier === "@nifrajs/web/plugins/vite-server-only") {
        issues.push({
          file,
          reason:
            "imports the retired @nifrajs/web/plugins/vite-server-only; remove it: nifra's Vite builds and dev server enforce the zones themselves (a hand-built Vite config uses viteLeakGuard from @nifrajs/web/plugins/vite-leak-guard)",
        })
      }
      const target = resolveIn(known, file, ref.specifier)
      if (target !== undefined) refs.push({ target, typeOnly: ref.typeOnly })
      else if (/^[@~]\//.test(ref.specifier))
        issues.push({
          file,
          reason: `the path alias "${ref.specifier}" is left as written; point it at the new location by hand`,
        })
    }
    edges.set(file, refs)
  }
  const reach = (roots: readonly string[]): Set<string> => {
    const seen = new Set<string>()
    const queue = [...roots]
    while (queue.length > 0) {
      const file = queue.pop() as string
      if (seen.has(file)) continue
      seen.add(file)
      for (const edge of edges.get(file) ?? []) if (!edge.typeOnly) queue.push(edge.target)
    }
    return seen
  }
  const files = [...new Set([...next.keys(), ...everyFile.filter((f) => !original.has(f))])]
  const frontendRoots = files.filter(
    (f) => f.startsWith("routes/") && ROUTE_FILE.test(f) && !f.includes(".backend."),
  )
  const backendRoots = files.filter(
    (f) =>
      (f.startsWith("routes/") && f.includes(".backend.")) ||
      f.startsWith("backend/") ||
      ROOT_MOVES[f] !== undefined ||
      (isRootScript(f) && f !== "nifra.config.ts" && !isTestFile(f)),
  )
  const browser = reach(frontendRoots)
  const server = reach(backendRoots)
  // What the app's own server modules reach, without the root scripts: a root file in here is a module
  // the app imports, not an entry, so it moves into a zone.
  const appServer = reach(
    backendRoots.filter((f) => f.includes("/") || ROOT_MOVES[f] !== undefined),
  )
  // A `.server` module ran empty in the browser, so only server code used it: it moves under backend/.
  for (const file of files) {
    if (!LEGACY_SERVER.test(file) || isTestFile(file)) continue
    const parts = file.replace(LEGACY_SERVER, "$1").split("/")
    if (parts.length > 1 && ZONE_DIRS.has(parts[0] ?? "")) parts.shift()
    const to = `backend/${parts.join("/")}`
    moveMap.set(file, to)
    if (browser.has(file)) {
      issues.push({
        file,
        reason: `a route frontend still imports it at runtime, where it ran empty as a ".server" module; move that use into the route's backend half before it moves to ${to}`,
      })
    }
  }
  const zoneOf = (file: string): "frontend" | "backend" | "shared" =>
    browser.has(file) && server.has(file) ? "shared" : browser.has(file) ? "frontend" : "backend"
  for (const file of files) {
    if (
      moveMap.has(file) ||
      isTestFile(file) ||
      file.endsWith(".d.ts") ||
      file === "nifra.config.ts"
    )
      continue
    if (/\.(?:frontend|backend|shared|fn)\.[cm]?[jt]sx?$/.test(file)) continue
    const top = file.split("/")[0] ?? ""
    if (file.includes("/")) {
      if (ZONE_DIRS.has(top) || (!browser.has(file) && !server.has(file))) continue
    } else if (!browser.has(file) && !appServer.has(file)) continue
    moveMap.set(file, `${zoneOf(file)}/${file}`)
  }
  const claimed = new Map<string, string>()
  for (const [from, to] of moveMap) {
    const holder = claimed.get(to) ?? (known.has(to) && !moveMap.has(to) ? to : undefined)
    if (holder === undefined) {
      claimed.set(to, from)
      continue
    }
    issues.push({
      file: from,
      reason: `would move to "${to}", which ${holder === to ? "already exists" : `"${holder}" moves to as well`}; move it by hand`,
    })
    moveMap.delete(from)
  }
  for (const [from, to] of moveMap) {
    if (to.startsWith("shared/") && /from\s+["'](?:node:|bun:)/.test(next.get(from) ?? "")) {
      issues.push({
        file: from,
        reason: `both halves import it at runtime, but it uses a server built-in; split it before moving to ${to}`,
      })
    }
  }

  // 5. Rewrite imports to the new locations.
  const newPath = (file: string): string => moveMap.get(file) ?? file
  const final: Files = new Map()
  const rewritten: string[] = []
  for (const [file, text] of next) {
    const imports = rewriteImports(ts, file, text, (specifier) => {
      const retired = RETIRED_SPECIFIERS[specifier]
      if (retired !== undefined) return retired
      const target = resolveIn(known, file, specifier)
      // Outside the app (or a skipped dir): the target stays put, so only a moved importer re-bases it.
      if (target === undefined) return rebase(specifier, file, newPath(file))
      if (newPath(target) === target && newPath(file) === file) return undefined
      return respecify(specifier, target, newPath(file), newPath(target))
    })
    const updated = renameRetiredTypes(ts, file, imports)
    final.set(newPath(file), updated)
    if (updated !== text && !moveMap.has(file) && original.get(file) === text) rewritten.push(file)
  }

  // A path in a string or comment is not an import, so nothing above rewrote it: a build script that
  // writes `data/x.json` would keep writing to the old place.
  for (const [file, text] of final) {
    for (const [from, to] of moveMap) {
      // `shared/lib/x.ts` contains `lib/x.ts`; that is the new path, not a stale one.
      const newPrefix = to.endsWith(from) ? to.slice(0, to.length - from.length) : undefined
      const stale = [
        ...text.matchAll(new RegExp(`(?<![\\w.-])${escapeRegExp(from)}(?![\\w])`, "g")),
      ].some((match) => newPrefix === undefined || !text.slice(0, match.index).endsWith(newPrefix))
      if (stale) issues.push({ file, reason: `mentions "${from}" by path; it moved to "${to}"` })
    }
  }

  // The server refuses data a loader or action returns without an output schema; only the author
  // knows which fields the browser may see.
  for (const [file, text] of final) {
    if (!file.startsWith("routes/") || !/\.backend\.[cm]?[jt]s$/.test(file)) continue
    for (const { name, schema } of missingOutputSchemas(text)) {
      issues.push({
        file,
        reason: `exports ${name === "action" ? "an" : "a"} ${name} but no ${schema}, so data it returns fails the request. Declare what the browser may see: export const ${schema} = t.object({ ... })`,
      })
    }
  }

  const moves = [...moveMap]
    .map(([from, to]) => ({ from, to }))
    .sort((a, b) => codeUnitOrder(a.from, b.from))
  if (options.write === true) {
    for (const [file, text] of final) {
      if (original.get(file) === text) continue
      const path = join(root, file)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
    }
    for (const file of original.keys()) {
      if (!final.has(file)) rmSync(join(root, file), { force: true })
    }
    for (const { from, to } of moves) {
      if (original.has(from) || !existsSync(join(root, from))) continue
      mkdirSync(dirname(join(root, to)), { recursive: true })
      renameSync(join(root, from), join(root, to))
    }
    pruneEmptyDirs(root)
  }
  return {
    ok: issues.length === 0,
    write: options.write === true,
    splits: splits.sort((a, b) => codeUnitOrder(a.file, b.file)),
    moves,
    rewritten: rewritten.sort(),
    issues,
  }
}

function pruneEmptyDirs(root: string): void {
  const prune = (dir: string): boolean => {
    let empty = true
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) {
        empty = false
        continue
      }
      const full = join(dir, entry.name)
      if (entry.isDirectory() ? !prune(full) : true) empty = false
    }
    if (empty && dir !== root) rmSync(dir, { recursive: true, force: true })
    return empty
  }
  prune(root)
}

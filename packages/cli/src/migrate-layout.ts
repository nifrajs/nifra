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
 *      by who imports it at runtime: only route frontends and the `clientModule` -> `frontend/`, only
 *      the server side -> `backend/`, both -> `shared/`. Imports through tsconfig `paths`/`baseUrl` and
 *      package.json `imports` count as the bundler reads them;
 *   5. rewrites every import in the app to the new locations (test-runner mocks included), an alias
 *      through the same alias when one of its targets covers the new place and as a relative path
 *      otherwise, each checked to resolve to its target after the moves; the config's `clientModule`
 *      and `componentPipeline.entries` paths; `@nifrajs/web/server-only` to
 *      `@nifrajs/web/backend-only`; and `ServerOnly` to `BackendOnly`;
 *   6. adds the zone folders moved TypeScript lands in to tsconfig `include`, and `.nifra/` to
 *      `.gitignore`.
 *
 * Data files (JSON, YAML, CSV, ...) and folders the app zones in package.json stay where they are.
 *
 * It is a dry run unless `write` is set, and it reports what it could not decide (a frontend that uses
 * a moved name at runtime, a helper both halves need, a loader with no output schema, an import no
 * specifier reaches after the moves, a specifier that names nothing) instead of guessing.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { builtinModules } from "node:module"
import { dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path"
import { BACKEND_ROUTE_EXPORTS } from "@nifrajs/web/route-manifest"
import { parseZoneConfig, type ZoneConfig } from "@nifrajs/web/zones"
import type * as TS from "typescript"
import { BACKEND_APP_FILE, CONFIG_FILE, FRAMEWORK_FILE, retiredRootFiles } from "./app-files.ts"
import { codeUnitOrder } from "./internal/code-unit-order.ts"
import { createKindProbe, hasWebConfig } from "./internal/nifra-project.ts"
import { createSpecifierResolver, isFile } from "./internal/project-specifiers.ts"
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
/** Scripts and config that name app files by path: scanned for paths that moved, never rewritten. */
const TOOLING_FILE =
  /(?:\.(?:json|jsonc|ya?ml|toml|sh|bash|zsh|ps1)|(?:^|\/)(?:Dockerfile|Makefile|Procfile))$/
const SELF_LOCATION = /\bimport\.meta\.(?:dirname|dir|filename|url)\b|\b__(?:dirname|filename)\b/
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git", ".vite", "public"])
const ZONE_DIRS = new Set(["frontend", "backend", "shared", "routes", "public"])
/** Data other tools may read by path too; reported, never moved. Images and fonts still move. */
const DATA_FILE = /\.(?:json|jsonc|json5|ndjson|ya?ml|toml|csv|tsv|txt|xml|sql)$/
/** Test-runner calls that name a module by path, as an import does. */
const MOCK_CALLS: ReadonlySet<string> = new Set([
  "mock.module",
  "vi.mock",
  "vi.doMock",
  "vi.importActual",
  "vi.importMock",
  "jest.mock",
  "jest.doMock",
  "jest.requireActual",
  "jest.requireMock",
  "jest.unstable_mockModule",
])
const TAILWIND_CONFIG = /^tailwind\.config\.[cm]?[jt]s$/

export interface LayoutMigrationIssue {
  readonly file: string
  readonly reason: string
}

export interface LayoutMigrationResult {
  readonly ok: boolean
  readonly write: boolean
  /** `"api"` for an app that serves no pages: only its backend entry moves, nothing is split or zoned. */
  readonly mode: "web" | "api"
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
  /** Tooling config the migration updated so it still covers what moved. */
  readonly tooling: ReadonlyArray<{ readonly file: string; readonly change: string }>
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

/** A specifier without its `?query` or `#hash`; a leading `#` names a package.json import. */
const withoutQuery = (specifier: string): string => specifier.replace(/(?!^)[?#].*$/, "")

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
interface JsxBindings {
  readonly element: readonly string[]
  readonly fragment: readonly string[]
}

/**
 * The bindings classic JSX compiles to calls of, which no identifier in the source names: the roots
 * of the `@jsx`/`@jsxFrag` pragmas, else TypeScript's default `React`. A file that names its own
 * `@jsxImportSource` imports the runtime itself.
 */
function jsxBindings(ts: typeof TS, source: string): JsxBindings {
  const comments = (ts.getLeadingCommentRanges(source, 0) ?? [])
    .map(({ pos, end }) => source.slice(pos, end))
    .join("\n")
  if (/@jsxImportSource\s/.test(comments)) return { element: [], fragment: [] }
  const root = (pragma: string): string | undefined =>
    new RegExp(`@${pragma}\\s+([A-Za-z_$][\\w$]*)`).exec(comments)?.[1]
  const element = root("jsx") ?? "React"
  return { element: [element], fragment: [root("jsxFrag") ?? element] }
}

function references(
  ts: typeof TS,
  node: TS.Node,
  jsx: JsxBindings,
): { value: Set<string>; type: Set<string> } {
  const value = new Set<string>()
  const type = new Set<string>()
  const visit = (current: TS.Node, inType: boolean): void => {
    if (ts.isJsxOpeningElement(current) || ts.isJsxSelfClosingElement(current))
      for (const name of jsx.element) value.add(name)
    else if (ts.isJsxFragment(current)) for (const name of jsx.fragment) value.add(name)
    const typed =
      inType ||
      ts.isTypeNode(current) ||
      // nifra-expect NF-S002: `token` is the heritage clause's syntax kind, not a credential.
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
  const jsx = jsxBindings(ts, sf.text)
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
      : references(ts, node, jsx)
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
  return `${leading}import ${typeOnly}${parts.join(", ")} from ${spec}${attributes}${terminatorOf(sf, node)}`
}

/** The `;` a statement was written with, so a rebuilt one keeps the file's style. */
const terminatorOf = (sf: TS.SourceFile, node: TS.Node): string =>
  node.getText(sf).endsWith(";") ? ";" : ""

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
  return `${leading}export ${node.isTypeOnly ? "type " : ""}{ ${kept.join(", ")} }${from}${terminatorOf(sf, node)}`
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
    const semi = statements.some((info) => terminatorOf(sf, info.node) !== "") ? ";" : ""
    frontendTexts.splice(
      afterImports,
      0,
      `\nimport type { ${[...typeImports].sort().join(", ")} } from "${backendSpecifier}"${semi}`,
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
      out = `${out.slice(0, node.getStart(sf))}export const middleware = ${node.expression.getText(sf)}${terminatorOf(sf, node)}${out.slice(node.getEnd())}`
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
        const semi = sf.statements.some((s) => terminatorOf(sf, s) !== "") ? ";" : ""
        out = `${out.trimEnd()}\nexport { ${node.name.text} as middleware }${semi}\n`
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
  // A closing tag ends at any space, slash or `>` after its name, as the compilers read it.
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script(?=[\s/>])[^>]*>/gi
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

/** The path argument of `mock.module("./x", ...)` or a vitest/jest twin, when it is a literal. */
function mockedSpecifier(ts: typeof TS, node: TS.CallExpression): TS.StringLiteralLike | undefined {
  const callee = node.expression
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression))
    return undefined
  if (!MOCK_CALLS.has(`${callee.expression.text}.${callee.name.text}`)) return undefined
  const arg = node.arguments[0]
  return arg !== undefined && ts.isStringLiteralLike(arg) ? arg : undefined
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
      // A test's mock names the module without loading it into the app: no runtime edge.
      const mocked = mockedSpecifier(ts, node)
      if (mocked !== undefined) refs.push({ specifier: mocked.text, typeOnly: true })
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

/** Where `text` spells, inside quotes, an import specifier that resolves among `files`: [start, end). */
function liveSpecifierSpans(
  ts: typeof TS,
  file: string,
  text: string,
  files: ReadonlySet<string>,
): Array<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = []
  for (const { specifier } of importsOf(ts, file, text)) {
    if (resolveIn(files, file, specifier) === undefined) continue
    for (const quote of ['"', "'", "`"]) {
      const quoted = `${quote}${specifier}${quote}`
      for (let at = text.indexOf(quoted); at !== -1; at = text.indexOf(quoted, at + 1))
        spans.push([at + 1, at + 1 + specifier.length])
    }
  }
  return spans
}

const OWN_DIR = new Set(["import.meta.dir", "import.meta.dirname", "__dirname"])

/**
 * Re-point the paths a module moving from `from` to `to` builds from its own location, so each still
 * reaches what it did: `join(import.meta.dir, "..", "x")` (or `resolve`), `import.meta.dir + "/../x"`,
 * `` `${__dirname}/../x` `` and `new URL("../x", import.meta.url)`, each with literal segments. `locate`
 * maps an app-relative target to where it ends up. Returns the new text and the first use of the
 * module's location it could not follow.
 */
function rebaseOwnPaths(
  ts: typeof TS,
  from: string,
  to: string,
  text: string,
  locate: (target: string) => string,
): { readonly text: string; readonly unfollowed: string | undefined } {
  const sf = ts.createSourceFile(
    to,
    text,
    ts.ScriptTarget.Latest,
    true,
    to.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const edits: Array<{ start: number; end: number; text: string }> = []
  const followed: Array<readonly [number, number]> = []
  const isOwnDir = (node: TS.Node | undefined): node is TS.Expression =>
    node !== undefined && OWN_DIR.has(node.getText(sf))
  const isLiteral = (
    node: TS.Node | undefined,
  ): node is TS.StringLiteral | TS.NoSubstitutionTemplateLiteral =>
    node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
  const quoted = (node: TS.Node, value: string): string => {
    const quote = node.getText(sf)[0] ?? '"'
    return `${quote}${value}${quote}`
  }
  // The path `relative` names from the module's old folder, named from its new folder.
  const rebased = (relative: string): string => {
    const target = locate(posix.normalize(posix.join(posix.dirname(from), relative)))
    const next = posix.relative(posix.dirname(to), target) || "."
    return relative.endsWith("/") && next !== "." ? `${next}/` : next
  }
  const follow = (anchor: TS.Node, start: number, end: number, replacement: string): void => {
    followed.push([anchor.getStart(sf), anchor.getEnd()])
    if (text.slice(start, end) !== replacement) edits.push({ start, end, text: replacement })
  }

  const visit = (node: TS.Node): void => {
    if (ts.isCallExpression(node)) {
      const [dir, ...parts] = node.arguments
      const callee = node.expression.getText(sf)
      const first = parts[0]
      const last = parts[parts.length - 1]
      if (
        isOwnDir(dir) &&
        /(?:^|\.)(?:join|resolve)$/.test(callee) &&
        first !== undefined &&
        last !== undefined &&
        parts.every(isLiteral) &&
        !(callee.endsWith("resolve") && parts.some((part) => part.text.startsWith("/")))
      ) {
        const next = rebased(posix.join(...parts.map((part) => part.text)))
        const segments = parts.length === 1 ? [next] : next.split("/").filter((s) => s !== "")
        const replacement = segments.map((segment) => quoted(first, segment)).join(", ")
        follow(dir, first.getStart(sf), last.getEnd(), replacement)
        return
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      isOwnDir(node.left) &&
      isLiteral(node.right) &&
      node.right.text.startsWith("/")
    ) {
      const next = rebased(node.right.text.slice(1) || ".")
      follow(
        node.left,
        node.right.getStart(sf),
        node.right.getEnd(),
        quoted(node.right, `/${next}`),
      )
      return
    }
    if (ts.isTemplateExpression(node) && node.head.text === "" && node.templateSpans.length === 1) {
      const span = node.templateSpans[0]
      if (span !== undefined && isOwnDir(span.expression) && span.literal.text.startsWith("/")) {
        const next = rebased(span.literal.text.slice(1) || ".")
        const replacement = `\`\${${span.expression.getText(sf)}}/${next}\``
        follow(span.expression, node.getStart(sf), node.getEnd(), replacement)
        return
      }
    }
    if (
      ts.isNewExpression(node) &&
      node.expression.getText(sf) === "URL" &&
      node.arguments?.length === 2 &&
      node.arguments[1]?.getText(sf) === "import.meta.url"
    ) {
      const path = node.arguments[0]
      if (isLiteral(path) && !/^(?:\/|[a-z][a-z\d+.-]*:)/i.test(path.text)) {
        const next = rebased(path.text)
        const replacement = quoted(path, next.startsWith("..") ? next : `./${next}`)
        follow(node.arguments[1], path.getStart(sf), path.getEnd(), replacement)
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  const unfollowed = [...text.matchAll(new RegExp(SELF_LOCATION.source, "g"))].find(
    (match) => !followed.some(([start, end]) => start <= match.index && match.index < end),
  )?.[0]
  let next = text
  for (const edit of edits.sort((a, b) => b.start - a.start))
    next = next.slice(0, edit.start) + edit.text + next.slice(edit.end)
  return { text: next, unfollowed }
}

/** Rewrite one relative specifier from `from`'s new location to `target`'s new location, keeping the
 * author's style: extension kept when written, dropped when not, `/index` collapsed when it was. */
function respecify(
  original: string,
  oldTarget: string,
  newFrom: string,
  newTarget: string,
): string {
  const query = original.slice(withoutQuery(original).length)
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

/** A split route as an importer sees it: the names that left it, and how this importer spells the
 * backend half they went to. */
interface SplitTarget {
  readonly backend: string
  readonly moved: ReadonlySet<string>
  readonly specifier: string
}

/** `specifier` re-pointed from a split route to its backend half, in the author's extension style. */
function backendSpecifier(specifier: string, route: string, backend: string, from: string): string {
  const query = specifier.slice(withoutQuery(specifier).length)
  const written = extname(specifier.slice(0, specifier.length - query.length))
  const stem = backend.slice(0, -extname(backend).length)
  const target =
    written === ""
      ? stem
      : written === extname(route)
        ? backend
        : `${stem}${written === ".jsx" ? ".js" : written}`
  const rel = posix.relative(posix.dirname(from), target)
  return (rel.startsWith(".") ? rel : `./${rel}`) + query
}

/**
 * Point an importer's named imports of a split route's moved exports (`loader`, `action`, ...) at the
 * backend half, splitting a statement that also names what stayed. What cannot be rewritten (a
 * namespace or dynamic import that reads a moved name, `export *`) is returned as an issue.
 */
function redirectMovedImports(
  ts: typeof TS,
  file: string,
  text: string,
  splitOf: (specifier: string) => SplitTarget | undefined,
): {
  readonly text: string
  readonly issues: readonly string[]
  readonly redirects: ReadonlyArray<{ names: string[]; from: string; to: string }>
} {
  const redirects: Array<{ names: string[]; from: string; to: string }> = []
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const edits: Array<{ start: number; end: number; text: string }> = []
  const issues: string[] = []
  const mentioned = (split: SplitTarget, pattern: (name: string) => RegExp): string[] =>
    [...split.moved].filter((name) => pattern(escapeRegExp(name)).test(text)).sort()
  const quoted = (names: readonly string[]): string => names.map((name) => `"${name}"`).join(", ")
  const visit = (node: TS.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const from = node.moduleSpecifier.text
      const split = splitOf(from)
      if (split === undefined) return
      const clause = ts.isImportDeclaration(node) ? node.importClause : undefined
      const named = ts.isImportDeclaration(node) ? clause?.namedBindings : node.exportClause
      if (named !== undefined && (ts.isNamespaceImport(named) || ts.isNamespaceExport(named))) {
        const reads = mentioned(split, (name) => new RegExp(`\\b${named.name.text}\\.${name}\\b`))
        if (reads.length > 0)
          issues.push(
            `reads ${quoted(reads)} through a namespace import of "${from}", but they moved to "${split.backend}"; import them from there by hand`,
          )
        return
      }
      if (named === undefined) {
        if (ts.isExportDeclaration(node))
          issues.push(
            `re-exports everything from "${from}", but ${quoted([...split.moved].sort())} moved to "${split.backend}"; re-export them from there by hand`,
          )
        return
      }
      const elements: readonly (TS.ImportSpecifier | TS.ExportSpecifier)[] = named.elements
      const isMoved = (el: TS.ImportSpecifier | TS.ExportSpecifier): boolean =>
        split.moved.has((el.propertyName ?? el.name).text)
      const moved = elements.filter(isMoved)
      if (moved.length === 0) return
      redirects.push({
        names: moved.map((el) => (el.propertyName ?? el.name).text),
        from,
        to: split.specifier,
      })
      const kept = elements.filter((el) => !isMoved(el)).map((el) => el.getText(sf))
      const quote = node.moduleSpecifier.getText(sf)[0] ?? '"'
      const attributes = node.attributes ? ` ${node.attributes.getText(sf)}` : ""
      const tail = (specifier: string): string =>
        ` from ${quote}${specifier}${quote}${attributes}${terminatorOf(sf, node)}`
      const keyword = ts.isImportDeclaration(node)
        ? `import ${clause?.isTypeOnly ? "type " : ""}`
        : `export ${node.isTypeOnly ? "type " : ""}`
      const list = (names: readonly string[]): string => `{ ${names.join(", ")} }`
      const backend = `${keyword}${list(moved.map((el) => el.getText(sf)))}${tail(split.specifier)}`
      const stays = [
        ...(clause?.name === undefined ? [] : [clause.name.text]),
        ...(kept.length === 0 ? [] : [list(kept)]),
      ]
      edits.push({
        start: node.getStart(sf),
        end: node.getEnd(),
        text:
          stays.length === 0 ? backend : `${keyword}${stays.join(", ")}${tail(from)}\n${backend}`,
      })
      return
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const from = node.arguments[0].text
      const split = splitOf(from)
      const reads =
        split === undefined ? [] : mentioned(split, (name) => new RegExp(`\\b${name}\\b`))
      if (split !== undefined && reads.length > 0)
        issues.push(
          `loads "${from}" with import() and mentions ${quoted(reads)}, which moved to "${split.backend}"; load the backend half for them by hand`,
        )
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  let out = text
  for (const edit of edits.sort((a, b) => b.start - a.start))
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  return { text: out, issues, redirects }
}

/** The package folder an app without its own package.json sits in (`--dir src`), at most two levels
 * up and never a workspace root, so the scan beside it stays inside one package. */
function enclosingPackage(root: string): string | undefined {
  if (existsSync(join(root, "package.json"))) return undefined
  for (const dir of [dirname(root), dirname(dirname(root))]) {
    const manifest = join(dir, "package.json")
    if (dir === root || !existsSync(manifest)) continue
    try {
      const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"))
      const workspace = typeof parsed === "object" && parsed !== null && "workspaces" in parsed
      return workspace ? undefined : dir
    } catch {
      return undefined
    }
  }
  return undefined
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
      } else if (ts.isCallExpression(node)) literal = mockedSpecifier(ts, node)
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

/** Root files that stay where they are: the CLI's config, and scripts no build loads. */
/** The config files the loader reads, old layout included; a path field may live in any of them. */
const CONFIG_FILES = ["nifra.config.ts", "framework.ts", "backend/framework.ts"]

interface ConfigEntry {
  /** `clientModule`, or `componentPipeline.entries.<name>`. */
  readonly field: string
  readonly role: "frontend" | "backend"
  readonly value: string
  /** The literal's text, quotes excluded: [start, end). */
  readonly start: number
  readonly end: number
}

/**
 * The module paths a config exports as string literals: `clientModule` and the component pipeline's
 * `entries`. The browser loads `clientModule` and `entries.client`; `ssr` and `rsc` run on the server.
 */
function configEntries(ts: typeof TS, file: string, text: string): ConfigEntry[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const bare = (node: TS.Expression | undefined): TS.Expression | undefined => {
    let current = node
    while (
      current !== undefined &&
      (ts.isAsExpression(current) ||
        ts.isSatisfiesExpression(current) ||
        ts.isParenthesizedExpression(current))
    )
      current = current.expression
    return current
  }
  const out: ConfigEntry[] = []
  const literal = (field: string, role: ConfigEntry["role"], node: TS.Expression | undefined) => {
    const value = bare(node)
    if (value === undefined || !ts.isStringLiteralLike(value)) return
    out.push({
      field,
      role,
      value: value.text,
      start: value.getStart(sf) + 1,
      end: value.getEnd() - 1,
    })
  }
  for (const statement of sf.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      !hasModifier(ts, statement, ts.SyntaxKind.ExportKeyword)
    )
      continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue
      if (declaration.name.text === "clientModule")
        literal("clientModule", "frontend", declaration.initializer)
      if (declaration.name.text !== "componentPipeline") continue
      const pipeline = bare(declaration.initializer)
      if (pipeline === undefined || !ts.isObjectLiteralExpression(pipeline)) continue
      for (const property of pipeline.properties) {
        if (!ts.isPropertyAssignment(property) || property.name.getText(sf) !== "entries") continue
        const entries = bare(property.initializer)
        if (entries === undefined || !ts.isObjectLiteralExpression(entries)) continue
        for (const entry of entries.properties) {
          if (!ts.isPropertyAssignment(entry)) continue
          const name = entry.name.getText(sf).replace(/^["']|["']$/g, "")
          if (name === "client" || name === "ssr" || name === "rsc")
            literal(
              `componentPipeline.entries.${name}`,
              name === "client" ? "frontend" : "backend",
              entry.initializer,
            )
        }
      }
    }
  }
  return out
}

/** The package an import names: `@scope/pkg` or `pkg`, without a subpath. */
const packageName = (specifier: string): string => {
  const parts = specifier.split("/")
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "")
}

const isRootScript = (file: string, rootMoves: Readonly<Record<string, string>>): boolean =>
  !file.includes("/") && SOURCE_FILE.test(file) && rootMoves[file] === undefined
const isTestFile = (file: string): boolean =>
  /(?:^|\/)(?:test|tests|__tests__)\//.test(file) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)

/** The web config an app has, old root `framework.ts` included, or `undefined`. */
const webConfigFile = (
  root: string,
  rootMoves: Readonly<Record<string, string>>,
): string | undefined =>
  rootMoves["framework.ts"] !== undefined
    ? "framework.ts"
    : existsSync(join(root, FRAMEWORK_FILE))
      ? FRAMEWORK_FILE
      : hasWebConfig(root, ".")
        ? CONFIG_FILE
        : undefined

/**
 * `"api"` when the app declares `"nifra": { "kind": "api" }`, or has no web config, no `routes/` and a
 * backend; `"web"` when it has `routes/`. Web config without `routes/` could be either, so it throws.
 */
function layoutMode(root: string, rootMoves: Readonly<Record<string, string>>): "web" | "api" {
  const declared = createKindProbe(root)(root)
  if (declared.invalid !== undefined) throw new Error(declared.invalid)
  const config = webConfigFile(root, rootMoves)
  if (declared.kind === "api") {
    if (config === undefined) return "api"
    throw new Error(
      `[nifra] ${declared.manifest} declares "nifra": { "kind": "api" }, but ${root} has web config (${config}); remove "kind" to migrate it as a web app, or remove the web config`,
    )
  }
  if (existsSync(join(root, "routes"))) return "web"
  const nested = nestedAppHint(root)
  if (config !== undefined) {
    throw new Error(
      `[nifra] no routes/ directory in ${root}, but it has web config (${config}). A web app is file-routed under routes/; if this one serves no pages, remove the web config and declare "nifra": { "kind": "api" } in package.json${nested}`,
    )
  }
  if (declared.kind === "web") throw new Error(`[nifra] no routes/ directory in ${root}${nested}`)
  if (rootMoves["backend.ts"] === undefined && !existsSync(join(root, BACKEND_APP_FILE))) {
    throw new Error(
      `[nifra] ${root} has no routes/, no web config and no backend (a backend.ts that exports \`backend\`, or ${BACKEND_APP_FILE}); there is nothing to migrate${nested}`,
    )
  }
  return "api"
}

/** An app one folder down (`src/routes/`): the `--dir` that migrates it, as a sentence to append. */
function nestedAppHint(root: string): string {
  const found = readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        !SKIP_DIRS.has(entry.name) &&
        existsSync(join(root, entry.name, "routes")),
    )
    .map((entry) => entry.name)
    .sort(codeUnitOrder)
  const first = found[0]
  if (first === undefined) return ""
  return `. ${found.map((name) => `${name}/routes/`).join(", ")} exists: run \`nifra migrate layout --dir ${first}\` to migrate the app there`
}

export async function migrateLayout(
  appRoot: string,
  options: LayoutMigrationOptions = {},
): Promise<LayoutMigrationResult> {
  const ts = options.typescript ?? (await importTypeScript())
  if (ts === undefined)
    throw new Error("[nifra] `nifra migrate layout` needs TypeScript: bun add -d typescript")
  const root = resolve(appRoot)
  // Only a root file that exports what the old layout read moves; any other backend.ts is a module.
  const rootMoves: Readonly<Record<string, string>> = Object.fromEntries(retiredRootFiles(root))
  const mode = layoutMode(root, rootMoves)
  // An API-only app has no browser: nothing to split, and every file is server code where it is.
  const api = mode === "api"
  const zones = appZones(root)
  const configured = [...(zones.backend ?? []), ...(zones.frontend ?? []), ...(zones.shared ?? [])]
  const inConfiguredFolder = (file: string): boolean =>
    configured.some((folder) => file === folder || file.startsWith(`${folder}/`))
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
    if (api || !file.startsWith("routes/") || file.includes(".backend.")) continue
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
  for (const [from, to] of Object.entries(rootMoves)) if (next.has(from)) moveMap.set(from, to)
  // Assets (images, fonts) resolve too, so they move with the modules that import them.
  const known = new Set([...next.keys(), ...everyFile])
  const knownPaths = new Set([...known].map((file) => join(root, file)))
  // Route halves the split creates resolve before they are written.
  const resolver = createSpecifierResolver({
    moduleExists: (path) => knownPaths.has(path) || isFile(path),
  })
  const realRoot = (() => {
    try {
      return realpathSync(root)
    } catch {
      return root
    }
  })()
  /** An app file as the migration names it, from a path the resolver found (real, or as planned). */
  const appFile = (path: string | undefined): string | undefined => {
    if (path === undefined) return undefined
    for (const base of [realRoot, root]) {
      const rel = toPosix(relative(base, path))
      if (!rel.startsWith("../") && !isAbsolute(rel)) return rel
    }
    return undefined
  }
  /** A non-relative specifier the app's tsconfig `paths`/`baseUrl` or package.json `imports` maps to
   * one of its files, as the bundler reads it. */
  const viaAlias = (file: string, specifier: string): string | undefined => {
    if (specifier.startsWith(".") || isAbsolute(specifier)) return undefined
    const rel = appFile(resolver(join(root, file), withoutQuery(specifier)))
    return rel === undefined || !known.has(rel) ? undefined : rel
  }
  const resolveAny = (file: string, specifier: string): string | undefined =>
    resolveIn(known, file, specifier) ?? viaAlias(file, specifier)
  const ownName = (() => {
    try {
      const name: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name
      return typeof name === "string" ? name : undefined
    } catch {
      return undefined
    }
  })()
  const installed = new Map<string, boolean>()
  /** Whether a bare specifier names something outside the app that exists: a built-in, a URL or a
   * scheme the bundler owns, the app's own package name, or a package installed at or above it. */
  const external = (specifier: string): boolean => {
    if (/^[a-z][a-z\d+.-]*:/i.test(specifier) || specifier === "bun") return true
    const name = packageName(withoutQuery(specifier))
    if (builtinModules.includes(name) || name === ownName) return true
    let found = installed.get(name)
    if (found === undefined) {
      const types = `@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`
      found = false
      for (let dir = root; ; dir = dirname(dir)) {
        if (
          existsSync(join(dir, "node_modules", name)) ||
          existsSync(join(dir, "node_modules", types))
        ) {
          found = true
          break
        }
        if (dirname(dir) === dir) break
      }
      installed.set(name, found)
    }
    return found
  }
  // A test (or any module) that imports `loader` from a page would import a name the page no longer
  // exports: it reads it from the backend half instead.
  const splitRoutes = new Map<string, { backend: string; moved: ReadonlySet<string> }>()
  for (const split of splits)
    if (next.has(split.file)) splitRoutes.set(split.file, { ...split, moved: new Set(split.moved) })
  /** `base` is where `file` is relative to: the app root, or the package folder around it. */
  const splitTarget =
    (base: string, file: string, resolve: (specifier: string) => string | undefined) =>
    (specifier: string): SplitTarget | undefined => {
      const route = resolve(specifier)
      const split = route === undefined ? undefined : splitRoutes.get(route)
      if (route === undefined || split === undefined) return undefined
      const inBase = (path: string): string => toPosix(relative(base, join(root, path)))
      const relativePath = backendSpecifier(specifier, inBase(route), inBase(split.backend), file)
      const respelled = specifier.startsWith(".")
        ? relativePath
        : (resolver.respell(join(base, file), specifier, join(root, split.backend)) ?? relativePath)
      return { backend: split.backend, moved: split.moved, specifier: respelled }
    }
  const redirectedFiles = new Set<string>()
  for (const [file, text] of splitRoutes.size === 0 ? [] : next) {
    if (splitRoutes.has(file) || !/\.[cm]?[jt]sx?$/.test(file)) continue
    const redirected = redirectMovedImports(
      ts,
      file,
      text,
      splitTarget(root, file, (specifier) => resolveAny(file, specifier)),
    )
    if (redirected.text !== text) {
      next.set(file, redirected.text)
      redirectedFiles.add(file)
    }
    for (const reason of redirected.issues) issues.push({ file, reason })
  }
  const edges = new Map<string, Array<{ target: string; typeOnly: boolean }>>()
  for (const [file, text] of api ? [] : next) {
    const refs: Array<{ target: string; typeOnly: boolean }> = []
    const reported = new Set<string>()
    for (const ref of importsOf(ts, file, text)) {
      if (ref.specifier === "@nifrajs/web/plugins/vite-server-only") {
        issues.push({
          file,
          reason:
            "imports the retired @nifrajs/web/plugins/vite-server-only; remove it: nifra's Vite builds and dev server enforce the zones themselves (a hand-built Vite config uses viteLeakGuard from @nifrajs/web/plugins/vite-leak-guard)",
        })
      }
      const target = resolveAny(file, ref.specifier)
      if (target !== undefined) refs.push({ target, typeOnly: ref.typeOnly })
      else if (
        !ref.specifier.startsWith(".") &&
        !isAbsolute(ref.specifier) &&
        RETIRED_SPECIFIERS[ref.specifier] === undefined &&
        resolver(join(root, file), ref.specifier) === undefined &&
        !external(ref.specifier) &&
        !reported.has(ref.specifier)
      ) {
        reported.add(ref.specifier)
        issues.push({
          file,
          reason: `"${ref.specifier}" names no installed package and no file through the app's tsconfig paths or package.json imports, so the migration cannot tell where it belongs; check it by hand`,
        })
      }
    }
    edges.set(file, refs)
  }
  // The config's module paths are entries too: the browser loads `clientModule`.
  const entries = CONFIG_FILES.filter((file) => next.has(file)).flatMap((file) =>
    configEntries(ts, file, next.get(file) ?? "").map((entry) => ({
      ...entry,
      file,
      // Relative to the app root, as the loader reads it, whichever config file holds it.
      target: resolveAny("nifra.config.ts", entry.value),
    })),
  )
  const entryTargets = (role: ConfigEntry["role"]): Set<string> =>
    new Set(
      entries.flatMap((entry) =>
        entry.role === role && entry.target !== undefined ? [entry.target] : [],
      ),
    )
  const browserEntries = entryTargets("frontend")
  const serverEntries = entryTargets("backend")
  const files = [...new Set([...next.keys(), ...everyFile.filter((f) => !original.has(f))])]
  const frontendRoots = [
    ...files.filter(
      (f) => f.startsWith("routes/") && ROUTE_FILE.test(f) && !f.includes(".backend."),
    ),
    ...browserEntries,
  ]
  // A route page the server imports - a generated `server-manifest.ts` imports them all - is rendered
  // there, not run as server code, so the server's walk stops at it: what only pages use stays frontend.
  const pages = new Set(frontendRoots.filter((f) => !browserEntries.has(f)))
  const reach = (roots: readonly string[], stopAt?: ReadonlySet<string>): Set<string> => {
    const seen = new Set<string>()
    const queue = [...roots]
    while (queue.length > 0) {
      const file = queue.pop() as string
      if (seen.has(file)) continue
      seen.add(file)
      if (stopAt?.has(file)) continue
      for (const edge of edges.get(file) ?? []) if (!edge.typeOnly) queue.push(edge.target)
    }
    return seen
  }
  const backendRoots = [
    ...files.filter(
      (f) =>
        (f.startsWith("routes/") && f.includes(".backend.")) ||
        f.startsWith("backend/") ||
        rootMoves[f] !== undefined ||
        (isRootScript(f, rootMoves) &&
          f !== "nifra.config.ts" &&
          !isTestFile(f) &&
          !browserEntries.has(f)),
    ),
    ...serverEntries,
  ]
  const browser = reach(frontendRoots)
  const server = reach(backendRoots, pages)
  // What the app's own server modules reach, without the root scripts: a root file in here is a module
  // the app imports, not an entry, so it moves into a zone.
  const appServer = reach(
    backendRoots.filter(
      (f) => f.includes("/") || rootMoves[f] !== undefined || serverEntries.has(f),
    ),
    pages,
  )
  // A `.server` module ran empty in the browser, so only server code used it: it moves under backend/.
  for (const file of api ? [] : files) {
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
  for (const file of api ? [] : files) {
    if (
      moveMap.has(file) ||
      isTestFile(file) ||
      file.endsWith(".d.ts") ||
      file === "nifra.config.ts" ||
      inConfiguredFolder(file)
    )
      continue
    if (/\.(?:frontend|backend|shared|fn)\.[cm]?[jt]sx?$/.test(file)) continue
    const top = file.split("/")[0] ?? ""
    if (file.includes("/")) {
      if (ZONE_DIRS.has(top) || (!browser.has(file) && !server.has(file))) continue
    } else if (!browser.has(file) && !appServer.has(file)) continue
    const zone = zoneOf(file)
    if (DATA_FILE.test(file)) {
      const folder = file.includes("/") ? posix.dirname(file) : undefined
      issues.push({
        file,
        reason: `is data ${zone === "shared" ? "both sides import" : `${zone} code imports`}, and a build only loads files in a zone; it stays here because other tools may read it by path. Move it to "${zone}/${file}" by hand, or ${folder === undefined ? "into a folder listed" : `list "${folder}"`} under "nifra": { "zones": { "${zone}": [...] } } in package.json`,
      })
      continue
    }
    moveMap.set(file, `${zone}/${file}`)
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
  // The app as the migration leaves it, where every rewritten specifier must reach its target.
  const planned = new Set(
    [...known].filter((file) => next.has(file) || !original.has(file)).map(newPath),
  )
  const plannedResolver = createSpecifierResolver({
    moduleExists: (path) => {
      const file = appFile(path)
      if (file !== undefined && (planned.has(file) || known.has(file))) return planned.has(file)
      return isFile(path)
    },
  })
  /** Whether `specifier`, written in `from` after the moves, loads `target` there. */
  const reaches = (from: string, specifier: string, target: string): boolean =>
    specifier.startsWith(".")
      ? resolveIn(planned, from, specifier) === target
      : appFile(plannedResolver(join(root, from), withoutQuery(specifier))) === target
  const unreached = new Set<string>()
  const unreachable = (file: string, specifier: string, target: string, from: string): void => {
    if (unreached.has(`${file}\0${specifier}`)) return
    unreached.add(`${file}\0${specifier}`)
    issues.push({
      file,
      reason: `"${specifier}" names "${target}", which moves to "${newPath(target)}", and no specifier the migration can write from "${from}" reaches it there; point it there by hand`,
    })
  }
  /**
   * How `from` names `target` after the moves, for the alias `specifier` that `file` writes: as written
   * while it still reaches it, through the same alias when one of its targets covers the new place,
   * else as a relative path. `undefined` leaves it as written.
   */
  const aliasTo = (
    file: string,
    specifier: string,
    target: string,
    from = newPath(file),
  ): string | undefined => {
    const to = newPath(target)
    if (to === target && from === file) return undefined
    const written = withoutQuery(specifier)
    if (reaches(from, written, to)) return undefined
    const respelled = resolver.respell(join(root, file), written, join(root, to))
    if (respelled !== undefined && reaches(from, respelled, to))
      return `${respelled}${specifier.slice(written.length)}`
    const relativePath = respecify(specifier, target, from, to)
    if (reaches(from, relativePath, to)) return relativePath
    unreachable(file, specifier, target, from)
    return undefined
  }
  for (const [file, text] of next) {
    const imports = rewriteImports(ts, file, text, (specifier) => {
      const retired = RETIRED_SPECIFIERS[specifier]
      if (retired !== undefined) return retired
      const target = resolveAny(file, specifier)
      // Outside the app (or a skipped dir): the target stays put, so only a moved importer re-bases it.
      if (target === undefined) return rebase(specifier, file, newPath(file))
      if (!specifier.startsWith(".")) return aliasTo(file, specifier, target)
      if (newPath(target) === target && newPath(file) === file) return undefined
      const relativePath = respecify(specifier, target, newPath(file), newPath(target))
      if (!reaches(newPath(file), relativePath, newPath(target)))
        unreachable(file, specifier, target, newPath(file))
      return relativePath
    })
    const updated = renameRetiredTypes(ts, file, imports)
    final.set(newPath(file), updated)
    if (
      !moveMap.has(file) &&
      (redirectedFiles.has(file) || (updated !== text && original.get(file) === text))
    )
      rewritten.push(file)
  }

  // A config path names its module from the app root, so it follows the module, never the config file.
  for (const configFile of CONFIG_FILES) {
    const at = newPath(configFile)
    const text = final.get(at)
    if (text === undefined || !next.has(configFile)) continue
    const edits: Array<{ start: number; end: number; text: string }> = []
    for (const entry of configEntries(ts, at, text)) {
      const target = resolveAny("nifra.config.ts", entry.value)
      if (target === undefined || newPath(target) === target) continue
      const value = entry.value.startsWith(".")
        ? respecify(entry.value, target, "nifra.config.ts", newPath(target))
        : aliasTo(configFile, entry.value, target, "nifra.config.ts")
      if (value !== undefined) edits.push({ start: entry.start, end: entry.end, text: value })
    }
    if (edits.length === 0) continue
    let updated = text
    for (const edit of edits.sort((a, b) => b.start - a.start))
      updated = updated.slice(0, edit.start) + edit.text + updated.slice(edit.end)
    final.set(at, updated)
    if (!moveMap.has(configFile) && !rewritten.includes(configFile)) rewritten.push(configFile)
  }

  const moves = [...moveMap]
    .map(([from, to]) => ({ from, to }))
    .sort((a, b) => codeUnitOrder(a.from, b.from))

  // A moved module's paths from its own location now start from its new folder: re-point the ones it
  // spells out, and report the first one it cannot follow.
  const unfollowed = new Map<string, string>()
  for (const { from, to } of moves) {
    const text = final.get(to)
    if (text === undefined || !SELF_LOCATION.test(text)) continue
    if (!/\.[cm]?[jt]sx?$/.test(to)) {
      unfollowed.set(to, SELF_LOCATION.exec(text)?.[0] ?? "")
      continue
    }
    const result = rebaseOwnPaths(ts, from, to, text, (target) =>
      known.has(target) ? newPath(target) : target,
    )
    final.set(to, result.text)
    if (result.unfollowed !== undefined) unfollowed.set(to, result.unfollowed)
  }

  // A path in a string or comment is not an import, so nothing above rewrote it: a build script that
  // writes `data/x.json` would keep writing to the old place, and so would a deploy script or
  // `package.json` beside the code.
  const settled = new Set([...known].map(newPath))
  const scanned: Array<readonly [string, string]> = [...final]
  for (const file of everyFile) {
    if (
      !original.has(file) &&
      TOOLING_FILE.test(file) &&
      statSync(join(root, file)).size <= 256_000
    )
      scanned.push([newPath(file), readFileSync(join(root, file), "utf8")])
  }
  for (const [file, text] of scanned) {
    let live: ReadonlyArray<readonly [number, number]> | undefined
    for (const [from, to] of moveMap) {
      // `shared/lib/x.ts` contains `lib/x.ts`; that is the new path, not a stale one.
      const newPrefix = to.endsWith(from) ? to.slice(0, to.length - from.length) : undefined
      const stale = [
        ...text.matchAll(new RegExp(`(?<![\\w.-])${escapeRegExp(from)}(?![\\w])`, "g")),
      ].some((match) => {
        if (newPrefix !== undefined && text.slice(0, match.index).endsWith(newPrefix)) return false
        // An import that resolves after the moves is current, even when it still reads like the old
        // path: `./x.json` from a module that moved together with `x.json`.
        live ??= liveSpecifierSpans(ts, file, text, settled)
        const end = match.index + from.length
        return !live.some(([start, stop]) => start <= match.index && end <= stop)
      })
      if (stale) issues.push({ file, reason: `mentions "${from}" by path; it moved to "${to}"` })
    }
  }

  // Code beside an app one folder down (a package's test/ when the app is its src/) is not the
  // migration's to edit, so each import there that stops resolving to what it named is reported.
  const pkg = enclosingPackage(root)
  if (pkg !== undefined) {
    const prefix = toPosix(relative(pkg, root))
    const inApp = new Set([...known].map((file) => `${prefix}/${file}`))
    const appPath = (file: string, specifier: string): string | undefined =>
      resolveIn(inApp, file, specifier)?.slice(prefix.length + 1)
    const outside = ` - it is outside ${prefix}/, so the migration does not rewrite it`
    for (const file of listFiles(pkg)) {
      if (file.startsWith(`${prefix}/`) || !/\.[cm]?[jt]sx?$/.test(file)) continue
      const text = readFileSync(join(pkg, file), "utf8")
      const at = toPosix(relative(root, join(pkg, file)))
      for (const { specifier } of importsOf(ts, file, text)) {
        const target = appPath(file, specifier)
        const to = target === undefined ? undefined : moveMap.get(target)
        if (to !== undefined)
          issues.push({
            file: at,
            reason: `imports "${specifier}", which moves to "${to}"${outside}`,
          })
      }
      const redirected = redirectMovedImports(
        ts,
        file,
        text,
        splitTarget(pkg, file, (specifier) => appPath(file, specifier)),
      )
      for (const { names, from, to } of redirected.redirects) {
        issues.push({
          file: at,
          reason: `imports ${names.map((name) => `"${name}"`).join(", ")} from "${from}"; import it from "${to}"${outside}`,
        })
      }
      for (const reason of redirected.issues) issues.push({ file: at, reason })
    }
  }

  // Paths a module finds at run time are not imports either: one built from the module's own location
  // now starts from its new folder, and a folder listed at run time loses whatever moved out of it.
  const leaving = new Map<string, Array<{ from: string; to: string }>>()
  for (const move of moves) {
    const own = unfollowed.get(move.to)
    if (own !== undefined) {
      issues.push({
        file: move.to,
        reason: `builds a path from its own location (${own}) that the migration could not re-point, and it moved from "${move.from}"; check that path by hand`,
      })
    }
    const dir = posix.dirname(move.from)
    if (dir === "." || ZONE_DIRS.has(dir.split("/")[0] ?? "") || inConfiguredFolder(move.from))
      continue
    leaving.set(dir, [...(leaving.get(dir) ?? []), move])
  }
  for (const [dir, group] of leaving) {
    const staying = files.filter(
      (f) => posix.dirname(f) === dir && !moveMap.has(f) && !isTestFile(f) && !f.endsWith(".d.ts"),
    )
    const first = group[0]
    if (staying.length === 0 || first === undefined) continue
    const others = group.length === 1 ? "" : ` with ${group.length - 1} other file(s)`
    const left =
      staying.length === 1
        ? `"${staying[0]}" stays`
        : `${staying.length} files such as "${staying[0]}" stay`
    issues.push({
      file: first.from,
      reason: `moves to "${first.to}"${others} but ${left} in ${dir}/; code or tooling that lists ${dir}/ no longer finds what moved - move the folder together by hand`,
    })
  }

  // The server refuses data a loader or action returns without an output schema; only the author
  // knows which fields the browser may see.
  for (const [file, text] of final) {
    if (!file.startsWith("routes/") || !/\.backend\.[cm]?[jt]s$/.test(file)) continue
    for (const { name, schema } of missingOutputSchemas(text)) {
      issues.push({
        file,
        reason: `exports ${name === "action" ? "an" : "a"} ${name} but no ${schema}, so data it returns fails the request. Declare what the browser may see: export const ${schema} = t.object({ ... }), or run \`nifra schemas --write\` after the migration to draft it from the ${name}'s return type`,
      })
    }
  }

  // Tooling that lists folders or globs, not files: the import rewrite above never sees it.
  const tooling: Array<{ file: string; change: string }> = []
  const toolingWrites = new Map<string, string>()
  const tsconfig = coverMovedFiles(ts, root, moves)
  if (tsconfig?.issue !== undefined) issues.push({ file: "tsconfig.json", reason: tsconfig.issue })
  if (tsconfig?.text !== undefined) {
    toolingWrites.set("tsconfig.json", tsconfig.text)
    tooling.push({ file: "tsconfig.json", change: `include += ${tsconfig.added.join(", ")}` })
  }
  for (const file of everyFile) {
    if (!TAILWIND_CONFIG.test(file)) continue
    const reason = staleContentGlobs(ts, readFileSync(join(root, file), "utf8"), moves)
    if (reason !== undefined) issues.push({ file, reason })
  }
  const gitignore = ignoreNifraState(root)
  if (gitignore !== undefined) {
    toolingWrites.set(".gitignore", gitignore)
    tooling.push({ file: ".gitignore", change: "ignore .nifra/ (dev and build state)" })
  }
  // `nifra check` reads the declaration statically; without it, a later routes/ or config would zone the app.
  const kind = api && createKindProbe(root)(root).kind === undefined ? declareApiKind(ts, root) : {}
  if (kind.issue !== undefined) issues.push({ file: "package.json", reason: kind.issue })
  if (kind.text !== undefined) {
    toolingWrites.set("package.json", kind.text)
    tooling.push({ file: "package.json", change: '"nifra": { "kind": "api" }' })
  }

  if (options.write === true) {
    for (const [file, text] of toolingWrites) writeFileSync(join(root, file), text)
    for (const [file, text] of final) {
      if (original.get(file) === text) continue
      const path = join(root, file)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
    }
    const vacated: string[] = []
    for (const file of original.keys()) {
      if (final.has(file)) continue
      rmSync(join(root, file), { force: true })
      vacated.push(file)
    }
    for (const { from, to } of moves) {
      if (original.has(from) || !existsSync(join(root, from))) continue
      mkdirSync(dirname(join(root, to)), { recursive: true })
      renameSync(join(root, from), join(root, to))
      vacated.push(from)
    }
    pruneVacatedDirs(root, vacated)
  }
  return {
    ok: issues.length === 0,
    write: options.write === true,
    mode,
    splits: splits.sort((a, b) => codeUnitOrder(a.file, b.file)),
    moves,
    rewritten: rewritten.sort(),
    tooling,
    issues,
  }
}

/** The app's `"nifra": { "zones": ... }`, so folders it already zones are left where they are. */
function appZones(root: string): ZoneConfig {
  const manifest = join(root, "package.json")
  if (!existsSync(manifest)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifest, "utf8"))
  } catch {
    return {}
  }
  const nifra =
    typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "nifra") : undefined
  const zones =
    typeof nifra === "object" && nifra !== null ? Reflect.get(nifra, "zones") : undefined
  return zones === undefined ? {} : parseZoneConfig(zones, manifest)
}

/** Whether a tsconfig `include` entry takes in `file` (app-relative), the way tsc reads it. */
function includes(pattern: string, file: string): boolean {
  let spec = pattern.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "")
  if (spec === "" || spec === ".") return true
  if (!/[*?]/.test(spec)) return file === spec || file.startsWith(`${spec}/`)
  if (spec.endsWith("**")) spec = `${spec}/*`
  else if (!/[*?.][^/]*$/.test(spec.slice(spec.lastIndexOf("/") + 1))) spec = `${spec}/**/*`
  return new Bun.Glob(spec).match(file)
}

/**
 * Add each zone folder that receives moved TypeScript to tsconfig `include`, editing only that array
 * so comments and layout survive. A tsconfig without `include` (or with only `extends`) is left
 * alone: tsc's default, or the base config, decides, and `nifra check` reports any folder left out.
 */
function coverMovedFiles(
  ts: typeof TS,
  root: string,
  moves: ReadonlyArray<{ readonly from: string; readonly to: string }>,
): { text?: string; added: string[]; issue?: string } | undefined {
  const path = join(root, "tsconfig.json")
  if (!existsSync(path)) return undefined
  const text = readFileSync(path, "utf8")
  const source = ts.parseJsonText(path, text)
  const top = source.statements[0]?.expression
  if (top === undefined || !ts.isObjectLiteralExpression(top))
    return { added: [], issue: "is not a JSON object; add the zone folders to its include by hand" }
  const include = jsonProperty(ts, top, "include")
  if (include === undefined) return undefined
  const array = include.initializer
  if (!ts.isArrayLiteralExpression(array))
    return { added: [], issue: '"include" is not an array; add the zone folders to it by hand' }
  const patterns = array.elements.filter(ts.isStringLiteral).map((element) => element.text)
  const added: string[] = []
  for (const { to } of moves) {
    if (!/\.(?:[cm]?ts|tsx)$/.test(to) || /\.d\.[cm]?ts$/.test(to)) continue
    const folder = to.split("/")[0] ?? to
    if (added.includes(folder) || patterns.some((pattern) => includes(pattern, to))) continue
    added.push(folder)
  }
  if (added.length === 0) return undefined
  added.sort(codeUnitOrder)
  const quoted = added.map((folder) => JSON.stringify(folder))
  const last = array.elements[array.elements.length - 1]
  if (last === undefined) {
    const at = array.getStart(source) + 1
    return { text: `${text.slice(0, at)}${quoted.join(", ")}${text.slice(at)}`, added }
  }
  let at = last.end
  const trailing = /^\s*,/.exec(text.slice(at))
  if (trailing !== null) at += trailing[0].length
  // A multi-line array gets one entry per line at the last element's indent, below any comment that
  // closes the last element's line; anything else gets them inline.
  if (text.slice(array.getStart(source), last.getStart(source)).includes("\n")) {
    const lineStart = text.lastIndexOf("\n", last.getStart(source)) + 1
    const indent = text.slice(lineStart, last.getStart(source)).match(/^\s*/)?.[0] ?? ""
    const newline = text.indexOf("\n", at)
    const eol = newline === -1 ? text.length : newline
    if (/^\s*(?:\/\/.*|\/\*.*\*\/\s*)?$/.test(text.slice(at, eol))) {
      const head =
        trailing !== null
          ? text.slice(0, eol)
          : `${text.slice(0, last.end)},${text.slice(last.end, eol)}`
      const entries = quoted.join(`,\n${indent}`)
      return {
        text: `${head}\n${indent}${entries}${trailing !== null ? "," : ""}${text.slice(eol)}`,
        added,
      }
    }
  }
  const insert = trailing !== null ? ` ${quoted.join(", ")},` : `, ${quoted.join(", ")}`
  return { text: `${text.slice(0, at)}${insert}${text.slice(at)}`, added }
}

const jsonProperty = (
  ts: typeof TS,
  object: TS.ObjectLiteralExpression,
  key: string,
): TS.PropertyAssignment | undefined =>
  object.properties.find(
    (property): property is TS.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      ts.isStringLiteral(property.name) &&
      property.name.text === key,
  )

/** `text` with `entry` as the last property of `object`, on its own line when the object spans lines. */
function insertProperty(
  source: TS.JsonSourceFile,
  text: string,
  object: TS.ObjectLiteralExpression,
  entry: string,
): string {
  const open = object.getStart(source)
  const last = object.properties[object.properties.length - 1]
  if (last === undefined) return `${text.slice(0, open)}{ ${entry} }${text.slice(object.end)}`
  const start = last.getStart(source)
  if (!text.slice(open, start).includes("\n")) {
    return `${text.slice(0, last.end)}, ${entry}${text.slice(last.end)}`
  }
  const indent = /^[ \t]*/.exec(text.slice(text.lastIndexOf("\n", start) + 1, start))?.[0] ?? ""
  return `${text.slice(0, last.end)},\n${indent}${entry}${text.slice(last.end)}`
}

/** The app's package.json with `"nifra": { "kind": "api" }` added, editing only where it goes. */
function declareApiKind(ts: typeof TS, root: string): { text?: string; issue?: string } {
  const path = join(root, "package.json")
  if (!existsSync(path)) {
    return {
      issue:
        'there is none in the app; declare "nifra": { "kind": "api" } in the package.json that governs it',
    }
  }
  const text = readFileSync(path, "utf8")
  const source = ts.parseJsonText(path, text)
  const top = source.statements[0]?.expression
  if (top === undefined || !ts.isObjectLiteralExpression(top))
    return { issue: 'is not a JSON object; add "nifra": { "kind": "api" } to it by hand' }
  const nifra = jsonProperty(ts, top, "nifra")
  if (nifra === undefined) {
    return { text: insertProperty(source, text, top, '"nifra": { "kind": "api" }') }
  }
  if (!ts.isObjectLiteralExpression(nifra.initializer))
    return { issue: '"nifra" is not an object; add "kind": "api" to it by hand' }
  return { text: insertProperty(source, text, nifra.initializer, '"kind": "api"') }
}

/** Tailwind `content` globs that matched a moved file at its old path and match nothing at its new one. */
function staleContentGlobs(
  ts: typeof TS,
  text: string,
  moves: ReadonlyArray<{ readonly from: string; readonly to: string }>,
): string | undefined {
  const globs: string[] = []
  const source = ts.createSourceFile("tailwind.config.ts", text, ts.ScriptTarget.Latest, true)
  const visit = (node: TS.Node): void => {
    if (ts.isStringLiteralLike(node) && /[*/]/.test(node.text) && !node.text.startsWith("!"))
      globs.push(node.text.replace(/^\.\//, ""))
    ts.forEachChild(node, visit)
  }
  visit(source)
  const matchers = globs.map((glob) => ({ glob, matcher: new Bun.Glob(glob) }))
  const lost = moves.filter(
    ({ from, to }) =>
      matchers.some(({ matcher }) => matcher.match(from)) &&
      !matchers.some(({ matcher }) => matcher.match(to)),
  )
  const first = lost[0]
  if (first === undefined) return undefined
  const folders = [...new Set(lost.map(({ to }) => to.split("/")[0] ?? to))].sort(codeUnitOrder)
  return `its content globs matched ${lost.length} file(s) that move, but none of their new paths (such as "${first.from}" -> "${first.to}"), so Tailwind would stop seeing their classes. Add globs for ${folders.map((folder) => `"./${folder}/**/*"`).join(", ")} (with the extensions you use)`
}

/**
 * `.nifra/` holds generated types, dev state and the dev server's launch token; none of it belongs in
 * git. The new `.gitignore` text when it is not ignored yet, else `undefined`.
 */
function ignoreNifraState(root: string): string | undefined {
  let exitCode: number | null = null
  try {
    exitCode = Bun.spawnSync(["git", "check-ignore", "-q", ".nifra/types"], {
      cwd: root,
      stdout: "ignore",
      stderr: "ignore",
    }).exitCode
  } catch {
    // No git installed: the same as no checkout.
  }
  if (exitCode === 0) return undefined
  const path = join(root, ".gitignore")
  const current = existsSync(path) ? readFileSync(path, "utf8") : ""
  // Outside a git checkout `check-ignore` cannot answer; the app's own file decides.
  if (exitCode !== 1 && /^\/?\.nifra(?:\/|\*|\/\*\*)?\s*$/m.test(current)) return undefined
  const separator = current === "" || current.endsWith("\n") ? "" : "\n"
  return `${current}${separator}.nifra/\n`
}

/** Remove each directory the run emptied, then each parent that leaves empty. A directory that was
 * empty before the run is the app's own, not the migration's to remove. */
function pruneVacatedDirs(root: string, vacated: Iterable<string>): void {
  const dirs = new Set<string>()
  for (const file of vacated) dirs.add(dirname(join(root, file)))
  // Deepest first, so a parent is judged after its emptied children are gone.
  for (const start of [...dirs].sort((a, b) => b.length - a.length)) {
    for (let dir = start; dir !== root && dir.startsWith(`${root}${sep}`); dir = dirname(dir)) {
      if (!existsSync(dir) || readdirSync(dir).length > 0) break
      rmdirSync(dir)
    }
  }
}

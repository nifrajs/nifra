/**
 * The module path a nifra config names, read from its source without running it. The loader reads a
 * string from the app root (`"./src/client.tsx"`, or an alias or package name the bundler resolves);
 * `resolve`/`join` from `node:path` of the config's own folder and literal segments, or
 * `fileURLToPath(new URL("x", import.meta.url))`, names a file relative to the config itself.
 */
import { posix } from "node:path"
import type * as TS from "typescript"

export interface StaticConfigPath {
  /** `"app"`: read from the app root as the loader reads a string. `"config"`: from the config's folder. */
  readonly base: "app" | "config"
  readonly path: string
  /** The string literal's text, quotes excluded, for an `"app"` path: [start, end). */
  readonly span?: readonly [number, number]
}

const OWN_DIR = new Set(["import.meta.dir", "import.meta.dirname", "__dirname"])
const PATH_MODULES = new Set(["node:path", "path", "node:path/posix", "path/posix"])
const URL_MODULES = new Set(["node:url", "url"])

interface PathBindings {
  /** Local names of `resolve` and `join`. */
  readonly calls: ReadonlySet<string>
  /** Default and namespace imports of `node:path`. */
  readonly namespaces: ReadonlySet<string>
  readonly fileURLToPath: ReadonlySet<string>
}

function pathBindings(ts: typeof TS, sf: TS.SourceFile): PathBindings {
  const calls = new Set<string>()
  const namespaces = new Set<string>()
  const fileURLToPath = new Set<string>()
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    const from = statement.moduleSpecifier.text
    const clause = statement.importClause
    if (clause === undefined || clause.isTypeOnly) continue
    const isPath = PATH_MODULES.has(from)
    if (!isPath && !URL_MODULES.has(from)) continue
    if (isPath && clause.name !== undefined) namespaces.add(clause.name.text)
    const bindings = clause.namedBindings
    if (bindings === undefined) continue
    if (ts.isNamespaceImport(bindings)) {
      if (isPath) namespaces.add(bindings.name.text)
      continue
    }
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue
      const imported = (element.propertyName ?? element.name).text
      if (isPath && (imported === "resolve" || imported === "join")) calls.add(element.name.text)
      else if (!isPath && imported === "fileURLToPath") fileURLToPath.add(element.name.text)
    }
  }
  return { calls, namespaces, fileURLToPath }
}

const unwrap = (ts: typeof TS, node: TS.Expression): TS.Expression => {
  let current = node
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current)
  )
    current = current.expression
  return current
}

const isLiteral = (
  ts: typeof TS,
  node: TS.Node | undefined,
): node is TS.StringLiteral | TS.NoSubstitutionTemplateLiteral =>
  node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))

/** A readable static path, normalized; `undefined` for an absolute one or a URL. */
function relativeSegments(segments: readonly string[]): string | undefined {
  if (segments.some((segment) => segment.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(segment)))
    return undefined
  const path = posix.normalize(posix.join(...segments))
  return path === "." ? undefined : path
}

/**
 * Create a reader for one config file. It answers for an expression the config exports, so a path
 * built any other way (a variable, `process.cwd()`, a template with substitutions) is `undefined`.
 */
export function configPathReader(
  ts: typeof TS,
  sf: TS.SourceFile,
): (node: TS.Expression | undefined) => StaticConfigPath | undefined {
  const bindings = pathBindings(ts, sf)
  const isPathCall = (callee: TS.Expression): boolean =>
    ts.isIdentifier(callee)
      ? bindings.calls.has(callee.text)
      : ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        bindings.namespaces.has(callee.expression.text) &&
        (callee.name.text === "resolve" || callee.name.text === "join")
  return (node) => {
    if (node === undefined) return undefined
    const value = unwrap(ts, node)
    if (isLiteral(ts, value))
      return { base: "app", path: value.text, span: [value.getStart(sf) + 1, value.getEnd() - 1] }
    if (!ts.isCallExpression(value)) return undefined
    const [first, ...rest] = value.arguments
    if (isPathCall(value.expression)) {
      if (first === undefined || !OWN_DIR.has(first.getText(sf)) || rest.length === 0)
        return undefined
      const segments: string[] = []
      for (const segment of rest) {
        if (!isLiteral(ts, segment)) return undefined
        segments.push(segment.text)
      }
      const path = relativeSegments(segments)
      return path === undefined ? undefined : { base: "config", path }
    }
    if (
      ts.isIdentifier(value.expression) &&
      bindings.fileURLToPath.has(value.expression.text) &&
      first !== undefined &&
      ts.isNewExpression(first) &&
      first.expression.getText(sf) === "URL" &&
      first.arguments?.length === 2 &&
      first.arguments[1]?.getText(sf) === "import.meta.url" &&
      isLiteral(ts, first.arguments[0])
    ) {
      const path = relativeSegments([first.arguments[0].text])
      return path === undefined ? undefined : { base: "config", path }
    }
    return undefined
  }
}

/** The `export const <name> = ...` initializer in a config, or `undefined`. */
export function exportedInitializer(
  ts: typeof TS,
  sf: TS.SourceFile,
  name: string,
): TS.Expression | undefined {
  for (const statement of sf.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    )
      continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name)
        return declaration.initializer
    }
  }
  return undefined
}

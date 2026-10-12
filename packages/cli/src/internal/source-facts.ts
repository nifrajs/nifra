import type * as TSApi from "typescript"
import { scriptKindOf } from "./script-kind.ts"
import type { TypeScriptApi } from "./typescript-import.ts"

/**
 * The deliberately small AST seam used by source lints. It is not a project-wide TypeScript
 * Program: a rule asks for a file only after its lexical fast path found a candidate. That keeps
 * cold checks and projects without a TypeScript install on the existing conservative path.
 */
export interface SourceFacts {
  parse(file: string, content: string): TSApi.SourceFile | undefined
  isValueImportAt(
    source: TSApi.SourceFile,
    position: number,
    specifier: string,
  ): boolean | undefined
  isRouteRegistrationAt(
    source: TSApi.SourceFile,
    position: number,
    method: string,
    path: string,
  ): boolean | undefined
  /** A `.method(argument, …)` member call whose first argument is written exactly as `argument`. */
  isRouteArgumentAt(
    source: TSApi.SourceFile,
    position: number,
    method: string,
    argument: string,
  ): boolean | undefined
  /** A call to the free function `callee` whose argument at `pathIndex` is the literal `path`. */
  isFunctionRouteCallAt(
    source: TSApi.SourceFile,
    position: number,
    callee: string,
    pathIndex: number,
    path: string,
  ): boolean | undefined
  isResponseSyntaxAt(source: TSApi.SourceFile, position: number): boolean | undefined
  /** Whether the `import` keyword at `position` starts a runtime `import(specifier)` call (true) or a
   * type-position `import("…")` such as `typeof import("x")` (false); undefined when neither. */
  isDynamicImportAt(
    source: TSApi.SourceFile,
    position: number,
    specifier: string,
  ): boolean | undefined
}

function nodeAt(ts: TypeScriptApi, source: TSApi.SourceFile, position: number): TSApi.Node {
  let best: TSApi.Node = source
  const visit = (node: TSApi.Node): void => {
    if (position < node.pos || position >= node.end) return
    best = node
    ts.forEachChild(node, visit)
  }
  visit(source)
  return best
}

function ancestorAt<T extends TSApi.Node>(
  ts: TypeScriptApi,
  source: TSApi.SourceFile,
  position: number,
  predicate: (node: TSApi.Node) => node is T,
): T | undefined {
  let node: TSApi.Node = nodeAt(ts, source, Math.max(0, Math.min(position, source.end - 1)))
  for (;;) {
    if (predicate(node)) return node
    if (node === source) return undefined
    node = node.parent
  }
}

function rawResponseExpression(ts: TypeScriptApi, node: TSApi.Expression): boolean {
  if (ts.isNewExpression(node)) {
    return ts.isIdentifier(node.expression) && node.expression.text === "Response"
  }
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false
  return (
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "Response" &&
    node.expression.name.text === "json"
  )
}

export interface SourceFactsOptions {
  /** Whether the compiler settings for a parsed file keep an import whose named specifiers are all
   * type-only (`verbatimModuleSyntax`). Without it such an import is erased. */
  readonly keepsTypeOnlyImports?: (file: string) => boolean
}

export function createSourceFacts(
  ts: TypeScriptApi,
  options: SourceFactsOptions = {},
): SourceFacts {
  const cache = new Map<string, { content: string; source: TSApi.SourceFile | undefined }>()
  // `{}` loads its module in every bundler; a list of type-only specifiers is erased unless the
  // compiler keeps it as `import {} from "x"`.
  const loadsModule = (
    source: TSApi.SourceFile,
    elements: readonly { readonly isTypeOnly: boolean }[],
  ): boolean =>
    elements.length === 0 ||
    elements.some((element) => !element.isTypeOnly) ||
    (options.keepsTypeOnlyImports?.(source.fileName) ?? false)

  const parse = (file: string, content: string): TSApi.SourceFile | undefined => {
    const cached = cache.get(file)
    if (cached?.content === content) return cached.source
    const kind = scriptKindOf(ts, file)
    let parsed: TSApi.SourceFile | undefined
    try {
      const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind)
      const diagnostics = (
        source as TSApi.SourceFile & { parseDiagnostics?: readonly TSApi.Diagnostic[] }
      ).parseDiagnostics
      parsed = diagnostics !== undefined && diagnostics.length > 0 ? undefined : source
    } catch {
      // TypeScript 7 parses only the files its session preloaded; a module reached by following an
      // import may not be one. Callers fall back to the lexical rule for a file with no tree.
      parsed = undefined
    }
    cache.set(file, { content, source: parsed })
    return parsed
  }

  const isValueImportAt = (
    source: TSApi.SourceFile,
    position: number,
    specifier: string,
  ): boolean | undefined => {
    const reexport = ancestorAt(ts, source, position, ts.isExportDeclaration)
    if (reexport !== undefined) {
      const from = reexport.moduleSpecifier
      if (from === undefined || !ts.isStringLiteral(from) || from.text !== specifier)
        return undefined
      if (reexport.isTypeOnly) return false
      const named = reexport.exportClause
      if (named !== undefined && ts.isNamedExports(named))
        return loadsModule(source, named.elements)
      return true // `export *` and `export * as ns`
    }
    const declaration = ancestorAt(ts, source, position, ts.isImportDeclaration)
    if (declaration === undefined || !ts.isStringLiteral(declaration.moduleSpecifier))
      return undefined
    if (declaration.moduleSpecifier.text !== specifier) return undefined
    const clause = declaration.importClause
    if (clause === undefined) return true // side-effect import
    if (clause.isTypeOnly) return false
    // A default binding is a runtime import whatever its named list holds.
    const named = clause.name === undefined ? clause.namedBindings : undefined
    if (named !== undefined && ts.isNamedImports(named)) return loadsModule(source, named.elements)
    return true // default and namespace bindings are runtime imports
  }

  const isRouteRegistrationAt = (
    source: TSApi.SourceFile,
    position: number,
    method: string,
    path: string,
  ): boolean | undefined => {
    const call = ancestorAt(ts, source, position, ts.isCallExpression)
    if (call === undefined || !ts.isPropertyAccessExpression(call.expression)) return false
    const name = call.expression.name.text.toUpperCase()
    const first = call.arguments[0]
    return (
      name === method && first !== undefined && ts.isStringLiteralLike(first) && first.text === path
    )
  }

  const isRouteArgumentAt = (
    source: TSApi.SourceFile,
    position: number,
    method: string,
    argument: string,
  ): boolean | undefined => {
    const call = ancestorAt(ts, source, position, ts.isCallExpression)
    if (call === undefined || !ts.isPropertyAccessExpression(call.expression)) return false
    const first = call.arguments[0]
    return (
      call.expression.name.text.toUpperCase() === method &&
      call.arguments.length > 1 &&
      first !== undefined &&
      first.getText(source) === argument
    )
  }

  const isFunctionRouteCallAt = (
    source: TSApi.SourceFile,
    position: number,
    callee: string,
    pathIndex: number,
    path: string,
  ): boolean | undefined => {
    const call = ancestorAt(ts, source, position, ts.isCallExpression)
    if (call === undefined || !ts.isIdentifier(call.expression)) return false
    const argument = call.arguments[pathIndex]
    return (
      call.expression.text === callee &&
      argument !== undefined &&
      ts.isStringLiteralLike(argument) &&
      argument.text === path
    )
  }

  const isResponseSyntaxAt = (source: TSApi.SourceFile, position: number): boolean | undefined => {
    const returnStatement = ancestorAt(ts, source, position, ts.isReturnStatement)
    if (returnStatement !== undefined) {
      return (
        returnStatement.expression !== undefined &&
        rawResponseExpression(ts, returnStatement.expression)
      )
    }
    const arrow = ancestorAt(ts, source, position, ts.isArrowFunction)
    if (arrow !== undefined && !ts.isBlock(arrow.body)) return rawResponseExpression(ts, arrow.body)
    return false
  }

  const isDynamicImportAt = (
    source: TSApi.SourceFile,
    position: number,
    specifier: string,
  ): boolean | undefined => {
    let node: TSApi.Node = nodeAt(ts, source, Math.max(0, Math.min(position, source.end - 1)))
    for (;;) {
      if (ts.isImportTypeNode(node)) return false
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0]
        if (
          argument === undefined ||
          !(ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
        ) {
          return undefined
        }
        return argument.text === specifier ? true : undefined
      }
      if (node === source) return undefined
      node = node.parent
    }
  }

  return {
    parse,
    isValueImportAt,
    isRouteRegistrationAt,
    isRouteArgumentAt,
    isFunctionRouteCallAt,
    isResponseSyntaxAt,
    isDynamicImportAt,
  }
}

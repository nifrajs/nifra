import type * as TSApi from "typescript"
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
  isResponseSyntaxAt(source: TSApi.SourceFile, position: number): boolean | undefined
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

function ancestorAt(
  ts: TypeScriptApi,
  source: TSApi.SourceFile,
  position: number,
  predicate: (node: TSApi.Node) => boolean,
): TSApi.Node | undefined {
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

export function createSourceFacts(ts: TypeScriptApi): SourceFacts {
  const cache = new Map<string, { content: string; source: TSApi.SourceFile | undefined }>()

  const parse = (file: string, content: string): TSApi.SourceFile | undefined => {
    const cached = cache.get(file)
    if (cached?.content === content) return cached.source
    const kind = /\.tsx?$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.JS
    const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind)
    const diagnostics = (
      source as TSApi.SourceFile & { parseDiagnostics?: readonly TSApi.Diagnostic[] }
    ).parseDiagnostics
    const parsed = diagnostics !== undefined && diagnostics.length > 0 ? undefined : source
    cache.set(file, { content, source: parsed })
    return parsed
  }

  const isValueImportAt = (
    source: TSApi.SourceFile,
    position: number,
    specifier: string,
  ): boolean | undefined => {
    const declaration = ancestorAt(ts, source, position, ts.isImportDeclaration) as
      | TSApi.ImportDeclaration
      | undefined
    if (declaration === undefined || !ts.isStringLiteral(declaration.moduleSpecifier))
      return undefined
    if (declaration.moduleSpecifier.text !== specifier) return undefined
    const clause = declaration.importClause
    if (clause === undefined) return true // side-effect import
    if (clause.isTypeOnly) return false
    if (clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
      return clause.namedBindings.elements.some((element) => !element.isTypeOnly)
    }
    return true // default and namespace bindings are runtime imports
  }

  const isRouteRegistrationAt = (
    source: TSApi.SourceFile,
    position: number,
    method: string,
    path: string,
  ): boolean | undefined => {
    const call = ancestorAt(ts, source, position, ts.isCallExpression) as
      | TSApi.CallExpression
      | undefined
    if (call === undefined || !ts.isPropertyAccessExpression(call.expression)) return false
    const name = call.expression.name.text.toUpperCase()
    const first = call.arguments[0]
    return (
      name === method && first !== undefined && ts.isStringLiteralLike(first) && first.text === path
    )
  }

  const isResponseSyntaxAt = (source: TSApi.SourceFile, position: number): boolean | undefined => {
    const returnStatement = ancestorAt(ts, source, position, ts.isReturnStatement) as
      | TSApi.ReturnStatement
      | undefined
    if (returnStatement !== undefined) {
      return (
        returnStatement.expression !== undefined &&
        rawResponseExpression(ts, returnStatement.expression)
      )
    }
    const arrow = ancestorAt(ts, source, position, ts.isArrowFunction) as
      | TSApi.ArrowFunction
      | undefined
    if (arrow !== undefined && !ts.isBlock(arrow.body)) return rawResponseExpression(ts, arrow.body)
    return false
  }

  return { parse, isValueImportAt, isRouteRegistrationAt, isResponseSyntaxAt }
}

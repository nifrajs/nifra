/**
 * The string value of each module-level `const` in a doc page, evaluated from its syntax tree the way
 * the page computes it: a string or template literal, a template over other evaluable consts,
 * `[...].join(literal)`, and `+` between evaluable parts. Shared by the LLM corpus generator and the
 * doc-sample typecheck, so both read the code a page shows, not a regex's guess at it.
 */
import ts from "typescript"

export interface DocConsts {
  /** Each const whose value could be evaluated. */
  readonly values: ReadonlyMap<string, string>
  /** Each other module-level const, with why it could not be. */
  readonly unresolved: ReadonlyMap<string, string>
  /** The source ranges of the evaluated declarations, so their text is never read as the page body. */
  readonly ranges: ReadonlyArray<readonly [number, number]>
}

export function evaluateDocConsts(file: string, src: string): DocConsts {
  const source = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const declared = new Map<string, ts.Expression>()
  const statements = new Map<string, ts.VariableStatement>()
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue
      declared.set(declaration.name.text, declaration.initializer)
      statements.set(declaration.name.text, statement)
    }
  }

  const values = new Map<string, string>()
  const unresolved = new Map<string, string>()
  const visiting = new Set<string>()
  const constValue = (name: string): string | undefined => {
    if (values.has(name)) return values.get(name)
    if (unresolved.has(name) || visiting.has(name)) return undefined
    const initializer = declared.get(name)
    if (initializer === undefined) return undefined
    visiting.add(name)
    const why: string[] = []
    const value = evaluate(initializer, why)
    visiting.delete(name)
    if (value === undefined) unresolved.set(name, why[0] ?? "not a string expression")
    else values.set(name, value)
    return value
  }

  const evaluate = (node: ts.Expression, why: string[]): string | undefined => {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node)
    )
      return evaluate(node.expression, why)
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
    if (ts.isIdentifier(node)) {
      const value = constValue(node.text)
      if (value === undefined) why.push(`${node.text} is not a string const of this page`)
      return value
    }
    if (ts.isTemplateExpression(node)) {
      let out = node.head.text
      for (const span of node.templateSpans) {
        const part = evaluate(span.expression, why)
        if (part === undefined) return undefined
        out += part + span.literal.text
      }
      return out
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = evaluate(node.left, why)
      const right = left === undefined ? undefined : evaluate(node.right, why)
      return left === undefined || right === undefined ? undefined : left + right
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "join" &&
      ts.isArrayLiteralExpression(node.expression.expression) &&
      node.arguments.length <= 1
    ) {
      const separator = node.arguments[0] === undefined ? "," : evaluate(node.arguments[0], why)
      if (separator === undefined) return undefined
      const items: string[] = []
      for (const element of node.expression.expression.elements) {
        if (ts.isSpreadElement(element)) {
          why.push("a spread inside the joined array")
          return undefined
        }
        const item = evaluate(element, why)
        if (item === undefined) return undefined
        items.push(item)
      }
      return items.join(separator)
    }
    why.push(`${ts.SyntaxKind[node.kind]} is not a string the page can show`)
    return undefined
  }

  for (const name of declared.keys()) constValue(name)
  // One statement may declare several consts; its range is listed once.
  const evaluated = new Set([...values.keys()].flatMap((name) => statements.get(name) ?? []))
  const ranges = [...evaluated].map(
    (statement) => [statement.getStart(source), statement.end] as const,
  )
  return { values, unresolved, ranges }
}

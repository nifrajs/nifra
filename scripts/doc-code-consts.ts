/**
 * The literal value of each module-level `const` in a doc page, evaluated from its syntax tree the
 * way the page computes it: strings and templates, `[...].join(literal)`, `+` between strings, and
 * two-column tuple rows for static tables. Shared by the LLM corpus generator and the doc-sample
 * typecheck, so both read the code a page shows, not a regex's guess at it.
 */
import ts from "typescript"

export interface DocConsts {
  /** Each const whose value could be evaluated as a string. */
  readonly values: ReadonlyMap<string, string>
  /** Each const whose value could be evaluated as literal two-column rows. */
  readonly tuples: ReadonlyMap<string, readonly (readonly [string, string])[]>
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

  type Evaluated = string | readonly (readonly [string, string])[]

  const values = new Map<string, string>()
  const tuples = new Map<string, readonly (readonly [string, string])[]>()
  const unresolved = new Map<string, string>()
  const evaluated = new Map<string, Evaluated>()
  const visiting = new Set<string>()

  const constEvaluated = (name: string): Evaluated | undefined => {
    if (evaluated.has(name)) return evaluated.get(name)
    if (unresolved.has(name) || visiting.has(name)) return undefined
    const initializer = declared.get(name)
    if (initializer === undefined) return undefined
    visiting.add(name)
    const why: string[] = []
    const value = evaluate(initializer, why)
    visiting.delete(name)
    if (value === undefined) unresolved.set(name, why[0] ?? "not a string expression")
    else {
      evaluated.set(name, value)
      if (typeof value === "string") values.set(name, value)
      else tuples.set(name, value)
    }
    return value
  }

  const constValue = (name: string): string | undefined => {
    const value = constEvaluated(name)
    return typeof value === "string" ? value : undefined
  }

  const evaluate = (node: ts.Expression, why: string[]): Evaluated | undefined => {
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
        if (typeof part !== "string") {
          if (part !== undefined) why.push("a template interpolation is not a string")
          return undefined
        }
        out += part + span.literal.text
      }
      return out
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = evaluate(node.left, why)
      const right = typeof left === "string" ? evaluate(node.right, why) : undefined
      if (typeof left !== "string" || typeof right !== "string") {
        if (left !== undefined && typeof left !== "string")
          why.push("a string expression contains literal rows")
        return undefined
      }
      return left + right
    }
    if (ts.isArrayLiteralExpression(node)) {
      const rows: Array<readonly [string, string]> = []
      for (const element of node.elements) {
        if (!ts.isArrayLiteralExpression(element) || element.elements.length !== 2) {
          why.push("an array contains a non-pair element")
          return undefined
        }
        const first = evaluate(element.elements[0], why)
        const second = evaluate(element.elements[1], why)
        if (typeof first !== "string" || typeof second !== "string") {
          why.push("a row contains a non-string value")
          return undefined
        }
        rows.push([first, second])
      }
      return rows
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "join" &&
      ts.isArrayLiteralExpression(node.expression.expression) &&
      node.arguments.length <= 1
    ) {
      const separatorValue =
        node.arguments[0] === undefined ? "," : evaluate(node.arguments[0], why)
      if (typeof separatorValue !== "string") return undefined
      const items: string[] = []
      for (const element of node.expression.expression.elements) {
        if (ts.isSpreadElement(element)) {
          why.push("a spread inside the joined array")
          return undefined
        }
        const item = evaluate(element, why)
        if (typeof item !== "string") return undefined
        items.push(item)
      }
      return items.join(separatorValue)
    }
    why.push(`${ts.SyntaxKind[node.kind]} is not a string the page can show`)
    return undefined
  }

  for (const name of declared.keys()) constEvaluated(name)
  // One statement may declare several consts; its range is listed once.
  const evaluatedStatements = new Set(
    [...evaluated.keys()].flatMap((name) => statements.get(name) ?? []),
  )
  const ranges = [...evaluatedStatements].map(
    (statement) => [statement.getStart(source), statement.end] as const,
  )
  return { values, tuples, unresolved, ranges }
}

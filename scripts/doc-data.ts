/**
 * The values a doc page imports from `site/shared/data/` - its benchmark numbers - and the calls its
 * prose makes to them, evaluated for the LLM corpus. The page computes those numbers when it renders;
 * the corpus is converted from source, so without this it carried the call text instead of the
 * number, or dropped the line as JSX residue.
 */
import { dirname, resolve } from "node:path"
import ts from "typescript"

/** Each value a page imports from a data module, by the name the page uses. */
export type DocData = ReadonlyMap<string, unknown>

/** The values `file` (an absolute path) imports from `shared/data/` modules; types are skipped. */
export async function docDataBindings(file: string, src: string): Promise<DocData> {
  const source = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const bindings = new Map<string, unknown>()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    const specifier = statement.moduleSpecifier.text
    if (!/\/shared\/data\/[\w-]+$/.test(specifier)) continue
    const clause = statement.importClause
    const named = clause?.namedBindings
    if (clause === undefined || clause.isTypeOnly || named === undefined) continue
    if (!ts.isNamedImports(named)) continue
    const exports: Record<string, unknown> = await import(resolve(dirname(file), specifier))
    for (const element of named.elements) {
      if (!element.isTypeOnly)
        bindings.set(element.name.text, exports[(element.propertyName ?? element.name).text])
    }
  }
  return bindings
}

// A JSX expression container holding one call, possibly across lines. Nothing inside may open a
// brace, so an arrow body or an object literal is never read as one.
const CALL_CONTAINER = /\{\s*([A-Za-z_$][\w$]*\s*\([^{}]*\))\s*\}/g

/**
 * `body` with each `{call(...)}` whose callee the page imports from a data module replaced by the
 * text it renders. A call to anything else is left as it was. A data call reading anything but
 * literals and other data values throws, naming the page: the corpus must say what the page says.
 */
export function evaluateDataCalls(file: string, body: string, data: DocData): string {
  if (data.size === 0) return body
  return body.replace(CALL_CONTAINER, (container, expression: string) => {
    const callee = /^[A-Za-z_$][\w$]*/.exec(expression)?.[0]
    return callee !== undefined && data.has(callee)
      ? evaluateCall(file, expression, data)
      : container
  })
}

function evaluateCall(file: string, expression: string, data: DocData): string {
  const source = ts.createSourceFile("expression.ts", `(${expression})`, ts.ScriptTarget.Latest)
  const statement = source.statements[0]
  if (statement === undefined || !ts.isExpressionStatement(statement))
    throw new Error(`${file}: {${expression}} is not an expression`)
  const value = (node: ts.Expression): unknown => {
    if (ts.isParenthesizedExpression(node)) return value(node.expression)
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
    if (ts.isNumericLiteral(node)) return Number(node.text)
    if (ts.isIdentifier(node) && data.has(node.text)) return data.get(node.text)
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = data.get(node.expression.text)
      if (typeof callee === "function") return callee(...node.arguments.map(value))
    }
    throw new Error(
      `${file}: {${expression}} reads ${ts.SyntaxKind[node.kind]}, which the corpus cannot evaluate`,
    )
  }
  const result = value(statement.expression)
  if (typeof result !== "string" && typeof result !== "number")
    throw new Error(`${file}: {${expression}} renders no text`)
  return String(result)
}

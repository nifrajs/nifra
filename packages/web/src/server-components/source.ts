import { createHash } from "node:crypto"
import { relative } from "node:path"
import type * as TS from "typescript"
import { ts } from "./typescript.ts"

export interface CompiledComponentModule {
  readonly code: string
  readonly references: Readonly<Record<string, string>>
}

export function componentReference(file: string, root: string, name: string): string {
  return (
    "sc_" +
    createHash("sha256")
      .update(`${relative(root, file).replaceAll("\\", "/")}#${name}`)
      .digest("hex")
      .slice(0, 32)
  )
}

export function sourceFile(source: string, file: string): TS.SourceFile {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

function modifier(node: TS.Node, kind: TS.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((item) => item.kind === kind) ?? false)
  )
}

function literal(node: TS.Expression): unknown {
  if (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node)
  )
    return literal(node.expression)
  if (ts.isStringLiteral(node)) return node.text
  if (!ts.isObjectLiteralExpression(node)) throw new Error("component_pipeline_literal")
  const result: Record<string, unknown> = Object.create(null)
  for (const member of node.properties) {
    if (
      !ts.isPropertyAssignment(member) ||
      !(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
    )
      throw new Error("component_pipeline_literal")
    if (
      Object.hasOwn(result, member.name.text) ||
      ["__proto__", "prototype", "constructor"].includes(member.name.text)
    )
      throw new Error("component_pipeline_literal")
    result[member.name.text] = literal(member.initializer)
  }
  return result
}

/** The `componentPipeline` a config module exports as a plain literal, read without running the
 * module, or `undefined` when it exports none or one that is not a literal. */
export function staticComponentPipeline(source: string, file: string): unknown {
  let pipeline: unknown
  for (const statement of sourceFile(source, file).statements) {
    if (!ts.isVariableStatement(statement) || !modifier(statement, ts.SyntaxKind.ExportKeyword))
      continue
    for (const variable of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(variable.name) ||
        variable.name.text !== "componentPipeline" ||
        variable.initializer === undefined
      )
        continue
      try {
        pipeline = literal(variable.initializer)
      } catch {
        return undefined
      }
    }
  }
  return pipeline
}

export function directive(file: TS.SourceFile, value: string): boolean {
  let found = false
  const visit = (node: TS.Node): void => {
    if (ts.isSourceFile(node) || ts.isBlock(node)) {
      for (const statement of node.statements) {
        if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break
        if (statement.expression.text === value) found = true
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

export function exportedValues(file: TS.SourceFile): readonly string[] {
  const names = new Set<string>()
  for (const statement of file.statements) {
    if (ts.isExportAssignment(statement)) {
      names.add("default")
      continue
    }
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue
      if (statement.exportClause === undefined || !ts.isNamedExports(statement.exportClause))
        throw new Error(
          "[nifra/components] Native client modules require explicit, schema-registered component exports",
        )
      for (const element of statement.exportClause.elements)
        if (!element.isTypeOnly) names.add(element.name.text)
    }
    if (!modifier(statement, ts.SyntaxKind.ExportKeyword)) continue
    if (modifier(statement, ts.SyntaxKind.DefaultKeyword)) {
      names.add("default")
      continue
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name))
          throw new Error("[nifra/components] Destructured component exports are unsupported")
        names.add(declaration.name.text)
      }
    } else if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      if (statement.name !== undefined) names.add(statement.name.text)
    }
  }
  return [...names]
}

export function compileComponentModule(
  source: string,
  file: string,
  root: string,
  environment: string,
  kind: "server" | "island" = "server",
): CompiledComponentModule {
  const ast = sourceFile(source, file)
  if (directive(ast, "use server"))
    throw new Error(
      "[nifra/components] Native use-server actions are unsupported; use a validated serverFn in a *.fn.ts module",
    )
  const factories = new Set<string>()
  const namespaces = new Set<string>()
  for (const statement of ast.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !==
        (kind === "server"
          ? "@nifrajs/web/server-components"
          : "@nifrajs/web/server-components/islands")
    )
      continue
    const bindings = statement.importClause?.namedBindings
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements)
        if (
          (element.propertyName ?? element.name).text ===
          (kind === "server" ? "defineServerComponent" : "defineClientIsland")
        )
          factories.add(element.name.text)
    } else if (bindings !== undefined && ts.isNamespaceImport(bindings))
      namespaces.add(bindings.name.text)
  }
  const definitions = new Map<string, TS.CallExpression>()
  for (const statement of ast.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      let expression = declaration.initializer
      while (
        expression !== undefined &&
        (ts.isAsExpression(expression) ||
          ts.isSatisfiesExpression(expression) ||
          ts.isParenthesizedExpression(expression))
      )
        expression = expression.expression
      if (
        !ts.isIdentifier(declaration.name) ||
        expression === undefined ||
        !ts.isCallExpression(expression)
      )
        continue
      const callee = expression.expression
      if (
        (ts.isIdentifier(callee) && factories.has(callee.text)) ||
        (ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          namespaces.has(callee.expression.text) &&
          callee.name.text === (kind === "server" ? "defineServerComponent" : "defineClientIsland"))
      ) {
        if (expression.arguments.length !== 1)
          throw new Error(
            "[nifra/components] Component references are generated by the compiler; remove the handwritten reference",
          )
        definitions.set(declaration.name.text, expression)
      }
    }
  }
  const references: Record<string, string> = Object.create(null)
  for (const statement of ast.statements) {
    if (ts.isVariableStatement(statement) && modifier(statement, ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !definitions.has(declaration.name.text))
          throw new Error(
            "[nifra/components] Only named defineServerComponent handles may be exported from *.component.server modules",
          )
        references[declaration.name.text] = componentReference(file, root, declaration.name.text)
      }
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      if (
        statement.moduleSpecifier !== undefined ||
        statement.exportClause === undefined ||
        !ts.isNamedExports(statement.exportClause)
      )
        throw new Error("[nifra/components] Re-export component handles through a separate barrel")
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly) continue
        const local = (element.propertyName ?? element.name).text
        if (!definitions.has(local))
          throw new Error("[nifra/components] A component module exported an unregistered value")
        references[element.name.text] = componentReference(file, root, local)
      }
    } else if (
      ts.isExportAssignment(statement) ||
      (modifier(statement, ts.SyntaxKind.ExportKeyword) &&
        !ts.isInterfaceDeclaration(statement) &&
        !ts.isTypeAliasDeclaration(statement))
    ) {
      throw new Error(
        "[nifra/components] Export named defineServerComponent handles from *.component.server modules",
      )
    }
  }
  if (Object.keys(references).length === 0)
    throw new Error("[nifra/components] A component module has no recognized server component")
  if (environment === "client" && kind === "server") {
    return {
      references,
      code: Object.entries(references)
        .map(
          ([name, reference]) =>
            `export const ${name} = Object.freeze({ reference: ${JSON.stringify(reference)} });`,
        )
        .join("\n"),
    }
  }
  let code = source
  for (const [name, call] of [...definitions].sort((a, b) => b[1].end - a[1].end)) {
    const argument = call.arguments[0]
    if (argument === undefined)
      throw new Error("[nifra/components] Missing server component definition")
    const at = argument.end
    code =
      code.slice(0, at) +
      ", " +
      JSON.stringify(componentReference(file, root, name)) +
      code.slice(at)
  }
  return { code, references }
}

export function guardCreateElementCalls(source: string, file: string): string {
  const ast = sourceFile(source, file)
  const namespaces = new Set<string>()
  const factories = new Set<string>()
  for (const statement of ast.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "react"
    )
      continue
    if (statement.importClause?.name !== undefined) namespaces.add(statement.importClause.name.text)
    const bindings = statement.importClause?.namedBindings
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
    if (bindings !== undefined && ts.isNamedImports(bindings))
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === "createElement")
          factories.add(element.name.text)
      }
  }
  const changes: Array<{ start: number; end: number }> = []
  const visit = (node: TS.Node): void => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression
      const named = ts.isIdentifier(expression) && factories.has(expression.text)
      const member =
        ts.isPropertyAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        namespaces.has(expression.expression.text) &&
        expression.name.text === "createElement"
      const computed =
        ts.isElementAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        namespaces.has(expression.expression.text) &&
        ts.isStringLiteral(expression.argumentExpression) &&
        expression.argumentExpression.text === "createElement"
      if (named || member || computed)
        changes.push({ start: expression.getStart(ast), end: expression.end })
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  if (changes.length === 0) return source
  const identifier = `__nifra_guardedCreateElement_${createHash("sha256").update(file).digest("hex").slice(0, 12)}`
  let code = source
  for (const change of changes.sort((a, b) => b.start - a.start))
    code = code.slice(0, change.start) + identifier + code.slice(change.end)
  return (
    `import { guardedCreateElement as ${identifier} } from "@nifrajs/web-react/server-components/guard";\n` +
    code
  )
}

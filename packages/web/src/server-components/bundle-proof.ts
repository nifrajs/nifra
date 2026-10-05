import ts from "typescript"

/** RSC rewrites chunks after linking; inspect emitted imports rather than stale chunk metadata. */
export function componentBundleImports(code: string): readonly string[] {
  const imports = new Set<string>()
  const source = ts.createSourceFile(
    "component-bundle.js",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  )
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      imports.add(node.moduleSpecifier.text)
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const argument = node.arguments[0]
      if (argument !== undefined && ts.isStringLiteralLike(argument)) imports.add(argument.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return [...imports]
}

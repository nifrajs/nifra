import type * as TS from "typescript"

/**
 * The local names a file imports `exportName` under from the modules `isModule` accepts, and the
 * local names it imports those modules under as a namespace.
 */
export function importedAs(
  ts: typeof TS,
  tree: TS.SourceFile,
  isModule: (specifier: string) => boolean,
  exportName: string,
): { readonly locals: Set<string>; readonly namespaces: Set<string> } {
  const locals = new Set<string>()
  const namespaces = new Set<string>()
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier))
      continue
    if (!isModule(statement.moduleSpecifier.text)) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined) continue
    if (ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
    else {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === exportName)
          locals.add(element.name.text)
      }
    }
  }
  return { locals, namespaces }
}

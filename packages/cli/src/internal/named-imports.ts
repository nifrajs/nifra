import type * as TS from "typescript"

/** The local names `source` imports from a specifier matching `from`, by the imported name in `wanted`. */
export function importedNames(
  ts: typeof TS,
  source: TS.SourceFile,
  from: RegExp,
  wanted: readonly string[],
): ReadonlyMap<string, string> {
  const names = new Map<string, string>()
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !from.test(statement.moduleSpecifier.text)
    )
      continue
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      const original = (element.propertyName ?? element.name).text
      if (wanted.includes(original)) names.set(element.name.text, original)
    }
  }
  return names
}

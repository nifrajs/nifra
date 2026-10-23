import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { discoverRoutes } from "@nifrajs/web/fs"
import type * as TSApi from "typescript"
import { type Diagnostic, diagnostic } from "../diagnostics.ts"
import { codeUnitOrder } from "../internal/code-unit-order.ts"
import { scriptKindOf } from "../internal/script-kind.ts"
import type { CheckRule } from "./index.ts"
import { lineOf } from "./islands.ts"
import { loadRuleTypeScript } from "./typescript.ts"

/** The module whose calls read the visitor's request from async context. */
export const REQUEST_READ_MODULE = "@nifrajs/middleware/context-storage"
const REQUEST_READS: ReadonlySet<string> = new Set(["getContext", "tryGetContext"])
const SCRIPT_PAGE = /\.[cm]?[jt]sx?$/

/** Each local name `tree` imports a request read under, mapped to the export it names. */
export function requestReadImports(
  ts: typeof TSApi,
  tree: TSApi.SourceFile,
): ReadonlyMap<string, string> {
  const names = new Map<string, string>()
  for (const statement of tree.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== REQUEST_READ_MODULE
    )
      continue
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text
      if (REQUEST_READS.has(imported)) names.set(element.name.text, imported)
    }
  }
  return names
}

/** Each call in `tree` of a name `reads` holds. */
export function requestReadCalls(
  ts: typeof TSApi,
  tree: TSApi.SourceFile,
  reads: ReadonlyMap<string, string>,
): TSApi.CallExpression[] {
  const calls: TSApi.CallExpression[] = []
  if (reads.size === 0) return calls
  const visit = (node: TSApi.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      reads.has(node.expression.text)
    )
      calls.push(node)
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return calls
}

const exportsShellLoader = (ts: typeof TSApi, tree: TSApi.SourceFile): boolean =>
  tree.statements.some((statement) => {
    if (ts.isExportDeclaration(statement))
      return (
        statement.exportClause !== undefined &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.some((element) => element.name.text === "shellLoader")
      )
    const exported = (node: TSApi.FunctionDeclaration | TSApi.VariableStatement): boolean =>
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
    if (ts.isFunctionDeclaration(statement))
      return exported(statement) && statement.name?.text === "shellLoader"
    return (
      ts.isVariableStatement(statement) &&
      exported(statement) &&
      statement.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) && declaration.name.text === "shellLoader",
      )
    )
  })

/**
 * NF-C053: a partially prerendered page (its backend half exports `shellLoader`) reads the visitor's
 * request through `getContext()` or `tryGetContext()`. Its shell is built once and served to every
 * visitor, so the shell check refuses it; this reports each read before a build runs that check.
 */
export const shellRequestReadRule: CheckRule = {
  code: "NF-C053",
  title: "Partially prerendered page reads the request",
  async scan(ctx) {
    const routesDir = join(ctx.root, "routes")
    if (!existsSync(routesDir)) return []
    let manifest: ReturnType<typeof discoverRoutes>
    try {
      manifest = discoverRoutes(routesDir)
    } catch {
      return []
    }
    const routes = manifest.routes.filter(
      (route) => route.backend !== undefined && SCRIPT_PAGE.test(route.file),
    )
    if (routes.length === 0) return []
    const loaded = await loadRuleTypeScript(ctx)
    const ts = loaded.compiler
    if (ts === undefined) return []
    const parse = (file: string): TSApi.SourceFile =>
      ts.createSourceFile(
        file,
        readFileSync(join(routesDir, file), "utf8"),
        ts.ScriptTarget.Latest,
        true,
        scriptKindOf(ts, file),
      )
    const findings: Diagnostic[] = []
    for (const route of routes.sort((a, b) => codeUnitOrder(a.file, b.file))) {
      const backend = route.backend
      if (backend === undefined) continue
      const page = parse(route.file)
      const reads = requestReadImports(ts, page)
      const calls = requestReadCalls(ts, page, reads)
      if (calls.length === 0 || !exportsShellLoader(ts, parse(backend))) continue
      for (const call of calls) {
        const name = call.expression.getText(page)
        findings.push(
          diagnostic({
            code: "NF-C053",
            severity: "error",
            file: `routes/${route.file}`,
            line: lineOf(page, call),
            message: `routes/${route.file} calls ${name}() in a partially prerendered page. Its shell is built once and served to every visitor, so the shell check refuses a page that reads the request. Read it in a dynamic hole's loader, and render what uses it in that hole.`,
            evidence: [`read: ${name}()`, `shell: routes/${backend} exports shellLoader`],
            fix: { recipe: "ppr.read-to-hole", command: "nifra fix --code NF-C053" },
            verify: "nifra check",
          }),
        )
      }
    }
    return findings
  },
}

export const pprRules = Object.freeze([shellRequestReadRule])

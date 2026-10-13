import type * as TSApi from "typescript"
import { type Diagnostic, diagnostic } from "../diagnostics.ts"
import { scriptKindOf } from "../internal/script-kind.ts"
import type { TypeScriptApi } from "../internal/typescript-import.ts"
import { commentBlockExpectation } from "./comment-markers.ts"
import type { CheckRule } from "./index.ts"
import { loadRuleTypeScript } from "./typescript.ts"

const ROUTE_STATEMENT_EXPECTATION = ["NF-C045", "route-statement"]
const SERVER_FACTORY = /(?<![.\w$])(?:server|createWebApp)\s*\(/

/** The `Server` methods whose return type is the only place the route they add is recorded. */
const REGISTRY_METHODS: ReadonlySet<string> = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "sse",
  "ws",
  "tool",
  "group",
  "merge",
])

function unwrap(ts: TypeScriptApi, node: TSApi.Expression): TSApi.Expression {
  let current = node
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  )
    current = current.expression
  return current
}

/** The member calls of a chain, outermost first, and the expression it starts from. */
function chainOf(
  ts: TypeScriptApi,
  expression: TSApi.Expression,
): { readonly calls: readonly TSApi.CallExpression[]; readonly root: TSApi.Expression } {
  const calls: TSApi.CallExpression[] = []
  let current = unwrap(ts, expression)
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    calls.push(current)
    current = unwrap(ts, current.expression.expression)
  }
  return { calls, root: current }
}

function isServerFactoryCall(ts: TypeScriptApi, node: TSApi.Expression): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    (node.expression.text === "server" || node.expression.text === "createWebApp")
  )
}

/** Names bound to a `server(...)`/`createWebApp(...)` chain whose type leaves the file: exported, or
 * read by a `typeof` (the shape `client<typeof app>` and `export type App = typeof app` take). */
function typedServerBindings(ts: TypeScriptApi, tree: TSApi.SourceFile): ReadonlySet<string> {
  const servers = new Set<string>()
  const exported = new Set<string>()
  const typed = new Set<string>()
  const isExported = (modifiers: readonly TSApi.ModifierLike[] | undefined): boolean =>
    modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
  const visit = (node: TSApi.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      isServerFactoryCall(ts, chainOf(ts, node.initializer).root)
    )
      servers.add(node.name.text)
    else if (ts.isVariableStatement(node) && isExported(node.modifiers)) {
      for (const declaration of node.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) exported.add(declaration.name.text)
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier === undefined &&
      node.exportClause !== undefined &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const element of node.exportClause.elements)
        exported.add((element.propertyName ?? element.name).text)
    } else if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression))
      exported.add(node.expression.text)
    else if (ts.isTypeQueryNode(node) && ts.isIdentifier(node.exprName))
      typed.add(node.exprName.text)
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return new Set([...servers].filter((name) => exported.has(name) || typed.has(name)))
}

function routeLabel(ts: TypeScriptApi, call: TSApi.CallExpression, method: string): string {
  const first = call.arguments[0]
  return first !== undefined && ts.isStringLiteralLike(first)
    ? `${method}("${first.text}", ...)`
    : `${method}(...)`
}

/**
 * NF-C045: a route added to a typed server as its own statement - `app.get("/x", h)` on a line of its
 * own, its result unused. Each registration returns a NEW type that records the route, so the statement
 * registers the route at runtime while `typeof app` - what the typed client and an `App` export read -
 * never contains it, and the client call fails to compile with no hint why. Reported only for a binding
 * whose type leaves the file (exported, or read by `typeof`); a server nothing types is unaffected.
 */
export const routeStatementRule: CheckRule = {
  code: "NF-C045",
  title: "Route registered outside the typed chain",
  async scan(ctx) {
    const loaded = await loadRuleTypeScript(ctx)
    if (loaded.diagnostics !== undefined) return loaded.diagnostics
    // Without TypeScript there is no typed client to keep in step.
    const ts = loaded.compiler
    if (ts === undefined) return []
    const findings: Diagnostic[] = []
    for (const file of ctx.project.source.files) {
      if (!/\.[cm]?tsx?$/.test(file)) continue
      const text = ctx.project.source.read(file)
      if (text === undefined || !SERVER_FACTORY.test(text)) continue
      const tree = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
        scriptKindOf(ts, file),
      )
      const bindings = typedServerBindings(ts, tree)
      if (bindings.size === 0) continue
      const lines = text.split("\n")
      for (const statement of tree.statements) {
        if (!ts.isExpressionStatement(statement)) continue
        const { calls, root } = chainOf(ts, statement.expression)
        if (!ts.isIdentifier(root) || !bindings.has(root.text)) continue
        // Innermost first: the route the statement adds before anything chained after it.
        const registration = [...calls].reverse().find((call) => {
          const callee = call.expression
          return ts.isPropertyAccessExpression(callee) && REGISTRY_METHODS.has(callee.name.text)
        })
        if (registration === undefined || !ts.isPropertyAccessExpression(registration.expression))
          continue
        const line = tree.getLineAndCharacterOfPosition(statement.getStart(tree)).line + 1
        if (commentBlockExpectation(lines, line, ROUTE_STATEMENT_EXPECTATION)?.reason !== undefined)
          continue
        const name = root.text
        const route = routeLabel(ts, registration, registration.expression.name.text)
        findings.push(
          diagnostic({
            code: "NF-C045",
            severity: "warn",
            file,
            line,
            message: `\`${name}.${route}\` is a statement of its own, so \`typeof ${name}\` does not include it: the route runs, but the typed client built from \`typeof ${name}\` has no such call. Chain it onto the server's declaration, or merge() a server that declares it.`,
            evidence: [
              "each route registration returns a new type that records the route; a discarded result drops it",
              `\`${name}\` is exported or read by \`typeof\`, so its type is what a typed client sees`,
              "a route kept off the type on purpose: `// nifra-expect NF-C045: <reason>` above the statement",
            ],
            verify: "nifra check",
          }),
        )
      }
    }
    return findings
  },
}

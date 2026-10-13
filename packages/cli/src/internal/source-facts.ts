import type * as TSApi from "typescript"
import { scriptKindOf } from "./script-kind.ts"
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
  /** A `.method(argument, …)` member call whose first argument is written exactly as `argument`. */
  isRouteArgumentAt(
    source: TSApi.SourceFile,
    position: number,
    method: string,
    argument: string,
  ): boolean | undefined
  /** A call to the free function `callee` whose argument at `pathIndex` is the literal `path`. */
  isFunctionRouteCallAt(
    source: TSApi.SourceFile,
    position: number,
    callee: string,
    pathIndex: number,
    path: string,
  ): boolean | undefined
  isResponseSyntaxAt(source: TSApi.SourceFile, position: number): boolean | undefined
  /**
   * Whether `position` lies in a route handler: a function passed to `.get("/path", …)` and the
   * other method registrations, a function value of an `implement(contract, {...})` map, a local
   * function either one names, or a local function a handler returns a call to (one hop).
   */
  isRouteHandlerAt(source: TSApi.SourceFile, position: number): boolean
  /**
   * Positions of the values route handlers return that are a raw `Response` the lexical pattern
   * cannot see: a local `const` holding one, the context's `json()`/`text()` from a registered
   * handler, or a call to an imported function `importReturnsResponse` answers for.
   */
  indirectResponseReturns(
    source: TSApi.SourceFile,
    importReturnsResponse?: (specifier: string, name: string) => boolean,
  ): readonly number[]
  /** Whether the function `source` exports as `name` returns a raw `Response` on some path. */
  exportReturnsResponse(source: TSApi.SourceFile, name: string): boolean
  /** Whether the `import` keyword at `position` starts a runtime `import(specifier)` call (true) or a
   * type-position `import("…")` such as `typeof import("x")` (false); undefined when neither. */
  isDynamicImportAt(
    source: TSApi.SourceFile,
    position: number,
    specifier: string,
  ): boolean | undefined
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

function ancestorAt<T extends TSApi.Node>(
  ts: TypeScriptApi,
  source: TSApi.SourceFile,
  position: number,
  predicate: (node: TSApi.Node) => node is T,
): T | undefined {
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

const REGISTRATION_METHODS: ReadonlySet<string> = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "all",
])

function unwrapExpression(ts: TypeScriptApi, node: TSApi.Expression): TSApi.Expression {
  let current = node
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isAwaitExpression(current)
  )
    current = current.expression
  return current
}

type FunctionNode =
  | TSApi.ArrowFunction
  | TSApi.FunctionExpression
  | TSApi.FunctionDeclaration
  | TSApi.MethodDeclaration

function isFunctionValue(ts: TypeScriptApi, node: TSApi.Node): node is FunctionNode {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)
}

/** Local functions by name; a name declared twice keeps both, which only ever adds findings. */
function localFunctions(
  ts: TypeScriptApi,
  source: TSApi.SourceFile,
): ReadonlyMap<string, readonly FunctionNode[]> {
  const locals = new Map<string, FunctionNode[]>()
  const declare = (name: string, fn: FunctionNode): void => {
    locals.set(name, [...(locals.get(name) ?? []), fn])
  }
  const collect = (node: TSApi.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) declare(node.name.text, node)
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = unwrapExpression(ts, node.initializer)
      if (isFunctionValue(ts, value)) declare(node.name.text, value)
    }
    ts.forEachChild(node, collect)
  }
  collect(source)
  return locals
}

/** The values `fn` itself returns: a concise arrow body, or each `return` outside nested functions. */
function returnedValues(ts: TypeScriptApi, fn: FunctionNode): readonly TSApi.Expression[] {
  const body = fn.body
  if (body === undefined) return []
  if (!ts.isBlock(body)) return [body]
  const values: TSApi.Expression[] = []
  // The facade over TypeScript 7 guarantees `isFunctionLike`; a class method is function-like too.
  const visit = (node: TSApi.Node): void => {
    if (ts.isFunctionLike(node)) return
    if (ts.isReturnStatement(node) && node.expression !== undefined) values.push(node.expression)
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(body, visit)
  return values
}

/** Local variables of `fn` (outside nested functions) initialised with a raw `Response`. */
function responseBindings(ts: TypeScriptApi, fn: FunctionNode): ReadonlySet<string> {
  const names = new Set<string>()
  const visit = (node: TSApi.Node): void => {
    if (ts.isFunctionLike(node)) return
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      rawResponseExpression(ts, unwrapExpression(ts, node.initializer))
    )
      names.add(node.name.text)
    ts.forEachChild(node, visit)
  }
  if (fn.body !== undefined) ts.forEachChild(fn.body, visit)
  return names
}

/** Whether a value `fn` returns is a raw `Response`, written there or held in a local variable. */
function returnsRawResponse(ts: TypeScriptApi, fn: FunctionNode): boolean {
  const bindings = responseBindings(ts, fn)
  return returnedValues(ts, fn).some((value) => {
    const unwrapped = unwrapExpression(ts, value)
    return (
      rawResponseExpression(ts, unwrapped) ||
      (ts.isIdentifier(unwrapped) && bindings.has(unwrapped.text))
    )
  })
}

/** Value imports from relative modules, by local name: `import { json as reply } from "./http"`. */
function relativeImports(
  ts: TypeScriptApi,
  source: TSApi.SourceFile,
): ReadonlyMap<string, { readonly specifier: string; readonly name: string }> {
  const imports = new Map<string, { readonly specifier: string; readonly name: string }>()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    const specifier = statement.moduleSpecifier.text
    const clause = statement.importClause
    if (!specifier.startsWith(".") || clause === undefined || clause.isTypeOnly) continue
    const named = clause.namedBindings
    if (named === undefined || !ts.isNamedImports(named)) continue
    for (const element of named.elements) {
      if (element.isTypeOnly) continue
      const name = (element.propertyName ?? element.name).text
      imports.set(element.name.text, { specifier, name })
    }
  }
  return imports
}

/** The local name `source` exports as `name`: an exported declaration, or `export { local as name }`. */
function exportedLocal(
  ts: TypeScriptApi,
  source: TSApi.SourceFile,
  name: string,
): string | undefined {
  const exported = (modifiers: readonly TSApi.ModifierLike[] | undefined): boolean =>
    modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      if (statement.name?.text === name && exported(statement.modifiers)) return name
    } else if (ts.isVariableStatement(statement)) {
      const declarations = statement.declarationList.declarations
      if (
        exported(statement.modifiers) &&
        declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === name)
      )
        return name
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier === undefined &&
      !statement.isTypeOnly &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements)
        if (element.name.text === name && !element.isTypeOnly)
          return (element.propertyName ?? element.name).text
    }
  }
  return undefined
}

interface RouteHandlerSets {
  /** Functions a route registration or an `implement()` map passes: their first parameter is the context. */
  readonly direct: ReadonlySet<FunctionNode>
  /** Local functions a direct handler returns a call to (one hop). */
  readonly returned: ReadonlySet<FunctionNode>
  /** {@link direct} and {@link returned} together. */
  readonly all: ReadonlySet<TSApi.Node>
}

/** Every route handler of `source`, by the rules {@link SourceFacts.isRouteHandlerAt} states. */
function routeHandlers(ts: TypeScriptApi, source: TSApi.SourceFile): RouteHandlerSets {
  const locals = localFunctions(ts, source)
  const handlers = new Set<FunctionNode>()
  const named = (expression: TSApi.Node): readonly FunctionNode[] => {
    if (ts.isIdentifier(expression)) return locals.get(expression.text) ?? []
    return isFunctionValue(ts, expression) ? [expression] : []
  }
  const find = (node: TSApi.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined
      const [first, ...rest] = node.arguments
      if (
        method !== undefined &&
        REGISTRATION_METHODS.has(method) &&
        first !== undefined &&
        (ts.isStringLiteralLike(first) || ts.isTemplateExpression(first))
      ) {
        for (const argument of rest)
          for (const fn of named(unwrapExpression(ts, argument))) handlers.add(fn)
      }
      const implement =
        (ts.isIdentifier(callee) && callee.text === "implement") || method === "implement"
      const map =
        node.arguments[1] === undefined ? undefined : unwrapExpression(ts, node.arguments[1])
      if (implement && map !== undefined && ts.isObjectLiteralExpression(map)) {
        for (const property of map.properties) {
          if (ts.isMethodDeclaration(property)) handlers.add(property)
          else if (ts.isPropertyAssignment(property))
            for (const fn of named(unwrapExpression(ts, property.initializer))) handlers.add(fn)
          else if (ts.isShorthandPropertyAssignment(property))
            for (const fn of locals.get(property.name.text) ?? []) handlers.add(fn)
        }
      }
    }
    ts.forEachChild(node, find)
  }
  find(source)

  // One hop: a local function a handler returns a call to answers for that handler.
  const returned = new Set<FunctionNode>()
  const follow = (node: TSApi.Node): void => {
    const value =
      ts.isReturnStatement(node) && node.expression !== undefined
        ? node.expression
        : ts.isArrowFunction(node) && !ts.isBlock(node.body)
          ? node.body
          : undefined
    const call = value === undefined ? undefined : unwrapExpression(ts, value)
    if (call !== undefined && ts.isCallExpression(call))
      for (const fn of named(call.expression)) returned.add(fn)
    ts.forEachChild(node, follow)
  }
  for (const handler of handlers) follow(handler)
  const all = new Set<TSApi.Node>(handlers)
  for (const fn of returned) all.add(fn)
  return { direct: handlers, returned, all }
}

/** `c.json(…)`/`c.text(…)` on the handler's own context parameter: both build a plain `Response`. */
function contextResponseCall(
  ts: TypeScriptApi,
  handler: FunctionNode,
  value: TSApi.Expression,
): boolean {
  const context = handler.parameters[0]?.name
  if (context === undefined || !ts.isIdentifier(context)) return false
  if (!ts.isCallExpression(value) || !ts.isPropertyAccessExpression(value.expression)) return false
  const target = value.expression.expression
  const method = value.expression.name.text
  return (
    ts.isIdentifier(target) &&
    target.text === context.text &&
    (method === "json" || method === "text")
  )
}

export interface SourceFactsOptions {
  /** Whether the compiler settings for a parsed file keep an import whose named specifiers are all
   * type-only (`verbatimModuleSyntax`). Without it such an import is erased. */
  readonly keepsTypeOnlyImports?: (file: string) => boolean
}

export function createSourceFacts(
  ts: TypeScriptApi,
  options: SourceFactsOptions = {},
): SourceFacts {
  const cache = new Map<string, { content: string; source: TSApi.SourceFile | undefined }>()
  // `{}` loads its module in every bundler; a list of type-only specifiers is erased unless the
  // compiler keeps it as `import {} from "x"`.
  const loadsModule = (
    source: TSApi.SourceFile,
    elements: readonly { readonly isTypeOnly: boolean }[],
  ): boolean =>
    elements.length === 0 ||
    elements.some((element) => !element.isTypeOnly) ||
    (options.keepsTypeOnlyImports?.(source.fileName) ?? false)

  const parse = (file: string, content: string): TSApi.SourceFile | undefined => {
    const cached = cache.get(file)
    if (cached?.content === content) return cached.source
    const kind = scriptKindOf(ts, file)
    let parsed: TSApi.SourceFile | undefined
    try {
      const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind)
      const diagnostics = (
        source as TSApi.SourceFile & { parseDiagnostics?: readonly TSApi.Diagnostic[] }
      ).parseDiagnostics
      parsed = diagnostics !== undefined && diagnostics.length > 0 ? undefined : source
    } catch {
      // TypeScript 7 parses only the files its session preloaded; a module reached by following an
      // import may not be one. Callers fall back to the lexical rule for a file with no tree.
      parsed = undefined
    }
    cache.set(file, { content, source: parsed })
    return parsed
  }

  const isValueImportAt = (
    source: TSApi.SourceFile,
    position: number,
    specifier: string,
  ): boolean | undefined => {
    const reexport = ancestorAt(ts, source, position, ts.isExportDeclaration)
    if (reexport !== undefined) {
      const from = reexport.moduleSpecifier
      if (from === undefined || !ts.isStringLiteral(from) || from.text !== specifier)
        return undefined
      if (reexport.isTypeOnly) return false
      const named = reexport.exportClause
      if (named !== undefined && ts.isNamedExports(named))
        return loadsModule(source, named.elements)
      return true // `export *` and `export * as ns`
    }
    const declaration = ancestorAt(ts, source, position, ts.isImportDeclaration)
    if (declaration === undefined || !ts.isStringLiteral(declaration.moduleSpecifier))
      return undefined
    if (declaration.moduleSpecifier.text !== specifier) return undefined
    const clause = declaration.importClause
    if (clause === undefined) return true // side-effect import
    if (clause.isTypeOnly) return false
    // A default binding is a runtime import whatever its named list holds.
    const named = clause.name === undefined ? clause.namedBindings : undefined
    if (named !== undefined && ts.isNamedImports(named)) return loadsModule(source, named.elements)
    return true // default and namespace bindings are runtime imports
  }

  const isRouteRegistrationAt = (
    source: TSApi.SourceFile,
    position: number,
    method: string,
    path: string,
  ): boolean | undefined => {
    const call = ancestorAt(ts, source, position, ts.isCallExpression)
    if (call === undefined || !ts.isPropertyAccessExpression(call.expression)) return false
    const name = call.expression.name.text.toUpperCase()
    const first = call.arguments[0]
    return (
      name === method && first !== undefined && ts.isStringLiteralLike(first) && first.text === path
    )
  }

  const isRouteArgumentAt = (
    source: TSApi.SourceFile,
    position: number,
    method: string,
    argument: string,
  ): boolean | undefined => {
    const call = ancestorAt(ts, source, position, ts.isCallExpression)
    if (call === undefined || !ts.isPropertyAccessExpression(call.expression)) return false
    const first = call.arguments[0]
    return (
      call.expression.name.text.toUpperCase() === method &&
      call.arguments.length > 1 &&
      first !== undefined &&
      first.getText(source) === argument
    )
  }

  const isFunctionRouteCallAt = (
    source: TSApi.SourceFile,
    position: number,
    callee: string,
    pathIndex: number,
    path: string,
  ): boolean | undefined => {
    const call = ancestorAt(ts, source, position, ts.isCallExpression)
    if (call === undefined || !ts.isIdentifier(call.expression)) return false
    const argument = call.arguments[pathIndex]
    return (
      call.expression.text === callee &&
      argument !== undefined &&
      ts.isStringLiteralLike(argument) &&
      argument.text === path
    )
  }

  const isResponseSyntaxAt = (source: TSApi.SourceFile, position: number): boolean | undefined => {
    const returnStatement = ancestorAt(ts, source, position, ts.isReturnStatement)
    if (returnStatement !== undefined) {
      return (
        returnStatement.expression !== undefined &&
        rawResponseExpression(ts, returnStatement.expression)
      )
    }
    const arrow = ancestorAt(ts, source, position, ts.isArrowFunction)
    if (arrow !== undefined && !ts.isBlock(arrow.body)) return rawResponseExpression(ts, arrow.body)
    return false
  }

  const handlersBySource = new WeakMap<TSApi.SourceFile, RouteHandlerSets>()
  const handlersOf = (source: TSApi.SourceFile): RouteHandlerSets => {
    let handlers = handlersBySource.get(source)
    if (handlers === undefined) {
      handlers = routeHandlers(ts, source)
      handlersBySource.set(source, handlers)
    }
    return handlers
  }
  const isRouteHandlerAt = (source: TSApi.SourceFile, position: number): boolean => {
    const { all } = handlersOf(source)
    return (
      ancestorAt(ts, source, position, (node): node is TSApi.Node => all.has(node)) !== undefined
    )
  }

  const indirectResponseReturns = (
    source: TSApi.SourceFile,
    importReturnsResponse?: (specifier: string, name: string) => boolean,
  ): readonly number[] => {
    const { direct, returned } = handlersOf(source)
    const imports = importReturnsResponse === undefined ? undefined : relativeImports(ts, source)
    const positions: number[] = []
    const inspect = (handler: FunctionNode, isDirect: boolean): void => {
      const bindings = responseBindings(ts, handler)
      for (const value of returnedValues(ts, handler)) {
        const unwrapped = unwrapExpression(ts, value)
        const imported =
          ts.isCallExpression(unwrapped) && ts.isIdentifier(unwrapped.expression)
            ? imports?.get(unwrapped.expression.text)
            : undefined
        if (
          (ts.isIdentifier(unwrapped) && bindings.has(unwrapped.text)) ||
          (isDirect && contextResponseCall(ts, handler, unwrapped)) ||
          (imported !== undefined &&
            importReturnsResponse?.(imported.specifier, imported.name) === true)
        )
          positions.push(unwrapped.getStart(source))
      }
    }
    for (const handler of direct) inspect(handler, true)
    for (const handler of returned) if (!direct.has(handler)) inspect(handler, false)
    return positions
  }

  const exportReturnsResponse = (source: TSApi.SourceFile, name: string): boolean => {
    const local = exportedLocal(ts, source, name)
    if (local === undefined) return false
    return (localFunctions(ts, source).get(local) ?? []).some((fn) => returnsRawResponse(ts, fn))
  }

  const isDynamicImportAt = (
    source: TSApi.SourceFile,
    position: number,
    specifier: string,
  ): boolean | undefined => {
    let node: TSApi.Node = nodeAt(ts, source, Math.max(0, Math.min(position, source.end - 1)))
    for (;;) {
      if (ts.isImportTypeNode(node)) return false
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0]
        if (
          argument === undefined ||
          !(ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
        ) {
          return undefined
        }
        return argument.text === specifier ? true : undefined
      }
      if (node === source) return undefined
      node = node.parent
    }
  }

  return {
    parse,
    isValueImportAt,
    isRouteRegistrationAt,
    isRouteArgumentAt,
    isFunctionRouteCallAt,
    isResponseSyntaxAt,
    isRouteHandlerAt,
    indirectResponseReturns,
    exportReturnsResponse,
    isDynamicImportAt,
  }
}

import type * as TSApi from "typescript"
import { scriptKindOf } from "./script-kind.ts"
import type { TypeScriptApi } from "./typescript-import.ts"

/**
 * The deliberately small AST seam used by source lints. It is not a project-wide TypeScript
 * Program: a rule asks for a file only after its lexical fast path found a candidate. That keeps
 * cold checks and projects without a TypeScript install on the existing conservative path.
 */
/** What {@link SourceFacts.untypedResponseRoutes} finds in one file. */
export interface UntypedResponseRoutes {
  /** Whether `position` lies in one of those handlers. */
  isUntypedAt(position: number): boolean
  /**
   * Positions of their returned raw `Response` values that the lexical pattern cannot see: a local
   * `const` holding one, the context's `json()`/`text()` from a registered handler, or a call to an
   * imported function `importReturnsResponse` answers for.
   */
  readonly indirectReturns: readonly number[]
}

/** A route registration of one file that declares no `response`, from {@link SourceFacts.undeclaredResponseRoutes}. */
export interface UndeclaredResponseRoute {
  /** The start of the registration's method name (`get` in `.get("/x", h)`). */
  readonly position: number
  readonly method: string
  readonly path: string
}

/** A zod `coerce.boolean()` that a route's text slot reaches, from {@link SourceFacts.textSlotBooleanCoercions}. */
export interface TextSlotBooleanCoercion {
  /** The start of the `coerce.boolean()` call. */
  readonly position: number
  readonly slot: "query" | "headers" | "cookies"
  readonly method: string
  readonly path: string
}

/** A `serverFunctions("namespace", module)` mount of a `*.fn.ts` module, from {@link SourceFacts.serverFunctionMounts}. */
export interface ServerFunctionMount {
  /** The start of the namespace literal. */
  readonly position: number
  /** The start of the `serverFunctions(...)` call, where a `nifra-expect` comment is written above. */
  readonly callPosition: number
  readonly namespace: string
  /** The specifier the mounted module namespace was imported from. */
  readonly specifier: string
}

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
   * The route handlers of `source` that return no plain value, so a raw `Response` they return leaves
   * the typed client nothing to infer. A route handler is a function passed to `.get("/path", …)` and
   * the other method registrations, a function value of an `implement(contract, {...})` map, a local
   * function either one names, or a local function a handler returns a call to (one hop). A handler
   * that also returns a plain value keeps the route typed (the client drops a bare `Response` from the
   * union), and so does a registration that declares `{ response: … }`. A returned call to an imported
   * function counts as a plain value unless `importReturnsResponse` shows it returns a `Response`.
   */
  untypedResponseRoutes(
    source: TSApi.SourceFile,
    importReturnsResponse?: (specifier: string, name: string) => boolean,
  ): UntypedResponseRoutes
  /**
   * The `.get("/path", …)` registrations (and the other methods) whose options are all object
   * literals and none declares `response`, leaving out those whose handlers {@link untypedResponseRoutes}
   * reports: a raw `Response` has no JSON body to declare. One whose options are a variable or a call is
   * left out too, since the file does not show whether it declares one.
   */
  undeclaredResponseRoutes(source: TSApi.SourceFile): readonly UndeclaredResponseRoute[]
  /**
   * The zod `coerce.boolean()` calls a route's `query`, `headers` or `cookies` schema reaches in
   * `source`: written in the route's options, or in a variable of the file the options name, at any
   * depth. Each call is reported once, for the first route that reaches it. A schema imported from
   * another file is not followed.
   */
  textSlotBooleanCoercions(source: TSApi.SourceFile): readonly TextSlotBooleanCoercion[]
  /**
   * The `serverFunctions("namespace", module)` calls in `source` whose `module` is a namespace import
   * (`import * as todos from "./todos.fn"`) of a `*.fn` file. A module reached any other way is left out.
   */
  serverFunctionMounts(source: TSApi.SourceFile): readonly ServerFunctionMount[]
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

/** A route registration such as `app.get("/path", handler)`: its method name, path, and the arguments after the path. */
function routeRegistration(
  ts: TypeScriptApi,
  node: TSApi.Node,
):
  | {
      readonly name: TSApi.MemberName
      readonly method: string
      readonly path: string
      readonly rest: readonly TSApi.Expression[]
    }
  | undefined {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression))
    return undefined
  const method = node.expression.name.text
  const [first, ...rest] = node.arguments
  if (!REGISTRATION_METHODS.has(method) || first === undefined || !ts.isStringLiteralLike(first))
    return undefined
  return { name: node.expression.name, method, path: first.text, rest }
}

const SERVER_FN_MODULE_ID = "@nifrajs/web/fn"
const SERVER_FN_FILE = /\.fn(?:\.[cm]?[jt]sx?)?$/

const ZOD_MODULES: ReadonlySet<string> = new Set(["zod", "zod/v4", "zod/mini", "zod/v4/mini"])

/** The names `source` binds zod's namespace to (`z`), and those it binds zod's `coerce` to. */
function zodBindings(
  ts: TypeScriptApi,
  source: TSApi.SourceFile,
): { readonly namespaces: ReadonlySet<string>; readonly coerce: ReadonlySet<string> } {
  const namespaces = new Set<string>()
  const coerce = new Set<string>()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    const clause = statement.importClause
    if (!ZOD_MODULES.has(statement.moduleSpecifier.text) || clause === undefined) continue
    if (clause.isTypeOnly) continue
    if (clause.name !== undefined) namespaces.add(clause.name.text)
    const bindings = clause.namedBindings
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
    else if (bindings !== undefined) {
      for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).text
        if (element.isTypeOnly) continue
        if (imported === "z") namespaces.add(element.name.text)
        if (imported === "coerce") coerce.add(element.name.text)
      }
    }
  }
  return { namespaces, coerce }
}

/** Every name `source` declares other than by import: variables, parameters, functions and classes, any scope. */
function declaredNames(ts: TypeScriptApi, source: TSApi.SourceFile): Set<string> {
  const names = new Set<string>()
  const bind = (name: TSApi.BindingName): void => {
    if (ts.isIdentifier(name)) names.add(name.text)
    else for (const element of name.elements) if (ts.isBindingElement(element)) bind(element.name)
  }
  const visit = (node: TSApi.Node): void => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) bind(node.name)
    else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name)
      names.add(node.name.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return names
}

/** The initializer of each variable of `source`, any scope, by name: the first one wins. */
function variableInitializers(
  ts: TypeScriptApi,
  source: TSApi.SourceFile,
): Map<string, TSApi.Expression> {
  const consts = new Map<string, TSApi.Expression>()
  const visit = (node: TSApi.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      !consts.has(node.name.text)
    )
      consts.set(node.name.text, node.initializer)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return consts
}

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

/** Named and default value imports, by local name: `import { json as reply } from "./http"`. */
function valueImports(
  ts: TypeScriptApi,
  source: TSApi.SourceFile,
): ReadonlyMap<string, { readonly specifier: string; readonly name: string }> {
  const imports = new Map<string, { readonly specifier: string; readonly name: string }>()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    const specifier = statement.moduleSpecifier.text
    const clause = statement.importClause
    if (clause === undefined || clause.isTypeOnly) continue
    if (clause.name !== undefined) imports.set(clause.name.text, { specifier, name: "default" })
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
  /** The direct handlers registered at least once without a `{ response: … }` declaration. */
  readonly undeclared: ReadonlySet<FunctionNode>
  /** Local functions a direct handler returns a call to (one hop), with the handlers that do. */
  readonly returned: ReadonlyMap<FunctionNode, ReadonlySet<FunctionNode>>
}

/** What a handler's returned value is, as far as one file shows: a raw `Response` reached some way,
 * a plain value the client types, or neither for sure. */
type ReturnKind =
  | "raw"
  | "held"
  | "context"
  | "imported"
  | "helper"
  | "plain"
  | "opaque"
  | "unknown"
/** A returned value the client may type: a plain value, or an imported call not shown to be a `Response`. */
const TYPED_KINDS: ReadonlySet<ReturnKind> = new Set(["plain", "opaque"])
const RESPONSE_KINDS: ReadonlySet<ReturnKind> = new Set([
  "raw",
  "held",
  "context",
  "imported",
  "helper",
])
const INDIRECT_KINDS: ReadonlySet<ReturnKind> = new Set(["held", "context", "imported"])

/** An options object literal with a `response` property: the route's output is declared. */
function declaresResponse(ts: TypeScriptApi, argument: TSApi.Expression): boolean {
  return (
    ts.isObjectLiteralExpression(argument) &&
    argument.properties.some(
      (property) =>
        (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
        ts.isIdentifier(property.name) &&
        property.name.text === "response",
    )
  )
}

/** Every route handler of `source`, by the rules {@link SourceFacts.isRouteHandlerAt} states. */
function routeHandlers(ts: TypeScriptApi, source: TSApi.SourceFile): RouteHandlerSets {
  const locals = localFunctions(ts, source)
  const handlers = new Set<FunctionNode>()
  const undeclared = new Set<FunctionNode>()
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
        const arguments_ = rest.map((argument) => unwrapExpression(ts, argument))
        const declared = arguments_.some((argument) => declaresResponse(ts, argument))
        for (const argument of arguments_)
          for (const fn of named(argument)) {
            handlers.add(fn)
            if (!declared) undeclared.add(fn)
          }
      }
      const implement =
        (ts.isIdentifier(callee) && callee.text === "implement") || method === "implement"
      const map =
        node.arguments[1] === undefined ? undefined : unwrapExpression(ts, node.arguments[1])
      if (implement && map !== undefined && ts.isObjectLiteralExpression(map)) {
        const add = (fn: FunctionNode): void => {
          handlers.add(fn)
          undeclared.add(fn)
        }
        for (const property of map.properties) {
          if (ts.isMethodDeclaration(property)) add(property)
          else if (ts.isPropertyAssignment(property))
            for (const fn of named(unwrapExpression(ts, property.initializer))) add(fn)
          else if (ts.isShorthandPropertyAssignment(property))
            for (const fn of locals.get(property.name.text) ?? []) add(fn)
        }
      }
    }
    ts.forEachChild(node, find)
  }
  find(source)

  // One hop: a local function a handler returns a call to answers for that handler.
  const returned = new Map<FunctionNode, Set<FunctionNode>>()
  for (const handler of handlers) {
    const follow = (node: TSApi.Node): void => {
      const value =
        ts.isReturnStatement(node) && node.expression !== undefined
          ? node.expression
          : ts.isArrowFunction(node) && !ts.isBlock(node.body)
            ? node.body
            : undefined
      const call = value === undefined ? undefined : unwrapExpression(ts, value)
      if (call !== undefined && ts.isCallExpression(call))
        for (const fn of named(call.expression)) {
          const callers = returned.get(fn) ?? new Set<FunctionNode>()
          callers.add(handler)
          returned.set(fn, callers)
        }
      ts.forEachChild(node, follow)
    }
    follow(handler)
  }
  return { direct: handlers, undeclared, returned }
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
  const untypedResponseRoutes = (
    source: TSApi.SourceFile,
    importReturnsResponse?: (specifier: string, name: string) => boolean,
  ): UntypedResponseRoutes => {
    const { direct, undeclared, returned } = handlersOf(source)
    const locals = localFunctions(ts, source)
    const imports = valueImports(ts, source)
    // A local call this file cannot see into, or a conditional, may or may not be a Response: it
    // neither marks a handler untyped nor keeps it typed. An imported call keeps it typed unless the
    // imported module shows a Response: a mapper or serializer from elsewhere is the usual plain return.
    const kindOf = (fn: FunctionNode, isDirect: boolean, value: TSApi.Expression): ReturnKind => {
      if (rawResponseExpression(ts, value)) return "raw"
      if (ts.isConditionalExpression(value) || ts.isNewExpression(value)) return "unknown"
      if (!ts.isCallExpression(value)) return "plain"
      if (isDirect && contextResponseCall(ts, fn, value)) return "context"
      if (!ts.isIdentifier(value.expression)) return "unknown"
      const imported = imports.get(value.expression.text)
      if (imported !== undefined)
        return imported.specifier.startsWith(".") &&
          importReturnsResponse?.(imported.specifier, imported.name) === true
          ? "imported"
          : "opaque"
      // From a direct handler, a call to a local helper answers as the helper does (one hop).
      const helpers = isDirect
        ? (locals.get(value.expression.text) ?? []).filter((helper) => returned.has(helper))
        : []
      if (helpers.length === 0) return "unknown"
      const kinds = helpers.flatMap((helper) =>
        returnKinds(helper, false).map((entry) => entry.kind),
      )
      if (kinds.some((kind) => TYPED_KINDS.has(kind))) return "plain"
      return kinds.every((kind) => RESPONSE_KINDS.has(kind)) ? "helper" : "unknown"
    }
    const returnKinds = (fn: FunctionNode, isDirect: boolean) => {
      const bindings = responseBindings(ts, fn)
      return returnedValues(ts, fn).map((returnedValue) => {
        const value = unwrapExpression(ts, returnedValue)
        const kind: ReturnKind =
          ts.isIdentifier(value) && bindings.has(value.text) ? "held" : kindOf(fn, isDirect, value)
        return { value, kind }
      })
    }
    // No plain return: a Response written anywhere in it (a `.then(() => new Response(…))` too)
    // is what the route answers with.
    const isUntyped = (fn: FunctionNode, isDirect: boolean): boolean =>
      !returnKinds(fn, isDirect).some((entry) => TYPED_KINDS.has(entry.kind))

    const untyped = new Map<FunctionNode, boolean>()
    for (const handler of direct)
      untyped.set(handler, undeclared.has(handler) && isUntyped(handler, true))
    for (const [helper, callers] of returned) {
      if (direct.has(helper)) continue
      const reached = [...callers].some((caller) => untyped.get(caller) === true)
      untyped.set(helper, reached && isUntyped(helper, false))
    }
    const indirectReturns: number[] = []
    for (const [fn, untypedFn] of untyped) {
      if (!untypedFn) continue
      // A raw `new Response(` is the lexical pattern's to report, and a helper's at its own return.
      for (const { value, kind } of returnKinds(fn, direct.has(fn)))
        if (INDIRECT_KINDS.has(kind)) indirectReturns.push(value.getStart(source))
    }
    const byNode: ReadonlyMap<TSApi.Node, boolean> = untyped
    return {
      isUntypedAt: (position) => {
        const handler = ancestorAt(ts, source, position, (node): node is TSApi.Node =>
          byNode.has(node),
        )
        return handler !== undefined && byNode.get(handler) === true
      },
      indirectReturns,
    }
  }

  const undeclaredResponseRoutes = (
    source: TSApi.SourceFile,
  ): readonly UndeclaredResponseRoute[] => {
    const locals = localFunctions(ts, source)
    const raw = untypedResponseRoutes(source)
    const routes: UndeclaredResponseRoute[] = []
    const visit = (node: TSApi.Node): void => {
      ts.forEachChild(node, visit)
      const registration = routeRegistration(ts, node)
      if (registration === undefined) return
      const { name, method, path, rest } = registration
      const handlers: FunctionNode[] = []
      for (const argument of rest.map((value) => unwrapExpression(ts, value))) {
        const local = ts.isIdentifier(argument) ? locals.get(argument.text) : undefined
        if (isFunctionValue(ts, argument)) handlers.push(argument)
        else if (local !== undefined) handlers.push(...local)
        else if (!ts.isObjectLiteralExpression(argument) || declaresResponse(ts, argument)) return
      }
      // Every registration takes a handler: `headers.get("etag")` and `map.get("/")` are reads.
      if (handlers.length === 0 || handlers.every((fn) => raw.isUntypedAt(fn.getStart(source))))
        return
      routes.push({ position: name.getStart(source), method: method.toUpperCase(), path })
    }
    visit(source)
    return routes.sort((a, b) => a.position - b.position)
  }

  const textSlotBooleanCoercions = (
    source: TSApi.SourceFile,
  ): readonly TextSlotBooleanCoercion[] => {
    const zod = zodBindings(ts, source)
    if (zod.namespaces.size === 0 && zod.coerce.size === 0) return []
    const consts = variableInitializers(ts, source)
    const isCoerceBoolean = (node: TSApi.Node): boolean => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression))
        return false
      const { expression, name } = node.expression
      if (name.text !== "boolean") return false
      if (ts.isIdentifier(expression)) return zod.coerce.has(expression.text)
      return (
        ts.isPropertyAccessExpression(expression) &&
        expression.name.text === "coerce" &&
        ts.isIdentifier(expression.expression) &&
        zod.namespaces.has(expression.expression.text)
      )
    }
    const found: TextSlotBooleanCoercion[] = []
    const reported = new Set<number>()
    const reach = (
      node: TSApi.Node,
      seen: Set<TSApi.Node>,
      route: Omit<TextSlotBooleanCoercion, "position">,
    ): void => {
      if (ts.isIdentifier(node)) {
        const initializer = consts.get(node.text)
        if (initializer !== undefined && !seen.has(initializer)) {
          seen.add(initializer)
          reach(initializer, seen, route)
        }
        return
      }
      if (isCoerceBoolean(node)) {
        const position = node.getStart(source)
        if (!reported.has(position)) {
          reported.add(position)
          found.push({ position, ...route })
        }
      }
      // Only the value side: a property name or a member name is never a schema.
      if (ts.isPropertyAccessExpression(node)) reach(node.expression, seen, route)
      else if (ts.isPropertyAssignment(node)) reach(node.initializer, seen, route)
      else ts.forEachChild(node, (child) => reach(child, seen, route))
    }
    const visit = (node: TSApi.Node): void => {
      ts.forEachChild(node, visit)
      const registration = routeRegistration(ts, node)
      if (registration === undefined) return
      const { method, path, rest } = registration
      const arguments_ = rest.map((argument) => {
        const value = unwrapExpression(ts, argument)
        const named = ts.isIdentifier(value) ? consts.get(value.text) : undefined
        return named === undefined ? value : unwrapExpression(ts, named)
      })
      // Every registration takes a handler: `config.get("key", { query })` is not a route.
      if (arguments_.every((value) => ts.isObjectLiteralExpression(value))) return
      for (const options of arguments_) {
        if (!ts.isObjectLiteralExpression(options)) continue
        for (const property of options.properties) {
          if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))
            continue
          const slot =
            ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
              ? property.name.text
              : undefined
          if (slot !== "query" && slot !== "headers" && slot !== "cookies") continue
          const value = ts.isPropertyAssignment(property) ? property.initializer : property.name
          reach(value, new Set(), { slot, method: method.toUpperCase(), path })
        }
      }
    }
    visit(source)
    return found.sort((a, b) => a.position - b.position)
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

  const serverFunctionMounts = (source: TSApi.SourceFile): readonly ServerFunctionMount[] => {
    const callees = new Set<string>()
    const members = new Set<string>()
    const modules = new Map<string, string>()
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
        continue
      const clause = statement.importClause
      if (clause === undefined || clause.isTypeOnly) continue
      const specifier = statement.moduleSpecifier.text
      const bindings = clause.namedBindings
      if (bindings === undefined) continue
      if (ts.isNamespaceImport(bindings)) {
        if (specifier === SERVER_FN_MODULE_ID) members.add(bindings.name.text)
        else if (SERVER_FN_FILE.test(specifier)) modules.set(bindings.name.text, specifier)
      } else if (specifier === SERVER_FN_MODULE_ID) {
        for (const element of bindings.elements) {
          if (
            !element.isTypeOnly &&
            (element.propertyName ?? element.name).text === "serverFunctions"
          )
            callees.add(element.name.text)
        }
      }
    }
    if (modules.size === 0 || (callees.size === 0 && members.size === 0)) return []
    // A name the file declares again (a local `serverFunctions`, a parameter called like the module) is
    // not the import, whatever scope it sits in: leave those calls out rather than guess the scope.
    for (const name of declaredNames(ts, source)) {
      callees.delete(name)
      members.delete(name)
      modules.delete(name)
    }
    const mounts: ServerFunctionMount[] = []
    const visit = (node: TSApi.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        const [namespace, module] = node.arguments
        if (
          (ts.isIdentifier(callee)
            ? callees.has(callee.text)
            : ts.isPropertyAccessExpression(callee) &&
              ts.isIdentifier(callee.expression) &&
              members.has(callee.expression.text) &&
              callee.name.text === "serverFunctions") &&
          namespace !== undefined &&
          ts.isStringLiteralLike(namespace) &&
          module !== undefined &&
          ts.isIdentifier(module)
        ) {
          const specifier = modules.get(module.text)
          if (specifier !== undefined)
            mounts.push({
              position: namespace.getStart(source),
              callPosition: node.getStart(source),
              namespace: namespace.text,
              specifier,
            })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    return mounts
  }

  return {
    parse,
    isValueImportAt,
    isRouteRegistrationAt,
    isRouteArgumentAt,
    isFunctionRouteCallAt,
    isResponseSyntaxAt,
    untypedResponseRoutes,
    undeclaredResponseRoutes,
    textSlotBooleanCoercions,
    serverFunctionMounts,
    exportReturnsResponse,
    isDynamicImportAt,
  }
}

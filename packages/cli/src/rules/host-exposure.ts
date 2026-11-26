import type * as TSApi from "typescript"
import type { HostTopology } from "../check-diagnostics.ts"
import { type Diagnostic, diagnostic } from "../diagnostics.ts"
import { importedAs } from "../internal/imported-as.ts"
import { commentBlockExpectation, MISSING_EXPECTATION_REASON } from "./comment-markers.ts"
import type { CheckRule, SourceIndex } from "./index.ts"
import { loadRuleTypeScript } from "./typescript.ts"

const EXPECTATION = ["NF-S010", "host-exposure"]
/** The one option a Deno or Bun listener reads: core has no `allowedHosts` or `canonicalHost`, those are the Node adapters'. */
const HOST_OPTION = "validateHost"
const LISTENER_HINT = /\b(?:serve|listen)\b/
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/
/** Options that mean the listener terminates TLS itself, so no proxy in front is handling Host. */
const TLS_OPTIONS: ReadonlySet<string> = new Set(["tls", "cert"])

type Runtime = "deno" | "bun"

/** Whether the listener serves a Nifra app (which takes `validateHost`) or a bare runtime handler (which does not). */
type Surface = "app" | "native"

const CONSEQUENCE: Readonly<Record<Runtime, string>> = {
  deno: "Deno builds the request URL from Host, so a Host such as `evil.test/admin?` routes the request to `/admin`, past any path rule in front of the app",
  bun: "Bun may leave `c.req.url` relative, or build it on a Host the URL parser refuses, so `new URL(c.req.url)` can throw in a handler",
}

const LABEL: Readonly<Record<Runtime, string>> = {
  deno: "Deno",
  bun: "Bun",
}

function propertyKey(ts: typeof TSApi, prop: TSApi.ObjectLiteralElementLike): string | undefined {
  if (ts.isShorthandPropertyAssignment(prop)) return prop.name.text
  if (!ts.isPropertyAssignment(prop) && !ts.isMethodDeclaration(prop)) return undefined
  const name = prop.name
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text
  return undefined
}

type Bindings = ReadonlyMap<string, readonly TSApi.Expression[]>

/**
 * What a spread can copy from, `null` standing for a branch that writes nothing, or `undefined` when
 * one of them cannot be read.
 */
/** `node` without the wrappers that change only its type: parentheses, `as`, `satisfies`, `!`. */
function unwrapped(ts: typeof TSApi, node: TSApi.Expression): TSApi.Expression {
  let inner = node
  while (isTypeWrapper(ts, inner)) inner = inner.expression
  return inner
}

function isTypeWrapper(
  ts: typeof TSApi,
  node: TSApi.Node,
): node is
  | TSApi.ParenthesizedExpression
  | TSApi.AsExpression
  | TSApi.SatisfiesExpression
  | TSApi.NonNullExpression {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  )
}

/** Whether `node` only names a member (`request.options`, `{ options: 1 }`) and refers to no binding. */
function namesMember(ts: typeof TSApi, node: TSApi.Identifier): boolean {
  const parent = node.parent
  if (ts.isBindingElement(parent)) return parent.propertyName === node
  if (ts.isQualifiedName(parent)) return parent.right === node
  return (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === node
  )
}

function spreadSources(
  ts: typeof TSApi,
  from: TSApi.Expression,
  bindings: Bindings,
  seen: ReadonlySet<TSApi.Node>,
): readonly (TSApi.ObjectLiteralExpression | null)[] | undefined {
  if (isTypeWrapper(ts, from)) return spreadSources(ts, from.expression, bindings, seen)
  if (ts.isObjectLiteralExpression(from)) return [from]
  if (
    from.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(from) && from.text === "undefined")
  )
    return [null]
  let branches: readonly TSApi.Expression[] | undefined
  if (ts.isConditionalExpression(from)) branches = [from.whenTrue, from.whenFalse]
  else if (
    ts.isBinaryExpression(from) &&
    from.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    const right = spreadSources(ts, from.right, bindings, seen)
    return right === undefined ? undefined : [...right, null]
  } else if (ts.isIdentifier(from)) branches = bindings.get(from.text)
  if (branches === undefined) return undefined
  const found: (TSApi.ObjectLiteralExpression | null)[] = []
  for (const branch of branches) {
    // Each node is followed once, so a name bound to itself ends here.
    if (seen.has(branch)) return undefined
    const sources = spreadSources(ts, branch, bindings, new Set([...seen, branch]))
    if (sources === undefined) return undefined
    found.push(...sources)
  }
  return found
}

/**
 * What an object literal leaves `validateHost` at, the last writer winning: `true` for a value that
 * is the literal `true`, `undefined` when nothing writes it. A spread that cannot be read may
 * write it, so it is no guarantee.
 */
function hostSetting(
  ts: typeof TSApi,
  object: TSApi.ObjectLiteralExpression,
  bindings: Bindings,
  seen: ReadonlySet<TSApi.Node> = new Set(),
): boolean | undefined {
  let setting: boolean | undefined
  for (const prop of object.properties) {
    if (ts.isSpreadAssignment(prop)) {
      const sources = spreadSources(ts, prop.expression, bindings, seen)
      if (sources === undefined) {
        setting = false
        continue
      }
      const results = sources.map((source) =>
        source === null ? undefined : hostSetting(ts, source, bindings, new Set([...seen, source])),
      )
      if (results.includes(false)) setting = false
      else if (results.every((result) => result === true)) setting = true
    } else if (prop.name !== undefined && ts.isComputedPropertyName(prop.name)) {
      setting = false
    } else if (propertyKey(ts, prop) === HOST_OPTION) {
      setting =
        ts.isPropertyAssignment(prop) &&
        unwrapped(ts, prop.initializer).kind === ts.SyntaxKind.TrueKeyword
    }
  }
  return setting
}

/** The local names `@nifrajs/deno` exports `serve` under in this file. */
function serveImports(ts: typeof TSApi, tree: TSApi.SourceFile): ReadonlyMap<string, Runtime> {
  const { locals, namespaces } = importedAs(ts, tree, (from) => from === "@nifrajs/deno", "serve")
  const found = new Map<string, Runtime>()
  for (const name of locals) found.set(name, "deno")
  for (const name of namespaces) found.set(`${name}.serve`, "deno")
  return found
}

/** Local names under which this file has `server` from `@nifrajs/core`, and namespace imports of it. */
interface CoreNames {
  readonly factories: ReadonlySet<string>
  readonly namespaces: ReadonlySet<string>
  readonly bindings: Bindings
}

function coreNames(ts: typeof TSApi, tree: TSApi.SourceFile): CoreNames {
  const { locals: factories, namespaces } = importedAs(
    ts,
    tree,
    (from) => from === "@nifrajs/core" || from.startsWith("@nifrajs/core/"),
    "server",
  )
  return { factories, namespaces, bindings: bindingsIn(ts, tree) }
}

/** Every initializer each name in the file is declared with. */
function bindingsIn(ts: typeof TSApi, tree: TSApi.SourceFile): Bindings {
  const bindings = new Map<string, TSApi.Expression[]>()
  const collect = (node: TSApi.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const found = bindings.get(node.name.text)
      if (found === undefined) bindings.set(node.name.text, [node.initializer])
      else found.push(node.initializer)
    }
    ts.forEachChild(node, collect)
  }
  collect(tree)
  return bindings
}

function isServerFactory(ts: typeof TSApi, callee: TSApi.Expression, names: CoreNames): boolean {
  return ts.isIdentifier(callee)
    ? names.factories.has(callee.text)
    : ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        names.namespaces.has(callee.expression.text) &&
        callee.name.text === "server"
}

function constantBindings(ts: typeof TSApi, tree: TSApi.SourceFile): Bindings {
  const bindings = new Map<string, TSApi.Expression[]>()
  for (const statement of tree.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      (statement.declarationList.flags & ts.NodeFlags.Const) === 0
    )
      continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined)
        bindings.set(declaration.name.text, [declaration.initializer])
    }
  }
  return bindings
}

function isModuleScope(ts: typeof TSApi, node: TSApi.Node): boolean {
  for (let parent: TSApi.Node | undefined = node.parent; parent; parent = parent.parent) {
    if (ts.isBlock(parent) || ts.isFunctionLike(parent)) return false
  }
  return true
}

function unescapedOptions(
  ts: typeof TSApi,
  tree: TSApi.SourceFile,
  names: CoreNames,
  constants: Bindings,
): Bindings {
  const options = new Map(constants)
  const visit = (node: TSApi.Node): void => {
    if (ts.isIdentifier(node) && options.has(node.text) && !namesMember(ts, node)) {
      let value: TSApi.Node = node
      while (
        isTypeWrapper(ts, value.parent) ||
        (ts.isConditionalExpression(value.parent) && value !== value.parent.condition) ||
        (ts.isBinaryExpression(value.parent) &&
          value.parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
          value === value.parent.right)
      ) {
        value = value.parent
      }
      const use = value.parent
      const declares = ts.isVariableDeclaration(use) && use.name === node
      const spreads = ts.isSpreadAssignment(use)
      const configures =
        ts.isCallExpression(use) &&
        use.arguments[0] === value &&
        isModuleScope(ts, use) &&
        isServerFactory(ts, use.expression, names)
      // Property writes, aliases, and calls to unknown code may change the options object.
      if (!declares && !spreads && !configures) options.delete(node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return options
}

function hasHostGuard(
  ts: typeof TSApi,
  listener: TSApi.CallExpression,
  app: TSApi.Expression,
  names: CoreNames,
  constants: Bindings,
  optionsBindings: Bindings,
): boolean {
  // A nested scope may shadow a module-level app, option, or factory.
  if (!isModuleScope(ts, listener)) return false
  const seen = new Set<TSApi.Expression>()
  let receiver: TSApi.Expression | undefined = app
  while (receiver !== undefined && !seen.has(receiver)) {
    seen.add(receiver)
    if (ts.isIdentifier(receiver)) receiver = constants.get(receiver.text)?.[0]
    else if (isTypeWrapper(ts, receiver)) receiver = receiver.expression
    else if (ts.isCallExpression(receiver)) {
      const callee = receiver.expression
      if (isServerFactory(ts, callee, names)) {
        const options = receiver.arguments[0]
        if (options === undefined) return false
        return (
          spreadSources(ts, options, optionsBindings, new Set())?.every(
            (source) => source !== null && hostSetting(ts, source, optionsBindings) === true,
          ) === true
        )
      }
      receiver =
        ts.isPropertyAccessExpression(callee) &&
        /^(?:get|post|put|patch|delete|head|options|route|use|derive|decorate|group|guard)$/.test(
          callee.name.text,
        )
          ? callee.expression
          : undefined
    } else return false
  }
  return false
}

/**
 * Whether `receiver` can be a Nifra server: a `server(...)` call or a chain from one, or a name this
 * file binds to one. A name it does not bind (an import, a parameter) is given the benefit of the
 * doubt; a name bound to something else (`const tcp = net.createServer()`) is not.
 */
function isNifraServer(
  ts: typeof TSApi,
  receiver: TSApi.Expression,
  names: CoreNames,
  lenient = true,
  hops = 0,
): boolean {
  // Only following a binding counts: a chain or a wrapper is finite, a binding can name itself.
  if (hops > 6) return false
  if (
    ts.isParenthesizedExpression(receiver) ||
    ts.isAwaitExpression(receiver) ||
    ts.isNonNullExpression(receiver) ||
    ts.isAsExpression(receiver)
  )
    return isNifraServer(ts, receiver.expression, names, lenient, hops)
  if (ts.isIdentifier(receiver)) {
    const inits = names.bindings.get(receiver.text)
    if (inits === undefined) return lenient
    return inits.some((init) => isNifraServer(ts, init, names, true, hops + 1))
  }
  if (ts.isCallExpression(receiver)) {
    const callee = receiver.expression
    if (isServerFactory(ts, callee, names)) return true
    if (ts.isPropertyAccessExpression(callee)) {
      // A method call on a name this file does not bind (`net.createServer()`) proves nothing.
      return isNifraServer(ts, callee.expression, names, false, hops)
    }
    return false
  }
  // `this.app`, `ctx.app`: not traceable here.
  return (
    lenient && (ts.isPropertyAccessExpression(receiver) || ts.isElementAccessExpression(receiver))
  )
}

function calleeName(ts: typeof TSApi, callee: TSApi.Expression): string | undefined {
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression))
    return `${callee.expression.text}.${callee.name.text}`
  return undefined
}

interface Kind {
  readonly runtime: Runtime
  readonly surface: Surface
  /** Which argument holds the listener's options: an adapter or `listen()` takes them second, the runtime's own call first. */
  readonly optionsAt: "second" | "first"
  readonly app?: TSApi.Expression | undefined
}

function listenerKind(
  ts: typeof TSApi,
  call: TSApi.CallExpression,
  imports: ReadonlyMap<string, Runtime>,
  names: CoreNames,
): Kind | undefined {
  const name = calleeName(ts, call.expression)
  if (name !== undefined) {
    const imported = imports.get(name)
    if (imported !== undefined)
      return { runtime: imported, surface: "app", optionsAt: "second", app: call.arguments[0] }
    if (name === "Deno.serve") return { runtime: "deno", surface: "native", optionsAt: "first" }
    if (name === "Bun.serve") return { runtime: "bun", surface: "native", optionsAt: "first" }
  }
  if (
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === "listen" &&
    (names.factories.size > 0 || names.namespaces.size > 0) &&
    isNifraServer(ts, call.expression.expression, names)
  )
    return { runtime: "bun", surface: "app", optionsAt: "second", app: call.expression.expression }
  return undefined
}

/** Whether the options a listener is given hold TLS: the listener terminates it, with no proxy in front. */
function terminatesTls(ts: typeof TSApi, call: TSApi.CallExpression, kind: Kind): boolean {
  const candidate =
    kind.optionsAt === "second"
      ? call.arguments[1]
      : call.arguments.find(ts.isObjectLiteralExpression)
  if (candidate === undefined || !ts.isObjectLiteralExpression(candidate)) return false
  return candidate.properties.some((prop) => {
    const key = propertyKey(ts, prop)
    if (key === undefined || !TLS_OPTIONS.has(key)) return false
    if (!ts.isPropertyAssignment(prop)) return true
    const value = prop.initializer
    // `tls: undefined` is how a caller leaves TLS out.
    return !(
      (ts.isIdentifier(value) && value.text === "undefined") ||
      value.kind === ts.SyntaxKind.NullKeyword ||
      value.kind === ts.SyntaxKind.FalseKeyword
    )
  })
}

/** A parsed source file, read once and shared with every other rule that scans it. */
export interface ParsedSource {
  readonly tree: TSApi.SourceFile
  readonly lines: readonly string[]
}

/** Where in a file a listener sits, and the diagnostic it reports once its line is known. */
interface Listener {
  readonly position: number
  readonly runtime: Runtime
  readonly surface: Surface
}

function listenersIn(
  ts: typeof TSApi,
  tree: TSApi.SourceFile,
  topology: HostTopology | undefined,
): readonly Listener[] {
  const imports = serveImports(ts, tree)
  const names = coreNames(ts, tree)
  const constants = constantBindings(ts, tree)
  const optionBindings = unescapedOptions(ts, tree, names, constants)
  const found: Listener[] = []
  const visit = (node: TSApi.Node): void => {
    if (ts.isCallExpression(node)) {
      const kind = listenerKind(ts, node, imports, names)
      if (
        kind !== undefined &&
        (topology === "direct" || terminatesTls(ts, node, kind)) &&
        (kind.app === undefined ||
          !hasHostGuard(ts, node, kind.app, names, constants, optionBindings))
      )
        found.push({
          position: node.expression.getStart(tree),
          runtime: kind.runtime,
          surface: kind.surface,
        })
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return found
}

/**
 * NF-S010: a Deno or Bun listener that answers every request without checking `Host`, where
 * nothing says a proxy does. The check is off by default on both, which costs a request
 * nothing and is right behind a proxy that checks `Host`. It is not right for a server clients reach
 * directly, and Deno routes on what `Host` carries.
 *
 * The rule never infers a proxy: a Dockerfile, an `nginx.conf` or a `fly.toml` says little about the
 * network a server runs in. It fires on evidence of direct exposure (the listener terminates TLS
 * itself) or on `"hostTopology": "direct"` in `nifra.check.json`, and stays silent on
 * `"hostTopology": "proxied"`. A guard exempts the listener whose app can be traced to a local
 * server factory with `validateHost: true`.
 *
 * `parsedFile` is the security rules' shared parse cache, so a file is read once for all of them.
 */
export function createHostExposureRule(
  parsedFile: (ts: typeof TSApi, sources: SourceIndex, file: string) => ParsedSource | undefined,
): CheckRule {
  return {
    code: "NF-S010",
    title: "Server answers requests with Host unchecked",
    async scan(ctx): Promise<readonly Diagnostic[]> {
      const topology = ctx.project.policies.checkConfig.hostTopology
      if (topology === "proxied") return []
      const loaded = await loadRuleTypeScript(ctx)
      if (loaded.diagnostics !== undefined) return loaded.diagnostics
      const ts = loaded.compiler
      if (ts === undefined) return []
      const sources = ctx.project.source
      const findings: Diagnostic[] = []
      for (const file of sources.files) {
        if (!SCRIPT_FILE.test(file)) continue
        const source = parsedFile(ts, sources, file)
        if (source === undefined || !LISTENER_HINT.test(source.tree.text)) continue
        const { tree, lines } = source
        for (const listener of listenersIn(ts, tree, topology)) {
          const line = tree.getLineAndCharacterOfPosition(listener.position).line + 1
          const expected = commentBlockExpectation(lines, line, EXPECTATION)
          if (expected?.reason !== undefined) continue
          const remedy =
            listener.surface === "app"
              ? "Set `validateHost: true` on the server (one header read per request)"
              : "Check `Host` in the handler before routing on it (this listener has no `validateHost` option)"
          const message = `This ${LABEL[listener.runtime]} listener answers every request without checking Host: ${CONSEQUENCE[listener.runtime]}. ${remedy}, or say a proxy in front checks it with \`"hostTopology": "proxied"\` in nifra.check.json or a \`nifra-expect NF-S010: <reason>\` comment above the listener`
          findings.push(
            diagnostic({
              code: "NF-S010",
              severity: "warn",
              file: tree.fileName,
              line,
              message:
                expected === undefined ? message : `${message}. ${MISSING_EXPECTATION_REASON}`,
              evidence: [
                topology === "direct"
                  ? 'nifra.check.json declares "hostTopology": "direct"'
                  : "the listener terminates TLS itself",
                "this listener has no provable Host guard",
              ],
              verify: "nifra check --lints-only",
            }),
          )
        }
      }
      return findings
    },
  }
}

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
const HOST_OPTION_HINT = /\bvalidateHost\b/
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

/** Whether `node` or anything under it is an object literal that sets `key`. */
function setsKey(ts: typeof TSApi, node: TSApi.Node, key: string): boolean {
  if (ts.isObjectLiteralExpression(node)) {
    for (const prop of node.properties) if (propertyKey(ts, prop) === key) return true
  }
  return ts.forEachChild(node, (child) => (setsKey(ts, child, key) ? true : undefined)) === true
}

/**
 * Whether code in `tree` puts a Host check on a server: a `validateHost` that is not the literal
 * `false` and that no later spread in the same object may override. A comment or a string that
 * names it configures nothing.
 */
function configuresHost(ts: typeof TSApi, tree: TSApi.SourceFile): boolean {
  const visit = (node: TSApi.Node): boolean => {
    if (ts.isObjectLiteralExpression(node)) {
      const { properties } = node
      for (const [at, prop] of properties.entries()) {
        if (propertyKey(ts, prop) !== HOST_OPTION) continue
        if (ts.isPropertyAssignment(prop) && prop.initializer.kind === ts.SyntaxKind.FalseKeyword)
          continue
        // A spread after it can write the option again: one that may sets it is no guarantee.
        const overridden = properties
          .slice(at + 1)
          .some((later) => ts.isSpreadAssignment(later) && setsKey(ts, later, HOST_OPTION))
        if (!overridden) return true
      }
    }
    return ts.forEachChild(node, (child) => (visit(child) ? true : undefined)) === true
  }
  return visit(tree)
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
  readonly bindings: ReadonlyMap<string, readonly TSApi.Expression[]>
}

function coreNames(ts: typeof TSApi, tree: TSApi.SourceFile): CoreNames {
  const { locals: factories, namespaces } = importedAs(
    ts,
    tree,
    (from) => from === "@nifrajs/core" || from.startsWith("@nifrajs/core/"),
    "server",
  )
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
  return { factories, namespaces, bindings }
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
  depth = 0,
): boolean {
  if (depth > 6) return false
  if (
    ts.isParenthesizedExpression(receiver) ||
    ts.isAwaitExpression(receiver) ||
    ts.isNonNullExpression(receiver) ||
    ts.isAsExpression(receiver)
  )
    return isNifraServer(ts, receiver.expression, names, lenient, depth + 1)
  if (ts.isIdentifier(receiver)) {
    const inits = names.bindings.get(receiver.text)
    if (inits === undefined) return lenient
    return inits.some((init) => isNifraServer(ts, init, names, true, depth + 1))
  }
  if (ts.isCallExpression(receiver)) {
    const callee = receiver.expression
    if (ts.isIdentifier(callee)) return names.factories.has(callee.text)
    if (ts.isPropertyAccessExpression(callee)) {
      if (
        ts.isIdentifier(callee.expression) &&
        names.namespaces.has(callee.expression.text) &&
        callee.name.text === "server"
      )
        return true
      // A method call on a name this file does not bind (`net.createServer()`) proves nothing.
      return isNifraServer(ts, callee.expression, names, false, depth + 1)
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
    if (imported !== undefined) return { runtime: imported, surface: "app", optionsAt: "second" }
    if (name === "Deno.serve") return { runtime: "deno", surface: "native", optionsAt: "first" }
    if (name === "Bun.serve") return { runtime: "bun", surface: "native", optionsAt: "first" }
  }
  if (
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === "listen" &&
    (names.factories.size > 0 || names.namespaces.size > 0) &&
    isNifraServer(ts, call.expression.expression, names)
  )
    return { runtime: "bun", surface: "app", optionsAt: "second" }
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
  const found: Listener[] = []
  const visit = (node: TSApi.Node): void => {
    if (ts.isCallExpression(node)) {
      const kind = listenerKind(ts, node, imports, names)
      if (kind !== undefined && (topology === "direct" || terminatesTls(ts, node, kind)))
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
 * `"hostTopology": "proxied"`. A project that sets `validateHost` in code anywhere is left alone
 * (`allowedHosts` and `canonicalHost` belong to the Node adapters; a Deno or Bun listener ignores them).
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
      const parsed: ParsedSource[] = []
      for (const file of sources.files) {
        if (!SCRIPT_FILE.test(file)) continue
        const source = parsedFile(ts, sources, file)
        if (source === undefined) continue
        if (HOST_OPTION_HINT.test(source.tree.text) && configuresHost(ts, source.tree)) return []
        parsed.push(source)
      }
      const findings: Diagnostic[] = []
      for (const source of parsed) {
        if (!LISTENER_HINT.test(source.tree.text)) continue
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
                "no validateHost is set anywhere in the project",
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

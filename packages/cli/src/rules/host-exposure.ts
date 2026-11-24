import type * as TSApi from "typescript"
import type { HostTopology } from "../check-diagnostics.ts"
import { type Diagnostic, diagnostic } from "../diagnostics.ts"
import { commentBlockExpectation, MISSING_EXPECTATION_REASON } from "./comment-markers.ts"
import type { CheckRule, SourceIndex } from "./index.ts"
import { loadRuleTypeScript } from "./typescript.ts"

const EXPECTATION = ["NF-S010", "host-exposure"]
/** Names that put a Host check or Host policy on a server. */
const HOST_OPTIONS: ReadonlySet<string> = new Set(["validateHost", "allowedHosts", "canonicalHost"])
const HOST_OPTION_HINT = /\b(?:validateHost|allowedHosts|canonicalHost)\b/
const LISTENER_HINT = /\b(?:serve|listen)\b/
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/
const TS_FILE = /\.[cm]?tsx?$/
/** Options that mean the listener terminates TLS itself, so no proxy in front is handling Host. */
const TLS_OPTIONS: ReadonlySet<string> = new Set(["tls", "cert"])

type Runtime = "deno" | "bun"

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

/**
 * Whether code in `tree` puts a Host check or policy on a server: a `validateHost` that is not the
 * literal `false`, or an `allowedHosts` or `canonicalHost`. A comment or a string that names one
 * configures nothing.
 */
function configuresHost(ts: typeof TSApi, tree: TSApi.SourceFile): boolean {
  const visit = (node: TSApi.Node): boolean => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        const key = propertyKey(ts, prop)
        if (key === undefined || !HOST_OPTIONS.has(key)) continue
        if (
          key === "validateHost" &&
          ts.isPropertyAssignment(prop) &&
          prop.initializer.kind === ts.SyntaxKind.FalseKeyword
        )
          continue
        return true
      }
    }
    return ts.forEachChild(node, (child) => (visit(child) ? true : undefined)) === true
  }
  return visit(tree)
}

/** The local names `@nifrajs/deno` exports `serve` under in this file. */
function serveImports(ts: typeof TSApi, tree: TSApi.SourceFile): ReadonlyMap<string, Runtime> {
  const found = new Map<string, Runtime>()
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier))
      continue
    if (statement.moduleSpecifier.text !== "@nifrajs/deno") continue
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined) continue
    if (ts.isNamespaceImport(bindings)) found.set(`${bindings.name.text}.serve`, "deno")
    else {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === "serve")
          found.set(element.name.text, "deno")
      }
    }
  }
  return found
}

/** Whether the file imports a nifra package whose `listen()` is Bun's. */
function importsCore(ts: typeof TSApi, tree: TSApi.SourceFile): boolean {
  return tree.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      (statement.moduleSpecifier.text === "@nifrajs/core" ||
        statement.moduleSpecifier.text.startsWith("@nifrajs/core/")),
  )
}

function calleeName(ts: typeof TSApi, callee: TSApi.Expression): string | undefined {
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression))
    return `${callee.expression.text}.${callee.name.text}`
  return undefined
}

function runtimeOf(
  ts: typeof TSApi,
  call: TSApi.CallExpression,
  imports: ReadonlyMap<string, Runtime>,
  core: boolean,
): Runtime | undefined {
  const name = calleeName(ts, call.expression)
  if (name === undefined) return undefined
  const imported = imports.get(name)
  if (imported !== undefined) return imported
  if (name === "Deno.serve") return "deno"
  if (name === "Bun.serve") return "bun"
  if (
    core &&
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === "listen"
  )
    return "bun"
  return undefined
}

/** Whether the options a listener is given hold TLS: the listener terminates it, with no proxy in front. */
function terminatesTls(ts: typeof TSApi, call: TSApi.CallExpression): boolean {
  const options = call.arguments.find(ts.isObjectLiteralExpression)
  if (options === undefined) return false
  return options.properties.some((prop) => {
    const key = propertyKey(ts, prop)
    return key !== undefined && TLS_OPTIONS.has(key)
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
}

function listenersIn(
  ts: typeof TSApi,
  tree: TSApi.SourceFile,
  topology: HostTopology | undefined,
): readonly Listener[] {
  const imports = serveImports(ts, tree)
  const core = importsCore(ts, tree)
  const found: Listener[] = []
  const visit = (node: TSApi.Node): void => {
    if (ts.isCallExpression(node)) {
      const runtime = runtimeOf(ts, node, imports, core)
      if (runtime !== undefined && (topology === "direct" || terminatesTls(ts, node)))
        found.push({ position: node.expression.getStart(tree), runtime })
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
 * `"hostTopology": "proxied"`. A project that names `validateHost`, `allowedHosts` or
 * `canonicalHost` in code anywhere is left alone.
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
      const parsed: { file: string; source: ParsedSource }[] = []
      for (const file of sources.files) {
        if (!SCRIPT_FILE.test(file)) continue
        const source = parsedFile(ts, sources, file)
        if (source === undefined) continue
        if (HOST_OPTION_HINT.test(source.tree.text) && configuresHost(ts, source.tree)) return []
        parsed.push({ file, source })
      }
      const findings: Diagnostic[] = []
      for (const { file, source } of parsed) {
        if (!TS_FILE.test(file) || !LISTENER_HINT.test(source.tree.text)) continue
        const { tree, lines } = source
        for (const listener of listenersIn(ts, tree, topology)) {
          const line = tree.getLineAndCharacterOfPosition(listener.position).line + 1
          const expected = commentBlockExpectation(lines, line, EXPECTATION)
          if (expected?.reason !== undefined) continue
          const message = `This ${LABEL[listener.runtime]} listener answers every request without checking Host: ${CONSEQUENCE[listener.runtime]}. Set \`validateHost: true\` (one header read per request), or say a proxy in front checks it with \`"hostTopology": "proxied"\` in nifra.check.json or a \`nifra-expect NF-S010: <reason>\` comment above the listener`
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
                "no validateHost, allowedHosts or canonicalHost is set anywhere in the project",
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

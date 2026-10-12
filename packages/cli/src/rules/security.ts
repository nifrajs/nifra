import type * as TSApi from "typescript"
import { BACKEND_APP_FILE } from "../app-files.ts"
import { isBrowserSource } from "../check-scan.ts"
import { type Diagnostic, diagnostic } from "../diagnostics.ts"
import { createWebAppProbe } from "../internal/nifra-project.ts"
import { scriptKindOf } from "../internal/script-kind.ts"
import {
  commentBlockExpectation,
  commentBlockHasMarker,
  MISSING_EXPECTATION_REASON,
} from "./comment-markers.ts"
import type { CheckRule, SourceIndex } from "./index.ts"
import { loadRuleTypeScript } from "./typescript.ts"

/**
 * A security rule that cannot run says so as an advisory finding instead of silently returning no
 * findings - a report that skipped a scanner reads as "scanned and safe", which is a lie. Same
 * contract the interpolated-SQL rule already keeps.
 */
function didNotRun(code: string, title: string): readonly Diagnostic[] {
  return [
    diagnostic({
      code,
      severity: "warn",
      message: `${title} (${code}) did NOT run - TypeScript is not installed, so this report says nothing about it`,
      fix: { recipe: "toolchain.install-typescript", command: "bun add -d typescript" },
      verify: "nifra check --lints-only",
    }),
  ]
}

const SECRET = /(?:token|secret|apiKey|api_key|signature|hmac|password)/i
const PII = /(?:email|phone|ssn|password|token|authorization)/i
// Retired in 5.0.0: it silenced any security finding without a reason. It now silences nothing and
// only makes the finding name the form that replaced it.
const RETIRED_REVIEW_MARKER = "@nifra-gate-reviewed"
const parseCache = new WeakMap<
  SourceIndex,
  Map<string, { readonly tree: TSApi.SourceFile; readonly lines: readonly string[] }>
>()

/**
 * The reason a `nifra-expect <code>: <reason>` comment on or above `line` gives for a security
 * finding. Every security hatch needs the reason: a comment without one silences nothing.
 */
function expectedReason(lines: readonly string[], line: number, code: string): string | undefined {
  return commentBlockExpectation(lines, line, [code])?.reason
}

/** The evidence a silenced finding carries: the comment that silenced it, reason included. */
function expectationEvidence(
  lines: readonly string[],
  line: number,
  code: string,
): readonly string[] {
  const reason = expectedReason(lines, line, code)
  return reason === undefined ? [] : [`nifra-expect ${code}: ${reason}`]
}

/** An unsilenced finding's message, plus why a hatch comment written for it does not count. */
function unexpectedMessage(
  message: string,
  lines: readonly string[],
  line: number,
  code: string,
): string {
  if (commentBlockExpectation(lines, line, [code]) !== undefined)
    return `${message}; ${MISSING_EXPECTATION_REASON}`
  if (commentBlockHasMarker(lines, line, RETIRED_REVIEW_MARKER))
    return `${message}; ${RETIRED_REVIEW_MARKER} no longer silences a finding - after review, write // nifra-expect ${code}: <reason>`
  return message
}

const parentOf = (dir: string): string => dir.slice(0, Math.max(dir.lastIndexOf("/"), 0))

/**
 * Whether NF-S001 and NF-S002 may treat `file` as browser code, where a finding is advisory: a
 * browser compares values the client already holds, and a gate there that fails open grants nothing
 * the server does not check again. It must be browser code by path (a route's frontend half,
 * `frontend/`) and sit inside a nifra web app: a `routes/` folder in an API-only project or a package
 * without a web dependency runs on the server. `shared/` also runs on the server, and a file that
 * cannot be classified is treated as server - fail closed.
 */
export function provenBrowserFile(
  root: string,
  file: string,
  inWebApp: (dir: string) => boolean = createWebAppProbe(root),
): boolean {
  const path = file.replaceAll("\\", "/")
  if (!isBrowserSource(path) || /\.server\.[cm]?[tj]sx?$/.test(path)) return false
  if (/\.shared\.[^/]+$/.test(path) || /(?:^|\/)shared\//.test(path)) return false
  return inWebApp(parentOf(path))
}

const CONFIRMATION_NAME =
  /^(?:confirm|confirmation|confirmPassword|passwordConfirmation|passwordConfirm|passwordRepeat|repeatPassword)$/i

/** Client form confirmation compares two values already held by the browser, not secret material. */
function isClientConfirmationPair(
  browser: boolean,
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (!browser) return false
  const names = [left, right]
  return (
    names.some((name) => name?.toLowerCase() === "password") &&
    names.some((name) => name !== undefined && CONFIRMATION_NAME.test(name))
  )
}

function nameOf(ts: typeof TSApi, node: TSApi.Node): string | undefined {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  return undefined
}

/**
 * The operand name to match secret-like patterns against for NF-S002, or undefined when the operand
 * cannot hold runtime secret material. A property access to a PascalCase member
 * (`ts.SyntaxKind.PlusToken`, `MediaKind.Audio`) reads an enum/type-constant discriminant, never a
 * secret string or byte buffer, so comparing against it is a kind check a timing oracle does not
 * apply to. An `UPPER_SNAKE` member is the configuration spelling (`process.env.API_TOKEN`,
 * `env.WEBHOOK_SECRET`) and stays matched, as does a string-literal element access
 * (`process.env["API_KEY"]`).
 */
function secretName(ts: typeof TSApi, node: TSApi.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) {
    const member = node.name.text
    return /^[A-Z]/.test(member) && !/^[A-Z][A-Z0-9_]*$/.test(member) ? undefined : member
  }
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
    return node.argumentExpression.text
  return nameOf(ts, node)
}

/**
 * Presence checks (`token === undefined`, `secret == null`, `apiKey !== ""`) and `typeof` guards are
 * not equality over secret material - rewriting them to a timing-safe comparison would break the code.
 * A comparison against a numeric literal (`signature !== 1`, `signatureLength !== 64`) is a
 * length/version/discriminant check, and one against `true`/`false` (`persistRefreshToken === true`)
 * is a flag check: secrets are strings or bytes, so a number or a boolean on either side proves this
 * is not the compare a timing oracle applies to.
 */
function isPresenceComparison(ts: typeof TSApi, node: TSApi.BinaryExpression): boolean {
  for (const side of [node.left, node.right]) {
    if (ts.isIdentifier(side) && side.text === "undefined") return true
    if (side.kind === ts.SyntaxKind.NullKeyword) return true
    if (side.kind === ts.SyntaxKind.TrueKeyword || side.kind === ts.SyntaxKind.FalseKeyword)
      return true
    if (ts.isStringLiteralLike(side) && side.text === "") return true
    if (ts.isTypeOfExpression(side)) return true
    if (ts.isVoidExpression(side)) return true
    if (ts.isNumericLiteral(side)) return true
    if (ts.isPrefixUnaryExpression(side) && ts.isNumericLiteral(side.operand)) return true
  }
  return false
}

function parse(ts: typeof TSApi, file: string, source: string): TSApi.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindOf(ts, file))
}

function parsedFile(
  ts: typeof TSApi,
  sources: SourceIndex,
  file: string,
): { readonly tree: TSApi.SourceFile; readonly lines: readonly string[] } | undefined {
  let files = parseCache.get(sources)
  if (files === undefined) {
    files = new Map()
    parseCache.set(sources, files)
  }
  const cached = files.get(file)
  if (cached !== undefined) return cached
  const source = sources.read(file)
  if (source === undefined) return undefined
  const tree = parse(ts, file, source)
  const parsed = { tree, lines: tree.text.split("\n") }
  files.set(file, parsed)
  return parsed
}

interface SecretComparison {
  readonly node: TSApi.BinaryExpression
  readonly left: string | undefined
  readonly right: string | undefined
  readonly line: number
}

// The last word of a name that states a fact about a secret rather than holding it: `tokenType`,
// `SECRET_CAP_SQLSTATE`, `apiKeyIds`, `apiKeyHeaderName`. Exact words only, so the secret word anywhere
// else still matches (`tokenValue`, `passwordHash`, `apiKeyHeader`). `code`, `url`, `path` and `prefix`
// stay out: an OTP, a capability URL and a prefix compare all leak secret material.
const NON_MATERIAL_WORD: ReadonlySet<string> = new Set([
  "type",
  "kind",
  "name",
  "id",
  "ids",
  "length",
  "len",
  "count",
  "size",
  "mode",
  "policy",
  "version",
  "sqlstate",
  "status",
  "enabled",
  "required",
  "ttl",
  "expiry",
  "expires",
])

function lastWord(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_$-]+/)
  return (words.findLast((word) => word !== "") ?? "").toLowerCase()
}

function isSecretName(name: string | undefined): boolean {
  return name !== undefined && SECRET.test(name) && !NON_MATERIAL_WORD.has(lastWord(name))
}

/** Whether `name` binds a declaration in `statements` itself (not in a nested scope). */
function declaresIn(
  ts: typeof TSApi,
  statements: TSApi.NodeArray<TSApi.Statement>,
  name: string,
): boolean {
  return statements.some((statement) => {
    if (ts.isVariableStatement(statement))
      return statement.declarationList.declarations.some((d) => bindsName(ts, d.name, name))
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
      return statement.name?.text === name
    return false
  })
}

function bindsName(ts: typeof TSApi, binding: TSApi.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name
  return binding.elements.some(
    (element) => !ts.isOmittedExpression(element) && bindsName(ts, element.name, name),
  )
}

/**
 * Whether `id` names a plain parameter of an enclosing function, not a value the file builds: the
 * nearest declaration of the name, walking out, must be that parameter. A loop or catch variable, a
 * local or a destructured parameter in between disproves it.
 */
function isParameterRef(ts: typeof TSApi, id: TSApi.Identifier): boolean {
  for (let node: TSApi.Node | undefined = id.parent; node !== undefined; node = node.parent) {
    if (ts.isFunctionLike(node)) {
      for (const parameter of node.parameters) {
        if (ts.isIdentifier(parameter.name)) {
          if (parameter.name.text === id.text) return true
        } else if (bindsName(ts, parameter.name, id.text)) return false
      }
    }
    if ((ts.isBlock(node) || ts.isSourceFile(node)) && declaresIn(ts, node.statements, id.text))
      return false
    if (
      (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      node.initializer !== undefined &&
      ts.isVariableDeclarationList(node.initializer) &&
      node.initializer.declarations.some((d) => bindsName(ts, d.name, id.text))
    )
      return false
    if (
      ts.isCatchClause(node) &&
      node.variableDeclaration !== undefined &&
      bindsName(ts, node.variableDeclaration.name, id.text)
    )
      return false
  }
  return false
}

const CONFIG_KEY = /^[A-Z][A-Z0-9_]*$/
const CONTEXT_NAMES: ReadonlySet<string> = new Set(["c", "ctx", "context"])

/**
 * Whether `node` reads deployment configuration: `process.env.X`, `Bun.env.X`, `import.meta.env.X`,
 * `Deno.env.get("X")`, `c.env.UPPER_SNAKE` (also `ctx`/`context`), or `env.X`, where `c` and `env` must
 * be parameters of an enclosing function, never values the file builds. Comparing two such reads
 * involves no request value, so it is no timing oracle (a startup "keys must differ" check).
 */
function isConfigRead(ts: typeof TSApi, node: TSApi.Expression): boolean {
  if (ts.isCallExpression(node)) {
    const callee = node.expression
    const [key] = node.arguments
    return (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "get" &&
      ts.isPropertyAccessExpression(callee.expression) &&
      callee.expression.name.text === "env" &&
      ts.isIdentifier(callee.expression.expression) &&
      callee.expression.expression.text === "Deno" &&
      node.arguments.length === 1 &&
      key !== undefined &&
      ts.isStringLiteralLike(key)
    )
  }
  let key: string
  if (ts.isPropertyAccessExpression(node)) key = node.name.text
  else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
    key = node.argumentExpression.text
  else return false
  const object = node.expression
  if (ts.isIdentifier(object)) return object.text === "env" && isParameterRef(ts, object)
  if (!ts.isPropertyAccessExpression(object) || object.name.text !== "env") return false
  const owner = object.expression
  if (ts.isMetaProperty(owner)) return owner.name.text === "meta"
  if (!ts.isIdentifier(owner)) return false
  if (owner.text === "process" || owner.text === "Bun") return true
  return CONTEXT_NAMES.has(owner.text) && CONFIG_KEY.test(key) && isParameterRef(ts, owner)
}

function secretComparisons(
  ts: typeof TSApi,
  tree: TSApi.SourceFile,
  browser: boolean,
): readonly SecretComparison[] {
  const operators = [
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
  ]
  const found: SecretComparison[] = []
  const visit = (node: TSApi.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      operators.includes(node.operatorToken.kind) &&
      !isPresenceComparison(ts, node)
    ) {
      const left = secretName(ts, node.left)
      const right = secretName(ts, node.right)
      if (
        (isSecretName(left) || isSecretName(right)) &&
        !isClientConfirmationPair(browser, left, right) &&
        !(isConfigRead(ts, node.left) && isConfigRead(ts, node.right))
      ) {
        const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1
        found.push({ node, left, right, line })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return found
}

function timingSafeHelper(file: string): string {
  const typed = /\.[cm]?tsx?$/.test(file)
  return [
    'import { timingSafeEqual as nifraTimingSafeEqualBytes } from "node:crypto"',
    "",
    typed
      ? "function nifraTimingSafeEqual(left: string, right: string): boolean {"
      : "function nifraTimingSafeEqual(left, right) {",
    "  const leftBytes = Buffer.from(left)",
    "  const rightBytes = Buffer.from(right)",
    "  return leftBytes.length === rightBytes.length && nifraTimingSafeEqualBytes(leftBytes, rightBytes)",
    "}",
  ].join("\n")
}

/**
 * Rewrite every unreviewed NF-S002 comparison in one file to `nifraTimingSafeEqual(left, right)` and
 * add the helper once. Sites come from the syntax tree, not a reported line: the helper lands above
 * them, so a line number a check run reported no longer names the same statement after the first fix.
 * `browser` is {@link provenBrowserFile} for the file, so the fix rewrites exactly what check reported.
 */
export function rewriteSecretComparisons(
  ts: typeof TSApi,
  file: string,
  source: string,
  browser: boolean,
): string {
  const tree = parse(ts, file, source)
  const lines = tree.text.split("\n")
  const sites = secretComparisons(ts, tree, browser).filter(
    (site) => expectedReason(lines, site.line, "NF-S002") === undefined,
  )
  // A comparison nested inside another (`(token === a) === flag`) is left for the next run, so every
  // edit below covers a disjoint range and applying them from the end keeps earlier offsets valid.
  const outer = sites.filter(
    ({ node }) =>
      !sites.some(
        (other) => other.node !== node && other.node.pos >= node.pos && other.node.end <= node.end,
      ),
  )
  if (outer.length === 0) return source
  let text = source
  for (const { node } of outer.toSorted((a, b) => b.node.end - a.node.end)) {
    const call = `nifraTimingSafeEqual(${node.left.getText(tree)}, ${node.right.getText(tree)})`
    const negated =
      node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken
    text = `${text.slice(0, node.getStart(tree))}${negated ? `!${call}` : call}${text.slice(node.end)}`
  }
  if (source.includes("function nifraTimingSafeEqual")) return text
  // After a shebang and the directive prologue: an import above `"use client"` turns it into a no-op.
  let at = 0
  for (const statement of tree.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break
    at = statement.end
  }
  if (at === 0 && text.startsWith("#!")) at = text.includes("\n") ? text.indexOf("\n") : text.length
  const helper = timingSafeHelper(file)
  return at === 0 ? `${helper}\n\n${text}` : `${text.slice(0, at)}\n\n${helper}\n${text.slice(at)}`
}

export const secretComparisonRule: CheckRule = {
  code: "NF-S002",
  title: "Non-constant-time secret comparison",
  async scan(ctx) {
    const loaded = await loadRuleTypeScript(ctx)
    if (loaded.diagnostics !== undefined) return loaded.diagnostics
    const ts = loaded.compiler
    if (ts === undefined) return didNotRun("NF-S002", "Non-constant-time secret comparison scan")
    const findings: Diagnostic[] = []
    const webDirs = createWebAppProbe(ctx.root)
    for (const file of ctx.project.source.files) {
      const parsed = parsedFile(ts, ctx.project.source, file)
      if (parsed === undefined) continue
      const { tree, lines } = parsed
      const browser = provenBrowserFile(ctx.root, file, webDirs)
      for (const { left, right, line } of secretComparisons(ts, tree, browser)) {
        const reviewed = expectedReason(lines, line, "NF-S002") !== undefined
        findings.push(
          diagnostic({
            code: "NF-S002",
            severity: reviewed ? "info" : browser ? "warn" : "error",
            file,
            line,
            message: reviewed
              ? "secret comparison is expected here"
              : unexpectedMessage(
                  "secret-like values must use a length check and timing-safe comparison",
                  lines,
                  line,
                  "NF-S002",
                ),
            evidence: [
              left ?? right ?? "secret comparison",
              ...expectationEvidence(lines, line, "NF-S002"),
            ],
            ...(reviewed
              ? {}
              : {
                  fix: {
                    recipe: "security.timing-safe-equal",
                    command: "nifra fix --code NF-S002",
                  },
                }),
            verify: "nifra check --lints-only",
          }),
        )
      }
    }
    return findings
  },
}

export const piiLogRule: CheckRule = {
  code: "NF-S003",
  title: "Sensitive value in log call",
  async scan(ctx) {
    const loaded = await loadRuleTypeScript(ctx)
    if (loaded.diagnostics !== undefined) return loaded.diagnostics
    const ts = loaded.compiler
    if (ts === undefined) return didNotRun("NF-S003", "Sensitive-value-in-log scan")
    const findings: Diagnostic[] = []
    for (const file of ctx.project.source.files) {
      const parsed = parsedFile(ts, ctx.project.source, file)
      if (parsed === undefined) continue
      const { tree, lines } = parsed
      const visit = (node: TSApi.Node): void => {
        if (ts.isCallExpression(node)) {
          const expression = node.expression
          const callee = ts.isPropertyAccessExpression(expression)
            ? `${nameOf(ts, expression.expression) ?? ""}.${expression.name.text}`
            : (nameOf(ts, expression) ?? "")
          if (/^(?:console|logger)\./.test(callee)) {
            for (const arg of node.arguments) {
              const name = nameOf(ts, arg)
              if (name !== undefined && PII.test(name)) {
                const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1
                const reviewed = expectedReason(lines, line, "NF-S003") !== undefined
                findings.push(
                  diagnostic({
                    code: "NF-S003",
                    severity: reviewed ? "info" : "warn",
                    file,
                    line,
                    message: reviewed
                      ? "sensitive value in log call is expected here"
                      : unexpectedMessage(
                          "PII-shaped values must not be passed directly to log calls",
                          lines,
                          line,
                          "NF-S003",
                        ),
                    evidence: [name, ...expectationEvidence(lines, line, "NF-S003")],
                    verify: "nifra check --lints-only",
                  }),
                )
              }
            }
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(tree)
    }
    return findings
  },
}

/**
 * A function's own name, or for an anonymous arrow/function expression the name it is bound to
 * (`const requireAuth = async () => …`, `{ canEdit: () => … }`), which is how a gate is usually written.
 */
function functionName(ts: typeof TSApi, fn: TSApi.Node): string | undefined {
  if (ts.isFunctionLike(fn) && fn.name !== undefined)
    return ts.isIdentifier(fn.name) ? fn.name.text : undefined
  let binding = fn.parent
  while (
    binding !== undefined &&
    (ts.isParenthesizedExpression(binding) ||
      ts.isAsExpression(binding) ||
      ts.isSatisfiesExpression(binding))
  )
    binding = binding.parent
  if (
    binding !== undefined &&
    (ts.isVariableDeclaration(binding) || ts.isPropertyAssignment(binding)) &&
    ts.isIdentifier(binding.name)
  )
    return binding.name.text
  return undefined
}

/**
 * A gate's name. `can` only names a gate in camelCase (`canEdit`, `canAccess`) - matching it
 * case-insensitively swept in `canonicalize…`, `cancel…`, `candidate…`, none of them authorization
 * decisions. `ensure`/`verify`/`check`/`validate` name one only before what a gate decides on
 * (`verifyToken`, `ensureLoggedIn`, `checkPermission`), so `ensureDir` and `checkHealth` are not gates.
 */
const GATE_NAMES = [
  /^(?:require|assert|authori[sz]e|authenticate)/i,
  /^can[A-Z]/,
  /.Guard$/,
  /^(?:ensure|verify|check|validate)(?:Auth|LoggedIn|Login|Session|Token|Jwt|JWT|Signature|Webhook|Hmac|HMAC|Password|Credential|Permission|Access|Role|Admin|Owner|Scope|Csrf|CSRF|ApiKey|Origin|Tenant|User|Member)/,
]

/** Helpers whose whole job is to fail (`fail(…)`, `deny(…)`, `reject(…)`, …). */
const FAILING_HELPERS = new Set(["fail", "deny", "reject", "forbid", "unauthorized", "abort"])

/**
 * Whether a gate's catch block fails closed: it throws, returns `false`, a `new Response(…)` or a
 * `deny…(…)` call, or hands the failure to a {@link FAILING_HELPERS} helper. The last form is why
 * conformance/invariant asserts that funnel every error through a `never`-returning `fail()` are not
 * fail-open - the scanner reads no types, so it trusts the helper by name, the same trade the SQL and
 * gate-name heuristics already make. Read from the syntax, so a "throw" in a comment or a string counts
 * for nothing, and a nested function's statements are not the catch's own.
 */
function failsClosed(ts: typeof TSApi, block: TSApi.Block): boolean {
  let closed = false
  const visit = (node: TSApi.Node): void => {
    if (closed || ts.isFunctionLike(node)) return
    if (
      ts.isThrowStatement(node) ||
      (ts.isReturnStatement(node) &&
        node.expression !== undefined &&
        isDenial(ts, node.expression)) ||
      (ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        FAILING_HELPERS.has(node.expression.text))
    ) {
      closed = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(block)
  return closed
}

function isDenial(ts: typeof TSApi, expression: TSApi.Expression): boolean {
  let value = expression
  while (
    ts.isParenthesizedExpression(value) ||
    ts.isAwaitExpression(value) ||
    ts.isAsExpression(value) ||
    ts.isSatisfiesExpression(value)
  )
    value = value.expression
  if (value.kind === ts.SyntaxKind.FalseKeyword) return true
  if (ts.isNewExpression(value))
    return ts.isIdentifier(value.expression) && value.expression.text === "Response"
  return (
    ts.isCallExpression(value) &&
    ts.isIdentifier(value.expression) &&
    value.expression.text.startsWith("deny")
  )
}

export const failOpenGateRule: CheckRule = {
  code: "NF-S001",
  title: "Fail-open gate",
  async scan(ctx) {
    const loaded = await loadRuleTypeScript(ctx)
    if (loaded.diagnostics !== undefined) return loaded.diagnostics
    const ts = loaded.compiler
    if (ts === undefined) return didNotRun("NF-S001", "Fail-open gate scan")
    const findings: Diagnostic[] = []
    const webDirs = createWebAppProbe(ctx.root)
    for (const file of ctx.project.source.files) {
      const parsed = parsedFile(ts, ctx.project.source, file)
      if (parsed === undefined) continue
      const { tree, lines } = parsed
      let browser: boolean | undefined
      const visit = (node: TSApi.Node): void => {
        if (ts.isCatchClause(node)) {
          let parent: TSApi.Node | undefined = node.parent
          while (parent !== undefined && !ts.isFunctionLike(parent)) parent = parent.parent
          const name = parent === undefined ? undefined : functionName(ts, parent)
          if (name !== undefined && GATE_NAMES.some((gate) => gate.test(name))) {
            if (!failsClosed(ts, node.block)) {
              const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1
              const reviewed = expectedReason(lines, line, "NF-S001") !== undefined
              browser ??= provenBrowserFile(ctx.root, file, webDirs)
              findings.push(
                diagnostic({
                  code: "NF-S001",
                  severity: reviewed ? "info" : browser ? "warn" : "error",
                  file,
                  line,
                  message: reviewed
                    ? "gate catch block is expected here"
                    : unexpectedMessage(
                        "gate catch blocks must rethrow or return an explicit denial",
                        lines,
                        line,
                        "NF-S001",
                      ),
                  evidence: [
                    name,
                    "catch block has no denial or rethrow",
                    ...(browser ? ["browser code: the server's own gate decides"] : []),
                    ...expectationEvidence(lines, line, "NF-S001"),
                  ],
                  verify: "nifra check --lints-only",
                }),
              )
            }
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(tree)
    }
    return findings
  },
}

/** True when `param` is referenced anywhere inside `body`. */
function usesParam(ts: typeof TSApi, body: TSApi.Node, param: string): boolean {
  let used = false
  const walk = (n: TSApi.Node): void => {
    if (used) return
    if (ts.isIdentifier(n) && n.text === param) {
      used = true
      return
    }
    ts.forEachChild(n, walk)
  }
  walk(body)
  return used
}

export const corsOriginPredicateRule: CheckRule = {
  code: "NF-S004",
  title: "CORS origin predicate ignores the origin",
  async scan(ctx) {
    const loaded = await loadRuleTypeScript(ctx)
    if (loaded.diagnostics !== undefined) return loaded.diagnostics
    const ts = loaded.compiler
    if (ts === undefined) return didNotRun("NF-S004", "CORS origin predicate scan")
    const findings: Diagnostic[] = []
    for (const file of ctx.project.source.files) {
      const parsed = parsedFile(ts, ctx.project.source, file)
      if (parsed === undefined) continue
      const { tree, lines } = parsed
      const visit = (node: TSApi.Node): void => {
        if (ts.isCallExpression(node) && nameOf(ts, node.expression) === "cors") {
          const arg = node.arguments[0]
          if (arg !== undefined && ts.isObjectLiteralExpression(arg)) {
            for (const prop of arg.properties) {
              if (
                ts.isPropertyAssignment(prop) &&
                nameOf(ts, prop.name) === "origin" &&
                (ts.isArrowFunction(prop.initializer) || ts.isFunctionExpression(prop.initializer))
              ) {
                const fn = prop.initializer
                const param = fn.parameters[0]?.name
                // A predicate with no parameter, or one that never reads it, allows every origin -
                // the guardrail the predicate form exists for is bypassed. A destructured parameter
                // is left alone (can't cheaply prove non-use).
                const ignoresOrigin =
                  param === undefined
                    ? true
                    : ts.isIdentifier(param)
                      ? !usesParam(ts, fn.body, param.text)
                      : false
                if (ignoresOrigin) {
                  const line = tree.getLineAndCharacterOfPosition(prop.getStart(tree)).line + 1
                  const reviewed = expectedReason(lines, line, "NF-S004") !== undefined
                  findings.push(
                    diagnostic({
                      code: "NF-S004",
                      severity: reviewed ? "info" : "warn",
                      file,
                      line,
                      message: reviewed
                        ? "constant CORS origin predicate is expected here"
                        : unexpectedMessage(
                            "CORS origin predicate never inspects the origin - it allows every origin; list explicit origins or use the argument",
                            lines,
                            line,
                            "NF-S004",
                          ),
                      evidence: [
                        "origin predicate",
                        ...expectationEvidence(lines, line, "NF-S004"),
                      ],
                      verify: "nifra check --lints-only",
                    }),
                  )
                }
              }
            }
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(tree)
    }
    return findings
  },
}

export const externalRedirectRule: CheckRule = {
  code: "NF-S005",
  title: "External redirect opt-out",
  async scan(ctx) {
    const loaded = await loadRuleTypeScript(ctx)
    if (loaded.diagnostics !== undefined) return loaded.diagnostics
    const ts = loaded.compiler
    if (ts === undefined) return didNotRun("NF-S005", "External redirect opt-out scan")
    const findings: Diagnostic[] = []
    for (const file of ctx.project.source.files) {
      const parsed = parsedFile(ts, ctx.project.source, file)
      if (parsed === undefined) continue
      const { tree, lines } = parsed
      const visit = (node: TSApi.Node): void => {
        if (ts.isCallExpression(node) && nameOf(ts, node.expression) === "redirect") {
          for (const arg of node.arguments) {
            if (!ts.isObjectLiteralExpression(arg)) continue
            for (const prop of arg.properties) {
              if (
                ts.isPropertyAssignment(prop) &&
                nameOf(ts, prop.name) === "external" &&
                prop.initializer.kind === ts.SyntaxKind.TrueKeyword
              ) {
                const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1
                const reviewed = expectedReason(lines, line, "NF-S005") !== undefined
                findings.push(
                  diagnostic({
                    code: "NF-S005",
                    severity: reviewed ? "info" : "warn",
                    file,
                    line,
                    message: reviewed
                      ? "external redirect is expected here"
                      : unexpectedMessage(
                          "redirect opts out of the same-origin default - verify the target can never be derived from request input (open-redirect risk)",
                          lines,
                          line,
                          "NF-S005",
                        ),
                    evidence: ["external: true", ...expectationEvidence(lines, line, "NF-S005")],
                    verify: "nifra check --lints-only",
                  }),
                )
              }
            }
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(tree)
    }
    return findings
  },
}

const ESCAPE_HATCHES: Readonly<Record<string, string>> = {
  allowLengthless:
    "body-limit stops publishing BODY_BOUNDED evidence - lengthless (chunked) bodies bypass the Content-Length gate",
  allowGlobalKey:
    "rate limiting collapses to one shared bucket - any client can exhaust the global allowance for everyone",
  allowInProduction:
    "in-memory rate-limit store in production - counts are per-instance and reset on restart",
}

export const assuranceEscapeHatchRule: CheckRule = {
  code: "NF-S006",
  title: "Security escape hatch enabled",
  async scan(ctx) {
    const loaded = await loadRuleTypeScript(ctx)
    if (loaded.diagnostics !== undefined) return loaded.diagnostics
    const ts = loaded.compiler
    if (ts === undefined) return didNotRun("NF-S006", "Security escape hatch scan")
    const findings: Diagnostic[] = []
    for (const file of ctx.project.source.files) {
      const parsed = parsedFile(ts, ctx.project.source, file)
      if (parsed === undefined) continue
      const { tree, lines } = parsed
      const visit = (node: TSApi.Node): void => {
        if (ts.isPropertyAssignment(node) && node.initializer.kind === ts.SyntaxKind.TrueKeyword) {
          const name = nameOf(ts, node.name)
          const consequence = name !== undefined ? ESCAPE_HATCHES[name] : undefined
          if (name !== undefined && consequence !== undefined) {
            const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1
            const reviewed = expectedReason(lines, line, "NF-S006") !== undefined
            findings.push(
              diagnostic({
                code: "NF-S006",
                severity: reviewed ? "info" : "warn",
                file,
                line,
                message: reviewed
                  ? `${name} escape hatch is expected here`
                  : unexpectedMessage(`${name}: ${consequence}`, lines, line, "NF-S006"),
                evidence: [name, ...expectationEvidence(lines, line, "NF-S006")],
                verify: "nifra check --lints-only",
              }),
            )
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(tree)
    }
    return findings
  },
}

const COOKIE_PREFIX = /^__(?:Host|Secure)-/

export const unprefixedSecureCookieRule: CheckRule = {
  code: "NF-S007",
  title: "Secure cookie without a __Host-/__Secure- prefix",
  async scan(ctx) {
    const loaded = await loadRuleTypeScript(ctx)
    if (loaded.diagnostics !== undefined) return loaded.diagnostics
    const ts = loaded.compiler
    if (ts === undefined) return didNotRun("NF-S007", "Secure cookie prefix scan")
    const findings: Diagnostic[] = []
    for (const file of ctx.project.source.files) {
      const parsed = parsedFile(ts, ctx.project.source, file)
      if (parsed === undefined) continue
      const { tree } = parsed
      const visit = (node: TSApi.Node): void => {
        if (ts.isCallExpression(node)) {
          const callee = nameOf(ts, node.expression)
          if (callee === "cookie" || callee === "serializeCookie") {
            const nameArg = node.arguments[0]
            const hasPrefix =
              nameArg !== undefined &&
              ts.isStringLiteralLike(nameArg) &&
              COOKIE_PREFIX.test(nameArg.text)
            const secure = node.arguments.some(
              (arg) =>
                ts.isObjectLiteralExpression(arg) &&
                arg.properties.some(
                  (prop) =>
                    ts.isPropertyAssignment(prop) &&
                    nameOf(ts, prop.name) === "secure" &&
                    prop.initializer.kind === ts.SyntaxKind.TrueKeyword,
                ),
            )
            // Only literal names are judged - a dynamic name can't be checked for a prefix.
            if (secure && !hasPrefix && nameArg !== undefined && ts.isStringLiteralLike(nameArg)) {
              const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1
              findings.push(
                diagnostic({
                  code: "NF-S007",
                  severity: "info",
                  file,
                  line,
                  message:
                    "Secure cookie without a __Host-/__Secure- prefix - a prefix stops subdomains and insecure contexts from shadowing it",
                  evidence: [nameArg.text],
                  verify: "nifra check --lints-only",
                }),
              )
            }
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(tree)
    }
    return findings
  },
}

/** Reads the backend the contract-lock check loaded; this rule runs no project code of its own. */
export const inputBeforeAuthenticationRule: CheckRule = {
  code: "NF-S008",
  title: "Authenticated route validates input before authentication",
  async scan(ctx) {
    return (ctx.project.check.contracts.inputBeforeAuth ?? []).map((route) =>
      diagnostic({
        code: "NF-S008",
        severity: "warn",
        file: BACKEND_APP_FILE,
        message: `${route} authenticates in a hook that runs after its declared input is validated, so an unauthenticated caller reaches the body parser and reads the validation issues. Authenticate with \`app.authenticate()\` (the first-party auth middleware already does), or set \`validationOrder: "auth-before-validation"\` on the route so its hooks run first`,
        evidence: [route],
        verify: "nifra check --lints-only",
      }),
    )
  },
}

export const securityRules = Object.freeze([
  failOpenGateRule,
  secretComparisonRule,
  piiLogRule,
  corsOriginPredicateRule,
  externalRedirectRule,
  assuranceEscapeHatchRule,
  unprefixedSecureCookieRule,
  inputBeforeAuthenticationRule,
])

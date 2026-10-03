import type * as TSApi from "typescript"
import { isBrowserSource } from "../check-scan.ts"
import { type Diagnostic, diagnostic } from "../diagnostics.ts"
import { commentBlockHasMarker } from "./comment-markers.ts"
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
const REVIEWED = "@nifra-gate-reviewed"
const parseCache = new WeakMap<
  SourceIndex,
  Map<string, { readonly tree: TSApi.SourceFile; readonly lines: readonly string[] }>
>()

// The marker counts anywhere in the contiguous comment block above the finding (or trailing on its
// line) - a human writing the multi-line justification the hatch asks for must not un-suppress the
// finding by growing the comment past two lines.
function hasReview(lines: readonly string[], line: number): boolean {
  return commentBlockHasMarker(lines, line, REVIEWED)
}

function reviewedEvidence(lines: readonly string[], line: number): readonly string[] {
  return hasReview(lines, line) ? [REVIEWED] : []
}

/**
 * NF-S002 severity by file role. Server-side code compares real secret material - a timing oracle
 * there is exploitable, so it fails the gate. Browser code (a route's frontend half, `frontend/`)
 * compares values the client already holds, so the same shape is advisory rather than a gate
 * failure. `shared/` also runs on the server, and a file that cannot be classified is treated as
 * server - fail closed.
 */
function secretComparisonSeverity(file: string): "error" | "warn" {
  const path = file.replaceAll("\\", "/")
  if (!isBrowserSource(path) || /\.server\.[cm]?[tj]sx?$/.test(path)) return "error"
  if (/\.shared\.[^/]+$/.test(path) || /(?:^|\/)shared\//.test(path)) return "error"
  return "warn"
}

const CONFIRMATION_NAME =
  /^(?:confirm|confirmation|confirmPassword|passwordConfirmation|passwordConfirm|passwordRepeat|repeatPassword)$/i

/** Client form confirmation compares two values already held by the browser, not secret material. */
function isClientConfirmationPair(
  file: string,
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (secretComparisonSeverity(file) !== "warn") return false
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
 * length/version/discriminant check, never a secret: secrets are strings or bytes, so a number on
 * either side proves this is not the compare a timing oracle applies to.
 */
function isPresenceComparison(ts: typeof TSApi, node: TSApi.BinaryExpression): boolean {
  for (const side of [node.left, node.right]) {
    if (ts.isIdentifier(side) && side.text === "undefined") return true
    if (side.kind === ts.SyntaxKind.NullKeyword) return true
    if (ts.isStringLiteralLike(side) && side.text === "") return true
    if (ts.isTypeOfExpression(side)) return true
    if (ts.isVoidExpression(side)) return true
    if (ts.isNumericLiteral(side)) return true
    if (ts.isPrefixUnaryExpression(side) && ts.isNumericLiteral(side.operand)) return true
  }
  return false
}

function parse(ts: typeof TSApi, file: string, source: string): TSApi.SourceFile {
  const kind = /\.tsx?$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.JS
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind)
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

function secretComparisons(
  ts: typeof TSApi,
  file: string,
  tree: TSApi.SourceFile,
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
        ((left !== undefined && SECRET.test(left)) ||
          (right !== undefined && SECRET.test(right))) &&
        !isClientConfirmationPair(file, left, right)
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
 */
export function rewriteSecretComparisons(ts: typeof TSApi, file: string, source: string): string {
  const tree = parse(ts, file, source)
  const lines = tree.text.split("\n")
  const sites = secretComparisons(ts, file, tree).filter((site) => !hasReview(lines, site.line))
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
    for (const file of ctx.project.source.files) {
      const parsed = parsedFile(ts, ctx.project.source, file)
      if (parsed === undefined) continue
      const { tree, lines } = parsed
      for (const { left, right, line } of secretComparisons(ts, file, tree)) {
        const reviewed = hasReview(lines, line)
        findings.push(
          diagnostic({
            code: "NF-S002",
            severity: reviewed ? "info" : secretComparisonSeverity(file),
            file,
            line,
            message: reviewed
              ? "secret comparison is explicitly marked as reviewed"
              : "secret-like values must use a length check and timing-safe comparison",
            evidence: [left ?? right ?? "secret comparison", ...reviewedEvidence(lines, line)],
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
                const reviewed = hasReview(lines, line)
                findings.push(
                  diagnostic({
                    code: "NF-S003",
                    severity: reviewed ? "info" : "warn",
                    file,
                    line,
                    message: reviewed
                      ? "sensitive value in log call is explicitly marked as reviewed"
                      : "PII-shaped values must not be passed directly to log calls",
                    evidence: [name, ...reviewedEvidence(lines, line)],
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

export const failOpenGateRule: CheckRule = {
  code: "NF-S001",
  title: "Fail-open gate",
  async scan(ctx) {
    const loaded = await loadRuleTypeScript(ctx)
    if (loaded.diagnostics !== undefined) return loaded.diagnostics
    const ts = loaded.compiler
    if (ts === undefined) return didNotRun("NF-S001", "Fail-open gate scan")
    const findings: Diagnostic[] = []
    for (const file of ctx.project.source.files) {
      const parsed = parsedFile(ts, ctx.project.source, file)
      if (parsed === undefined) continue
      const { tree, lines } = parsed
      const visit = (node: TSApi.Node): void => {
        if (ts.isCatchClause(node)) {
          let parent: TSApi.Node | undefined = node.parent
          while (parent !== undefined && !ts.isFunctionLike(parent)) parent = parent.parent
          const name =
            ts.isFunctionLike(parent) && parent.name && ts.isIdentifier(parent.name)
              ? parent.name.text
              : undefined
          // `can` only names a gate in camelCase (`canEdit`, `canAccess`) - matching it
          // case-insensitively swept in `canonicalize…`, `cancel…`, `candidate…`, none of them
          // authorization decisions. The other roots stay case-insensitive.
          const gateName =
            name !== undefined &&
            (/^(?:require|assert|authorize)/i.test(name) || /^can[A-Z]/.test(name))
          if (name !== undefined && gateName) {
            const text = node.block.getText(tree)
            // A catch fails closed when it rethrows, returns an explicit denial, or hands the failure
            // to a helper whose whole job is to fail (`fail(…)`, `deny(…)`, `reject(…)`, …). The last
            // form is why conformance/invariant asserts that funnel every error through a
            // `never`-returning `fail()` are not fail-open - the scanner reads no types, so it trusts
            // the helper by name, the same trade the SQL and gate-name heuristics already make.
            if (
              !/\b(?:throw|return\s+(?:false|new\s+Response|deny))/s.test(text) &&
              !/(?:^|[^.\w])(?:fail|deny|reject|forbid|unauthorized|abort)\s*\(/s.test(text)
            ) {
              const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1
              const reviewed = hasReview(lines, line)
              findings.push(
                diagnostic({
                  code: "NF-S001",
                  severity: reviewed ? "info" : "error",
                  file,
                  line,
                  message: reviewed
                    ? "gate catch block is explicitly marked as reviewed"
                    : "gate catch blocks must rethrow or return an explicit denial",
                  evidence: [
                    name,
                    "catch block has no denial or rethrow",
                    ...reviewedEvidence(lines, line),
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
                  const reviewed = hasReview(lines, line)
                  findings.push(
                    diagnostic({
                      code: "NF-S004",
                      severity: reviewed ? "info" : "warn",
                      file,
                      line,
                      message: reviewed
                        ? "constant CORS origin predicate is explicitly marked as reviewed"
                        : "CORS origin predicate never inspects the origin - it allows every origin; list explicit origins or use the argument",
                      evidence: ["origin predicate", ...reviewedEvidence(lines, line)],
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
                const reviewed = hasReview(lines, line)
                findings.push(
                  diagnostic({
                    code: "NF-S005",
                    severity: reviewed ? "info" : "warn",
                    file,
                    line,
                    message: reviewed
                      ? "external redirect is explicitly marked as reviewed"
                      : "redirect opts out of the same-origin default - verify the target can never be derived from request input (open-redirect risk)",
                    evidence: ["external: true", ...reviewedEvidence(lines, line)],
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
            const reviewed = hasReview(lines, line)
            findings.push(
              diagnostic({
                code: "NF-S006",
                severity: reviewed ? "info" : "warn",
                file,
                line,
                message: reviewed
                  ? `${name} escape hatch is explicitly marked as reviewed`
                  : `${name}: ${consequence}`,
                evidence: [name, ...reviewedEvidence(lines, line)],
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

export const securityRules = Object.freeze([
  failOpenGateRule,
  secretComparisonRule,
  piiLogRule,
  corsOriginPredicateRule,
  externalRedirectRule,
  assuranceEscapeHatchRule,
  unprefixedSecureCookieRule,
])

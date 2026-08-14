import type * as TSApi from "typescript"
import { type Diagnostic, diagnostic } from "../diagnostics.ts"
import { importProjectTypeScript } from "../internal/typescript-import.ts"
import { commentBlockHasMarker } from "./comment-markers.ts"
import type { CheckRule, SourceIndex } from "./index.ts"

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
 * there is exploitable, so it fails the gate. Client-bundled code (route modules, .tsx/.jsx)
 * compares values the client already holds, so the same shape is advisory rather than a gate
 * failure. A server marker beats a client marker (`routes/x.server.ts` is server), and a plain .ts
 * that cannot be classified is treated as server - fail closed.
 */
function secretComparisonSeverity(file: string): "error" | "warn" {
  const path = file.replaceAll("\\", "/")
  if (/\.server\.[cm]?[tj]sx?$/.test(path)) return "error"
  if (/(?:^|\/)server\//.test(path) || /(?:^|\/)backend\.[cm]?[tj]s$/.test(path)) return "error"
  if (/\.[tj]sx$/.test(path) || /(?:^|\/)routes\//.test(path)) return "warn"
  return "error"
}

function nameOf(ts: typeof TSApi, node: TSApi.Node): string | undefined {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  return undefined
}

/**
 * Presence checks (`token === undefined`, `secret == null`, `apiKey !== ""`) and `typeof` guards are
 * not equality over secret material - rewriting them to a timing-safe comparison would break the code.
 */
function isPresenceComparison(ts: typeof TSApi, node: TSApi.BinaryExpression): boolean {
  for (const side of [node.left, node.right]) {
    if (ts.isIdentifier(side) && side.text === "undefined") return true
    if (side.kind === ts.SyntaxKind.NullKeyword) return true
    if (ts.isStringLiteralLike(side) && side.text === "") return true
    if (ts.isTypeOfExpression(side)) return true
    if (ts.isVoidExpression(side)) return true
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

export const secretComparisonRule: CheckRule = {
  code: "NF-S002",
  title: "Non-constant-time secret comparison",
  async scan(ctx) {
    const ts = await importProjectTypeScript(ctx.root)
    if (ts === undefined) return didNotRun("NF-S002", "Non-constant-time secret comparison scan")
    const findings: Diagnostic[] = []
    for (const file of ctx.project.source.files) {
      const parsed = parsedFile(ts, ctx.project.source, file)
      if (parsed === undefined) continue
      const { tree, lines } = parsed
      const visit = (node: TSApi.Node): void => {
        if (
          ts.isBinaryExpression(node) &&
          [
            ts.SyntaxKind.EqualsEqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsEqualsToken,
            ts.SyntaxKind.EqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsToken,
          ].includes(node.operatorToken.kind) &&
          !isPresenceComparison(ts, node)
        ) {
          const left = nameOf(ts, node.left)
          const right = nameOf(ts, node.right)
          if (
            (left !== undefined && SECRET.test(left)) ||
            (right !== undefined && SECRET.test(right))
          ) {
            const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1
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
        ts.forEachChild(node, visit)
      }
      visit(tree)
    }
    return findings
  },
}

export const piiLogRule: CheckRule = {
  code: "NF-S003",
  title: "Sensitive value in log call",
  async scan(ctx) {
    const ts = await importProjectTypeScript(ctx.root)
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
    const ts = await importProjectTypeScript(ctx.root)
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
          if (name !== undefined && /^(?:require|assert|can|authorize)/i.test(name)) {
            const text = node.block.getText(tree)
            if (!/\b(?:throw|return\s+(?:false|new\s+Response|deny))/s.test(text)) {
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
    const ts = await importProjectTypeScript(ctx.root)
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
    const ts = await importProjectTypeScript(ctx.root)
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
    const ts = await importProjectTypeScript(ctx.root)
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
    const ts = await importProjectTypeScript(ctx.root)
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

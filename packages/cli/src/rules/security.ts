import type * as TSApi from "typescript"
import { type Diagnostic, diagnostic } from "../diagnostics.ts"
import type { CheckRule } from "./index.ts"

const SECRET = /(?:token|secret|apiKey|api_key|signature|hmac|password)/i
const PII = /(?:email|phone|ssn|password|token|authorization)/i
const REVIEWED = "@nifra-gate-reviewed"

function hasReview(source: string, line: number): boolean {
  const lines = source.split("\n")
  return (lines[line - 1] ?? "").includes(REVIEWED) || (lines[line - 2] ?? "").includes(REVIEWED)
}

function reviewedEvidence(source: string, line: number): readonly string[] {
  return hasReview(source, line) ? [REVIEWED] : []
}

function nameOf(ts: typeof TSApi, node: TSApi.Node): string | undefined {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  return undefined
}

function parse(ts: typeof TSApi, file: string, source: string): TSApi.SourceFile {
  const kind = /\.tsx?$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.JS
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind)
}

export const secretComparisonRule: CheckRule = {
  code: "NF-S002",
  title: "Non-constant-time secret comparison",
  async scan(ctx) {
    const ts = await import("../internal/typescript-import.ts").then((m) => m.importTypeScript())
    if (ts === undefined) return []
    const findings: Diagnostic[] = []
    for (const file of ctx.sources.files) {
      const source = ctx.sources.read(file)
      if (source === undefined) continue
      const tree = parse(ts, file, source)
      const visit = (node: TSApi.Node): void => {
        if (
          ts.isBinaryExpression(node) &&
          [
            ts.SyntaxKind.EqualsEqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsEqualsToken,
            ts.SyntaxKind.EqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsToken,
          ].includes(node.operatorToken.kind)
        ) {
          const left = nameOf(ts, node.left)
          const right = nameOf(ts, node.right)
          if (
            (left !== undefined && SECRET.test(left)) ||
            (right !== undefined && SECRET.test(right))
          ) {
            const line = source.slice(0, node.getStart(tree)).split("\n").length
            const reviewed = hasReview(source, line)
            findings.push(
              diagnostic({
                code: "NF-S002",
                severity: reviewed ? "info" : "error",
                file,
                line,
                message: reviewed
                  ? "secret comparison is explicitly marked as reviewed"
                  : "secret-like values must use a length check and timing-safe comparison",
                evidence: [left ?? right ?? "secret comparison", ...reviewedEvidence(source, line)],
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
    const ts = await import("../internal/typescript-import.ts").then((m) => m.importTypeScript())
    if (ts === undefined) return []
    const findings: Diagnostic[] = []
    for (const file of ctx.sources.files) {
      const source = ctx.sources.read(file)
      if (source === undefined) continue
      const tree = parse(ts, file, source)
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
                const line = source.slice(0, node.getStart(tree)).split("\n").length
                const reviewed = hasReview(source, line)
                findings.push(
                  diagnostic({
                    code: "NF-S003",
                    severity: reviewed ? "info" : "warn",
                    file,
                    line,
                    message: reviewed
                      ? "sensitive value in log call is explicitly marked as reviewed"
                      : "PII-shaped values must not be passed directly to log calls",
                    evidence: [name, ...reviewedEvidence(source, line)],
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
    const ts = await import("../internal/typescript-import.ts").then((m) => m.importTypeScript())
    if (ts === undefined) return []
    const findings: Diagnostic[] = []
    for (const file of ctx.sources.files) {
      const source = ctx.sources.read(file)
      if (source === undefined) continue
      const tree = parse(ts, file, source)
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
              const line = source.slice(0, node.getStart(tree)).split("\n").length
              const reviewed = hasReview(source, line)
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
                    ...reviewedEvidence(source, line),
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

export const securityRules = Object.freeze([failOpenGateRule, secretComparisonRule, piiLogRule])

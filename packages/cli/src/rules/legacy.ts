import type { CheckDiagnostic } from "../check.ts"
import type { Diagnostic, Severity } from "../diagnostics.ts"
import type { CheckRule, RuleContext } from "./index.ts"

const CODES: Readonly<Record<string, string>> = Object.freeze({
  typecheck: "NF-C001",
  "typed-client": "NF-C002",
  "untyped-client": "NF-C003",
  "server-only-import": "NF-C004",
  "removed-import": "NF-C005",
  "interpolated-sql": "NF-C006",
  "response-route": "NF-C007",
  "undeclared-dependency": "NF-C008",
  "duplicate-install": "NF-C009",
  "stale-workspace-dist": "NF-C010",
  pipeline: "NF-C011",
  "server-manifest-drift": "NF-C012",
  "manifest-drift": "NF-C013",
  "capability-assurance": "NF-C014",
  "capability-config": "NF-C015",
  "check-config": "NF-C016",
  "contract-drift": "NF-K001",
})

const TITLES: Readonly<Record<string, string>> = Object.freeze({
  typecheck: "TypeScript contract check",
  "typed-client": "Typed client check",
  "untyped-client": "Untyped client check",
  "server-only-import": "Server-only import check",
  "removed-import": "Removed import check",
  "interpolated-sql": "Interpolated SQL check",
  "response-route": "Raw response route advisory",
  "undeclared-dependency": "Undeclared dependency check",
  "duplicate-install": "Duplicate install check",
  "stale-workspace-dist": "Stale workspace build check",
  pipeline: "Build pipeline check",
  "server-manifest-drift": "Server manifest drift check",
  "manifest-drift": "Trust manifest drift check",
  "capability-assurance": "Capability assurance check",
  "capability-config": "Assurance configuration check",
  "check-config": "Check configuration check",
  "contract-drift": "Contract snapshot drift",
})

function recipeFor(finding: CheckDiagnostic): Diagnostic["fix"] {
  if (finding.rule === "stale-workspace-dist")
    return { recipe: "workspace-dist.rebuild", command: "nifra fix --code NF-C010" }
  if (finding.rule === "server-manifest-drift")
    return { recipe: "manifest.sync", command: "nifra sync-manifest" }
  if (finding.rule === "contract-drift")
    return { recipe: "contracts.snapshot", command: "nifra contracts snapshot" }
  return undefined
}

function toDiagnostic(finding: CheckDiagnostic, code: string): Diagnostic {
  const severity: Severity = finding.severity === "warning" ? "warn" : finding.severity
  const evidence = finding.evidence ?? finding.chain
  const fix = recipeFor(finding)
  return Object.freeze({
    code,
    severity,
    message: finding.message,
    ...(finding.file === undefined ? {} : { file: finding.file }),
    ...(finding.line === undefined ? {} : { line: finding.line }),
    ...(evidence === undefined ? {} : { evidence }),
    ...(fix === undefined ? {} : { fix }),
    ...(finding.verify === undefined ? {} : { verify: finding.verify }),
  })
}

function findingsFor(ctx: RuleContext, rule: string): Diagnostic[] {
  const findings = ctx.project.legacyDiagnostics
  if (!Array.isArray(findings)) return []
  const code = CODES[rule]
  if (code === undefined) return []
  return findings
    .filter((finding): finding is CheckDiagnostic => finding?.rule === rule)
    .map((finding) => toDiagnostic(finding, code))
}

function makeRule(rule: string): CheckRule {
  const code = CODES[rule]
  const title = TITLES[rule]
  if (code === undefined || title === undefined) throw new Error(`unknown legacy rule ${rule}`)
  return Object.freeze({ code, title, scan: async (ctx: RuleContext) => findingsFor(ctx, rule) })
}

/** Stable registry adapters for the existing source scanners. */
export const legacyRules: readonly CheckRule[] = Object.freeze(
  Object.keys(CODES).map((name) => makeRule(name)),
)

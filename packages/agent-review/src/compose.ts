import { digestReviewReport, sortedEvidence } from "./canonical.ts"
import { codeUnitOrder } from "./internal/code-unit-order.ts"
import { deriveReportOutcome, parseReviewReport } from "./parser.ts"
import {
  REVIEW_REPORT_VERSION,
  type ReviewCheckResult,
  type ReviewFinding,
  type ReviewFixResult,
  type ReviewReport,
  type ReviewReportDraft,
  type ReviewScope,
} from "./types.ts"

function copyScope(value: ReviewScope): ReviewScope {
  return {
    kind: value.kind,
    state: value.state,
    ...(value.gitRef === undefined ? {} : { gitRef: value.gitRef }),
    changedPaths: [...value.changedPaths].sort(codeUnitOrder),
    pathDigest: value.pathDigest,
    outOfScopeCount: value.outOfScopeCount,
    ...(value.reasonCode === undefined ? {} : { reasonCode: value.reasonCode }),
  }
}

function copyFinding(value: ReviewFinding): ReviewFinding {
  return {
    id: value.id,
    check: value.check,
    code: value.code,
    severity: value.severity,
    category: value.category,
    ...(value.location === undefined
      ? {}
      : {
          location: {
            path: value.location.path,
            ...(value.location.line === undefined ? {} : { line: value.location.line }),
            ...(value.location.column === undefined ? {} : { column: value.location.column }),
          },
        }),
    evidence: sortedEvidence(value.evidence),
    ...(value.fix === undefined ? {} : { fix: { recipe: value.fix.recipe } }),
  }
}

function copyCheck(value: ReviewCheckResult): ReviewCheckResult {
  return {
    id: value.id,
    required: value.required,
    status: value.status,
    duration: value.duration,
    counts: {
      findings: value.counts.findings,
      errors: value.counts.errors,
      warnings: value.counts.warnings,
      info: value.counts.info,
      outOfScope: value.counts.outOfScope,
    },
    findingIds: [...value.findingIds].sort(codeUnitOrder),
    evidence: sortedEvidence(value.evidence),
    ...(value.reasonCode === undefined ? {} : { reasonCode: value.reasonCode }),
  }
}

function copyFix(value: ReviewFixResult): ReviewFixResult {
  return {
    recipe: value.recipe,
    status: value.status,
    ...(value.changedPaths === undefined
      ? {}
      : { changedPaths: [...value.changedPaths].sort(codeUnitOrder) }),
    ...(value.reasonCode === undefined ? {} : { reasonCode: value.reasonCode }),
  }
}

/**
 * Compose a report from already-sanitized structural values. This function has no repository,
 * collector, CLI, filesystem, provider, or persistence access. The parser is run once more over
 * the assembled value so the returned report has the same boundary guarantees as external input.
 */
export async function composeReviewReport(input: ReviewReportDraft): Promise<ReviewReport> {
  const scope = copyScope(input.scope)
  const checks = [...input.checks]
    .map(copyCheck)
    .sort((left, right) => codeUnitOrder(left.id, right.id))
  const findings = [...input.findings]
    .map(copyFinding)
    .sort((left, right) => codeUnitOrder(left.id, right.id))
  const fixes =
    input.fixes === undefined
      ? undefined
      : [...input.fixes].map(copyFix).sort((left, right) => {
          const leftKey = `${left.recipe}\u0000${left.status}\u0000${left.changedPaths?.join("\u0000") ?? ""}`
          const rightKey = `${right.recipe}\u0000${right.status}\u0000${right.changedPaths?.join("\u0000") ?? ""}`
          return codeUnitOrder(leftKey, rightKey)
        })
  const outcome = deriveReportOutcome(input.strict, scope, checks, findings, fixes)
  const unsigned: ReviewReport = {
    version: REVIEW_REPORT_VERSION,
    strict: input.strict,
    scope,
    checks,
    findings,
    ...(fixes === undefined ? {} : { fixes }),
    ...outcome,
    digest: "0".repeat(64),
  }
  const digest = await digestReviewReport(unsigned)
  return parseReviewReport({ ...unsigned, digest })
}

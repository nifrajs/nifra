import type {
  ReviewCheckResult,
  ReviewEvidenceRef,
  ReviewFinding,
  ReviewFixResult,
  ReviewReport,
} from "./types.ts"

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function optionalText(value: string | undefined): string {
  return value ?? ""
}

function compareEvidence(left: ReviewEvidenceRef, right: ReviewEvidenceRef): number {
  return (
    compareText(left.source, right.source) ||
    compareText(left.token, right.token) ||
    compareText(left.digest, right.digest) ||
    compareText(optionalText(left.path), optionalText(right.path))
  )
}

function compareFinding(left: ReviewFinding, right: ReviewFinding): number {
  return compareText(left.id, right.id)
}

function compareCheck(
  left: Pick<ReviewCheckResult, "id">,
  right: Pick<ReviewCheckResult, "id">,
): number {
  return compareText(left.id, right.id)
}

function compareFix(left: ReviewFixResult, right: ReviewFixResult): number {
  const leftPaths = left.changedPaths?.join("\u0000") ?? ""
  const rightPaths = right.changedPaths?.join("\u0000") ?? ""
  return (
    compareText(left.recipe, right.recipe) ||
    compareText(left.status, right.status) ||
    compareText(leftPaths, rightPaths) ||
    compareText(optionalText(left.reasonCode), optionalText(right.reasonCode))
  )
}

function canonicalValue(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0))
      throw new TypeError("review canonical value must contain finite numbers other than -0")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalValue(item)).join(",")}]`
  if (!isPlainRecord(value))
    throw new TypeError("review canonical value must contain plain objects")

  const keys = Object.keys(value).sort(compareText)
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(",")}}`
}

function sortedEvidence(value: readonly ReviewEvidenceRef[]): readonly ReviewEvidenceRef[] {
  return [...value]
    .map((entry) => ({
      source: entry.source,
      token: entry.token,
      digest: entry.digest,
      ...(entry.path === undefined ? {} : { path: entry.path }),
    }))
    .sort(compareEvidence)
}

function sortedFindings(value: readonly ReviewFinding[]): readonly ReviewFinding[] {
  return [...value]
    .map((entry) => ({
      id: entry.id,
      check: entry.check,
      code: entry.code,
      severity: entry.severity,
      category: entry.category,
      ...(entry.location === undefined
        ? {}
        : {
            location: {
              path: entry.location.path,
              ...(entry.location.line === undefined ? {} : { line: entry.location.line }),
              ...(entry.location.column === undefined ? {} : { column: entry.location.column }),
            },
          }),
      evidence: sortedEvidence(entry.evidence),
      ...(entry.fix === undefined ? {} : { fix: { recipe: entry.fix.recipe } }),
    }))
    .sort(compareFinding)
}

function sortedChecks(
  value: readonly ReviewCheckResult[],
): readonly Omit<ReviewCheckResult, "duration">[] {
  return [...value]
    .map((entry) => ({
      id: entry.id,
      required: entry.required,
      status: entry.status,
      // Duration is intentionally display-only and must not enter the digest.
      counts: {
        findings: entry.counts.findings,
        errors: entry.counts.errors,
        warnings: entry.counts.warnings,
        info: entry.counts.info,
        outOfScope: entry.counts.outOfScope,
      },
      findingIds: [...entry.findingIds].sort(compareText),
      evidence: sortedEvidence(entry.evidence),
      ...(entry.reasonCode === undefined ? {} : { reasonCode: entry.reasonCode }),
    }))
    .sort(compareCheck)
}

function sortedFixes(value: readonly ReviewFixResult[]): readonly ReviewFixResult[] {
  return [...value]
    .map((entry) => ({
      recipe: entry.recipe,
      status: entry.status,
      ...(entry.changedPaths === undefined
        ? {}
        : { changedPaths: [...entry.changedPaths].sort(compareText) }),
      ...(entry.reasonCode === undefined ? {} : { reasonCode: entry.reasonCode }),
    }))
    .sort(compareFix)
}

/**
 * Return the stable UTF-8 text that identifies a review report's structural result.
 *
 * The report digest and check duration are omitted. Arrays are copied into their contract-defined
 * order, while object keys are sorted recursively. No caller-owned object is mutated.
 */
export function canonicalizeReviewReport(report: ReviewReport): string {
  const value = {
    version: report.version,
    strict: report.strict,
    scope: {
      kind: report.scope.kind,
      state: report.scope.state,
      ...(report.scope.gitRef === undefined ? {} : { gitRef: report.scope.gitRef }),
      changedPaths: [...report.scope.changedPaths].sort(compareText),
      pathDigest: report.scope.pathDigest,
      outOfScopeCount: report.scope.outOfScopeCount,
      ...(report.scope.reasonCode === undefined ? {} : { reasonCode: report.scope.reasonCode }),
    },
    checks: sortedChecks(report.checks),
    findings: sortedFindings(report.findings),
    ...(report.fixes === undefined ? {} : { fixes: sortedFixes(report.fixes) }),
    blocking: report.blocking,
    ok: report.ok,
    status: report.status,
  }
  return canonicalValue(value)
}

/** Compute a lowercase Web Crypto SHA-256 digest of the canonical report representation. */
export async function digestReviewReport(report: ReviewReport): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalizeReviewReport(report))
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** Stable version of the content-free review report contract. */
export const REVIEW_REPORT_VERSION = 1 as const

export type ReviewStatus = "pass" | "fail" | "inconclusive"

export type ReviewCheckId =
  | "typecheck"
  | "typed-client"
  | "server-boundary"
  | "route-boundary"
  | "pipeline"
  | "security"
  | "route-assurance"
  | "capability-provenance"
  | "manifest"
  | "dependency"
  | "contract-witness"
  | "coverage"
  | "hydration"
  | "configuration"

export type ReviewCheckStatus = "pass" | "fail" | "skipped" | "unavailable" | "error"

export type ReviewSeverity = "error" | "warning" | "info"

export type ReviewCategory =
  | "correctness"
  | "security"
  | "boundary"
  | "assurance"
  | "capability"
  | "contract"
  | "dependency"
  | "hydration"
  | "coverage"
  | "configuration"
  | "operational"

export type ReviewEvidenceSource =
  | "check"
  | "assurance"
  | "capability"
  | "manifest"
  | "contract"
  | "coverage"
  | "git-scope"
  | "collector"

export type ReviewDurationBucket = "none" | "fast" | "standard" | "slow" | "timeout"

export type ReviewReasonCode =
  | "not-configured"
  | "config-missing"
  | "config-invalid"
  | "collector-error"
  | "collector-unavailable"
  | "diagnostics-truncated"
  | "missing-typescript"
  | "invalid-target"
  | "invalid-git-ref"
  | "invalid-git-scope"
  | "filtered-out-of-scope"
  | "fix-failed"
  | "fix-no-op"
  | "unsupported"

export type ReviewParserErrorCode =
  | "invalid-root"
  | "unknown-key"
  | "forbidden-content"
  | "invalid-type"
  | "invalid-enum"
  | "invalid-id"
  | "invalid-reference"
  | "invalid-path"
  | "invalid-digest"
  | "duplicate-id"
  | "missing-required"
  | "oversized"
  | "derived-field-mismatch"
  | "non-canonical"

export type ReviewFixRecipeId = "manifest.sync" | "workspace-dist.rebuild"

export type ReviewFixStatus = "planned" | "changed" | "no-op" | "failed"

export interface ReviewCounts {
  readonly findings: number
  readonly errors: number
  readonly warnings: number
  readonly info: number
  readonly outOfScope: number
}

export interface ReviewEvidenceRef {
  readonly source: ReviewEvidenceSource
  readonly token: string
  readonly digest: string
  readonly path?: string
}

export interface ReviewLocation {
  readonly path: string
  readonly line?: number
  readonly column?: number
}

export interface ReviewFixRef {
  readonly recipe: ReviewFixRecipeId
}

export interface ReviewFinding {
  readonly id: string
  readonly check: ReviewCheckId
  readonly code: string
  readonly severity: ReviewSeverity
  readonly category: ReviewCategory
  readonly location?: ReviewLocation
  readonly evidence: readonly ReviewEvidenceRef[]
  readonly fix?: ReviewFixRef
}

export interface ReviewCheckResult {
  readonly id: ReviewCheckId
  readonly required: boolean
  readonly status: ReviewCheckStatus
  /** Display-only timing bucket. It is deliberately excluded from report digests. */
  readonly duration: ReviewDurationBucket
  readonly counts: ReviewCounts
  readonly findingIds: readonly string[]
  readonly evidence: readonly ReviewEvidenceRef[]
  readonly reasonCode?: ReviewReasonCode
}

export interface ReviewScope {
  readonly kind: "project" | "diff"
  readonly state: "valid" | "invalid"
  readonly gitRef?: string
  readonly changedPaths: readonly string[]
  /** SHA-256 of the canonical changed-path list. */
  readonly pathDigest: string
  readonly outOfScopeCount: number
  readonly reasonCode?: ReviewReasonCode
}

export interface ReviewFixResult {
  readonly recipe: ReviewFixRecipeId
  readonly status: ReviewFixStatus
  readonly changedPaths?: readonly string[]
  readonly reasonCode?: ReviewReasonCode
}

export interface ReviewReport {
  readonly version: typeof REVIEW_REPORT_VERSION
  readonly strict: boolean
  readonly scope: ReviewScope
  readonly checks: readonly ReviewCheckResult[]
  readonly findings: readonly ReviewFinding[]
  readonly fixes?: readonly ReviewFixResult[]
  readonly blocking: number
  readonly ok: boolean
  readonly status: ReviewStatus
  /** Lowercase SHA-256 of the canonical report without this field or display-only durations. */
  readonly digest: string
}

/** Sanitized structural inputs accepted by the deterministic composer. */
export interface ReviewReportDraft {
  readonly strict: boolean
  readonly scope: ReviewScope
  readonly checks: readonly ReviewCheckResult[]
  readonly findings: readonly ReviewFinding[]
  readonly fixes?: readonly ReviewFixResult[]
}

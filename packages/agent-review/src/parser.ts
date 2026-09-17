import { canonicalizeReviewReport, digestReviewReport } from "./canonical.ts"
import {
  REVIEW_REPORT_VERSION,
  type ReviewCategory,
  type ReviewCheckId,
  type ReviewCheckResult,
  type ReviewCheckStatus,
  type ReviewCounts,
  type ReviewDurationBucket,
  type ReviewEvidenceRef,
  type ReviewEvidenceSource,
  type ReviewFinding,
  type ReviewFixRecipeId,
  type ReviewFixRef,
  type ReviewFixResult,
  type ReviewFixStatus,
  type ReviewLocation,
  type ReviewParserErrorCode,
  type ReviewReasonCode,
  type ReviewReport,
  type ReviewScope,
  type ReviewSeverity,
  type ReviewStatus,
} from "./types.ts"

export const REVIEW_MAX_BYTES = 256 * 1024
export const REVIEW_MAX_DEPTH = 8
export const REVIEW_MAX_OBJECT_KEYS = 32
export const REVIEW_MAX_ARRAY_ITEMS = 1024
export const REVIEW_MAX_PATH_BYTES = 512
export const REVIEW_MAX_REF_BYTES = 256
export const REVIEW_MAX_ID_BYTES = 128
export const REVIEW_MAX_CODE_BYTES = 64

const HEX64 = /^[0-9a-f]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/
const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const GIT_REF_FORBIDDEN = /[\s\\~^:?*[\]]/

const FORBIDDEN_KEYS = new Set([
  "message",
  "description",
  "title",
  "prompt",
  "output",
  "payload",
  "snapshot",
  "diagnostic",
  "suggestion",
  "chain",
  "stack",
  "input",
  "body",
  "secret",
])

const REVIEW_CHECK_IDS: readonly ReviewCheckId[] = [
  "typecheck",
  "typed-client",
  "server-boundary",
  "route-boundary",
  "pipeline",
  "security",
  "route-assurance",
  "capability-provenance",
  "manifest",
  "dependency",
  "contract-witness",
  "coverage",
  "hydration",
  "configuration",
]

const REVIEW_CHECK_STATUSES: readonly ReviewCheckStatus[] = [
  "pass",
  "fail",
  "skipped",
  "unavailable",
  "error",
]

const REVIEW_SEVERITIES: readonly ReviewSeverity[] = ["error", "warning", "info"]
const REVIEW_CATEGORIES: readonly ReviewCategory[] = [
  "correctness",
  "security",
  "boundary",
  "assurance",
  "capability",
  "contract",
  "dependency",
  "hydration",
  "coverage",
  "configuration",
  "operational",
]
const REVIEW_EVIDENCE_SOURCES: readonly ReviewEvidenceSource[] = [
  "check",
  "assurance",
  "capability",
  "manifest",
  "contract",
  "coverage",
  "git-scope",
  "collector",
]
const REVIEW_DURATIONS: readonly ReviewDurationBucket[] = [
  "none",
  "fast",
  "standard",
  "slow",
  "timeout",
]
const REVIEW_REASONS: readonly ReviewReasonCode[] = [
  "not-configured",
  "config-missing",
  "config-invalid",
  "collector-error",
  "collector-unavailable",
  "diagnostics-truncated",
  "missing-typescript",
  "invalid-target",
  "invalid-git-ref",
  "invalid-git-scope",
  "filtered-out-of-scope",
  "fix-failed",
  "fix-no-op",
  "unsupported",
]
const REVIEW_FIX_RECIPES: readonly ReviewFixRecipeId[] = ["manifest.sync", "workspace-dist.rebuild"]
const REVIEW_FIX_STATUSES: readonly ReviewFixStatus[] = ["planned", "changed", "no-op", "failed"]

/** Error raised for every malformed, unsafe, or payload-bearing report. */
export class ReviewParserError extends Error {
  readonly code: ReviewParserErrorCode
  readonly path?: string

  constructor(code: ReviewParserErrorCode, path?: string) {
    super(`invalid review report (${code})${path === undefined ? "" : ` at ${path}`}`)
    this.name = "ReviewParserError"
    this.code = code
    if (path !== undefined) this.path = path
  }
}

function fail(code: ReviewParserErrorCode, path?: string): never {
  throw new ReviewParserError(code, path)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

class ParseGuard {
  private readonly seen = new WeakSet<object>()
  private chargedBytes = 0

  enter(value: object, depth: number, path: string): void {
    if (depth > REVIEW_MAX_DEPTH) fail("oversized", path)
    if (this.seen.has(value)) fail("invalid-reference", path)
    this.seen.add(value)
  }

  chargeString(value: string, maxBytes: number, code: ReviewParserErrorCode, path: string): void {
    const bytes = new TextEncoder().encode(value).byteLength
    if (bytes === 0 || bytes > maxBytes) fail(code, path)
    if (value.includes("\u0000") || value.includes("\\")) fail(code, path)
    this.chargedBytes += bytes + 2
    if (this.chargedBytes > REVIEW_MAX_BYTES) fail("oversized", path)
  }
}

function recordAt(
  value: unknown,
  guard: ParseGuard,
  depth: number,
  path: string,
): Record<string, unknown> {
  if (!isPlainRecord(value)) fail("invalid-type", path)
  guard.enter(value, depth, path)
  return value
}

function arrayAt(
  value: unknown,
  guard: ParseGuard,
  depth: number,
  path: string,
): readonly unknown[] {
  if (!Array.isArray(value)) fail("invalid-type", path)
  if (value.length > REVIEW_MAX_ARRAY_ITEMS) fail("oversized", path)
  guard.enter(value, depth, path)
  return value
}

function assertKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  guard: ParseGuard,
  path: string,
  allowSource = false,
): void {
  const allowedSet = new Set(allowed)
  let ownKeys: readonly (string | symbol)[]
  try {
    ownKeys = Reflect.ownKeys(record)
  } catch {
    fail("invalid-type", path)
  }
  if (ownKeys.length > REVIEW_MAX_OBJECT_KEYS) fail("oversized", path)
  for (const key of ownKeys) {
    if (typeof key !== "string") fail("unknown-key", path)
    guard.chargeString(key, REVIEW_MAX_ID_BYTES, "unknown-key", path)
    const lower = key.toLowerCase()
    if (lower === "source" && (!allowSource || key !== "source")) fail("forbidden-content", path)
    if (FORBIDDEN_KEYS.has(lower)) fail("forbidden-content", path)
    if (!allowedSet.has(key)) fail("unknown-key", path)
  }
}

function requiredValue(record: Record<string, unknown>, key: string, path: string): unknown {
  if (!hasOwn(record, key) || record[key] === undefined) fail("missing-required", `${path}.${key}`)
  return record[key]
}

function optionalValue(record: Record<string, unknown>, key: string, path: string): unknown {
  if (!hasOwn(record, key)) return undefined
  if (record[key] === undefined) fail("invalid-type", `${path}.${key}`)
  return record[key]
}

function stringValue(
  value: unknown,
  guard: ParseGuard,
  path: string,
  maxBytes: number,
  code: ReviewParserErrorCode = "invalid-type",
): string {
  if (typeof value !== "string") fail("invalid-type", path)
  guard.chargeString(value, maxBytes, code, path)
  return value
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  guard: ParseGuard,
  path: string,
  maxBytes: number,
  code: ReviewParserErrorCode = "invalid-type",
): string | undefined {
  const value = optionalValue(record, key, path)
  return value === undefined
    ? undefined
    : stringValue(value, guard, `${path}.${key}`, maxBytes, code)
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  guard: ParseGuard,
  path: string,
  maxBytes: number,
  code: ReviewParserErrorCode = "invalid-type",
): string {
  return stringValue(requiredValue(record, key, path), guard, `${path}.${key}`, maxBytes, code)
}

function booleanValue(record: Record<string, unknown>, key: string, path: string): boolean {
  const value = requiredValue(record, key, path)
  if (typeof value !== "boolean") fail("invalid-type", `${path}.${key}`)
  return value
}

function integerValue(record: Record<string, unknown>, key: string, path: string): number {
  const value = requiredValue(record, key, path)
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    fail("invalid-type", `${path}.${key}`)
  return value
}

function enumValue<T extends string>(
  record: Record<string, unknown>,
  key: string,
  values: readonly T[],
  guard: ParseGuard,
  path: string,
): T {
  const value = requiredString(record, key, guard, path, REVIEW_MAX_ID_BYTES)
  if (!values.includes(value as T)) fail("invalid-enum", `${path}.${key}`)
  return value as T
}

function optionalEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  values: readonly T[],
  guard: ParseGuard,
  path: string,
): T | undefined {
  const value = optionalString(record, key, guard, path, REVIEW_MAX_ID_BYTES)
  if (value === undefined) return undefined
  if (!values.includes(value as T)) fail("invalid-enum", `${path}.${key}`)
  return value as T
}

function digestValue(
  record: Record<string, unknown>,
  key: string,
  guard: ParseGuard,
  path: string,
): string {
  const value = requiredString(record, key, guard, path, REVIEW_MAX_CODE_BYTES)
  if (!HEX64.test(value)) fail("invalid-digest", `${path}.${key}`)
  return value
}

function identifierValue(
  record: Record<string, unknown>,
  key: string,
  guard: ParseGuard,
  path: string,
): string {
  const value = requiredString(record, key, guard, path, REVIEW_MAX_ID_BYTES)
  if (!ID.test(value)) fail("invalid-id", `${path}.${key}`)
  return value
}

function tokenValue(
  record: Record<string, unknown>,
  key: string,
  guard: ParseGuard,
  path: string,
): string {
  const value = requiredString(record, key, guard, path, REVIEW_MAX_ID_BYTES)
  if (!TOKEN.test(value)) fail("invalid-id", `${path}.${key}`)
  return value
}

function safePath(value: string, path: string): string {
  if (
    value.startsWith("/") ||
    /^[A-Za-z]:($|\/)/.test(value) ||
    value.startsWith("~") ||
    value.includes("//")
  )
    fail("invalid-path", path)
  const parts = value.split("/")
  if (parts.some((part) => part.length === 0 || part === "." || part === ".."))
    fail("invalid-path", path)
  return value
}

function pathValue(
  record: Record<string, unknown>,
  key: string,
  guard: ParseGuard,
  path: string,
): string {
  const value = requiredString(record, key, guard, path, REVIEW_MAX_PATH_BYTES, "invalid-path")
  return safePath(value, `${path}.${key}`)
}

function optionalPath(
  record: Record<string, unknown>,
  key: string,
  guard: ParseGuard,
  path: string,
): string | undefined {
  const value = optionalString(record, key, guard, path, REVIEW_MAX_PATH_BYTES, "invalid-path")
  return value === undefined ? undefined : safePath(value, `${path}.${key}`)
}

function safeGitRef(value: string, path: string): string {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.startsWith("-") ||
    value.includes("..") ||
    value.includes("@{") ||
    value.includes("//") ||
    value.endsWith(".") ||
    GIT_REF_FORBIDDEN.test(value) ||
    value.includes("\u0000")
  )
    fail("invalid-path", path)
  for (const part of value.split("/")) {
    if (
      part.length === 0 ||
      part === "." ||
      part === ".." ||
      part.startsWith(".") ||
      part.endsWith(".lock")
    )
      fail("invalid-path", path)
  }
  return value
}

function gitRefValue(
  record: Record<string, unknown>,
  key: string,
  guard: ParseGuard,
  path: string,
): string | undefined {
  const value = optionalString(record, key, guard, path, REVIEW_MAX_REF_BYTES, "invalid-path")
  return value === undefined ? undefined : safeGitRef(value, `${path}.${key}`)
}

function parseEvidence(
  value: unknown,
  guard: ParseGuard,
  depth: number,
  path: string,
): ReviewEvidenceRef {
  const record = recordAt(value, guard, depth, path)
  assertKeys(record, ["source", "token", "digest", "path"], guard, path, true)
  const source = enumValue(record, "source", REVIEW_EVIDENCE_SOURCES, guard, path)
  const token = tokenValue(record, "token", guard, path)
  const digest = digestValue(record, "digest", guard, path)
  const evidencePath = optionalPath(record, "path", guard, path)
  return {
    source,
    token,
    digest,
    ...(evidencePath === undefined ? {} : { path: evidencePath }),
  }
}

function parseEvidenceList(
  value: unknown,
  guard: ParseGuard,
  depth: number,
  path: string,
  requireNonEmpty: boolean,
): readonly ReviewEvidenceRef[] {
  const values = arrayAt(value, guard, depth, path)
  if (requireNonEmpty && values.length === 0) fail("missing-required", path)
  const result = values.map((item, index) =>
    parseEvidence(item, guard, depth + 1, `${path}[${index}]`),
  )
  assertSortedUnique(
    result,
    (item) => `${item.source}\u0000${item.token}\u0000${item.digest}\u0000${item.path ?? ""}`,
    path,
    "invalid-reference",
  )
  return result
}

function parseLocation(
  value: unknown,
  guard: ParseGuard,
  depth: number,
  path: string,
): ReviewLocation {
  const record = recordAt(value, guard, depth, path)
  assertKeys(record, ["path", "line", "column"], guard, path)
  const lineValue = optionalValue(record, "line", path)
  const columnValue = optionalValue(record, "column", path)
  const line =
    lineValue === undefined
      ? undefined
      : typeof lineValue === "number" && Number.isSafeInteger(lineValue) && lineValue > 0
        ? lineValue
        : fail("invalid-type", `${path}.line`)
  const column =
    columnValue === undefined
      ? undefined
      : typeof columnValue === "number" && Number.isSafeInteger(columnValue) && columnValue > 0
        ? columnValue
        : fail("invalid-type", `${path}.column`)
  const locationPath = pathValue(record, "path", guard, path)
  return {
    path: locationPath,
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
  }
}

function parseFixRef(value: unknown, guard: ParseGuard, depth: number, path: string): ReviewFixRef {
  const record = recordAt(value, guard, depth, path)
  assertKeys(record, ["recipe"], guard, path)
  return { recipe: enumValue(record, "recipe", REVIEW_FIX_RECIPES, guard, path) }
}

function parseFinding(
  value: unknown,
  guard: ParseGuard,
  depth: number,
  path: string,
): ReviewFinding {
  const record = recordAt(value, guard, depth, path)
  assertKeys(
    record,
    ["id", "check", "code", "severity", "category", "location", "evidence", "fix"],
    guard,
    path,
  )
  const id = identifierValue(record, "id", guard, path)
  const check = enumValue(record, "check", REVIEW_CHECK_IDS, guard, path)
  const code = requiredString(record, "code", guard, path, REVIEW_MAX_CODE_BYTES)
  if (!CODE.test(code)) fail("invalid-id", `${path}.code`)
  const severity = enumValue(record, "severity", REVIEW_SEVERITIES, guard, path)
  const category = enumValue(record, "category", REVIEW_CATEGORIES, guard, path)
  const locationValue = optionalValue(record, "location", path)
  const location =
    locationValue === undefined
      ? undefined
      : parseLocation(locationValue, guard, depth + 1, `${path}.location`)
  const evidence = parseEvidenceList(
    requiredValue(record, "evidence", path),
    guard,
    depth + 1,
    `${path}.evidence`,
    true,
  )
  const fixValue = optionalValue(record, "fix", path)
  const fix =
    fixValue === undefined ? undefined : parseFixRef(fixValue, guard, depth + 1, `${path}.fix`)
  return {
    id,
    check,
    code,
    severity,
    category,
    ...(location === undefined ? {} : { location }),
    evidence,
    ...(fix === undefined ? {} : { fix }),
  }
}

function parseCounts(value: unknown, guard: ParseGuard, depth: number, path: string): ReviewCounts {
  const record = recordAt(value, guard, depth, path)
  assertKeys(record, ["findings", "errors", "warnings", "info", "outOfScope"], guard, path)
  return {
    findings: integerValue(record, "findings", path),
    errors: integerValue(record, "errors", path),
    warnings: integerValue(record, "warnings", path),
    info: integerValue(record, "info", path),
    outOfScope: integerValue(record, "outOfScope", path),
  }
}

function parseFindingIds(
  value: unknown,
  guard: ParseGuard,
  depth: number,
  path: string,
): readonly string[] {
  const values = arrayAt(value, guard, depth, path)
  const result = values.map((item, index) => {
    if (typeof item !== "string") fail("invalid-type", `${path}[${index}]`)
    guard.chargeString(item, REVIEW_MAX_ID_BYTES, "invalid-id", `${path}[${index}]`)
    if (!ID.test(item)) fail("invalid-id", `${path}[${index}]`)
    return item
  })
  assertSortedUnique(result, (item) => item, path, "duplicate-id")
  return result
}

function parseCheck(
  value: unknown,
  guard: ParseGuard,
  depth: number,
  path: string,
): ReviewCheckResult {
  const record = recordAt(value, guard, depth, path)
  assertKeys(
    record,
    ["id", "required", "status", "duration", "counts", "findingIds", "evidence", "reasonCode"],
    guard,
    path,
  )
  const id = enumValue(record, "id", REVIEW_CHECK_IDS, guard, path)
  const required = booleanValue(record, "required", path)
  const status = enumValue(record, "status", REVIEW_CHECK_STATUSES, guard, path)
  const duration = enumValue(record, "duration", REVIEW_DURATIONS, guard, path)
  const counts = parseCounts(
    requiredValue(record, "counts", path),
    guard,
    depth + 1,
    `${path}.counts`,
  )
  const findingIds = parseFindingIds(
    requiredValue(record, "findingIds", path),
    guard,
    depth + 1,
    `${path}.findingIds`,
  )
  const evidence = parseEvidenceList(
    requiredValue(record, "evidence", path),
    guard,
    depth + 1,
    `${path}.evidence`,
    true,
  )
  const reasonCode = optionalEnum(record, "reasonCode", REVIEW_REASONS, guard, path)
  if (status === "skipped" && (required || reasonCode !== "not-configured"))
    fail("derived-field-mismatch", path)
  if ((status === "unavailable" || status === "error") && reasonCode === undefined)
    fail("missing-required", `${path}.reasonCode`)
  if ((status === "pass" || status === "fail") && reasonCode !== undefined)
    fail("derived-field-mismatch", path)
  return {
    id,
    required,
    status,
    duration,
    counts,
    findingIds,
    evidence,
    ...(reasonCode === undefined ? {} : { reasonCode }),
  }
}

function parsePaths(
  value: unknown,
  guard: ParseGuard,
  depth: number,
  path: string,
): readonly string[] {
  const values = arrayAt(value, guard, depth, path)
  const result = values.map((item, index) => {
    if (typeof item !== "string") fail("invalid-type", `${path}[${index}]`)
    guard.chargeString(item, REVIEW_MAX_PATH_BYTES, "invalid-path", `${path}[${index}]`)
    return safePath(item, `${path}[${index}]`)
  })
  assertSortedUnique(result, (item) => item, path, "duplicate-id")
  return result
}

function parseScope(value: unknown, guard: ParseGuard, depth: number, path: string): ReviewScope {
  const record = recordAt(value, guard, depth, path)
  assertKeys(
    record,
    ["kind", "state", "gitRef", "changedPaths", "pathDigest", "outOfScopeCount", "reasonCode"],
    guard,
    path,
  )
  const kind = enumValue(record, "kind", ["project", "diff"] as const, guard, path)
  const state = enumValue(record, "state", ["valid", "invalid"] as const, guard, path)
  const gitRef = gitRefValue(record, "gitRef", guard, path)
  const changedPaths = parsePaths(
    requiredValue(record, "changedPaths", path),
    guard,
    depth + 1,
    `${path}.changedPaths`,
  )
  const pathDigest = digestValue(record, "pathDigest", guard, path)
  const outOfScopeCount = integerValue(record, "outOfScopeCount", path)
  const reasonCode = optionalEnum(record, "reasonCode", REVIEW_REASONS, guard, path)
  if (state === "invalid" && reasonCode === undefined)
    fail("missing-required", `${path}.reasonCode`)
  if (state === "valid" && reasonCode !== undefined) fail("derived-field-mismatch", path)
  return {
    kind,
    state,
    ...(gitRef === undefined ? {} : { gitRef }),
    changedPaths,
    pathDigest,
    outOfScopeCount,
    ...(reasonCode === undefined ? {} : { reasonCode }),
  }
}

function parseFixResult(
  value: unknown,
  guard: ParseGuard,
  depth: number,
  path: string,
): ReviewFixResult {
  const record = recordAt(value, guard, depth, path)
  assertKeys(record, ["recipe", "status", "changedPaths", "reasonCode"], guard, path)
  const recipe = enumValue(record, "recipe", REVIEW_FIX_RECIPES, guard, path)
  const status = enumValue(record, "status", REVIEW_FIX_STATUSES, guard, path)
  const changedPathsValue = optionalValue(record, "changedPaths", path)
  const changedPaths =
    changedPathsValue === undefined
      ? undefined
      : parsePaths(changedPathsValue, guard, depth + 1, `${path}.changedPaths`)
  const reasonCode = optionalEnum(record, "reasonCode", REVIEW_REASONS, guard, path)
  if ((status === "no-op" || status === "failed") && reasonCode === undefined)
    fail("missing-required", `${path}.reasonCode`)
  if ((status === "planned" || status === "changed") && reasonCode !== undefined)
    fail("derived-field-mismatch", path)
  return {
    recipe,
    status,
    ...(changedPaths === undefined ? {} : { changedPaths }),
    ...(reasonCode === undefined ? {} : { reasonCode }),
  }
}

function assertSortedUnique<T>(
  values: readonly T[],
  key: (value: T) => string,
  path: string,
  duplicateCode: ReviewParserErrorCode,
): void {
  let previous: string | undefined
  for (const value of values) {
    const current = key(value)
    if (previous !== undefined) {
      if (current === previous) fail(duplicateCode, path)
      if (compareText(current, previous) < 0) fail("non-canonical", path)
    }
    previous = current
  }
}

function fixKey(value: ReviewFixResult): string {
  return `${value.recipe}\u0000${value.status}\u0000${value.changedPaths?.join("\u0000") ?? ""}\u0000${value.reasonCode ?? ""}`
}

function assertReportRelationships(
  checks: readonly ReviewCheckResult[],
  findings: readonly ReviewFinding[],
  fixes: readonly ReviewFixResult[] | undefined,
  path: string,
): { readonly blocking: number; readonly status: ReviewStatus; readonly ok: boolean } {
  assertSortedUnique(checks, (item) => item.id, `${path}.checks`, "duplicate-id")
  assertSortedUnique(findings, (item) => item.id, `${path}.findings`, "duplicate-id")
  if (fixes !== undefined) assertSortedUnique(fixes, fixKey, `${path}.fixes`, "duplicate-id")

  const checksById = new Map<ReviewCheckId, ReviewCheckResult>()
  for (const check of checks) checksById.set(check.id, check)
  const findingsById = new Map<string, ReviewFinding>()
  for (const finding of findings) {
    if (findingsById.has(finding.id)) fail("duplicate-id", `${path}.findings`)
    if (!checksById.has(finding.check)) fail("invalid-reference", `${path}.findings`)
    findingsById.set(finding.id, finding)
  }

  const referenced = new Set<string>()
  let errorCount = 0
  for (const check of checks) {
    let errors = 0
    let warnings = 0
    let info = 0
    for (const findingId of check.findingIds) {
      const finding = findingsById.get(findingId)
      if (finding === undefined || finding.check !== check.id || referenced.has(findingId))
        fail("invalid-reference", `${path}.checks`)
      referenced.add(findingId)
      if (finding.severity === "error") {
        errors += 1
        errorCount += 1
      } else if (finding.severity === "warning") {
        warnings += 1
      } else {
        info += 1
      }
    }
    if (
      check.counts.findings !== check.findingIds.length ||
      check.counts.errors !== errors ||
      check.counts.warnings !== warnings ||
      check.counts.info !== info
    )
      fail("derived-field-mismatch", `${path}.checks`)
  }
  if (referenced.size !== findings.length) fail("invalid-reference", `${path}.findings`)

  const unresolvedFixes =
    fixes?.filter((fix) => fix.status === "no-op" || fix.status === "failed").length ?? 0
  const blocking = errorCount + unresolvedFixes
  return { blocking, status: blocking > 0 ? "fail" : "pass", ok: blocking === 0 }
}

function deriveReportOutcome(
  strict: boolean,
  scope: ReviewScope,
  checks: readonly ReviewCheckResult[],
  findings: readonly ReviewFinding[],
  fixes: readonly ReviewFixResult[] | undefined,
): { readonly blocking: number; readonly status: ReviewStatus; readonly ok: boolean } {
  let errors = 0
  let warnings = 0
  for (const finding of findings) {
    if (finding.severity === "error") errors += 1
    if (finding.severity === "warning") warnings += 1
  }
  const unresolvedFixes =
    fixes?.filter((fix) => fix.status === "no-op" || fix.status === "failed").length ?? 0
  const blocking = errors + (strict ? warnings : 0) + unresolvedFixes
  const inconclusive =
    scope.state === "invalid" ||
    checks.some(
      (check) => check.required && (check.status === "unavailable" || check.status === "error"),
    )
  const status: ReviewStatus = inconclusive ? "inconclusive" : blocking > 0 ? "fail" : "pass"
  return { blocking, status, ok: status === "pass" }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null) return value
  const object = value as object
  if (seen.has(object)) return value
  seen.add(object)
  for (const key of Reflect.ownKeys(object)) {
    deepFreeze((object as Record<PropertyKey, unknown>)[key], seen)
  }
  return Object.freeze(value)
}

function parseObjectReport(value: unknown, guard: ParseGuard): ReviewReport {
  const record = recordAt(value, guard, 0, "$")
  assertKeys(
    record,
    [
      "version",
      "strict",
      "scope",
      "checks",
      "findings",
      "fixes",
      "blocking",
      "ok",
      "status",
      "digest",
    ],
    guard,
    "$",
  )
  const version = requiredValue(record, "version", "$")
  if (version !== REVIEW_REPORT_VERSION) fail("invalid-enum", "$.version")
  const strict = booleanValue(record, "strict", "$")
  const scope = parseScope(requiredValue(record, "scope", "$"), guard, 1, "$.scope")
  const checksValue = arrayAt(requiredValue(record, "checks", "$"), guard, 1, "$.checks")
  const checks = checksValue.map((item, index) => parseCheck(item, guard, 2, `$.checks[${index}]`))
  const findingsValue = arrayAt(requiredValue(record, "findings", "$"), guard, 1, "$.findings")
  const findings = findingsValue.map((item, index) =>
    parseFinding(item, guard, 2, `$.findings[${index}]`),
  )
  const fixesValue = optionalValue(record, "fixes", "$")
  const fixes =
    fixesValue === undefined
      ? undefined
      : arrayAt(fixesValue, guard, 1, "$.fixes").map((item, index) =>
          parseFixResult(item, guard, 2, `$.fixes[${index}]`),
        )
  const blocking = integerValue(record, "blocking", "$")
  const ok = booleanValue(record, "ok", "$")
  const status = enumValue(record, "status", ["pass", "fail", "inconclusive"] as const, guard, "$")
  const digest = digestValue(record, "digest", guard, "$")

  const relationshipOutcome = assertReportRelationships(checks, findings, fixes, "$")
  if (relationshipOutcome.blocking < 0) fail("derived-field-mismatch", "$.blocking")
  const outcome = deriveReportOutcome(strict, scope, checks, findings, fixes)
  if (blocking !== outcome.blocking || ok !== outcome.ok || status !== outcome.status)
    fail("derived-field-mismatch", "$")
  const report: ReviewReport = {
    version: REVIEW_REPORT_VERSION,
    strict,
    scope,
    checks,
    findings,
    ...(fixes === undefined ? {} : { fixes }),
    blocking,
    ok,
    status,
    digest,
  }
  return report
}

/** Parse a JSON string or unknown value into a bounded, deeply frozen review report. */
export async function parseReviewReport(input: unknown): Promise<ReviewReport> {
  let value = input
  if (typeof input === "string") {
    const bytes = new TextEncoder().encode(input).byteLength
    if (bytes > REVIEW_MAX_BYTES) fail("oversized", "$")
    try {
      value = JSON.parse(input) as unknown
    } catch {
      fail("invalid-root", "$")
    }
  }

  const report = parseObjectReport(value, new ParseGuard())
  const canonicalBytes = new TextEncoder().encode(canonicalizeReviewReport(report)).byteLength
  if (canonicalBytes > REVIEW_MAX_BYTES) fail("oversized", "$")
  const expectedDigest = await digestReviewReport(report)
  if (report.digest !== expectedDigest) fail("derived-field-mismatch", "$.digest")
  return deepFreeze(report)
}

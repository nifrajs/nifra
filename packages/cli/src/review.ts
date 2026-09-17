import { isAbsolute, relative, resolve, sep } from "node:path"
import type {
  ReviewCategory,
  ReviewCheckId,
  ReviewCheckResult,
  ReviewEvidenceRef,
  ReviewEvidenceSource,
  ReviewFinding,
  ReviewFixRecipeId,
  ReviewFixResult,
  ReviewReport,
  ReviewReportDraft,
  ReviewScope,
  ReviewSeverity,
} from "@nifrajs/agent-review"
import type { CheckResult } from "./check.ts"
import type { CommandCtx, CommandSpec } from "./command-catalog.ts"
import type { Diagnostic } from "./diagnostics.ts"
import { toSarifLog } from "./diagnostics.ts"
import { RULE_CODES } from "./rules/codes.ts"
import { LEGACY_RULE_CODES } from "./rules/legacy.ts"

export interface ReviewInput {
  readonly strict?: boolean | undefined
  readonly diff?: string | undefined
  readonly sarif?: string | undefined
  readonly fix?: boolean | undefined
  readonly dryRun?: boolean | undefined
  readonly write?: boolean | undefined
  readonly json?: boolean | undefined
}

export class ReviewInputError extends Error {
  readonly exitCode = 2 as const

  constructor(message: string) {
    super(message)
    this.name = "ReviewInputError"
  }
}

const REVIEW_INPUT_KEYS = new Set(["strict", "diff", "sarif", "fix", "dryRun", "write", "json"])
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SAFE_GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/@+-]{0,255}$/

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

const CHECK_IDS: readonly ReviewCheckId[] = [
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

const REQUIRED_CHECKS = new Set<ReviewCheckId>([
  "typecheck",
  "typed-client",
  "server-boundary",
  "route-boundary",
  "pipeline",
  "security",
  "dependency",
])

const CHECK_CATEGORIES: Readonly<Record<ReviewCheckId, ReviewCategory>> = {
  typecheck: "correctness",
  "typed-client": "correctness",
  "server-boundary": "boundary",
  "route-boundary": "boundary",
  pipeline: "correctness",
  security: "security",
  "route-assurance": "assurance",
  "capability-provenance": "capability",
  manifest: "assurance",
  dependency: "dependency",
  "contract-witness": "contract",
  coverage: "coverage",
  hydration: "hydration",
  configuration: "configuration",
}

const CHECK_SOURCES: Readonly<Record<ReviewCheckId, ReviewEvidenceSource>> = {
  typecheck: "check",
  "typed-client": "check",
  "server-boundary": "check",
  "route-boundary": "check",
  pipeline: "check",
  security: "check",
  "route-assurance": "assurance",
  "capability-provenance": "capability",
  manifest: "manifest",
  dependency: "check",
  "contract-witness": "contract",
  coverage: "coverage",
  hydration: "assurance",
  configuration: "collector",
}

const ALLOWED_FIXES = new Set<ReviewFixRecipeId>(["manifest.sync", "workspace-dist.rebuild"])

const CHECK_CODES: Readonly<Record<string, ReviewCheckId>> = {
  "NF-C001": "typecheck",
  "NF-C002": "typed-client",
  "NF-C003": "typed-client",
  "NF-C004": "server-boundary",
  "NF-C005": "typed-client",
  "NF-C006": "security",
  "NF-C007": "typed-client",
  "NF-C008": "dependency",
  "NF-C009": "dependency",
  "NF-C010": "dependency",
  "NF-C011": "pipeline",
  "NF-C012": "manifest",
  "NF-C013": "manifest",
  "NF-C014": "capability-provenance",
  "NF-C015": "route-assurance",
  "NF-C016": "configuration",
  "NF-C017": "configuration",
  "NF-C018": "route-boundary",
  "NF-C019": "route-boundary",
  "NF-C020": "route-boundary",
  "NF-C021": "route-boundary",
  "NF-C022": "route-boundary",
  "NF-C023": "route-boundary",
  "NF-D001": "dependency",
  "NF-A001": "route-assurance",
  "NF-H001": "hydration",
  "NF-H002": "hydration",
  "NF-H003": "hydration",
  "NF-H004": "hydration",
  "NF-K001": "contract-witness",
}

for (const code of ["NF-S001", "NF-S002", "NF-S003", "NF-S004", "NF-S005", "NF-S006", "NF-S007"])
  (CHECK_CODES as Record<string, ReviewCheckId>)[code] = "security"

const REVIEW_INPUT_SCHEMA = {
  type: "object",
  properties: {
    strict: { type: "boolean" },
    diff: { type: "string" },
    sarif: { type: "string" },
    fix: { type: "boolean" },
    dryRun: { type: "boolean" },
    write: { type: "boolean" },
    json: { type: "boolean" },
  },
  additionalProperties: false,
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optionalBoolean(raw: Record<string, unknown>, key: string): boolean | undefined {
  const value = raw[key]
  if (value === undefined) return undefined
  if (typeof value !== "boolean") throw new ReviewInputError(`${key} must be a boolean`)
  return value
}

function optionalString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key]
  if (value === undefined) return undefined
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\u0000") ||
    value.includes("\\")
  )
    throw new ReviewInputError(`${key} must be a non-empty safe string`)
  return value
}

/** Parse and validate the shared CLI/MCP review input before any collector is invoked. */
export function parseReviewInput(value: unknown): ReviewInput {
  if (!isRecord(value)) throw new ReviewInputError("review input must be an object")
  for (const key of Object.keys(value))
    if (!REVIEW_INPUT_KEYS.has(key)) throw new ReviewInputError(`unknown review option: ${key}`)
  const strict = optionalBoolean(value, "strict")
  const diff = optionalString(value, "diff")
  const sarif = optionalString(value, "sarif")
  const fix = optionalBoolean(value, "fix")
  const dryRun = optionalBoolean(value, "dryRun")
  const write = optionalBoolean(value, "write")
  const json = optionalBoolean(value, "json")
  if (dryRun === true && fix !== true) throw new ReviewInputError("dryRun requires fix")
  if (write === true && fix !== true) throw new ReviewInputError("write requires fix")
  if (dryRun === true && write === true)
    throw new ReviewInputError("dryRun and write are mutually exclusive")
  return {
    ...(strict === undefined ? {} : { strict }),
    ...(diff === undefined ? {} : { diff }),
    ...(sarif === undefined ? {} : { sarif }),
    ...(fix === undefined ? {} : { fix }),
    ...(dryRun === undefined ? {} : { dryRun }),
    ...(write === undefined ? {} : { write }),
    ...(json === undefined ? {} : { json }),
  }
}

function normalizedCode(value: unknown): string {
  if (typeof value !== "string") return "application-rule"
  const code = LEGACY_RULE_CODES[value] ?? value
  return CODE_PATTERN.test(code) ? code : "application-rule"
}

function normalizedSeverity(value: unknown): ReviewSeverity {
  return value === "error" ? "error" : value === "warn" || value === "warning" ? "warning" : "info"
}

function normalizedLocation(
  cwd: string,
  file: unknown,
  line: unknown,
): { readonly path: string; readonly line?: number } | undefined {
  if (
    typeof file !== "string" ||
    file.length === 0 ||
    file.includes("\u0000") ||
    file.includes("\\")
  )
    return undefined
  if (/^[A-Za-z]:[\\/]/.test(file)) return undefined
  const candidate = isAbsolute(file) ? resolve(file) : resolve(cwd, file)
  const path = relative(resolve(cwd), candidate).split(sep).join("/")
  if (path.length === 0 || path === ".." || path.startsWith("../") || path.startsWith("/"))
    return undefined
  if (path.split("/").some((part) => part === "." || part === ".." || part.length === 0))
    return undefined
  return {
    path,
    ...(typeof line === "number" && Number.isSafeInteger(line) && line > 0 ? { line } : {}),
  }
}

function codeCheck(code: string): ReviewCheckId {
  return CHECK_CODES[code] ?? "configuration"
}

function sourceFor(check: ReviewCheckId): ReviewEvidenceSource {
  return CHECK_SOURCES[check]
}

async function sha256Text(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function composeReport(input: ReviewReportDraft): Promise<ReviewReport> {
  // Keep the optional review leaf off ordinary CLI startup. The command catalog can describe the
  // command without importing the contract implementation; only an actual review loads it.
  const { composeReviewReport } = await import("@nifrajs/agent-review")
  return composeReviewReport(input)
}

async function evidenceRef(
  source: ReviewEvidenceSource,
  material: string,
  path?: string,
): Promise<ReviewEvidenceRef> {
  const digest = await sha256Text(material)
  const token = `r-${digest.slice(0, 32)}`
  return { source, token, digest, ...(path === undefined ? {} : { path }) }
}

function diagnosticValue(result: CheckResult): readonly Diagnostic[] {
  if (result.structuredDiagnostics !== undefined) return result.structuredDiagnostics
  return result.diagnostics.map((value) => ({
    code: value.code ?? value.rule,
    severity: value.severity === "warning" ? "warn" : value.severity,
    message: "Nifra diagnostic",
    ...(value.file === undefined ? {} : { file: value.file }),
    ...(value.line === undefined ? {} : { line: value.line }),
    ...(value.fix === undefined ? {} : { fix: { recipe: value.fix } }),
  }))
}

interface CandidateFinding {
  readonly diagnostic: Diagnostic
  readonly check: ReviewCheckId
  readonly code: string
  readonly severity: ReviewSeverity
  readonly location?: { readonly path: string; readonly line?: number }
  readonly finding: ReviewFinding
}

async function candidateFinding(
  cwd: string,
  diagnostic: Diagnostic,
  check: ReviewCheckId,
  index: number,
): Promise<CandidateFinding> {
  const code = normalizedCode(diagnostic.code)
  const severity = normalizedSeverity(diagnostic.severity)
  const location = normalizedLocation(cwd, diagnostic.file, diagnostic.line)
  const material = `${check}\u0000${code}\u0000${location?.path ?? ""}\u0000${location?.line ?? ""}\u0000${index}`
  const evidence = await evidenceRef(sourceFor(check), material, location?.path)
  const recipe = diagnostic.fix?.recipe
  const fix =
    typeof recipe === "string" && ALLOWED_FIXES.has(recipe as ReviewFixRecipeId)
      ? { recipe: recipe as ReviewFixRecipeId }
      : undefined
  const finding: ReviewFinding = {
    id: `f-${check}-${index}`,
    check,
    code,
    severity,
    category: CHECK_CATEGORIES[check],
    ...(location === undefined ? {} : { location }),
    evidence: [evidence],
    ...(fix === undefined ? {} : { fix }),
  }
  return {
    diagnostic,
    check,
    code,
    severity,
    ...(location === undefined ? {} : { location }),
    finding,
  }
}

function checkConfigured(
  id: ReviewCheckId,
  diagnostics: readonly CandidateFinding[],
  verification: ProjectVerificationLike,
): boolean {
  if (REQUIRED_CHECKS.has(id)) return true
  if (diagnostics.length > 0) return true
  switch (id) {
    case "route-assurance":
      return verification.config !== undefined || verification.assuranceConfigPresent
    case "capability-provenance":
      return verification.capability !== undefined
    case "manifest":
      return verification.evidence !== undefined
    case "contract-witness":
      return false
    case "coverage":
      return false
    case "hydration":
      return false
    case "configuration":
      return false
    default:
      return false
  }
}

function checkStatus(findings: readonly CandidateFinding[]): "pass" | "fail" {
  return findings.some((finding) => finding.severity === "error") ? "fail" : "pass"
}

function countsFor(
  findings: readonly CandidateFinding[],
  outOfScope: number,
): ReviewCheckResult["counts"] {
  return {
    findings: findings.length,
    errors: findings.filter((finding) => finding.severity === "error").length,
    warnings: findings.filter((finding) => finding.severity === "warning").length,
    info: findings.filter((finding) => finding.severity === "info").length,
    outOfScope,
  }
}

function safeGitRef(value: string): boolean {
  return (
    SAFE_GIT_REF.test(value) &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.includes("//") &&
    !value.endsWith(".") &&
    !value.endsWith("/") &&
    !value
      .split("/")
      .some(
        (part) =>
          part.length === 0 ||
          part === "." ||
          part === ".." ||
          part.startsWith(".") ||
          part.endsWith(".lock"),
      )
  )
}

interface GitResult {
  readonly ok: boolean
  readonly stdout: string
}

async function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  const process = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  const exitCode = await process.exited
  return { ok: exitCode === 0, stdout }
}

function nulPaths(value: string): readonly string[] {
  return value
    .split("\u0000")
    .filter((path) => path.length > 0)
    .map((path) => path.replaceAll("\\", "/"))
}

async function diffScope(cwd: string, ref: string): Promise<ReviewScope> {
  if (!safeGitRef(ref)) throw new ReviewInputError("invalid git ref")
  const verified = await runGit(cwd, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${ref}^{commit}`,
  ])
  if (!verified.ok) throw new ReviewInputError("invalid git ref")
  const commit = verified.stdout.trim()
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new ReviewInputError("invalid git ref")
  const changed = await runGit(cwd, [
    "diff",
    "--name-only",
    "-z",
    "--diff-filter=ACDMRTUXB",
    commit,
    "--",
  ])
  const untracked = await runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--"])
  if (!changed.ok || !untracked.ok) throw new ReviewInputError("invalid git scope")
  const paths = [...new Set([...nulPaths(changed.stdout), ...nulPaths(untracked.stdout)])].sort(
    compareText,
  )
  if (
    paths.some(
      (path) =>
        isAbsolute(path) ||
        path.includes("\u0000") ||
        path.includes("\\") ||
        path.split("/").some((part) => part === "" || part === "." || part === ".."),
    )
  )
    throw new ReviewInputError("invalid git scope")
  return {
    kind: "diff",
    state: "valid",
    gitRef: ref,
    changedPaths: paths,
    pathDigest: await sha256Text(JSON.stringify(paths)),
    outOfScopeCount: 0,
  }
}

async function projectScope(): Promise<ReviewScope> {
  const paths: readonly string[] = []
  return {
    kind: "project",
    state: "valid",
    changedPaths: paths,
    pathDigest: await sha256Text(JSON.stringify(paths)),
    outOfScopeCount: 0,
  }
}

interface ProjectVerificationLike {
  readonly assuranceConfigPresent: boolean
  readonly config?: unknown
  readonly configError?: unknown
  readonly capability?: unknown
  readonly evidence?: unknown
  check(): Promise<CheckResult>
}

type InconclusiveReasonCode =
  | "invalid-git-ref"
  | "invalid-git-scope"
  | "config-invalid"
  | "collector-error"

function invalidScope(kind: "project" | "diff", reasonCode: InconclusiveReasonCode): ReviewScope {
  return {
    kind,
    state: "invalid",
    changedPaths: [],
    pathDigest: "0".repeat(64),
    outOfScopeCount: 0,
    reasonCode,
  }
}

async function inconclusiveReport(
  kind: "project" | "diff",
  reasonCode: InconclusiveReasonCode,
): Promise<ReviewReport> {
  const scope = invalidScope(kind, reasonCode)
  const evidence = await evidenceRef("collector", `inconclusive\u0000${reasonCode}`)
  const check: ReviewCheckResult = {
    id: "configuration",
    required: true,
    status: "error",
    duration: "none",
    counts: { findings: 0, errors: 0, warnings: 0, info: 0, outOfScope: 0 },
    findingIds: [],
    evidence: [evidence],
    reasonCode,
  }
  return composeReport({
    strict: false,
    scope,
    checks: [check],
    findings: [],
  })
}

/**
 * A collector or composer failure must never turn the review command into an unstructured crash.
 * The normal path uses the public composer; this last-resort report is deliberately tiny and has
 * no collector payload. The digest is still computed through the public canonicalizer whenever it
 * is available, so an agent can consume the result with the same parser as every other report.
 */
async function safeInconclusiveReport(
  kind: "project" | "diff",
  reasonCode: InconclusiveReasonCode,
): Promise<ReviewReport> {
  try {
    return await inconclusiveReport(kind, reasonCode)
  } catch {
    const evidence: ReviewEvidenceRef = {
      source: "collector",
      token: "r-inconclusive",
      digest: "0".repeat(64),
    }
    const report = {
      version: 1 as const,
      strict: false,
      scope: invalidScope(kind, reasonCode),
      checks: [
        {
          id: "configuration" as const,
          required: true,
          status: "error" as const,
          duration: "none" as const,
          counts: { findings: 0, errors: 0, warnings: 0, info: 0, outOfScope: 0 },
          findingIds: [],
          evidence: [evidence],
          reasonCode,
        },
      ],
      findings: [],
      blocking: 0,
      ok: false,
      status: "inconclusive" as const,
      digest: "0".repeat(64),
    } satisfies ReviewReport
    try {
      const { digestReviewReport } = await import("@nifrajs/agent-review")
      return { ...report, digest: await digestReviewReport(report) }
    } catch {
      return report
    }
  }
}

async function composeCollectedReport(
  cwd: string,
  input: ReviewInput,
  scope: ReviewScope,
  verification: ProjectVerificationLike,
  checkResult: CheckResult,
): Promise<{ readonly report: ReviewReport; readonly candidates: readonly CandidateFinding[] }> {
  const diagnostics = diagnosticValue(checkResult)
    .map((diagnostic, index) => ({ diagnostic, index }))
    .sort((left, right) => {
      const leftLocation = normalizedLocation(cwd, left.diagnostic.file, left.diagnostic.line)
      const rightLocation = normalizedLocation(cwd, right.diagnostic.file, right.diagnostic.line)
      return (
        compareText(normalizedCode(left.diagnostic.code), normalizedCode(right.diagnostic.code)) ||
        compareText(
          normalizedSeverity(left.diagnostic.severity),
          normalizedSeverity(right.diagnostic.severity),
        ) ||
        compareText(leftLocation?.path ?? "", rightLocation?.path ?? "") ||
        (leftLocation?.line ?? 0) - (rightLocation?.line ?? 0) ||
        compareText(left.diagnostic.fix?.recipe ?? "", right.diagnostic.fix?.recipe ?? "") ||
        left.index - right.index
      )
    })
  const candidatesByCheck = new Map<ReviewCheckId, CandidateFinding[]>()
  for (const id of CHECK_IDS) candidatesByCheck.set(id, [])
  for (let index = 0; index < diagnostics.length; index += 1) {
    const diagnostic = diagnostics[index]!.diagnostic
    const candidate = await candidateFinding(
      cwd,
      diagnostic,
      codeCheck(normalizedCode(diagnostic.code)),
      index,
    )
    candidatesByCheck.get(candidate.check)?.push(candidate)
  }

  const changedPaths = new Set(scope.changedPaths)
  const retainedByCheck = new Map<ReviewCheckId, CandidateFinding[]>()
  let totalOutOfScope = 0
  for (const id of CHECK_IDS) {
    const source = candidatesByCheck.get(id) ?? []
    const retained: CandidateFinding[] = []
    let outOfScope = 0
    for (const candidate of source) {
      if (
        scope.kind === "diff" &&
        candidate.location !== undefined &&
        !changedPaths.has(candidate.location.path)
      ) {
        outOfScope += 1
        totalOutOfScope += 1
      } else retained.push(candidate)
    }
    retainedByCheck.set(id, retained)
    // Store the per-check count temporarily on the scope map below through a side channel-free map.
    void outOfScope
  }

  const checks: ReviewCheckResult[] = []
  const findings: ReviewFinding[] = []
  for (const id of CHECK_IDS) {
    const all = candidatesByCheck.get(id) ?? []
    const retained = retainedByCheck.get(id) ?? []
    const configured = checkConfigured(id, all, verification)
    const isTypecheckUnavailable =
      id === "typecheck" &&
      (checkResult.typecheck === "skipped" || checkResult.truncated !== undefined)
    let status: ReviewCheckResult["status"]
    let reasonCode: ReviewCheckResult["reasonCode"]
    if (isTypecheckUnavailable) {
      status = "unavailable"
      reasonCode =
        checkResult.truncated !== undefined
          ? "diagnostics-truncated"
          : checkResult.typecheckNote?.toLowerCase().includes("typescript")
            ? "missing-typescript"
            : "unsupported"
    } else if (!configured) {
      status = "skipped"
      reasonCode = "not-configured"
    } else {
      status = checkStatus(retained)
    }
    const checkEvidence =
      retained.length > 0
        ? retained
            .map((candidate) => candidate.finding.evidence[0]!)
            .filter((entry): entry is ReviewEvidenceRef => entry !== undefined)
        : [await evidenceRef(sourceFor(id), `check\u0000${id}\u0000${status}`)]
    const outOfScope = all.length - retained.length
    for (const candidate of retained) findings.push(candidate.finding)
    checks.push({
      id,
      required: REQUIRED_CHECKS.has(id),
      status,
      duration: status === "unavailable" ? "timeout" : "standard",
      counts: countsFor(retained, outOfScope),
      findingIds: retained.map((candidate) => candidate.finding.id),
      evidence: checkEvidence,
      ...(reasonCode === undefined ? {} : { reasonCode }),
    })
  }

  if (verification.assuranceConfigPresent && verification.configError !== undefined) {
    const id = "configuration"
    const evidence = await evidenceRef("collector", "assurance-config-invalid")
    const finding: ReviewFinding = {
      id: "f-configuration-config",
      check: id,
      code: "NF-C015",
      severity: "error",
      category: "configuration",
      evidence: [evidence],
    }
    findings.push(finding)
    const index = checks.findIndex((check) => check.id === id)
    const existing = checks[index]
    if (existing !== undefined) {
      checks[index] = {
        ...existing,
        required: true,
        status: "error",
        counts: {
          findings: existing.counts.findings + 1,
          errors: existing.counts.errors + 1,
          warnings: existing.counts.warnings,
          info: existing.counts.info,
          outOfScope: existing.counts.outOfScope,
        },
        findingIds: [...existing.findingIds, finding.id],
        evidence: [evidence],
        reasonCode: "config-invalid",
      }
    }
  }

  const finalScope: ReviewScope = {
    ...scope,
    outOfScopeCount: totalOutOfScope,
  }
  const fixes =
    input.fix === true
      ? [
          ...new Set(
            findings.flatMap((finding) => (finding.fix === undefined ? [] : [finding.fix.recipe])),
          ),
        ]
          .sort(compareText)
          .map((recipe): ReviewFixResult => ({ recipe, status: "planned" }))
      : undefined
  const draft: ReviewReportDraft = {
    strict: input.strict === true,
    scope: finalScope,
    checks,
    findings,
    ...(fixes === undefined ? {} : { fixes }),
  }
  const report = await composeReport(draft)
  return {
    report,
    candidates: [...retainedByCheck.values()].flat(),
  }
}

function staticDiagnostic(candidate: CandidateFinding): Diagnostic {
  const label = RULE_CODES[candidate.code as keyof typeof RULE_CODES] ?? "Nifra application rule"
  return {
    code: candidate.code,
    severity: candidate.severity === "warning" ? "warn" : candidate.severity,
    message: label,
    ...(candidate.location === undefined
      ? {}
      : {
          file: candidate.location.path,
          ...(candidate.location.line === undefined ? {} : { line: candidate.location.line }),
        }),
    // Fix recipes receive only the internal bounded evidence they need. The public report still
    // exposes opaque references; raw package names/paths never cross the report, SARIF, MCP, or
    // browser boundaries.
    evidence: candidate.diagnostic.evidence?.slice(0, 8) ?? [
      candidate.finding.evidence[0]?.token ?? "review",
    ],
    ...(candidate.finding.fix === undefined
      ? {}
      : { fix: { recipe: candidate.finding.fix.recipe } }),
  }
}

async function safeChangedPaths(cwd: string, paths: readonly string[]): Promise<readonly string[]> {
  const { resolveInsideProject } = await import("./project-path.ts")
  const result: string[] = []
  for (const path of paths) {
    if (typeof path !== "string" || path.length === 0 || isAbsolute(path)) continue
    const resolved = await resolveInsideProject(cwd, path)
    if (resolved === undefined) continue
    const relativePath = relative(resolve(cwd), resolved).split(sep).join("/")
    if (relativePath.length > 0 && relativePath !== ".." && !relativePath.startsWith("../"))
      result.push(relativePath)
  }
  return [...new Set(result)].sort(compareText)
}

async function applyRequestedFixes(
  cwd: string,
  candidates: readonly CandidateFinding[],
): Promise<readonly ReviewFixResult[]> {
  const { applyDiagnosticRecipe } = await import("./fix-recipes.ts")
  const results: ReviewFixResult[] = []
  const seen = new Set<ReviewFixRecipeId>()
  for (const candidate of candidates) {
    const recipe = candidate.finding.fix?.recipe
    if (recipe === undefined || seen.has(recipe)) continue
    seen.add(recipe)
    try {
      const changed = await applyDiagnosticRecipe(cwd, staticDiagnostic(candidate))
      const safe = await safeChangedPaths(cwd, changed)
      results.push(
        safe.length === 0
          ? { recipe, status: "no-op", reasonCode: "fix-no-op" }
          : { recipe, status: "changed", changedPaths: safe },
      )
    } catch {
      results.push({ recipe, status: "failed", reasonCode: "fix-failed" })
    }
  }
  return results
}

async function resolveSarifPath(cwd: string, path: string): Promise<string> {
  const { resolveInsideProject } = await import("./project-path.ts")
  const resolved = await resolveInsideProject(cwd, path)
  if (resolved === undefined) throw new ReviewInputError("sarif path must stay inside the project")
  return resolved
}

async function writeSarif(
  cwd: string,
  path: string,
  report: ReviewReport,
  cliVersion?: string,
): Promise<void> {
  const resolved = await resolveSarifPath(cwd, path)
  const diagnostics: Diagnostic[] = report.findings.map((finding) => {
    const label = RULE_CODES[finding.code as keyof typeof RULE_CODES] ?? "Nifra application rule"
    return {
      code: finding.code,
      severity: finding.severity === "warning" ? "warn" : finding.severity,
      message: label,
      ...(finding.location === undefined
        ? {}
        : {
            file: finding.location.path,
            ...(finding.location.line === undefined ? {} : { line: finding.location.line }),
          }),
      evidence: [finding.evidence[0]?.token ?? "review"],
      ...(finding.fix === undefined ? {} : { fix: { recipe: finding.fix.recipe } }),
    }
  })
  try {
    await Bun.write(
      resolved,
      `${JSON.stringify(
        toSarifLog(diagnostics, {
          toolName: "nifra",
          ...(cliVersion === undefined ? {} : { toolVersion: cliVersion }),
        }),
        null,
        2,
      )}\n`,
    )
  } catch {
    throw new ReviewInputError("could not write SARIF output")
  }
}

export async function runReview(input: ReviewInput, ctx: CommandCtx): Promise<ReviewReport> {
  const parsed = parseReviewInput(input)
  // Validate destination confinement before Git or project collectors run. A malformed output
  // target is an input error, not an inconclusive project result, and must not spend collector work.
  if (parsed.sarif !== undefined) await resolveSarifPath(ctx.cwd, parsed.sarif)
  let scope: ReviewScope
  try {
    scope = parsed.diff === undefined ? await projectScope() : await diffScope(ctx.cwd, parsed.diff)
  } catch (error) {
    if (error instanceof ReviewInputError)
      return safeInconclusiveReport(
        parsed.diff === undefined ? "project" : "diff",
        error.message.includes("ref") ? "invalid-git-ref" : "invalid-git-scope",
      )
    return safeInconclusiveReport(parsed.diff === undefined ? "project" : "diff", "collector-error")
  }

  let verification: ProjectVerificationLike
  try {
    const { collectProjectVerification } = await import("./verification.ts")
    verification = await collectProjectVerification(ctx.cwd, {
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    })
  } catch {
    return safeInconclusiveReport(scope.kind, "collector-error")
  }
  let checkResult: CheckResult
  try {
    checkResult = await verification.check()
  } catch {
    return safeInconclusiveReport(scope.kind, "collector-error")
  }
  let collected: Awaited<ReturnType<typeof composeCollectedReport>>
  try {
    collected = await composeCollectedReport(ctx.cwd, parsed, scope, verification, checkResult)
  } catch {
    return safeInconclusiveReport(scope.kind, "collector-error")
  }
  let report = collected.report

  if (parsed.fix === true && parsed.write === true && report.status !== "inconclusive") {
    try {
      const fixResults = await applyRequestedFixes(ctx.cwd, collected.candidates)
      const { collectProjectVerification } = await import("./verification.ts")
      const rerunVerification = await collectProjectVerification(ctx.cwd, {
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      })
      const rerunChecks = await rerunVerification.check()
      const rerun = await composeCollectedReport(
        ctx.cwd,
        { ...parsed, fix: false },
        scope,
        rerunVerification,
        rerunChecks,
      )
      report = await composeReport({
        strict: rerun.report.strict,
        scope: rerun.report.scope,
        checks: rerun.report.checks,
        findings: rerun.report.findings,
        fixes: fixResults,
      })
    } catch {
      return safeInconclusiveReport(scope.kind, "collector-error")
    }
  }

  if (parsed.sarif !== undefined && report.status !== "inconclusive")
    await writeSarif(ctx.cwd, parsed.sarif, report, ctx.cliVersion)
  return report
}

export function renderReviewReport(report: ReviewReport): readonly string[] {
  const lines = [
    report.status === "pass"
      ? `✓ review passed (${report.findings.length} findings)`
      : report.status === "fail"
        ? `✖ review failed (${report.blocking} blocking)`
        : "? review inconclusive (required evidence unavailable)",
    `  digest: ${report.digest}`,
  ]
  for (const finding of report.findings) {
    const location =
      finding.location === undefined
        ? ""
        : ` ${finding.location.path}${finding.location.line === undefined ? "" : `:${finding.location.line}`}`
    lines.push(`  ${finding.severity} ${finding.code} [${finding.check}]${location}`)
  }
  for (const check of report.checks) {
    if (check.status === "skipped") lines.push(`  skipped ${check.id}`)
    if (check.status === "unavailable" || check.status === "error")
      lines.push(`  unavailable ${check.id}`)
  }
  return lines
}

export const reviewSpec: CommandSpec<ReviewInput, ReviewReport> = {
  name: "review",
  summary: "Run the deterministic, evidence-backed Nifra review.",
  input: {
    jsonSchema: REVIEW_INPUT_SCHEMA,
    parse: parseReviewInput,
  },
  output: {
    version: 1,
    jsonSchema: {
      type: "object",
      required: ["version", "scope", "checks", "findings", "blocking", "ok", "status", "digest"],
    },
    parse: (value) => value as ReviewReport,
  },
  transports: ["cli", "mcp"],
  stability: "experimental",
  argv: {
    flags: [
      { name: "strict", field: "strict", type: "boolean" },
      { name: "diff", field: "diff", type: "string" },
      { name: "sarif", field: "sarif", type: "string" },
      { name: "fix", field: "fix", type: "boolean" },
      { name: "dry-run", field: "dryRun", type: "boolean" },
      { name: "write", field: "write", type: "boolean" },
      { name: "json", field: "json", type: "boolean" },
    ],
  },
  run: runReview,
  render: renderReviewReport,
  success: (report) => report.ok,
  exitCode: (report) => (report.status === "inconclusive" ? 2 : report.ok ? 0 : 1),
  json: (report) => report,
}

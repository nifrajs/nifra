/**
 * The single normalized shape every probe emits and the two artifacts consume. No external deps: the
 * skill must run in a repo that does not build and may not have zod installed, so validation is
 * hand-rolled guards.
 */
import { createHash } from "node:crypto"

export type Severity = "critical" | "high" | "medium" | "low" | "info"

export const SEVERITIES: readonly Severity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
] as const

/** Higher = more severe. Used for stable sort and the exit-gate threshold. */
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
}

export type ProbeId = "deps" | "secrets" | "patterns" | "verify" | "outdated"

export interface Suppression {
  readonly reason: string
  /** ISO date. An expired suppression is re-surfaced as `high` and gates. */
  readonly expires?: string
}

export interface Finding {
  /** sha256(probe|ruleId|file|startLine|detailNormalized), first 16 hex. Stable across runs. */
  readonly fingerprint: string
  readonly probe: ProbeId
  readonly severity: Severity
  readonly ruleId: string
  readonly title: string
  readonly file?: string
  readonly startLine?: number
  readonly endLine?: number
  readonly detail: string
  readonly remediation: string
  readonly reference?: string
  readonly suppressed?: Suppression
}

export interface Report {
  readonly schemaVersion: 1
  readonly generatedAtISO: string
  readonly repoHead: string
  readonly toolVersions: Readonly<Record<string, string>>
  readonly counts: Readonly<Record<Severity, number>>
  readonly findings: readonly Finding[]
}

/** A finding as a probe emits it, before the fingerprint is stamped. */
export type RawFinding = Omit<Finding, "fingerprint">

const isSeverity = (value: unknown): value is Severity =>
  typeof value === "string" && (SEVERITIES as readonly string[]).includes(value)

/** Deterministic content hash. Never folds in a timestamp, so an unchanged finding keeps its id. */
export function fingerprint(raw: RawFinding): string {
  const key = [raw.probe, raw.ruleId, raw.file ?? "", raw.startLine ?? "", raw.detail].join("|")
  return createHash("sha256").update(key).digest("hex").slice(0, 16)
}

/**
 * Validate and stamp a raw finding. Throws on a malformed probe result - a probe emitting a bad
 * finding is a bug in the probe and must fail loudly, never be silently dropped from a security scan.
 */
export function toFinding(raw: RawFinding, probe: ProbeId): Finding {
  if (!isSeverity(raw.severity)) {
    throw new Error(`probe ${probe}: invalid severity ${JSON.stringify(raw.severity)}`)
  }
  if (typeof raw.ruleId !== "string" || raw.ruleId.length === 0) {
    throw new Error(`probe ${probe}: missing ruleId`)
  }
  if (typeof raw.title !== "string" || typeof raw.detail !== "string") {
    throw new Error(`probe ${probe}: title and detail must be strings (ruleId ${raw.ruleId})`)
  }
  const normalized: RawFinding = { ...raw, probe }
  return { fingerprint: fingerprint(normalized), ...normalized }
}

/** Compare two findings into the stable output order: severity desc, then probe/file/line/rule. */
export function compareFindings(a: Finding, b: Finding): number {
  const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
  if (bySeverity !== 0) return bySeverity
  return (
    a.probe.localeCompare(b.probe) ||
    (a.file ?? "").localeCompare(b.file ?? "") ||
    (a.startLine ?? 0) - (b.startLine ?? 0) ||
    a.ruleId.localeCompare(b.ruleId) ||
    a.fingerprint.localeCompare(b.fingerprint)
  )
}

export function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  }
  for (const finding of findings) {
    // A suppressed finding does not count toward the gate totals.
    if (finding.suppressed === undefined) counts[finding.severity] += 1
  }
  return counts
}

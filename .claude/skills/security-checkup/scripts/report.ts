/**
 * Pure functions: raw findings -> validated, suppressed, sorted Report -> JSON + markdown. No I/O and
 * no clock here (the timestamp is passed in), so an unchanged tree renders byte-identical output.
 */
import {
  type Finding,
  type ProbeId,
  type RawFinding,
  type Report,
  type Severity,
  compareFindings,
  countBySeverity,
  fingerprint,
  SEVERITIES,
  toFinding,
} from "./schema.ts"

export interface SuppressionEntry {
  readonly reason: string
  readonly expires?: string
}
export type Baseline = Readonly<Record<string, SuppressionEntry>>

export interface AssembleInput {
  readonly raw: ReadonlyArray<{ probe: ProbeId; findings: readonly RawFinding[] }>
  readonly baseline: Baseline
  readonly generatedAtISO: string
  readonly repoHead: string
  readonly toolVersions: Readonly<Record<string, string>>
  /** `now` as an ISO date (YYYY-MM-DD) for expiry comparison; passed in, never read from a clock. */
  readonly todayISO: string
}

/** Apply the suppression baseline to one finding, promoting an expired suppression to a live `high`. */
function applySuppression(finding: Finding, baseline: Baseline, todayISO: string): Finding {
  const entry = baseline[finding.fingerprint]
  if (entry === undefined) return finding
  if (entry.expires !== undefined && entry.expires < todayISO) {
    // Expired: re-surface, escalate, and annotate why it came back. Never a silent forever-mute.
    return {
      ...finding,
      severity: "high" as Severity,
      detail: `${finding.detail}\n\n[suppression expired ${entry.expires}: "${entry.reason}" - re-review required]`,
    }
  }
  return { ...finding, suppressed: { reason: entry.reason, ...(entry.expires ? { expires: entry.expires } : {}) } }
}

export function assembleReport(input: AssembleInput): Report {
  const stamped: Finding[] = []
  for (const group of input.raw) {
    for (const raw of group.findings) {
      const finding = toFinding({ ...raw }, group.probe) // throws on a malformed probe result
      stamped.push(applySuppression(finding, input.baseline, input.todayISO))
    }
  }
  stamped.sort(compareFindings)
  return {
    schemaVersion: 1,
    generatedAtISO: input.generatedAtISO,
    repoHead: input.repoHead,
    toolVersions: input.toolVersions,
    counts: countBySeverity(stamped),
    findings: stamped,
  }
}

export function renderJson(report: Report): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

const SEV_LABEL: Readonly<Record<Severity, string>> = {
  critical: "CRITICAL",
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW",
  info: "INFO",
}

function findingBlock(f: Finding): string {
  const loc = f.file !== undefined ? ` \`${f.file}${f.startLine !== undefined ? `:${f.startLine}` : ""}\`` : ""
  const ref = f.reference !== undefined ? `\n  - ref: ${f.reference}` : ""
  return [
    `#### [${SEV_LABEL[f.severity]}] ${f.ruleId} - ${f.title}`,
    `${loc}`,
    ``,
    f.detail,
    ``,
    `**Fix:** ${f.remediation}${ref}`,
    `\n\`fingerprint: ${f.fingerprint}\``,
  ].join("\n")
}

/** Markdown. The only line that varies on an unchanged tree is the timestamp, kept on its own line. */
export function renderMarkdown(report: Report): string {
  const live = report.findings.filter((f) => f.suppressed === undefined)
  const suppressed = report.findings.filter((f) => f.suppressed !== undefined)
  const lines: string[] = ["# Security checkup", ""]
  lines.push(`generated: ${report.generatedAtISO}`, `commit: ${report.repoHead}`, "")
  lines.push("| severity | count |", "| --- | --- |")
  for (const sev of SEVERITIES) lines.push(`| ${sev} | ${report.counts[sev]} |`)
  lines.push("")
  const tools = Object.entries(report.toolVersions)
  if (tools.length > 0) {
    lines.push(`tools: ${tools.map(([t, v]) => `${t}@${v}`).join(", ")}`, "")
  }
  for (const sev of SEVERITIES) {
    const group = live.filter((f) => f.severity === sev)
    if (group.length === 0) continue
    lines.push(`## ${SEV_LABEL[sev]} (${group.length})`, "")
    for (const f of group) lines.push(findingBlock(f), "")
  }
  if (live.length === 0) lines.push("No un-suppressed findings.", "")
  if (suppressed.length > 0) {
    lines.push("<details><summary>Suppressed (accepted risk)</summary>", "")
    for (const f of suppressed) {
      lines.push(`- \`${f.ruleId}\` ${f.file ?? ""} - ${f.suppressed?.reason ?? ""}` + (f.suppressed?.expires ? ` (expires ${f.suppressed.expires})` : ""))
    }
    lines.push("", "</details>", "")
  }
  return lines.join("\n")
}

/** True when any un-suppressed finding is at or above the threshold severity. */
export function gateFails(report: Report, threshold: Severity): boolean {
  const rank = SEVERITIES.indexOf(threshold)
  return report.findings.some(
    (f) => f.suppressed === undefined && SEVERITIES.indexOf(f.severity) <= rank,
  )
}

export { fingerprint }

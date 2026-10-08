/**
 * One adapter per scanner. Each probe is `(ctx) => Promise<RawFinding[]>` and parses only the tool's
 * STRUCTURED output. A missing tool returns a single `tool-unavailable` finding so a silent skip can
 * never read as "clean"; a scanner that ran and failed throws, so the run exits 2 instead.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ProbeId, RawFinding, Severity } from "./schema.ts"

export interface ProbeContext {
  readonly repoRoot: string
  /** Skip the slow probes (patterns, verify) for a pre-commit run. */
  readonly fast: boolean
  /** Version drift is fatal rather than a finding. */
  readonly strictTools: boolean
  /** Absolute path to rules/semgrep.yml. */
  readonly semgrepRules: string
}

export interface ProbeResult {
  readonly probe: ProbeId
  readonly findings: readonly RawFinding[]
  /** Set when the probe could not run; surfaced as `DEGRADED: <probe>` in the summary. */
  readonly degraded?: string
  /** Tool version actually observed, for the report's toolVersions map. */
  readonly toolVersion?: string
}

/** Pinned tool versions. Drift is a finding (or fatal under --strict-tools), never silent. */
export const TOOL_PINS: Readonly<Record<string, string>> = {
  "osv-scanner": "2.4.0",
  gitleaks: "8.30.1",
  semgrep: "1.99.0",
}

interface Spawned {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

async function run(cmd: readonly string[], cwd: string): Promise<Spawned> {
  const child = Bun.spawn(cmd as string[], { cwd, stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

/** A scanner that ran and failed. Thrown, so the run reports exit 2 rather than a clean scan. */
function scannerFailed(tool: string, out: Spawned): Error {
  return new Error(`${tool} exited ${out.code}: ${out.stderr.slice(0, 200)}`)
}

async function which(tool: string): Promise<boolean> {
  const found = await run(["which", tool], process.cwd())
  return found.code === 0
}

const unavailable = (tool: string): RawFinding => ({
  probe: "deps",
  severity: "info",
  ruleId: `tool-unavailable.${tool}`,
  title: `${tool} is not installed - its checks did not run`,
  detail: `The scanner ${tool} was not found on PATH, so this class of finding was not evaluated. A missing scanner is reported, never silently skipped.`,
  remediation: `Install ${tool} (pinned ${TOOL_PINS[tool] ?? "latest"}) and re-run.`,
})

/** Compare `found` against the pin. Returns a drift finding, or undefined when they match. */
function versionDrift(tool: string, found: string): RawFinding | undefined {
  const pin = TOOL_PINS[tool]
  if (pin === undefined || found === pin) return undefined
  return {
    probe: "deps",
    severity: "high",
    ruleId: `tool-version-drift.${tool}`,
    title: `${tool} ${found} does not match the pinned ${pin}`,
    detail: `Scanner output is only reproducible against a pinned version. ${tool} reported ${found}; the skill pins ${pin}.`,
    remediation: `Install ${tool}@${pin}, or update TOOL_PINS after reviewing the new version's rule changes.`,
  }
}

// --- osv-scanner: dependency advisories (F-007) ---

const OSV_SEVERITY: Readonly<Record<string, Severity>> = {
  CRITICAL: "critical",
  HIGH: "high",
  MODERATE: "medium",
  MEDIUM: "medium",
  LOW: "low",
}

export async function depsProbe(ctx: ProbeContext): Promise<ProbeResult> {
  const probe: ProbeId = "deps"
  if (!(await which("osv-scanner"))) {
    return { probe, findings: [unavailable("osv-scanner")], degraded: "osv-scanner not installed" }
  }
  const version = (await run(["osv-scanner", "--version"], ctx.repoRoot)).stdout.match(
    /\d+\.\d+\.\d+/,
  )?.[0]
  const drift = version !== undefined ? versionDrift("osv-scanner", version) : undefined
  if (drift !== undefined && ctx.strictTools) {
    throw new Error(`osv-scanner version drift under --strict-tools: ${version}`)
  }
  // Scan the PROJECT's own lockfile explicitly. A recursive dir scan descends into `.claude/worktrees`
  // and vendored trees, whose stale lockfiles invent advisories the real dependency graph does not
  // have. `--lockfile` pins the scan to exactly what the project resolves.
  const LOCKFILES = ["bun.lock", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"] as const
  const lockArgs: string[] = []
  for (const name of LOCKFILES) {
    if (await Bun.file(`${ctx.repoRoot}/${name}`).exists()) lockArgs.push("--lockfile", `${ctx.repoRoot}/${name}`)
  }
  if (lockArgs.length === 0) {
    return {
      probe,
      findings: [
        {
          probe,
          severity: "info",
          ruleId: "deps.no-lockfile",
          title: "No recognized lockfile at the repo root - dependency scan skipped",
          detail: `Looked for ${LOCKFILES.join(", ")} at ${ctx.repoRoot}; none found.`,
          remediation: "Run the package manager to produce a lockfile, then re-run.",
        },
      ],
      degraded: "no lockfile to scan",
      ...(version !== undefined ? { toolVersion: version } : {}),
    }
  }
  const out = await run(["osv-scanner", "scan", "--format", "json", ...lockArgs], ctx.repoRoot)
  // osv-scanner exits 1 when it finds vulns and 128 when the lockfile lists no packages; that is data.
  // Any other non-zero exit is the scanner failing, which must not read as a clean scan.
  const findings: RawFinding[] = drift !== undefined ? [drift] : []
  if (out.code === 128) return { probe, findings, ...(version !== undefined ? { toolVersion: version } : {}) }
  if (out.code !== 0 && out.code !== 1) throw scannerFailed("osv-scanner", out)
  let parsed: unknown
  try {
    parsed = JSON.parse(out.stdout)
  } catch {
    // No JSON on an empty/clean scan is normal on some versions; a scan that reported findings
    // (exit 1) without readable JSON lost them.
    if (out.code === 0 && out.stdout.trim() === "")
      return { probe, findings, ...(version !== undefined ? { toolVersion: version } : {}) }
    throw new Error(`osv-scanner exited ${out.code} without a readable JSON report`)
  }
  const reported = (parsed as { results?: unknown }).results
  if (reported !== undefined && !Array.isArray(reported))
    throw new Error("osv-scanner report has no results array")
  const results = reported ?? []
  for (const result of results as Array<{ packages?: unknown[]; source?: { path?: string } }>) {
    const source = result.source?.path
    for (const pkg of (result.packages ?? []) as Array<{
      package?: { name?: string; version?: string }
      vulnerabilities?: Array<{
        id?: string
        summary?: string
        database_specific?: { severity?: string }
        references?: Array<{ url?: string }>
      }>
    }>) {
      const name = pkg.package?.name ?? "unknown"
      const at = pkg.package?.version ?? "?"
      for (const vuln of pkg.vulnerabilities ?? []) {
        const raw = (vuln.database_specific?.severity ?? "").toUpperCase()
        findings.push({
          probe,
          severity: OSV_SEVERITY[raw] ?? "medium",
          ruleId: vuln.id ?? "OSV-unknown",
          title: `${name}@${at}: ${vuln.summary ?? vuln.id ?? "advisory"}`.slice(0, 200),
          ...(source !== undefined ? { file: source } : {}),
          detail: `Dependency ${name}@${at} is affected by ${vuln.id ?? "an advisory"}.`,
          remediation: `Upgrade ${name} past the affected range, or remove the dependency.`,
          ...(vuln.references?.[0]?.url !== undefined ? { reference: vuln.references[0].url } : {}),
        })
      }
    }
  }
  return { probe, findings, ...(version !== undefined ? { toolVersion: version } : {}) }
}

// --- gitleaks: committed secrets. Never echoes the matched secret value. ---

export async function secretsProbe(ctx: ProbeContext): Promise<ProbeResult> {
  const probe: ProbeId = "secrets"
  if (!(await which("gitleaks"))) {
    return { probe, findings: [{ ...unavailable("gitleaks"), probe }], degraded: "gitleaks not installed" }
  }
  const version = (await run(["gitleaks", "version"], ctx.repoRoot)).stdout.match(/\d+\.\d+\.\d+/)?.[0]
  const drift = version !== undefined ? versionDrift("gitleaks", version) : undefined
  if (drift !== undefined && ctx.strictTools) {
    throw new Error(`gitleaks version drift under --strict-tools: ${version}`)
  }
  // The tool's own report goes to a private directory that is removed before the probe returns, and
  // `--redact` keeps secret values out of it even while it exists.
  const scratch = await mkdtemp(join(tmpdir(), "security-checkup-gitleaks-"))
  const reportPath = join(scratch, "report.json")
  let out: Spawned
  let parsed: unknown
  try {
    out = await run(
      [
        "gitleaks",
        "detect",
        "--no-banner",
        "--redact",
        "--report-format",
        "json",
        "--report-path",
        reportPath,
      ],
      ctx.repoRoot,
    )
    // gitleaks exits 1 when it finds leaks; any other non-zero exit is the tool failing.
    if (out.code > 1) throw scannerFailed("gitleaks", out)
    try {
      parsed = JSON.parse(await Bun.file(reportPath).text())
    } catch {
      throw new Error(`gitleaks exited ${out.code} without a readable JSON report`)
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  const findings: RawFinding[] = drift !== undefined ? [{ ...drift, probe }] : []
  if (!Array.isArray(parsed)) throw new Error("gitleaks report is not an array")
  for (const leak of parsed as Array<{
    RuleID?: string
    Description?: string
    File?: string
    StartLine?: number
  }>) {
    findings.push({
      probe,
      severity: "critical",
      ruleId: `gitleaks.${leak.RuleID ?? "secret"}`,
      title: `Possible committed secret: ${leak.RuleID ?? "secret"}`,
      ...(leak.File !== undefined ? { file: leak.File } : {}),
      ...(leak.StartLine !== undefined ? { startLine: leak.StartLine } : {}),
      detail: `${(leak.Description ?? "A secret-like value was found").replace(/\.$/, "")}. Rotate it if live; the value is redacted and never written here.`,
      remediation: `Remove the secret, rotate the credential, and purge it from history if it was pushed.`,
    })
  }
  return { probe, findings, ...(version !== undefined ? { toolVersion: version } : {}) }
}

// --- semgrep: taint / unsafe-API patterns from rules/semgrep.yml ---

const SEMGREP_SEVERITY: Readonly<Record<string, Severity>> = {
  ERROR: "high",
  WARNING: "medium",
  INFO: "low",
}

export async function patternsProbe(ctx: ProbeContext): Promise<ProbeResult> {
  const probe: ProbeId = "patterns"
  if (ctx.fast) return { probe, findings: [] }
  if (!(await which("semgrep"))) {
    return { probe, findings: [{ ...unavailable("semgrep"), probe }], degraded: "semgrep not installed" }
  }
  const version = (await run(["semgrep", "--version"], ctx.repoRoot)).stdout.match(/\d+\.\d+\.\d+/)?.[0]
  const drift = version !== undefined ? versionDrift("semgrep", version) : undefined
  if (drift !== undefined && ctx.strictTools) {
    throw new Error(`semgrep version drift under --strict-tools: ${version}`)
  }
  const out = await run(
    ["semgrep", "--config", ctx.semgrepRules, "--json", "--quiet", ctx.repoRoot],
    ctx.repoRoot,
  )
  const findings: RawFinding[] = drift !== undefined ? [{ ...drift, probe }] : []
  // semgrep exits 1 for findings under --error and 2 or more when the scan itself failed.
  if (out.code !== 0 && out.code !== 1) throw scannerFailed("semgrep", out)
  let parsed: unknown
  try {
    parsed = JSON.parse(out.stdout)
  } catch {
    throw new Error(`semgrep exited ${out.code} without a readable JSON report`)
  }
  for (const hit of (parsed as { results?: unknown[] }).results ?? []) {
    const r = hit as {
      check_id?: string
      path?: string
      start?: { line?: number }
      end?: { line?: number }
      extra?: { message?: string; severity?: string; metadata?: { references?: string[] } }
    }
    findings.push({
      probe,
      severity: SEMGREP_SEVERITY[(r.extra?.severity ?? "").toUpperCase()] ?? "medium",
      ruleId: r.check_id ?? "semgrep.rule",
      title: (r.extra?.message ?? r.check_id ?? "pattern match").slice(0, 200),
      ...(r.path !== undefined ? { file: r.path } : {}),
      ...(r.start?.line !== undefined ? { startLine: r.start.line } : {}),
      ...(r.end?.line !== undefined ? { endLine: r.end.line } : {}),
      detail: r.extra?.message ?? "A configured taint/unsafe-API rule matched here.",
      remediation: "Review the flagged line against the rule intent and refactor or justify it.",
      ...(r.extra?.metadata?.references?.[0] !== undefined
        ? { reference: r.extra.metadata.references[0] }
        : {}),
    })
  }
  return { probe, findings, ...(version !== undefined ? { toolVersion: version } : {}) }
}

// --- verify: the project's own gate (includes the Sketch 3 assurance check via nifra check) ---

export async function verifyProbe(ctx: ProbeContext): Promise<ProbeResult> {
  const probe: ProbeId = "verify"
  if (ctx.fast) return { probe, findings: [] }
  // Only run if the repo actually defines it; absence is info, not a failure.
  const pkg = await Bun.file(`${ctx.repoRoot}/package.json`)
    .json()
    .catch(() => ({}) as { scripts?: Record<string, string> })
  if (pkg.scripts?.verify === undefined) {
    return {
      probe,
      findings: [
        {
          probe,
          severity: "info",
          ruleId: "verify.absent",
          title: "No `verify` script in package.json - project gate not run",
          detail: "This repo defines no `bun run verify`, so the project's own gate was skipped.",
          remediation: "Add a `verify` script, or ignore this if the project has no gate.",
        },
      ],
    }
  }
  const out = await run(["bun", "run", "verify"], ctx.repoRoot)
  if (out.code === 0) return { probe, findings: [] }
  const tail = (out.stdout + out.stderr).trim().split("\n").slice(-20).join("\n")
  return {
    probe,
    findings: [
      {
        probe,
        severity: "high",
        ruleId: "verify.failed",
        title: `Project verify gate failed (exit ${out.code})`,
        detail: `\`bun run verify\` exited ${out.code}. Tail:\n${tail}`.slice(0, 400),
        remediation: "Run `bun run verify` locally and fix the first failing gate.",
      },
    ],
  }
}

// --- outdated: stale deps, advisory only ---

export async function outdatedProbe(ctx: ProbeContext): Promise<ProbeResult> {
  const probe: ProbeId = "outdated"
  if (ctx.fast) return { probe, findings: [] }
  const out = await run(["bun", "outdated"], ctx.repoRoot)
  // `bun outdated` is a human table; we surface a single advisory info if it reports anything.
  const rows = out.stdout.split("\n").filter((line) => /\|/.test(line)).length
  if (rows <= 2) return { probe, findings: [] } // header rows only
  return {
    probe,
    findings: [
      {
        probe,
        severity: "info",
        ruleId: "deps.outdated",
        title: `${rows - 2} dependencies are behind their latest published version`,
        detail: "Advisory hygiene signal from `bun outdated`. Not a vulnerability on its own.",
        remediation: "Review `bun outdated` and bump where safe.",
      },
    ],
  }
}

export const ALL_PROBES = [
  depsProbe,
  secretsProbe,
  patternsProbe,
  verifyProbe,
  outdatedProbe,
] as const

#!/usr/bin/env bun
/**
 * Orchestrator + exit contract for the security-checkup skill.
 *
 * Flags:
 *   (default)         scan all probes; exit 1 if any un-suppressed finding >= --severity (default high)
 *   --fast            deps + secrets only (pre-commit); same gate
 *   --report-only     scan, write artifacts, ALWAYS exit 0 (dashboards, never blocks)
 *   --strict-tools    a pinned-tool version mismatch is fatal (exit 2)
 *   --severity <sev>  override the gate threshold (critical|high|medium|low|info)
 *   --out <dir>       artifact directory (default ./.security)
 *
 * Exit: 0 clean / report-only; 1 findings at-or-above threshold; 2 operational failure.
 */
import { isAbsolute, join, resolve } from "node:path"
import { ALL_PROBES, type ProbeContext } from "./probes.ts"
import {
  type Baseline,
  assembleReport,
  gateFails,
  renderJson,
  renderMarkdown,
} from "./report.ts"
import { type ProbeId, type RawFinding, type Severity, SEVERITIES } from "./schema.ts"

interface Args {
  readonly fast: boolean
  readonly reportOnly: boolean
  readonly strictTools: boolean
  readonly severity: Severity
  readonly out: string
}

function parseArgs(argv: readonly string[], repoRoot: string): Args {
  let severity: Severity = "high"
  let out = join(repoRoot, ".security")
  const sevIndex = argv.indexOf("--severity")
  if (sevIndex !== -1) {
    const value = argv[sevIndex + 1]
    if (value === undefined || !(SEVERITIES as readonly string[]).includes(value)) {
      throw new Error(`--severity must be one of ${SEVERITIES.join(", ")}`)
    }
    severity = value as Severity
  }
  const outIndex = argv.indexOf("--out")
  if (outIndex !== -1 && argv[outIndex + 1] !== undefined) {
    const raw = argv[outIndex + 1] as string
    out = isAbsolute(raw) ? raw : resolve(repoRoot, raw)
  }
  return {
    fast: argv.includes("--fast"),
    reportOnly: argv.includes("--report-only"),
    strictTools: argv.includes("--strict-tools"),
    severity,
    out,
  }
}

async function capture(cmd: readonly string[], cwd: string): Promise<string> {
  const child = Bun.spawn(cmd as string[], { cwd, stdout: "pipe", stderr: "ignore" })
  const [, text] = await Promise.all([child.exited, new Response(child.stdout).text()])
  return text.trim()
}

async function loadBaseline(repoRoot: string): Promise<Baseline> {
  const path = join(repoRoot, ".claude/skills/security-checkup/config/baseline.json")
  try {
    const parsed: unknown = await Bun.file(path).json()
    return (parsed !== null && typeof parsed === "object" ? parsed : {}) as Baseline
  } catch {
    return {}
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`
  await Bun.write(tmp, content)
  // rename is atomic within a filesystem; avoids a half-written artifact a CI job might read.
  const { renameSync } = await import("node:fs")
  renameSync(tmp, path)
}

async function main(): Promise<number> {
  const argvAll = Bun.argv.slice(2)
  const repoRoot = await capture(["git", "rev-parse", "--show-toplevel"], process.cwd()).then(
    (root) => root || process.cwd(),
  )
  const args = parseArgs(argvAll, repoRoot)

  const skillDir = join(repoRoot, ".claude/skills/security-checkup")
  const ctx: ProbeContext = {
    repoRoot,
    fast: args.fast,
    strictTools: args.strictTools,
    semgrepRules: join(skillDir, "rules/semgrep.yml"),
  }

  // Ensure the out dir exists (gitleaks also writes a scratch report there).
  const { mkdirSync } = await import("node:fs")
  mkdirSync(args.out, { recursive: true })

  const raw: Array<{ probe: ProbeId; findings: readonly RawFinding[] }> = []
  const toolVersions: Record<string, string> = {}
  const degraded: string[] = []
  let operationalFailure = false

  for (const probe of ALL_PROBES) {
    try {
      const result = await probe(ctx)
      raw.push({ probe: result.probe, findings: result.findings })
      if (result.toolVersion !== undefined) {
        toolVersions[result.probe] = result.toolVersion
      }
      if (result.degraded !== undefined) degraded.push(`${result.probe}: ${result.degraded}`)
    } catch (error) {
      // A thrown probe is operational (e.g. --strict-tools drift, unreadable repo). Record and gate 2.
      operationalFailure = true
      degraded.push(`${probe.name}: ${(error as Error).message}`)
    }
  }

  const head = await capture(["git", "rev-parse", "HEAD"], repoRoot)
  // Timestamps are stamped HERE, at the I/O edge, and passed into the pure report layer.
  const nowISO = new Date().toISOString()
  const todayISO = nowISO.slice(0, 10)

  const report = assembleReport({
    raw,
    baseline: await loadBaseline(repoRoot),
    generatedAtISO: nowISO,
    repoHead: head || "unknown",
    toolVersions,
    todayISO,
  })

  await atomicWrite(join(args.out, "report.json"), renderJson(report))
  await atomicWrite(join(args.out, "report.md"), renderMarkdown(report))

  // Summary to stderr so stdout stays clean for piping.
  const c = report.counts
  process.stderr.write(
    `security-checkup: critical=${c.critical} high=${c.high} medium=${c.medium} low=${c.low} info=${c.info}\n`,
  )
  for (const line of degraded) process.stderr.write(`DEGRADED: ${line}\n`)
  process.stderr.write(`artifacts: ${join(args.out, "report.json")}, report.md\n`)

  if (args.reportOnly) return 0
  if (operationalFailure) return 2
  return gateFails(report, args.severity) ? 1 : 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    process.stderr.write(`security-checkup: fatal ${(error as Error).message}\n`)
    process.exitCode = 2
  })

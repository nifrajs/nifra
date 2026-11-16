import { appendFileSync } from "node:fs"

/**
 * Parser and formatter for `nifra check --json`.
 *
 * Kept dependency-free so the composite action can run it with plain Bun, with no install step.
 * The shapes below mirror the CLI's real, stable output (`packages/cli/src/diagnostics.ts` and
 * `packages/cli/src/check-diagnostics.ts`): findings are `Diagnostic` objects, `ok` is true only
 * when there are no error-severity findings, and a hard CLI failure is `{ ok: false, error }`.
 */
export type Severity = "error" | "warn" | "info"
export type FailOn = "error" | "warning" | "never"

export interface Finding {
  readonly code: string
  readonly severity: Severity
  readonly message: string
  readonly file?: string
  readonly line?: number
  readonly evidence: readonly string[]
  readonly fix?: { readonly recipe: string; readonly command?: string }
  readonly verify?: string
}

export interface Analysis {
  readonly ok: boolean
  readonly exit: number
  readonly findings: readonly Finding[]
  readonly errors: number
  readonly warnings: number
  readonly infos: number
  readonly typecheck?: string
  readonly typecheckNote?: string
  readonly truncated?: { readonly shown: number; readonly total: number }
  readonly unexpectedFailure: boolean
  readonly failed: boolean
  readonly parseError?: string
}

function severityOf(value: unknown): Severity | undefined {
  if (value === "error" || value === "warning" || value === "warn" || value === "info") {
    return value === "warning" ? "warn" : value
  }
  return undefined
}

function firstObject(raw: string): unknown {
  const start = raw.indexOf("{")
  if (start < 0) return undefined
  try {
    return JSON.parse(raw.slice(start))
  } catch {
    return undefined
  }
}

/** Normalize one emitted `Diagnostic` (or a legacy CheckDiagnostic) into a Finding. */
export function normalizeFinding(value: unknown): Finding | undefined {
  if (!value || typeof value !== "object") return undefined
  const item = value as Record<string, unknown>
  if (typeof item.message !== "string") return undefined
  const severity = severityOf(item.severity)
  if (severity === undefined) return undefined

  const fixValue = item.fix
  const fix =
    typeof fixValue === "string"
      ? { recipe: fixValue }
      : fixValue &&
          typeof fixValue === "object" &&
          typeof (fixValue as Record<string, unknown>).recipe === "string"
        ? {
            recipe: (fixValue as Record<string, unknown>).recipe as string,
            ...(typeof (fixValue as Record<string, unknown>).command === "string"
              ? { command: (fixValue as Record<string, unknown>).command as string }
              : {}),
          }
        : undefined

  const code =
    typeof item.code === "string"
      ? item.code
      : typeof item.rule === "string"
        ? item.rule
        : "NIFRA_FINDING"

  return {
    code,
    severity,
    message: item.message,
    ...(typeof item.file === "string" ? { file: item.file } : {}),
    ...(Number.isInteger(item.line) && (item.line as number) >= 1
      ? { line: item.line as number }
      : {}),
    evidence: Array.isArray(item.evidence)
      ? item.evidence.filter((entry): entry is string => typeof entry === "string")
      : [],
    ...(fix ? { fix } : {}),
    ...(typeof item.verify === "string" ? { verify: item.verify } : {}),
  }
}

/** Parse a `nifra check --json` document and decide the step outcome. */
export function analyze(raw: string, exitText: string, failOn: FailOn): Analysis {
  const exit = /^\d+$/.test(exitText.trim()) ? Number(exitText.trim()) : 1
  const parsed = firstObject(raw)

  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as Record<string, unknown>).ok !== "boolean"
  ) {
    return {
      ok: false,
      exit,
      findings: [],
      errors: 0,
      warnings: 0,
      infos: 0,
      unexpectedFailure: true,
      failed: true,
      parseError: "nifra check produced no usable JSON document",
    }
  }

  const payload = parsed as Record<string, unknown>
  // A hard CLI failure is emitted as { ok: false, error } with no `diagnostics` key.
  const source = Array.isArray(payload.diagnostics)
    ? payload.diagnostics
    : typeof payload.error === "string"
      ? [{ code: "NIFRA_CHECK_ERROR", severity: "error", message: payload.error }]
      : []

  const findings = source.flatMap((entry) => {
    const finding = normalizeFinding(entry)
    return finding ? [finding] : []
  })

  const errors = findings.filter((finding) => finding.severity === "error").length
  const warnings = findings.filter((finding) => finding.severity === "warn").length
  const infos = findings.filter((finding) => finding.severity === "info").length

  // Exit 0 = pass, 1 = findings. Anything else means the CLI itself failed.
  const unexpectedFailure = exit !== 0 && exit !== 1
  const ok = payload.ok === true
  const failed =
    unexpectedFailure ||
    (failOn === "never" ? false : failOn === "warning" ? errors + warnings > 0 || !ok : !ok)

  const truncated =
    payload.truncated && typeof payload.truncated === "object"
      ? {
          shown: Number((payload.truncated as Record<string, unknown>).shown) || 0,
          total: Number((payload.truncated as Record<string, unknown>).total) || 0,
        }
      : undefined

  return {
    ok,
    exit,
    findings,
    errors,
    warnings,
    infos,
    ...(typeof payload.typecheck === "string" ? { typecheck: payload.typecheck } : {}),
    ...(typeof payload.typecheckNote === "string" ? { typecheckNote: payload.typecheckNote } : {}),
    ...(truncated ? { truncated } : {}),
    unexpectedFailure,
    failed,
  }
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>")
}

function location(finding: Finding, env: NodeJS.ProcessEnv): string {
  if (!finding.file) return "-"
  const base = `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${env.GITHUB_REPOSITORY ?? ""}`
  const sha = env.NIFRA_SHA ?? env.GITHUB_SHA
  const url = sha
    ? `${base}/blob/${sha}/${finding.file}${finding.line ? `#L${finding.line}` : ""}`
    : finding.file
  return `[\`${finding.file}${finding.line ? `:${finding.line}` : ""}\`](${url})`
}

const BADGE: Record<Severity, string> = { error: "error", warn: "warning", info: "info" }

// GitHub caps comment bodies at 65,536 characters. Keep reports bounded on noisy projects.
const MAX_TABLE_ROWS = 60
const MAX_DETAILS = 20

function headline(analysis: Analysis): string {
  if (analysis.parseError) return "nifra check could not be parsed"
  return analysis.ok ? "nifra check passed" : "nifra check failed"
}

/** Markdown shared by the job summary and the PR comment. */
export function renderMarkdown(analysis: Analysis, env: NodeJS.ProcessEnv = process.env): string {
  const lines: string[] = []
  lines.push(`## ${analysis.ok ? "✅" : "❌"} ${headline(analysis)}`)
  lines.push("")
  lines.push(
    `- errors: **${analysis.errors}** · warnings: **${analysis.warnings}** · info: **${analysis.infos}**`,
  )
  if (analysis.typecheck) lines.push(`- typecheck: \`${analysis.typecheck}\``)
  if (analysis.typecheckNote) lines.push(`- ${analysis.typecheckNote}`)
  if (analysis.parseError) lines.push(`- **parse error:** ${analysis.parseError}`)
  if (analysis.truncated) {
    lines.push(`- showing ${analysis.truncated.shown} of ${analysis.truncated.total} findings`)
  }
  lines.push("")

  if (analysis.findings.length === 0) {
    lines.push("No findings.")
  } else {
    lines.push("| code | severity | location | message | fix |")
    lines.push("| --- | --- | --- | --- | --- |")
    for (const finding of analysis.findings.slice(0, MAX_TABLE_ROWS)) {
      const fix = finding.fix?.recipe ?? finding.verify ?? "-"
      lines.push(
        `| \`${cell(finding.code)}\` | ${BADGE[finding.severity]} | ${location(finding, env)} | ${cell(finding.message)} | ${cell(fix)} |`,
      )
    }
    if (analysis.findings.length > MAX_TABLE_ROWS) {
      lines.push("")
      lines.push(`_Showing the first ${MAX_TABLE_ROWS} of ${analysis.findings.length} findings._`)
    }
  }
  lines.push("")
  return lines.join("\n")
}

/** Full PR comment: shared report plus per-finding detail. */
export function renderComment(
  analysis: Analysis,
  marker: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const lines = [marker, renderMarkdown(analysis, env)]
  const detailed = analysis.findings
    .filter((finding) => finding.evidence.length > 0 || finding.fix || finding.verify)
    .slice(0, MAX_DETAILS)
  if (detailed.length > 0) {
    lines.push("<details><summary>Finding details</summary>", "")
    for (const finding of detailed) {
      lines.push(`### \`${finding.code}\` - ${finding.message}`)
      lines.push("")
      if (finding.file)
        lines.push(`location: \`${finding.file}${finding.line ? `:${finding.line}` : ""}\``)
      for (const entry of finding.evidence) lines.push(`- evidence: \`${entry}\``)
      if (finding.fix) {
        lines.push(`- fix: ${finding.fix.recipe}`)
        if (finding.fix.command) lines.push(`- command: \`${finding.fix.command}\``)
      }
      if (finding.verify) lines.push(`- verify: \`${finding.verify}\``)
      lines.push("")
    }
    lines.push("</details>", "")
  }
  return lines.join("\n")
}

function escapeProperty(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")
}

function escapeMessage(value: string): string {
  return escapeProperty(value).replace(/::/g, "%3A%3A")
}

/** GitHub workflow commands, one per line, safe to cat to stdout. */
export function renderAnnotations(analysis: Analysis): string {
  return analysis.findings
    .filter(
      (finding) =>
        finding.file &&
        !finding.file.includes("..") &&
        !finding.file.startsWith("/") &&
        !/^[A-Za-z]:/.test(finding.file),
    )
    .map((finding) => {
      const level = finding.severity === "warn" ? "warning" : finding.severity
      const props = [`file=${escapeProperty(finding.file!)}`]
      if (finding.line) props.push(`line=${finding.line}`)
      props.push(`title=${escapeProperty(finding.code)}`)
      const body = [finding.message, finding.fix?.recipe, finding.verify].filter(Boolean).join(" ")
      return `::${level} ${props.join(",")}::${escapeMessage(body)}`
    })
    .join("\n")
}

function writeOutput(name: string, value: string): void {
  const output = process.env.GITHUB_OUTPUT
  if (!output) return
  // Outputs must be single-line; JSON.stringify and the counters above are.
  appendFileSync(output, `${name}=${value.replace(/\r?\n/g, " ")}\n`, "utf8")
}

async function main(): Promise<void> {
  const jsonPath = process.env.NIFRA_JSON_PATH
  const errPath = process.env.NIFRA_ERR_PATH
  if (!jsonPath) throw new Error("NIFRA_JSON_PATH is required")

  const raw = await Bun.file(jsonPath).text()
  const failOn = (process.env.NIFRA_FAIL_ON ?? "error") as FailOn
  const analysis = analyze(raw, process.env.NIFRA_EXIT ?? "1", failOn)

  if (analysis.parseError && errPath && (await Bun.file(errPath).exists())) {
    const stderr = await Bun.file(errPath).text()
    if (stderr.trim()) console.error(`nifra check stderr:\n${stderr}`)
  }

  const summaryPath = process.env.NIFRA_SUMMARY_PATH
  const commentPath = process.env.NIFRA_COMMENT_PATH
  const annotationsPath = process.env.NIFRA_ANNOTATIONS_PATH
  if (summaryPath) await Bun.write(summaryPath, renderMarkdown(analysis))
  if (commentPath) {
    await Bun.write(
      commentPath,
      renderComment(analysis, process.env.NIFRA_MARKER ?? "<!-- nifra-check:v1 -->"),
    )
  }
  if (annotationsPath) await Bun.write(annotationsPath, renderAnnotations(analysis))

  writeOutput("ok", String(analysis.ok))
  writeOutput("errors", String(analysis.errors))
  writeOutput("warnings", String(analysis.warnings))
  writeOutput("infos", String(analysis.infos))
  writeOutput("failed", String(analysis.failed))
  writeOutput("findings", JSON.stringify(analysis.findings))
}

if (import.meta.main) {
  await main()
}

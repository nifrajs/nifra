import { appendFileSync } from "node:fs"
import { isAbsolute, posix, relative, resolve, sep } from "node:path"

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
  /** Repository-relative once `analyze` has placed it; relative to the working directory before. */
  readonly file?: string | undefined
  readonly line?: number | undefined
  readonly evidence: readonly string[]
  readonly fix?: { readonly recipe: string; readonly command?: string | undefined } | undefined
  readonly verify?: string | undefined
}

export interface Analysis {
  readonly ok: boolean
  readonly exit: number
  readonly findings: readonly Finding[]
  readonly errors: number
  readonly warnings: number
  readonly infos: number
  readonly typecheck?: string | undefined
  readonly typecheckNote?: string | undefined
  readonly truncated?: { readonly shown: number; readonly total: number } | undefined
  readonly unexpectedFailure: boolean
  readonly failed: boolean
  readonly parseError?: string | undefined
}

// biome-ignore lint/plugin/noHelperCopy: the composite action runs with plain Bun and no install step, so it cannot import the workspace helper
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function severityOf(value: unknown): Severity | undefined {
  if (value === "error" || value === "warning" || value === "warn" || value === "info") {
    return value === "warning" ? "warn" : value
  }
  return undefined
}

export function isFailOn(value: string): value is FailOn {
  return value === "error" || value === "warning" || value === "never"
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

function fixOf(value: unknown): Finding["fix"] {
  if (typeof value === "string") return { recipe: value }
  if (!isRecord(value) || typeof value.recipe !== "string") return undefined
  return {
    recipe: value.recipe,
    command: typeof value.command === "string" ? value.command : undefined,
  }
}

/** Normalize one emitted `Diagnostic` (or a legacy CheckDiagnostic) into a Finding. */
export function normalizeFinding(value: unknown): Finding | undefined {
  if (!isRecord(value) || typeof value.message !== "string") return undefined
  const severity = severityOf(value.severity)
  if (severity === undefined) return undefined

  const code =
    typeof value.code === "string"
      ? value.code
      : typeof value.rule === "string"
        ? value.rule
        : "NIFRA_FINDING"
  const line =
    typeof value.line === "number" && Number.isInteger(value.line) && value.line >= 1
      ? value.line
      : undefined

  return {
    code,
    severity,
    message: value.message,
    file: typeof value.file === "string" ? value.file : undefined,
    line,
    evidence: Array.isArray(value.evidence)
      ? value.evidence.filter((entry): entry is string => typeof entry === "string")
      : [],
    fix: fixOf(value.fix),
    verify: typeof value.verify === "string" ? value.verify : undefined,
  }
}

/**
 * The directory `nifra check` ran in, as a path from the repository root: `""` for the root itself,
 * `null` when it lies outside the workspace (its paths mean nothing to GitHub). Absolute inputs work.
 */
export function repoPrefix(directory: string | undefined, workspace: string): string | null {
  const path = relative(resolve(workspace), resolve(workspace, directory || "."))
  if (path === "") return ""
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) return null
  return path.split(sep).join("/")
}

/** Paths in a finding are relative to where the CLI ran; reports need them from the repository root. */
function place(finding: Finding, prefix: string | null): Finding {
  if (finding.file === undefined) return finding
  if (prefix === null) return { ...finding, file: undefined, line: undefined }
  if (prefix === "") return finding
  return { ...finding, file: posix.join(prefix, finding.file.replaceAll("\\", "/")) }
}

/**
 * Parse a `nifra check --json` document and decide the step outcome. `prefix` places each finding's
 * file under the repository root (see {@link repoPrefix}).
 */
export function analyze(
  raw: string,
  exitText: string,
  failOn: FailOn,
  prefix: string | null = "",
): Analysis {
  const exit = /^\d+$/.test(exitText.trim()) ? Number(exitText.trim()) : 1
  const payload = firstObject(raw)

  if (!isRecord(payload) || typeof payload.ok !== "boolean") {
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

  // A hard CLI failure is emitted as { ok: false, error } with no `diagnostics` key.
  const hardFailure = !Array.isArray(payload.diagnostics) && typeof payload.error === "string"
  const source = Array.isArray(payload.diagnostics)
    ? payload.diagnostics
    : typeof payload.error === "string"
      ? [{ code: "NIFRA_CHECK_ERROR", severity: "error", message: payload.error }]
      : []

  const findings = source.flatMap((entry) => {
    const finding = normalizeFinding(entry)
    return finding ? [place(finding, prefix)] : []
  })

  const errors = findings.filter((finding) => finding.severity === "error").length
  const warnings = findings.filter((finding) => finding.severity === "warn").length
  const infos = findings.filter((finding) => finding.severity === "info").length

  // Exit 0 = pass, 1 = findings. Anything else, or an error document, means the CLI itself failed;
  // that never passes, whatever `fail-on` says.
  const unexpectedFailure = (exit !== 0 && exit !== 1) || hardFailure
  const ok = payload.ok === true
  const failed =
    unexpectedFailure ||
    (failOn === "never" ? false : failOn === "warning" ? errors + warnings > 0 || !ok : !ok)

  const truncated = isRecord(payload.truncated)
    ? { shown: Number(payload.truncated.shown) || 0, total: Number(payload.truncated.total) || 0 }
    : undefined

  return {
    ok,
    exit,
    findings,
    errors,
    warnings,
    infos,
    typecheck: typeof payload.typecheck === "string" ? payload.typecheck : undefined,
    typecheckNote: typeof payload.typecheckNote === "string" ? payload.typecheckNote : undefined,
    truncated,
    unexpectedFailure,
    failed,
  }
}

/** Cut `value` to `max` characters, marking the cut. */
function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/**
 * Finding text comes from the checked project, so it is untrusted in a bot-authored comment: escape
 * markup, defuse `@mentions`, and keep it on one line so it cannot open a heading or close `<details>`.
 */
function prose(value: string, max: number, newline = " "): string {
  return clip(value, max)
    .replace(/[\\`*_[\]<>|]/g, "\\$&")
    .replace(/@/g, "@​")
    .replace(/\r?\n|\r/g, newline)
}

/** Text for a code span: a backtick would end it, a pipe would end a table cell. */
function code(value: string, max: number, table = false): string {
  const flat = clip(value, max)
    .replace(/\r?\n|\r/g, " ")
    .replaceAll("`", "'")
  return table ? flat.replaceAll("|", "\\|") : flat
}

function cell(value: string): string {
  return prose(value, 400, "<br>")
}

function fileUrl(file: string): string {
  // encodeURIComponent leaves ( and ), which end a markdown link destination.
  const encode = (segment: string) =>
    encodeURIComponent(segment).replace(
      /[!'()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    )
  return file.split("/").map(encode).join("/")
}

function location(finding: Finding, env: NodeJS.ProcessEnv): string {
  if (!finding.file) return "-"
  const base = `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${env.GITHUB_REPOSITORY ?? ""}`
  const sha = env.NIFRA_SHA ?? env.GITHUB_SHA
  const label = `\`${code(`${finding.file}${finding.line ? `:${finding.line}` : ""}`, 300, true)}\``
  if (!sha) return label
  return `[${label}](${base}/blob/${sha}/${fileUrl(finding.file)}${finding.line ? `#L${finding.line}` : ""})`
}

const BADGE: Record<Severity, string> = { error: "error", warn: "warning", info: "info" }

// GitHub rejects a comment body over 65,536 characters. The table and the details each get a share,
// measured as they are built, so one huge finding cannot push the comment past the limit.
const MAX_TABLE_ROWS = 60
const MAX_DETAILS = 20
const TABLE_BUDGET = 28_000
const COMMENT_BUDGET = 60_000
const MAX_EVIDENCE = 10

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
  if (analysis.typecheck) lines.push(`- typecheck: \`${code(analysis.typecheck, 100)}\``)
  if (analysis.typecheckNote) lines.push(`- ${prose(analysis.typecheckNote, 400)}`)
  if (analysis.parseError) lines.push(`- **parse error:** ${prose(analysis.parseError, 400)}`)
  if (analysis.truncated) {
    lines.push(`- showing ${analysis.truncated.shown} of ${analysis.truncated.total} findings`)
  }
  lines.push("")

  if (analysis.findings.length === 0) {
    lines.push("No findings.")
  } else {
    lines.push("| code | severity | location | message | fix |")
    lines.push("| --- | --- | --- | --- | --- |")
    let used = 0
    let shown = 0
    for (const finding of analysis.findings.slice(0, MAX_TABLE_ROWS)) {
      const fix = finding.fix?.recipe ?? finding.verify ?? "-"
      const row = `| \`${code(finding.code, 100, true)}\` | ${BADGE[finding.severity]} | ${location(finding, env)} | ${cell(finding.message)} | ${cell(fix)} |`
      if (used + row.length > TABLE_BUDGET) break
      used += row.length
      shown += 1
      lines.push(row)
    }
    if (shown < analysis.findings.length) {
      lines.push("")
      lines.push(`_Showing the first ${shown} of ${analysis.findings.length} findings._`)
    }
  }
  lines.push("")
  return lines.join("\n")
}

/** Full PR comment: shared report plus per-finding detail, kept under GitHub's size limit. */
export function renderComment(
  analysis: Analysis,
  marker: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const report = renderMarkdown(analysis, env)
  const candidates = analysis.findings
    .filter((finding) => finding.evidence.length > 0 || finding.fix || finding.verify)
    .slice(0, MAX_DETAILS)
  const sections: string[] = []
  let used = marker.length + report.length + 200
  for (const finding of candidates) {
    const lines = [`### \`${code(finding.code, 100)}\` - ${prose(finding.message, 600)}`, ""]
    if (finding.file) {
      lines.push(
        `location: \`${code(`${finding.file}${finding.line ? `:${finding.line}` : ""}`, 300)}\``,
      )
    }
    for (const entry of finding.evidence.slice(0, MAX_EVIDENCE)) {
      lines.push(`- evidence: \`${code(entry, 300)}\``)
    }
    if (finding.evidence.length > MAX_EVIDENCE) {
      lines.push(`- ${finding.evidence.length - MAX_EVIDENCE} more evidence entries omitted`)
    }
    if (finding.fix) {
      lines.push(`- fix: ${prose(finding.fix.recipe, 600)}`)
      if (finding.fix.command) {
        lines.push(`- command: \`${code(finding.fix.command, 300)}\``)
      }
    }
    if (finding.verify) lines.push(`- verify: \`${code(finding.verify, 300)}\``)
    lines.push("")
    const section = lines.join("\n")
    if (used + section.length > COMMENT_BUDGET) break
    used += section.length
    sections.push(section)
  }
  const out = [marker, report]
  if (sections.length > 0) {
    out.push("<details><summary>Finding details</summary>", "", ...sections, "</details>", "")
  }
  if (sections.length < candidates.length) {
    out.push(
      `_${candidates.length - sections.length} finding details omitted to stay under GitHub's comment size limit; see the job summary or annotations._`,
      "",
    )
  }
  return out.join("\n")
}

function escapeData(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")
}

function escapeProperty(value: string): string {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C")
}

/**
 * Print untrusted text without letting a line that starts with `::` run as a workflow command: the
 * runner ignores commands between a `stop-commands` line and its matching token.
 */
export function quarantine(text: string): string {
  const token = crypto.randomUUID()
  return `::stop-commands::${token}\n${text}\n::${token}::`
}

/** GitHub workflow commands, one per line, safe to cat to stdout. */
export function renderAnnotations(analysis: Analysis): string {
  return analysis.findings
    .filter(
      (finding) =>
        finding.file &&
        !finding.file.split("/").includes("..") &&
        !finding.file.startsWith("/") &&
        !/^[A-Za-z]:/.test(finding.file),
    )
    .map((finding) => {
      const level = finding.severity === "warn" ? "warning" : finding.severity
      const props = [`file=${escapeProperty(finding.file ?? "")}`]
      if (finding.line) props.push(`line=${finding.line}`)
      props.push(`title=${escapeProperty(finding.code)}`)
      const body = [finding.message, finding.fix?.recipe, finding.verify].filter(Boolean).join(" ")
      return `::${level} ${props.join(",")}::${escapeData(clip(body, 4000))}`
    })
    .join("\n")
}

function writeOutput(name: string, value: string): void {
  const output = process.env.GITHUB_OUTPUT
  if (!output) return
  // Outputs must be single-line; JSON.stringify and the counters above are.
  appendFileSync(output, `${name}=${value.replace(/\r?\n/g, " ")}\n`, "utf8")
}

const MAX_OUTPUT_FINDINGS = 100
const MAX_OUTPUT_BYTES = 500_000

/**
 * The `findings` step output: a bounded, compact copy. Outputs are size-limited by GitHub, and the
 * full evidence lists are already in the summary and comment.
 */
export function outputFindings(findings: readonly Finding[]): string {
  let kept = findings.slice(0, MAX_OUTPUT_FINDINGS).map((finding) => ({
    ...finding,
    message: clip(finding.message, 1000),
    evidence: finding.evidence.slice(0, 3).map((entry) => clip(entry, 300)),
  }))
  let json = JSON.stringify(kept)
  while (json.length > MAX_OUTPUT_BYTES && kept.length > 0) {
    kept = kept.slice(0, Math.floor(kept.length / 2))
    json = JSON.stringify(kept)
  }
  return json
}

async function main(): Promise<void> {
  const jsonPath = process.env.NIFRA_JSON_PATH
  const errPath = process.env.NIFRA_ERR_PATH
  if (!jsonPath) throw new Error("NIFRA_JSON_PATH is required")
  const failOnInput = process.env.NIFRA_FAIL_ON?.trim() || "error"
  if (!isFailOn(failOnInput)) {
    console.log(
      `::error::${escapeData(`invalid fail-on "${clip(failOnInput, 40)}": use error, warning, or never`)}`,
    )
    process.exit(1)
  }
  const marker = process.env.NIFRA_MARKER?.trim() || "<!-- nifra-check:v1 -->"

  const raw = await Bun.file(jsonPath).text()
  const prefix = repoPrefix(
    process.env.NIFRA_WORKING_DIRECTORY,
    process.env.GITHUB_WORKSPACE ?? process.cwd(),
  )
  const analysis = analyze(raw, process.env.NIFRA_EXIT ?? "1", failOnInput, prefix)

  if (analysis.parseError && errPath && (await Bun.file(errPath).exists())) {
    const stderr = await Bun.file(errPath).text()
    if (stderr.trim()) console.error(`nifra check stderr:\n${quarantine(stderr)}`)
  }

  const summaryPath = process.env.NIFRA_SUMMARY_PATH
  const commentPath = process.env.NIFRA_COMMENT_PATH
  const annotationsPath = process.env.NIFRA_ANNOTATIONS_PATH
  if (summaryPath) await Bun.write(summaryPath, renderMarkdown(analysis))
  if (commentPath) await Bun.write(commentPath, renderComment(analysis, marker))
  if (annotationsPath) await Bun.write(annotationsPath, renderAnnotations(analysis))

  writeOutput("ok", String(analysis.ok))
  writeOutput("errors", String(analysis.errors))
  writeOutput("warnings", String(analysis.warnings))
  writeOutput("infos", String(analysis.infos))
  writeOutput("failed", String(analysis.failed))
  writeOutput("findings", outputFindings(analysis.findings))
}

if (import.meta.main) {
  await main()
}

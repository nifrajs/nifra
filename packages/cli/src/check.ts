/**
 * `nifra check` - the agent's (and CI's) definition of done. It makes the guarantees that keep a nifra
 * app drift-proof actually *fire*, instead of relying on the agent to remember them:
 *
 *   1. **typecheck** (`tsc --noEmit`) - the frontend↔backend contract is compiler-enforced. The typed
 *      client derives request + response types from the routes, so a shape mismatch is a type error.
 *   2. **typed-client lint** - flags hand-rolled `fetch()` to this app's *own* API (a relative URL),
 *      which bypasses `client<typeof app>` so the compiler can't see the drift.
 *   3. **server-only-import lint** - flags a top-level import of server-only code (a DB driver, `node:`/
 *      `bun:` builtins, the `./db` module) into a `routes/` page module. Those modules are bundled for
 *      the browser too, so the import ships server code to the client and breaks the build - the #1
 *      full-stack footgun. Reach server resources via `c.db` / `ctx.api`, never a top-level import.
 *
 * `collectCheckResult` returns a structured, machine-readable result (consumed by `--json` and the
 * `nifra_check` MCP tool, so an agent acts on diagnostics instead of scraping prose). Exits non-zero if
 * anything fails. Pure scanners (`scanFetchText`, `scanServerOnlyImports`) are unit-tested.
 */

import { existsSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import {
  type CheckAssuranceContext,
  type CheckConfig,
  type CheckDiagnostic,
  type CheckResult,
  collectCheckDiagnostics,
  type RuleOverride,
} from "./check-diagnostics.ts"
import { createSourceFacts } from "./internal/source-facts.ts"
import { importProjectTypeScript, type TypeScriptApi } from "./internal/typescript-import.ts"
// Type-only: `pipeline-report.ts` imports this module's source scanners, so a value import here would
// close a cycle. Doctor is what actually runs the collector (see the `pipeline` rule below).
import type { ProjectFactsSeed } from "./project-facts.ts"
import { RULE_CODES } from "./rules/codes.ts"
import { sourceIndex } from "./rules/index.ts"

export type {
  CheckAnalysisInput,
  CheckAssuranceContext,
  CheckConfig,
  CheckDiagnostic,
  CheckDiagnosticsOptions,
  CheckResult,
  CheckSuggestion,
  CheckTypecheckResult,
  RuleOverride,
} from "./check-diagnostics.ts"

import {
  createProjectSqlImports,
  type ModuleReader,
  type ModuleResolver,
  resolveServerOnlyChains,
  type SourceFinding,
  type StaticRouteFinding,
  scanFetchText,
  scanInterpolatedSql,
  scanRemovedImports,
  scanResponseRoutes,
  scanServerManifestDrift,
  scanStaticRouteText,
  scanUntypedClient,
  type TransitiveServerImportFinding,
  walkSource,
} from "./check-scan.ts"

export * from "./check-scan.ts"

const ROUTE_FILE = /(^|\/)routes\//
interface TypecheckResult {
  readonly ran: boolean
  readonly ok: boolean
  readonly note?: string
  readonly output?: string
  readonly cancelled?: boolean
  /** tsconfig.json exists but no `typescript` install was found walking up from cwd. The contract
   * gate could not run - the caller surfaces this as a FAILING diagnostic, never a silent skip. */
  readonly missingTypeScript?: boolean
}

/**
 * Find the project's `tsc` the way module resolution would: `node_modules/typescript/bin/tsc` in
 * cwd, then each parent directory up to the filesystem root. A workspace package in a monorepo has
 * its TypeScript hoisted to the workspace root, so the literal `join(cwd, "node_modules", …)` probe
 * this replaces reported "typescript not installed" - and silently skipped the gate - whenever
 * `nifra check` ran from the package directory instead of the repo root.
 */
function resolveTscBin(cwd: string): string | undefined {
  let dir = cwd
  while (true) {
    const candidate = join(dir, "node_modules", "typescript", "bin", "tsc")
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Run the project's own `tsc --noEmit`, if TypeScript + a tsconfig are present. Never auto-installs. */
async function typecheck(cwd: string, signal?: AbortSignal): Promise<TypecheckResult> {
  const tsconfig = join(cwd, "tsconfig.json")
  if (!(await Bun.file(tsconfig).exists()))
    return { ran: false, ok: true, note: "no tsconfig.json" }
  const tscBin = resolveTscBin(cwd)
  if (tscBin === undefined) {
    return {
      ran: false,
      ok: false,
      missingTypeScript: true,
      note: "typescript not installed (run: bun add -d typescript)",
    }
  }
  if (signal?.aborted) return { ran: true, ok: false, cancelled: true, output: "cancelled" }
  const proc = Bun.spawn(["bun", tscBin, "--noEmit", "-p", tsconfig], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  let cancelled = false
  const abort = (): void => {
    cancelled = true
    proc.kill()
  }
  signal?.addEventListener("abort", abort, { once: true })
  let out = ""
  let err = ""
  let code: number | null = null
  try {
    const result = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    out = result[0]
    err = result[1]
    code = result[2]
  } finally {
    signal?.removeEventListener("abort", abort)
  }
  return {
    ran: true,
    ok: code === 0 && !cancelled,
    output: cancelled ? "cancelled" : `${out}${err}`.trim(),
    ...(cancelled ? { cancelled: true } : {}),
  }
}

// `src/x.tsx(12,5): error TS2322: <message>` → one structured diagnostic.
const OVERRIDE_SEVERITIES: readonly string[] = ["error", "warn", "info", "off"]

async function loadCheckConfig(
  cwd: string,
): Promise<{ config: CheckConfig; error?: string; warnings: readonly string[] }> {
  const path = join(cwd, "nifra.check.json")
  const empty: CheckConfig = { externalMounts: [], rules: {} }
  if (!existsSync(path)) return { config: empty, warnings: [] }
  try {
    const parsed = JSON.parse(await Bun.file(path).text()) as {
      externalMounts?: unknown
      rules?: unknown
    }
    const raw = Array.isArray(parsed.externalMounts) ? parsed.externalMounts : []
    const externalMounts = raw
      .filter((m): m is string => typeof m === "string" && m.startsWith("/"))
      .map((m) => m.replace(/\/\*+$/, "").replace(/\/+$/, "") || "/")
    const warnings: string[] = []
    const rules: Record<string, RuleOverride> = {}
    if (parsed.rules !== undefined) {
      if (
        typeof parsed.rules !== "object" ||
        parsed.rules === null ||
        Array.isArray(parsed.rules)
      ) {
        warnings.push('`rules` must be an object of { "<rule>": { severity?, ignore? } } - ignored')
      } else {
        for (const [rule, value] of Object.entries(parsed.rules)) {
          if (typeof value !== "object" || value === null || Array.isArray(value)) {
            warnings.push(`rules["${rule}"] must be an object - ignored`)
            continue
          }
          const entry = value as { severity?: unknown; ignore?: unknown }
          const override: {
            severity?: NonNullable<RuleOverride["severity"]>
            ignore?: readonly string[]
          } = {}
          if (entry.severity !== undefined) {
            if (
              typeof entry.severity === "string" &&
              OVERRIDE_SEVERITIES.includes(entry.severity)
            ) {
              override.severity = entry.severity as NonNullable<RuleOverride["severity"]>
            } else {
              warnings.push(
                `rules["${rule}"].severity must be "error" | "warn" | "info" | "off" - ignored`,
              )
            }
          }
          if (entry.ignore !== undefined) {
            if (
              Array.isArray(entry.ignore) &&
              entry.ignore.every((g): g is string => typeof g === "string")
            ) {
              if (entry.ignore.length > 0) override.ignore = entry.ignore
            } else {
              warnings.push(`rules["${rule}"].ignore must be an array of file globs - ignored`)
            }
          }
          if (override.severity !== undefined || override.ignore !== undefined)
            rules[rule] = override
        }
      }
    }
    return { config: { externalMounts, rules }, warnings }
  } catch (error) {
    return {
      config: empty,
      error: error instanceof Error ? error.message : String(error),
      warnings: [],
    }
  }
}

interface CheckCollectionOptions {
  readonly lintsOnly?: boolean
  readonly signal?: AbortSignal
  readonly maxDiagnostics?: number
  readonly loadTypeScript?: () => Promise<TypeScriptApi | undefined>
  readonly assurance?: CheckAssuranceContext
}

interface ProjectScan {
  readonly facts: ProjectFactsSeed
  readonly typecheck: TypecheckResult
  readonly sqlCompiler: TypeScriptApi | undefined
  readonly checkConfigError?: string
  readonly checkConfigWarnings: readonly string[]
}

/** Build the rule input from one source walk and the other check-wide scans. */
async function buildProjectScan(
  cwd: string,
  opts: Pick<CheckCollectionOptions, "lintsOnly" | "signal" | "loadTypeScript">,
): Promise<ProjectScan> {
  const fetches: SourceFinding[] = []
  const staticRoutes: StaticRouteFinding[] = []
  const untypedClients: SourceFinding[] = []
  const removedImports: SourceFinding[] = []
  const serverImports: TransitiveServerImportFinding[] = []
  const responseRoutes: SourceFinding[] = []
  const interpolatedSql: SourceFinding[] = []
  const routeModules: Array<{ rel: string; content: string }> = []
  const sourceFiles: Array<{ file: string; content: string }> = []
  const {
    config: checkConfig,
    error: checkConfigError,
    warnings: checkConfigWarnings,
  } = await loadCheckConfig(cwd)
  const sqlCompiler = await (opts.loadTypeScript ?? (() => importProjectTypeScript(cwd)))()
  const sourceFacts = sqlCompiler === undefined ? undefined : createSourceFacts(sqlCompiler)
  const sqlImports = sqlCompiler === undefined ? undefined : createProjectSqlImports(cwd)

  const [typecheckResult, _, doctor, manifestDrift] = await Promise.all([
    opts.lintsOnly
      ? Promise.resolve<TypecheckResult>({ ran: false, ok: true, note: "lints-only mode" })
      : typecheck(cwd, opts.signal),
    walkSource(cwd, (rel, content) => {
      sourceFiles.push({ file: rel, content })
      fetches.push(...scanFetchText(rel, content, checkConfig.externalMounts))
      staticRoutes.push(...scanStaticRouteText(rel, content, sourceFacts))
      untypedClients.push(...scanUntypedClient(rel, content))
      removedImports.push(...scanRemovedImports(rel, content))
      if (ROUTE_FILE.test(rel)) routeModules.push({ rel, content })
      responseRoutes.push(...scanResponseRoutes(rel, content, sourceFacts))
      if (sqlCompiler !== undefined)
        interpolatedSql.push(...scanInterpolatedSql(rel, content, sqlCompiler, sqlImports))
    }),
    import("./doctor.ts").then((m) => m.collectDoctorResult(cwd)),
    scanServerManifestDrift(cwd),
  ])

  const resolveModule: ModuleResolver = (fromFile, specifier) => {
    try {
      const fromAbs = isAbsolute(fromFile) ? fromFile : join(cwd, fromFile)
      return Bun.resolveSync(specifier, dirname(fromAbs))
    } catch {
      return undefined
    }
  }
  const readModule: ModuleReader = (absPath) => {
    try {
      return readFileSync(absPath, "utf8")
    } catch {
      return undefined
    }
  }
  for (const { rel, content } of routeModules) {
    serverImports.push(
      ...resolveServerOnlyChains(rel, content, resolveModule, readModule, sourceFacts),
    )
  }

  const source = sourceIndex(sourceFiles)
  const facts: ProjectFactsSeed = {
    source,
    routes: staticRoutes,
    importGraph: serverImports,
    packages: { doctor, manifestDrift },
    ...(doctor.pipeline === undefined ? {} : { pipeline: doctor.pipeline }),
    policies: { checkConfig, rulePacks: [] },
    sourceFindings: { fetches, untypedClients, removedImports, responseRoutes, interpolatedSql },
  }
  return {
    facts,
    typecheck: typecheckResult,
    sqlCompiler,
    ...(checkConfigError === undefined ? {} : { checkConfigError }),
    checkConfigWarnings,
  }
}

/** Run the three checks and assemble a structured, machine-readable result. The single source the CLI
 * report, `--json`, and the MCP tool all render from. */
/** Run the scan, freeze its facts, and project them into the public diagnostic result. */
export async function collectCheckResult(
  cwd: string,
  opts: CheckCollectionOptions = {},
): Promise<CheckResult> {
  const scan = await buildProjectScan(cwd, opts)
  return collectCheckDiagnostics(cwd, scan, opts)
}

/** The named rule sections of the human report, in print order. A rule absent from this list is NOT
 * dropped: {@link renderCheckReport} renders every remaining diagnostic in a generic section keyed by
 * its rule code, so a finding that can flip the exit code is never invisible in the default output. */
const REPORT_SECTIONS = [
  ["typecheck", "typecheck"],
  ["typed-client", "hand-rolled fetch() to your own API"],
  ["untyped-client", 'client("…") missing its <typeof app> type argument'],
  ["server-only-import", "server-only import in a route module"],
  ["interpolated-sql", "SQL built by interpolating a value into the statement"],
  ["response-route", "route returns a raw Response (typed client → data: never)"],
  ["undeclared-dependency", "undeclared dependency in package.json"],
  ["duplicate-install", "duplicate identity-sensitive dependency install"],
  ["stale-workspace-dist", "workspace-linked dist older than its source"],
  ["pipeline", "bundler pipeline (Vite/Bun) config"],
  ["server-manifest-drift", "server-manifest.ts drifted from routes/"],
  ["manifest-drift", "versioned trust manifest drift"],
  ["capability-assurance", "effect/capability assurance"],
  ["capability-config", "capability assurance config"],
  ["check-config", "nifra.check.json"],
] as const

/**
 * Render the human-readable check report as lines. Pure (no I/O, no cwd) so tests can assert
 * report/exit-code parity: every diagnostic in `result.diagnostics` appears in the output, and the
 * trailer states the error/advisory counts that produced `ok`.
 */
export function renderCheckReport(result: CheckResult): string[] {
  const lines: string[] = []
  lines.push("nifra check", "")
  lines.push(
    result.typecheck === "pass"
      ? "✓ typecheck passed"
      : result.typecheck === "fail"
        ? "✗ typecheck failed - the frontend/backend contract is broken"
        : `⚠ typecheck SKIPPED - ${result.typecheckNote ?? "no tsconfig / typescript not installed"} (the contract gate did not run)`,
  )
  // Stated on every run, passing or not. "Which bundler is this app on" decides which plugin slot is
  // live and which toolchain compiles a component, so it belongs in the report rather than only in the
  // dev server's banner - where CI never sees it.
  if (result.pipeline !== undefined) {
    lines.push(
      result.pipeline.pipeline === "unknown"
        ? `• bundler: not readable from ${result.pipeline.configFile} - ${result.pipeline.reason}`
        : `• bundler: ${result.pipeline.pipeline} (${result.pipeline.reason})`,
    )
  }
  if (result.externalMounts !== undefined && result.externalMounts.length > 0) {
    lines.push(
      `• intentional external mounts (not typed-client checked): ${result.externalMounts.join(", ")}`,
    )
  }
  if (result.ruleOverrides !== undefined) {
    const active = Object.entries(result.ruleOverrides).map(([rule, override]) => {
      const parts: string[] = []
      if (override.severity !== undefined) parts.push(`severity=${override.severity}`)
      if (override.ignore !== undefined) parts.push(`ignore=${override.ignore.join(",")}`)
      return `${rule} (${parts.join(", ")})`
    })
    lines.push(`• rule overrides from nifra.check.json: ${active.join("; ")}`)
  }
  const renderSection = (rule: string, label: string, ds: readonly CheckDiagnostic[]): void => {
    if (rule !== "typecheck") {
      // Marked by SEVERITY, not by rule name. `response-route` and `stale-workspace-dist` are advisory
      // in whole; `pipeline` is the first rule that is advisory in part (a misplaced plugin fails, a
      // resolve condition the Bun dev bundler can't take does not), so the counts are split rather than
      // rounded up to the worse of the two.
      const errors = ds.filter((d) => d.severity === "error").length
      const advisory = ds.length - errors
      lines.push(
        ds.length === 0
          ? `✓ ${label}: none`
          : errors === 0
            ? `⚠ ${label}: ${advisory} (advisory)`
            : `✗ ${label}: ${errors}${advisory > 0 ? ` (+${advisory} advisory)` : ""}`,
      )
    }
    for (const d of ds) {
      lines.push(`    ${d.file ?? ""}${d.line ? `:${d.line}` : ""}  ${d.message}`)
      if (d.suggestion !== undefined) {
        lines.push(`      fix: ${d.suggestion.title}`)
        if (d.suggestion.command !== undefined) {
          lines.push(`      command: ${d.suggestion.command.join(" ")}`)
        }
        if (d.suggestion.diff !== undefined) {
          for (const line of d.suggestion.diff.split("\n")) lines.push(`      ${line}`)
        }
        for (const step of d.suggestion.steps ?? []) lines.push(`      - ${step}`)
      }
    }
  }
  for (const [rule, label] of REPORT_SECTIONS) {
    renderSection(
      rule,
      label,
      result.diagnostics.filter((d) => d.rule === rule),
    )
  }
  // Generic section: diagnostics whose rule has no named section above (registry rules publishing
  // under their NF- code, application rule packs). These count toward `ok` exactly like the named
  // ones, so they get the same severity-marked rendering - only "✓ …: none" is skipped, because
  // the set of possible unlisted rules is open-ended.
  const named = new Set<string>(REPORT_SECTIONS.map(([rule]) => rule))
  const extraRules: string[] = []
  for (const d of result.diagnostics) {
    if (!named.has(d.rule) && !extraRules.includes(d.rule)) extraRules.push(d.rule)
  }
  for (const rule of extraRules) {
    const title = (RULE_CODES as Record<string, string | undefined>)[rule]
    renderSection(
      rule,
      title !== undefined ? `${title} (${rule})` : rule,
      result.diagnostics.filter((d) => d.rule === rule),
    )
  }
  if (result.truncated !== undefined) {
    lines.push(
      `• showing ${result.truncated.shown} of ${result.truncated.total} diagnostics (truncated)`,
    )
  }
  const errors = result.diagnostics.filter((d) => d.severity === "error").length
  const advisory = result.diagnostics.length - errors
  lines.push(
    "",
    result.ok
      ? advisory > 0
        ? `✓ check passed (${advisory} advisory)`
        : "✓ check passed"
      : `✗ check failed: ${errors} error${errors === 1 ? "" : "s"}${advisory > 0 ? ` (+${advisory} advisory)` : ""}`,
  )
  return lines
}

/** Run the full check; print a report (`--json` for machine output) and return whether it passed. */
export async function runCheck(
  cwd: string,
  opts: {
    readonly json?: boolean
    readonly lintsOnly?: boolean
    readonly structured?: boolean
  } = {},
): Promise<boolean> {
  // The check view over the one project verification: the same collector `assure` and `levels` read.
  const { collectProjectVerification } = await import("./verification.ts")
  const verification = await collectProjectVerification(cwd, { lintsOnly: opts.lintsOnly ?? false })
  const result = await verification.check()
  if (opts.json) {
    console.log(
      JSON.stringify(
        opts.structured === true && result.structuredDiagnostics !== undefined
          ? { ...result, diagnostics: result.structuredDiagnostics }
          : result,
        null,
        2,
      ),
    )
    return result.ok
  }

  console.log(renderCheckReport(result).join("\n"))
  // Discoverability nudge: a project with no `.mcp.json` hasn't wired its nifra MCP for coding agents.
  // `nifra init-agents` writes it (+ .cursor/mcp.json + a CLAUDE.md preamble), no-clobber. A non-fatal
  // one-line tip in the human report only (the `--json` path returns above, unaffected).
  if (!existsSync(join(cwd, ".mcp.json"))) {
    console.log(
      "\ntip: no .mcp.json here - run `nifra init-agents` to wire this project's MCP + agent files (no-clobber).",
    )
  }
  // `public/` used to be served in dev (inherited from Vite) and not in production, so every app
  // hand-rolled static serving in its own server entry - or shipped a file that 404'd only once
  // deployed. `@nifrajs/web` owns it now, so an app carrying the workaround can delete it. A tip
  // rather than a finding: a hand-rolled handler still works (it simply runs first), so this is
  // not a failure, and telling an app it can delete code is the entire point.
  if (existsSync(join(cwd, "public"))) {
    console.log(
      '\ntip: `public/` is now served by @nifrajs/web in dev AND production (publicDir, default "public"). If your server entry hand-rolls static serving, you can delete it.',
    )
  }
  return result.ok
}

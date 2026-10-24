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

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { declaredSide, specifierPackage } from "@nifrajs/web/zones"
import { BACKEND_APP_FILE } from "./app-files.ts"
import {
  type CheckAssuranceContext,
  type CheckConfig,
  type CheckDiagnostic,
  type CheckResult,
  collectCheckDiagnostics,
  type RuleOverride,
  safeIgnoreGlobMatch,
} from "./check-diagnostics.ts"
import { appDirs, clientModuleRoot } from "./client-module.ts"
import { checkContractsLock, DEFAULT_CONTRACTS_LOCK } from "./contracts.ts"
import { type Diagnostic, normalizeSeverity, toSarifLog } from "./diagnostics.ts"
import { installedManifest } from "./internal/installed-package.ts"
import { createApiOnlyProbe, createNifraProjectProbe } from "./internal/nifra-project.ts"
import { createSpecifierResolver } from "./internal/project-specifiers.ts"
import { createSourceFacts } from "./internal/source-facts.ts"
import { loadProjectTypeScript, type TypeScriptApi } from "./internal/typescript-import.ts"
import {
  forwardTerminalSignals,
  OWN_PROCESS_GROUP,
  signalProcessGroup,
  stopGroupAndWait,
} from "./mcp-io.ts"
// Type-only: `pipeline-report.ts` imports this module's source scanners, so a value import here would
// close a cycle. Doctor is what actually runs the collector (see the `pipeline` rule below).
import type { ContractCheckFacts, ProjectFactsSeed } from "./project-facts.ts"
import { RULE_CODES } from "./rules/codes.ts"
import { sourceIndex } from "./rules/index.ts"
import { filesOutsideProgram, splitListedFiles, typecheckProjects } from "./typecheck-coverage.ts"

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
  COMPONENT_FILE,
  componentScripts,
  createProjectSqlImports,
  createServerOnlyChains,
  isBrowserSource,
  type ModuleReader,
  type ModuleResolver,
  type SourceFinding,
  type SqlFinding,
  type StaticRouteFinding,
  scanFetchText,
  scanRemovedImports,
  scanResponseRoutes,
  scanServerManifestDrift,
  scanSqlSites,
  scanStaticRouteText,
  scanStreamText,
  scanUnresolvedRoutePaths,
  scanUntypedClient,
  type TransitiveServerImportFinding,
  type TypedClientFinding,
  type UnresolvedRoutePathFinding,
  walkSource,
} from "./check-scan.ts"
import { componentCheckReceipts } from "./component-check.ts"

export * from "./check-scan.ts"

interface TypecheckResult {
  readonly ran: boolean
  readonly ok: boolean
  readonly note?: string
  readonly output?: string
  readonly cancelled?: boolean
  /** tsconfig.json exists but no `typescript` install was found walking up from cwd. The contract
   * gate could not run - the caller surfaces this as a FAILING diagnostic, never a silent skip. */
  readonly missingTypeScript?: boolean
  /** No tsconfig.json at the project root. Fails the check only when TypeScript sources exist. */
  readonly missingTsconfig?: boolean
  /** TypeScript sources the scan found with no tsconfig.json to typecheck them. */
  readonly sourcesWithoutTsconfig?: number
  /** Every file in the compiler's program, absolute. Absent when the compiler listed none. */
  readonly programFiles?: readonly string[]
  /** Zoned TypeScript files outside the program, project-relative: the typecheck never read them. */
  readonly outsideProgram?: readonly string[]
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

/**
 * Run the project's own `tsc --noEmit` over each tsconfig `typecheckProjects` names, one program at a
 * time, if TypeScript and a tsconfig are present. Never auto-installs.
 */
async function typecheck(
  cwd: string,
  signal?: AbortSignal,
  configured?: readonly string[],
): Promise<TypecheckResult> {
  const projects = typecheckProjects(cwd, configured)
  if (projects.missing.length > 0) {
    return {
      ran: true,
      ok: false,
      output: `nifra.check.json "tsconfigs" names ${projects.missing.map((path) => `"${path}"`).join(", ")}, which does not exist`,
    }
  }
  if (projects.paths.length === 0)
    return { ran: false, ok: true, missingTsconfig: true, note: "no tsconfig.json" }
  // Routes import their generated `./+types` modules; bring them up to date before tsc reads them.
  const { refreshRouteTypes } = await import("./route-types.ts")
  refreshRouteTypes(cwd, () => {})
  const tscBin = resolveTscBin(cwd)
  if (tscBin === undefined) {
    return {
      ran: false,
      ok: false,
      missingTypeScript: true,
      note: "typescript not installed (run: bun add -d typescript)",
    }
  }
  const runs: TypecheckResult[] = []
  for (const tsconfig of projects.paths) {
    let run = await runTsc(cwd, tscBin, tsconfig, true, signal)
    // A compiler that rejects `--listFiles` still gets its typecheck; only the coverage check is lost.
    if (!run.ok && !run.cancelled && /TS50(?:23|25)\b[^\n]*listFiles/.test(run.output ?? ""))
      run = await runTsc(cwd, tscBin, tsconfig, false, signal)
    if (run.cancelled === true) return run
    runs.push(run)
  }
  const [only] = runs
  if (runs.length === 1 && only !== undefined) return only
  // A file two programs both hold reports each error twice; keep one copy of each diagnostic block.
  const blocks = new Set(
    runs.flatMap((run) => (run.output ?? "").split(/\n(?=\S)/).filter((block) => block !== "")),
  )
  const programFiles = [...new Set(runs.flatMap((run) => run.programFiles ?? []))]
  const merged: TypecheckResult = {
    ran: true,
    ok: runs.every((run) => run.ok),
    output: [...blocks].join("\n"),
  }
  return programFiles.length > 0 ? { ...merged, programFiles } : merged
}

async function runTsc(
  cwd: string,
  tscBin: string,
  tsconfig: string,
  listFiles: boolean,
  signal?: AbortSignal,
): Promise<TypecheckResult> {
  if (signal?.aborted) return { ran: true, ok: false, cancelled: true, output: "cancelled" }
  const args = [process.execPath, tscBin, "--noEmit", "-p", tsconfig]
  if (listFiles) args.push("--listFiles")
  // tsc calls process.exit after printing. Bun can discard buffered pipe writes at that point,
  // especially while the parent's other scans occupy the event loop. Files keep the full program.
  const outputDirectory = mkdtempSync(join(tmpdir(), "nifra-tsc-"))
  const stdout = Bun.file(join(outputDirectory, "stdout"))
  const stderr = Bun.file(join(outputDirectory, "stderr"))
  try {
    const proc = Bun.spawn(args, {
      cwd,
      stdout,
      stderr,
      // Its own group lets cancellation also stop a compiler process the tsc entry started.
      detached: OWN_PROCESS_GROUP,
    })
    let cancelled = false
    const stop = (): void => signalProcessGroup(proc, "SIGTERM")
    const abort = (): void => {
      cancelled = true
      stop()
    }
    signal?.addEventListener("abort", abort, { once: true })
    const releaseSignals = forwardTerminalSignals(() => stopGroupAndWait(proc))
    let out = ""
    let err = ""
    let code: number | null = null
    try {
      code = await proc.exited
      const result = await Promise.all([stdout.text(), stderr.text()])
      out = result[0]
      err = result[1]
    } finally {
      signal?.removeEventListener("abort", abort)
      releaseSignals()
    }
    if (cancelled) return { ran: true, ok: false, output: "cancelled", cancelled: true }
    const listed = listFiles ? splitListedFiles(out) : undefined
    return {
      ran: true,
      ok: code === 0,
      output: `${listed?.output ?? out}${err}`.trim(),
      ...(listed !== undefined && listed.programFiles.length > 0
        ? { programFiles: listed.programFiles }
        : {}),
    }
  } finally {
    rmSync(join(outputDirectory, "stdout"), { force: true })
    rmSync(join(outputDirectory, "stderr"), { force: true })
    rmdirSync(outputDirectory)
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
      tsconfigs?: unknown
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
    let tsconfigs: readonly string[] | undefined
    if (parsed.tsconfigs !== undefined) {
      if (
        Array.isArray(parsed.tsconfigs) &&
        parsed.tsconfigs.length > 0 &&
        parsed.tsconfigs.every(
          (entry): entry is string =>
            typeof entry === "string" && entry.endsWith(".json") && !isAbsolute(entry),
        )
      )
        tsconfigs = parsed.tsconfigs
      else
        warnings.push(
          '`tsconfigs` must be a non-empty array of tsconfig paths relative to the project, such as ["tsconfig.json"] - ignored',
        )
    }
    const config: CheckConfig =
      tsconfigs === undefined ? { externalMounts, rules } : { externalMounts, rules, tsconfigs }
    return { config, warnings }
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
}

async function collectContractFacts(cwd: string): Promise<ContractCheckFacts> {
  const hasBackend = existsSync(join(cwd, BACKEND_APP_FILE))
  const hasLock = existsSync(join(cwd, DEFAULT_CONTRACTS_LOCK))
  if (!hasBackend && !hasLock) return { present: false, vacuous: false, diagnostics: [] }
  try {
    return await checkContractsLock(cwd)
  } catch (error) {
    if (error instanceof Error && error.message === "contract source not configured") {
      return { present: false, vacuous: false, diagnostics: [] }
    }
    return {
      present: hasLock,
      vacuous: false,
      diagnostics: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** A project whose TypeScript no tsconfig.json covers has no typecheck to pass: the gate fails. */
function withoutTsconfig(
  result: TypecheckResult,
  sourceFiles: ReadonlyArray<{ readonly file: string }>,
): TypecheckResult {
  if (result.missingTsconfig !== true) return result
  const sources = sourceFiles.filter(({ file }) => !/\.d\.[cm]?ts$/.test(file)).length
  return sources === 0 ? result : { ...result, ok: false, sourcesWithoutTsconfig: sources }
}

/** Record the zoned files the compiler's program left out, minus the typecheck rule's `ignore` globs. */
function withProgramCoverage(
  cwd: string,
  result: TypecheckResult,
  sourceFiles: ReadonlyArray<{ readonly file: string }>,
  checkConfig: CheckConfig,
): TypecheckResult {
  const { programFiles, ...rest } = result
  if (programFiles === undefined) return result
  const ignore = (checkConfig.rules.typecheck ?? checkConfig.rules["NF-C001"])?.ignore
  const outside = filesOutsideProgram(
    cwd,
    sourceFiles.map((source) => source.file),
    programFiles,
  ).filter((file) => !ignore?.some((pattern) => safeIgnoreGlobMatch(pattern, file)))
  return outside.length === 0 ? rest : { ...rest, outsideProgram: outside }
}

/** Build the rule input from one source walk and the other check-wide scans. */
async function buildProjectScan(
  cwd: string,
  opts: Pick<CheckCollectionOptions, "lintsOnly" | "signal" | "loadTypeScript">,
): Promise<ProjectScan> {
  const fetches: TypedClientFinding[] = []
  const streams: TypedClientFinding[] = []
  const staticRoutes: StaticRouteFinding[] = []
  const untypedClients: SourceFinding[] = []
  const removedImports: SourceFinding[] = []
  const serverImports: TransitiveServerImportFinding[] = []
  const responseRoutes: SourceFinding[] = []
  const interpolatedSql: SqlFinding[] = []
  const routePaths: UnresolvedRoutePathFinding[] = []
  const browserModules: Array<{ rel: string; content: string }> = []
  const sourceFiles: Array<{ file: string; content: string }> = []
  const inNifraProject = createNifraProjectProbe(cwd)
  // An API-only project has no browser bundle for server code to reach.
  const apiOnly = createApiOnlyProbe(cwd)
  const {
    config: checkConfig,
    error: checkConfigError,
    warnings: checkConfigWarnings,
  } = await loadCheckConfig(cwd)
  const [typecheckRun, _, doctor, manifestDrift, contracts] = await Promise.all([
    opts.lintsOnly
      ? Promise.resolve<TypecheckResult>({ ran: false, ok: true, note: "lints-only mode" })
      : typecheck(cwd, opts.signal, checkConfig.tsconfigs),
    walkSource(
      cwd,
      (rel, content) => {
        sourceFiles.push({ file: rel, content })
        fetches.push(...scanFetchText(rel, content, checkConfig.externalMounts))
        streams.push(...scanStreamText(rel, content, checkConfig.externalMounts))
        untypedClients.push(...scanUntypedClient(rel, content))
        removedImports.push(...scanRemovedImports(rel, content))
        const dir = dirname(rel).replace(/^\.$/, "")
        if (isBrowserSource(rel) && inNifraProject(dir) && !apiOnly(dir))
          browserModules.push({ rel, content })
      },
      { scripts: true },
    ),
    import("./doctor.ts").then((m) => m.collectDoctorResult(cwd)),
    scanServerManifestDrift(cwd),
    collectContractFacts(cwd),
  ])

  // tsc compiles TypeScript sources only; the JavaScript and component files the scan reads are no
  // program's to cover.
  const typeScriptSources = sourceFiles.filter(({ file }) => /\.[cm]?tsx?$/.test(file))
  const typecheckResult = withoutTsconfig(
    withProgramCoverage(cwd, typecheckRun, typeScriptSources, checkConfig),
    typeScriptSources,
  )

  // TypeScript 7's unstable API materializes source files through one project session. Build the
  // source index first so every syntax-backed scanner (including the independent rule registry)
  // shares that session instead of spawning one compiler process per rule.
  const source = sourceIndex(sourceFiles)
  const loadedTypeScript = await loadProjectTypeScript(cwd, opts.loadTypeScript, source)
  try {
    const sqlCompiler = loadedTypeScript.compiler
    // Resolved modules stay project-relative, as the scanned files are: the zone of a path is read
    // from its folders, and a checkout under a folder named `backend/` must not make it all backend.
    // The resolver answers with real paths, so the project root is read as one too.
    const realCwd = (() => {
      try {
        return realpathSync(cwd)
      } catch {
        return cwd
      }
    })()
    const resolveSpecifier = createSpecifierResolver()
    const sourceFacts =
      sqlCompiler === undefined
        ? undefined
        : createSourceFacts(sqlCompiler, {
            keepsTypeOnlyImports: (file) =>
              resolveSpecifier.keepsTypeOnlyImports(isAbsolute(file) ? file : join(realCwd, file)),
          })
    const sqlImports = sqlCompiler === undefined ? undefined : createProjectSqlImports(cwd)
    const project = new Map(
      sourceFiles.map(({ file, content }) => [file.replaceAll("\\", "/"), content]),
    )
    for (const { file, content } of sourceFiles) {
      staticRoutes.push(...scanStaticRouteText(file, content, sourceFacts, project))
      routePaths.push(...scanUnresolvedRoutePaths(file, content, project, sourceFacts))
      responseRoutes.push(...scanResponseRoutes(file, content, sourceFacts, project))
      if (sqlCompiler !== undefined)
        interpolatedSql.push(...scanSqlSites(file, content, sqlCompiler, sqlImports))
    }

    const projectPath = (path: string): string => {
      const rel = relative(realCwd, path).replaceAll("\\", "/")
      return rel.startsWith("../") || isAbsolute(rel) ? path : rel
    }
    const resolveModule: ModuleResolver = (fromFile, specifier) => {
      const resolved = resolveSpecifier(
        isAbsolute(fromFile) ? fromFile : join(realCwd, fromFile),
        specifier,
      )
      return resolved === undefined ? undefined : projectPath(resolved)
    }
    const readModule: ModuleReader = (path) => {
      let text: string
      try {
        text = readFileSync(isAbsolute(path) ? path : join(cwd, path), "utf8")
      } catch {
        return undefined
      }
      return COMPONENT_FILE.test(path) ? componentScripts(text) : text
    }
    const components = await componentCheckReceipts(cwd, source)
    const componentReceipts = components.receipts
    // An app's `clientModule` is browser code wherever it lives: the generated client entry imports it.
    const browserRoots = new Set<string>()
    for (const app of appDirs(source.files)) {
      const entry = clientModuleRoot(cwd, app, resolveSpecifier, sqlCompiler)
      if (entry === undefined) continue
      const rel = projectPath(entry.file)
      if (isBrowserSource(rel) || browserRoots.has(rel)) continue
      const content = readModule(rel)
      if (content === undefined) continue
      browserRoots.add(rel)
      browserModules.push({ rel, content })
    }
    // The side the package gives the entry the import names: package-wide, or per entry.
    const backendPackage = (fromFile: string, specifier: string): boolean => {
      const name = specifierPackage(specifier)
      if (name === undefined) return false
      const manifest = installedManifest(
        isAbsolute(fromFile) ? fromFile : join(realCwd, fromFile),
        name,
      )
      if (manifest === undefined) return false
      try {
        const nifra: unknown = JSON.parse(readFileSync(manifest, "utf8"))?.nifra
        return (
          typeof nifra === "object" &&
          nifra !== null &&
          declaredSide(Reflect.get(nifra, "environment"), specifier) === "backend"
        )
      } catch {
        return false
      }
    }
    const serverOnlyChains = createServerOnlyChains({
      resolve: resolveModule,
      read: readModule,
      facts: sourceFacts,
      componentReceipts,
      backendPackage,
    })
    for (const { rel, content } of browserModules)
      serverImports.push(...serverOnlyChains(rel, content, browserRoots.has(rel)))

    const facts: ProjectFactsSeed = {
      source,
      routes: staticRoutes,
      importGraph: serverImports,
      packages: { doctor, manifestDrift },
      ...(doctor.pipeline === undefined ? {} : { pipeline: doctor.pipeline }),
      policies: { checkConfig, rulePacks: [] },
      check: {
        typecheck: typecheckResult,
        sqlCompilerAvailable: sqlCompiler !== undefined,
        componentCheckUnsupported:
          components.unsupported === undefined
            ? undefined
            : { version: components.unsupported.version, message: components.unsupported.message },
        ...(loadedTypeScript.unsupported === undefined
          ? {}
          : { unsupportedTypeScriptVersion: loadedTypeScript.unsupported.version }),
        ...(loadedTypeScript.session === undefined
          ? {}
          : { typescriptSession: loadedTypeScript.session }),
        ...(checkConfigError === undefined ? {} : { checkConfigError }),
        checkConfigWarnings,
        contracts,
      },
      sourceFindings: {
        fetches,
        streams,
        untypedClients,
        removedImports,
        responseRoutes,
        interpolatedSql,
        routePaths,
      },
    }
    return { facts }
  } catch (error) {
    await loadedTypeScript.session?.close()
    throw error
  }
}

/** Run the three checks and assemble a structured, machine-readable result. The single source the CLI
 * report, `--json`, and the MCP tool all render from. */
/** Run the scan, freeze its facts, and project them into the public diagnostic result. */
export async function collectCheckResult(
  root: string,
  opts: CheckCollectionOptions = {},
): Promise<CheckResult> {
  // The zone classifier works on absolute paths; under a relative root every file read as unzoned.
  const cwd = resolve(root)
  const scan = await buildProjectScan(cwd, opts)
  try {
    return await collectCheckDiagnostics(cwd, scan, opts)
  } finally {
    await scan.facts.check.typescriptSession?.close()
  }
}

/** The named rule sections of the human report, in print order. A rule absent from this list is NOT
 * dropped: {@link renderCheckReport} renders every remaining diagnostic in a generic section keyed by
 * its rule code, so a finding that can flip the exit code is never invisible in the default output. */
const REPORT_SECTIONS = [
  ["typecheck", "typecheck"],
  ["typed-client", "hand-rolled fetch()/EventSource/WebSocket to your own API"],
  ["untyped-client", 'client("…") missing its <typeof app> type argument'],
  ["server-only-import", "backend code in browser code"],
  ["interpolated-sql", "SQL built by interpolating a value into the statement"],
  ["response-route", "route returns a raw Response (typed client → data: never)"],
  ["undeclared-dependency", "undeclared dependency in package.json"],
  ["duplicate-install", "duplicate identity-sensitive dependency install"],
  ["version-skew", "identity-sensitive dependency at more than one version"],
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
 * trailer states the error, advisory and info counts that produced `ok`.
 */
export function renderCheckReport(result: CheckResult): string[] {
  const lines: string[] = []
  lines.push("nifra check", "")
  lines.push(
    result.typecheck === "pass"
      ? "✓ typecheck passed"
      : result.typecheck === "fail"
        ? `✗ typecheck failed - ${result.typecheckNote ?? "the frontend/backend contract is broken"}`
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
  if (result.tsconfigs !== undefined) {
    lines.push(
      `• typecheck programs (nifra.check.json "tsconfigs"): ${result.tsconfigs.join(", ")}`,
    )
  }
  for (const gap of result.knownGaps ?? []) {
    lines.push(`• known gap, not capability-analyzed: ${gap.path} - ${gap.reason}`)
  }
  const deduplicated = result.identityPreflight?.deduplicated ?? []
  if (deduplicated.length > 0) {
    const packages = deduplicated.map((finding) => finding.package).join(", ")
    lines.push(`• identity-sensitive duplicate installs handled by singleCopy: ${packages}`)
    const unarmed = deduplicated.find((finding) => finding.unenforced !== undefined)
    if (unarmed !== undefined) lines.push(`  ${unarmed.remediation}`)
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
      const warnings = ds.filter((d) => d.severity === "warning").length
      const infos = ds.length - errors - warnings
      const rest = belowError(warnings, infos)
      lines.push(
        ds.length === 0
          ? `✓ ${label}: none`
          : errors + warnings === 0
            ? `• ${label}: ${ds.length} (info)`
            : errors === 0
              ? `⚠ ${label}: ${warnings} (advisory)${infos > 0 ? ` (+${infos} info)` : ""}`
              : `✗ ${label}: ${errors}${rest === "" ? "" : ` (+${rest})`}`,
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
  const warnings = result.diagnostics.filter((d) => d.severity === "warning").length
  const rest = belowError(warnings, result.diagnostics.length - errors - warnings)
  lines.push(
    "",
    result.ok
      ? rest === ""
        ? "✓ check passed"
        : `✓ check passed (${rest})`
      : `✗ check failed: ${errors} error${errors === 1 ? "" : "s"}${rest === "" ? "" : ` (+${rest})`}`,
  )
  return lines
}

/** The findings that do not fail the check, named by severity: an info finding is not advisory. */
function belowError(warnings: number, infos: number): string {
  const parts: string[] = []
  if (warnings > 0) parts.push(`${warnings} advisory`)
  if (infos > 0) parts.push(`${infos} info`)
  return parts.join(", ")
}

/** Run the full check; print a report (`--json` for machine output) and return whether it passed. */
export async function runCheck(
  cwd: string,
  opts: {
    readonly json?: boolean
    readonly lintsOnly?: boolean
    readonly structured?: boolean
    readonly sarif?: boolean
  } = {},
): Promise<boolean> {
  // The check view over the one project verification: the same collector `assure` and `levels` read.
  const { collectProjectVerification } = await import("./verification.ts")
  const verification = await collectProjectVerification(cwd, { lintsOnly: opts.lintsOnly ?? false })
  const result = await verification.check()
  if (opts.sarif) {
    const diagnostics: readonly Diagnostic[] =
      result.structuredDiagnostics ??
      result.diagnostics.map((value) => ({
        code: value.code ?? value.rule,
        severity: normalizeSeverity(value.severity),
        message: value.message,
        ...(value.file === undefined ? {} : { file: value.file }),
        ...(value.line === undefined ? {} : { line: value.line }),
        ...(value.evidence === undefined ? {} : { evidence: value.evidence }),
        ...(value.fix === undefined ? {} : { fix: { recipe: value.fix } }),
        ...(value.verify === undefined ? {} : { verify: value.verify }),
      }))
    console.log(JSON.stringify(toSarifLog(diagnostics), null, 2))
    return result.ok
  }
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
  // `nifra init-agents` writes it (+ .cursor/mcp.json + each agent's pointer to AGENTS.md), no-clobber. A non-fatal
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

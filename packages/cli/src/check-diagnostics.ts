/**
 * Diagnostic model and projections for the nifra verification pipeline.
 *
 * Scanners publish frozen facts; this module turns those facts plus policy into the stable legacy and
 * structured diagnostic views. The CLI, JSON output, and MCP all consume the resulting CheckResult.
 */

import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import type { AssuranceConfig, AssuranceReport } from "@nifrajs/core/assurance"
import { type ProjectEvidenceSnapshot, snapshotProjectEvidence } from "@nifrajs/core/evidence"
import { SINGLE_COPY_REGISTER_SPECIFIER } from "@nifrajs/core/single-copy"
import { Glob } from "bun"
import type { CapabilityProjectReport } from "./capabilities-tool.ts"
import type { SourceFinding, StaticRouteFinding } from "./check-scan.ts"
import {
  IDENT,
  parseSimpleFetchCall,
  REMOVED_IMPORTS,
  SIMPLE_REWRITE_METHODS,
} from "./check-scan.ts"
import { type Diagnostic, diagnostic } from "./diagnostics.ts"
import type { DuplicateInstallFinding } from "./doctor.ts"
import type { TypeScriptApi } from "./internal/typescript-import.ts"
import type { PipelineReport } from "./pipeline-report.ts"
import { freezeProjectFacts, type ProjectFactsSeed } from "./project-facts.ts"
import { parseRulePacks, type RuleContext, runRuleRegistry } from "./rules/index.ts"
import { islandRules } from "./rules/islands.ts"
import { LEGACY_RULE_CODES, legacyRules } from "./rules/legacy.ts"
import { routeRules } from "./rules/routes.ts"
import { securityRules } from "./rules/security.ts"

const TSC_LINE = /^(.+?)\((\d+),\d+\):\s*(?:error|warning)\s+TS\d+:\s*(.+)$/

/** A single machine-readable check failure - the unit an agent (or CI) acts on. */
export interface CheckDiagnostic {
  readonly rule: string
  /** `error` fails the gate (a real contract break); `warning` is advisory - surfaced to the agent but
   * does NOT fail `nifra check`, for patterns that are sometimes intentional (a route returning a raw
   * `Response`, which silently drops the typed client to `data: never` but is valid for files/redirects). */
  readonly severity: "error" | "warning" | "info"
  /** Stable diagnostic protocol code. The legacy `rule` remains for compatibility. */
  readonly code?: string
  readonly file?: string
  readonly line?: number
  readonly message: string
  /** The canonical, rule-level fix - clean of the per-occurrence snippet, so an agent can apply it
   * directly. Set for the lint rules (they have one correct fix); omitted for `typecheck` (the fix is
   * specific to each type error). */
  readonly fix?: string
  /** A richer, agent-oriented fix hint. Diffs are only emitted when the edit is mechanical and local;
   * ambiguous cases give concrete steps instead of pretending the checker can safely rewrite code. */
  readonly suggestion?: CheckSuggestion
  /**
   * The import chain that pulls server-only code into the browser bundle, as display labels
   * `[routeFile, …as-written specifiers…, sink]`. Set only on `server-only-import`.
   *
   * #4.4: this is now the FULL **transitive** chain - a bounded import-resolution walk (`Bun.resolveSync`
   * from each file's dir, BFS the local module graph) follows `route → ../data → ../db → node:crypto`,
   * matching the build leak-guard's depth (`detectNodeBuiltinsInClient` in `@nifrajs/web/build`). A
   * length-2 chain (`[routeFile, specifier]`) means the route imports the sink directly. When a hop can't
   * be resolved precisely (a bare pkg, a tsconfig path alias), the walk degrades to the honest direct
   * edge rather than fabricating a deeper path - never a lie.
   */
  readonly chain?: readonly string[]
  readonly evidence?: readonly string[]
  readonly verify?: string
}

export interface CheckSuggestion {
  readonly kind: "edit" | "command" | "manual"
  readonly title: string
  readonly diff?: string
  /** argv array, not a shell string, so MCP clients can run it without quoting hazards. */
  readonly command?: readonly string[]
  readonly steps?: readonly string[]
}

/** The structured result of a full check - what `--json` prints and the `nifra_check` MCP tool returns. */
export interface CheckResult {
  readonly ok: boolean
  readonly typecheck: "pass" | "fail" | "skipped"
  /** Why `typecheck` is `"skipped"` (no tsconfig.json, typescript not installed, lints-only mode).
   * Absent when the typecheck ran. Echoed in the human report so a skip is never a dim mystery. */
  readonly typecheckNote?: string
  readonly diagnostics: readonly CheckDiagnostic[]
  /** Normalized diagnostics with stable codes for agents and external renderers. */
  readonly structuredDiagnostics?: readonly Diagnostic[]
  /**
   * Which bundler this app's phases run on, read statically from the config, and how nifra concluded
   * it. Returned even when nothing is wrong: an agent reading this project has to know which plugin
   * slot is live and which toolchain compiles a component before its next edit, and every `pipeline`
   * diagnostic below is only interpretable against it. Absent when the directory is not a nifra app.
   */
  readonly pipeline?: PipelineReport
  /** Intentional non-typed mount prefixes declared in `nifra.check.json` (e.g. `/auth` for a mounted
   * better-auth). Echoed here so `--json` / the MCP tool / the report can show what the typed-client scan
   * deliberately skipped - a suppressed prefix stays auditable instead of silently hiding real drift. */
  readonly externalMounts?: readonly string[]
  /** Active per-rule overrides from `nifra.check.json` `rules`, echoed verbatim so a retagged or
   * suppressed finding stays auditable in `--json`, the MCP tool, and the human report - config can
   * lower (or raise) the gate, but never invisibly. */
  readonly ruleOverrides?: Readonly<Record<string, RuleOverride>>
  /** Set only when the caller passed `maxDiagnostics` and there were more - `diagnostics` then holds the
   * first `shown` of `total`. It caps the serialized size so the `nifra_check` MCP tool can't emit a
   * message large enough to break the stdio transport; fix the shown diagnostics and re-run for the rest. */
  readonly truncated?: { readonly shown: number; readonly total: number }
  /**
   * The identity preflight's machine-readable result: every duplicate physical install of an
   * identity-sensitive package, with each copy's resolved absolute path, version, and the importers
   * that pulled it in. Present whenever the dependency scan ran - including when it found nothing, so
   * tooling can distinguish "clean" from "did not look". The human rendering of the same data lives in
   * the `duplicate-install` diagnostics; this field is what `--json` consumers parse instead.
   */
  readonly identityPreflight?: IdentityPreflightResult
}

/** The `identityPreflight` slice of {@link CheckResult}. */
export interface IdentityPreflightResult {
  /** Which tree the scan looked at, in the same words the build/dev preflight uses. */
  readonly basis?: string
  /** The scan stopped at the workspace-enumeration cap - "no duplicates" covers only the scanned part. */
  readonly truncated?: boolean
  /** Duplicates that fail the gate. Empty means the scanned tree is clean. */
  readonly duplicates: readonly DuplicateInstallFinding[]
  /** Duplicates covered by a `"nifra": { "singleCopy": [...] }` declaration - reported, never fatal. */
  readonly deduplicated: readonly DuplicateInstallFinding[]
}

/**
 * Pre-resolved route-assurance inputs, so the same reflection that `nifra assure` / `nifra levels`
 * already ran can feed `check`'s capability + trust-manifest diagnostics instead of a second pass.
 * Supplied by {@link collectProjectVerification}. When omitted, `collectCheckResult` loads and computes
 * these itself (the standalone `nifra_check` MCP path); the two routes produce byte-identical results.
 */
export interface CheckAssuranceContext {
  /** Whether `nifra.assurance.ts` exists: the gate for running the assurance-fed diagnostics at all. */
  readonly present: boolean
  /** The loaded config, when it loaded. Absent when the file is missing or {@link error} is set. */
  readonly config?: AssuranceConfig
  /** The failure from loading/evaluating the config, surfaced as a `capability-config` diagnostic. */
  readonly error?: unknown
  /** `evaluateRouteAssurance` over the config's source + policy (drives the trust-manifest check). */
  readonly routeAssurance?: AssuranceReport
  /** Static capability provenance, when the config declares a capabilities policy. */
  readonly capability?: CapabilityProjectReport
  /** Canonical token-only evidence reused by manifest and other offline projections. */
  readonly evidence?: ProjectEvidenceSnapshot
}

/** Optional per-project `nifra.check.json` - pure data (no code execution), so it's safe to read before
 * the app is built or even importable, preserving check's pre-`loadApp` invariant. */
export interface CheckConfig {
  readonly externalMounts: readonly string[]
  readonly rules: Readonly<Record<string, RuleOverride>>
}

/**
 * One entry of `nifra.check.json` `rules`, keyed by legacy rule name (`response-route`) or stable
 * NF- code (`NF-S002`) - one key retags the finding in both diagnostic views. `severity: "off"`
 * drops the rule's findings; `ignore` drops findings whose file matches any of the globs. Overrides
 * are applied centrally BEFORE `ok` is computed and echoed in the result and the human report -
 * configuration can lower (or raise) the gate, but never invisibly.
 */
export interface RuleOverride {
  readonly severity?: "error" | "warn" | "info" | "off"
  readonly ignore?: readonly string[]
}

const UNTYPED_CLIENT_HINT =
  'client("…") without a type argument - write client<typeof app>("…") (or client(contract, url)) so the compiler can catch drift'
const FETCH_HINT =
  "hand-rolled fetch() to your own API - call it through client<typeof app> (from @nifrajs/client) so the compiler catches drift"
const SERVER_IMPORT_HINT =
  "server-only import in a route module (bundled for the browser) - reach it via c.db / ctx.api inside a loader, never a top-level import"
const RESPONSE_ROUTE_HINT =
  "route handler returns a raw Response - the typed client infers `data: never`, so drift detection is lost for this route. Return a plain object (it's serialized for you); for a stream use a typed SSE route (`app.sse(...)`), which keeps typed events; or, if a raw Response is intended (file/redirect), add `{ response: t.… }` or a `// nifra-expect raw-response` comment to mark it and silence this"
const PIPELINE_DOC_HINT =
  "nifra runs one bundler per phase - `vitePlugins` feed Vite, `clientPlugins`/`serverPlugins` feed Bun, and the file `nifra build` imports the adapter from is bundled into the server. See the Gotchas section of the Dev & HMR guide."
const UNDECLARED_DEP_HINT =
  "imported package is not declared in package.json dependencies - run bun add to declare it"
const SQL_COMPILER_MISSING_HINT =
  "the interpolated-SQL rule did NOT run - it parses source with the TypeScript compiler, which is an optional peer and is not installed here. This report says nothing about SQL injection either way. Install it with `bun add -d typescript`"
const SQL_INTERPOLATION_EXAMPLE = "$" + "{value}"
const INTERPOLATED_SQL_HINT = `SQL built by interpolating a value into the statement text - the value becomes statement, not a parameter, so anything the caller controls can end the literal and continue as SQL. Pass it as a bound parameter (\`?\` / \`$1\` and an argument), or use your driver's tagged template (sql\`… ${SQL_INTERPOLATION_EXAMPLE} …\`), which binds the substitutions for you`
const MANIFEST_DRIFT_HINT =
  "server-manifest.ts is out of sync with routes/ - re-run the build to regenerate it (a disk-less worker bakes this route table, so the drift is a silent edge break), then commit it"
const TRUST_MANIFEST_DRIFT_HINT =
  "nifra.manifest.json is missing, invalid, or out of sync - run `nifra manifest emit`, review it, and commit the regenerated trust artifact"
const CAPABILITY_HINT =
  "effect/capability assurance failed - align the route declaration with approved adapter provenance; never bypass an owned effect seam"

export interface CheckTypecheckResult {
  readonly ran: boolean
  readonly ok: boolean
  readonly note?: string
  readonly output?: string
  readonly missingTypeScript?: boolean
}

export interface CheckAnalysisInput {
  readonly facts: ProjectFactsSeed
  readonly typecheck: CheckTypecheckResult
  readonly sqlCompiler: TypeScriptApi | undefined
  readonly checkConfigError?: string
  readonly checkConfigWarnings: readonly string[]
}

export interface CheckDiagnosticsOptions {
  readonly maxDiagnostics?: number
  readonly assurance?: CheckAssuranceContext
}

const bySite = (a: SourceFinding, b: SourceFinding): number =>
  a.file.localeCompare(b.file) || a.line - b.line

function oneLineDiff(file: string, line: number, before: string, after: string): string {
  return `--- ${file}:${line}\n+++ ${file}:${line}\n@@\n-${before}\n+${after}`
}

function untypedClientSuggestion(f: SourceFinding): CheckSuggestion {
  const replacement = f.snippet.replace(/(?<![.\w])client\s*\(/, "client<typeof app>(")
  return replacement === f.snippet
    ? {
        kind: "manual",
        title: "Add the app type argument to the client factory",
        steps: [
          'Change `client("...")` to `client<typeof app>("...")`.',
          "Make sure the backend app type is imported or otherwise in scope.",
        ],
      }
    : {
        kind: "edit",
        title: "Insert `<typeof app>` into the client factory call",
        diff: oneLineDiff(f.file, f.line, f.snippet, replacement),
        steps: ["Make sure the backend app type is imported or otherwise in scope."],
      }
}

function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`
}

function typedClientCall(method: string, path: string): string {
  const segs = path.split("/").filter((seg) => seg !== "")
  let chain = "api"
  if (segs.length === 0) chain += ".index"
  else {
    for (const seg of segs) {
      chain += IDENT.test(seg) ? `.${seg}` : `[${JSON.stringify(seg)}]`
    }
  }
  return `${chain}.${method.toLowerCase()}()`
}

function staticRouteMap(routes: readonly StaticRouteFinding[]): Map<string, StaticRouteFinding[]> {
  const out = new Map<string, StaticRouteFinding[]>()
  for (const route of routes) {
    if (route.path.includes(":") || route.path.includes("*")) continue
    const key = routeKey(route.method, route.path)
    const bucket = out.get(key)
    if (bucket === undefined) out.set(key, [route])
    else bucket.push(route)
  }
  return out
}

function ownFetchEditSuggestion(
  f: SourceFinding,
  routes: Map<string, StaticRouteFinding[]>,
): CheckSuggestion | undefined {
  const call = parseSimpleFetchCall(f.snippet)
  if (call === undefined || !SIMPLE_REWRITE_METHODS.has(call.method)) return undefined
  const matches = routes.get(routeKey(call.method, call.path))
  if (matches === undefined || matches.length !== 1) return undefined
  const replacementCall = typedClientCall(call.method, call.path)
  const replacement = `${f.snippet.slice(0, call.start)}${replacementCall}${f.snippet.slice(call.end)}`
  if (replacement === f.snippet) return undefined
  const route = matches[0]
  if (route === undefined) return undefined
  return {
    kind: "edit",
    title: "Rewrite simple own-API fetch to the typed nifra client",
    diff: oneLineDiff(f.file, f.line, f.snippet, replacement),
    steps: [
      `Matched ${route.method} ${route.path} at ${route.file}:${route.line}.`,
      "Use an in-scope typed client named `api` (`client<typeof app>(baseUrl)` or the route loader/action `api`).",
      "Update downstream `Response` handling to branch on `{ ok, data, error }` if this variable is used later.",
    ],
  }
}

function ownFetchSuggestion(
  f: SourceFinding,
  routes: Map<string, StaticRouteFinding[]>,
): CheckSuggestion {
  const exact = ownFetchEditSuggestion(f, routes)
  if (exact !== undefined) return exact
  return {
    kind: "manual",
    title: "Replace own-API fetch with the typed nifra client",
    steps: [
      "Call `nifra_routes` or read `nifra://routes` for the exact typed-client call form.",
      "Create `const api = client<typeof app>(baseUrl)` from `@nifrajs/client`.",
      "Replace the relative `fetch()` call with the generated `api...get/post/...` call and branch on `{ ok, data, error }`.",
    ],
  }
}

function serverImportSuggestion(
  specifier: string,
  chain: readonly string[],
  fallback: boolean,
): CheckSuggestion {
  const sink = chain[chain.length - 1] ?? specifier
  // Surface the resolved chain in the fix steps so the agent sees the full path (`route → ../data →
  // ../db → node:crypto`) and which module to cut - not just the route's own top-level import.
  const chainStep =
    chain.length > 2
      ? fallback
        ? `Server-only code reaches this route through \`${chain.join(" → ")}\` (the deeper chain couldn't be resolved precisely - trace it from \`${specifier}\`).`
        : `Server-only code reaches this route transitively: \`${chain.join(" → ")}\`. The sink is \`${sink}\`; break the chain at the first hop (\`${specifier}\`) or move the sink behind the server boundary.`
      : undefined
  return {
    kind: "manual",
    title: "Move server-only code behind the route server boundary",
    steps: [
      ...(chainStep !== undefined ? [chainStep] : []),
      `Remove the top-level \`import … from "${specifier}"\` from this route module (it's bundled for the browser).`,
      "Access backend/data work through the route `loader`/`action` context (`api`, `env`, or project server context).",
      `If a direct module import is unavoidable, lazy-load it (\`await import("${specifier}")\`) inside the server-only loader/action path.`,
    ],
  }
}

function responseRouteSuggestion(): CheckSuggestion {
  return {
    kind: "manual",
    title: "Preserve typed-client response inference",
    steps: [
      "Prefer returning a plain object from JSON routes; nifra serializes it for you.",
      "For a stream, use a typed SSE route - `app.sse(...)` (or `sse(c, run)` from `@nifrajs/core/server`) - which keeps typed events instead of collapsing the client to `data: never`.",
      "If this route must return a raw Response (redirect, file), declare an explicit response schema, or add a `// nifra-expect raw-response` comment above the return to mark it intentional and silence this advisory.",
    ],
  }
}

export async function collectCheckDiagnostics(
  cwd: string,
  scan: CheckAnalysisInput,
  opts: CheckDiagnosticsOptions = {},
): Promise<CheckResult> {
  const factsSeed = scan.facts
  const { fetches, untypedClients, removedImports, responseRoutes, interpolatedSql } =
    factsSeed.sourceFindings
  const staticRoutes = factsSeed.routes
  const serverImports = factsSeed.importGraph
  const { doctor: dr, manifestDrift } = factsSeed.packages
  const { checkConfig } = factsSeed.policies
  const tc = scan.typecheck
  const sqlCompiler = scan.sqlCompiler
  const checkConfigError = scan.checkConfigError
  const checkConfigWarnings = scan.checkConfigWarnings
  const diagnostics: CheckDiagnostic[] = []
  const structuredExtras: Diagnostic[] = []
  if (checkConfigError !== undefined) {
    diagnostics.push({
      rule: "check-config",
      severity: "warning",
      file: "nifra.check.json",
      message: `nifra.check.json could not be parsed (${checkConfigError}) - its external-mount allowlist was ignored`,
      fix: "Fix the JSON syntax in nifra.check.json",
    })
  }
  for (const warning of checkConfigWarnings) {
    diagnostics.push({
      rule: "check-config",
      severity: "warning",
      file: "nifra.check.json",
      message: `nifra.check.json: ${warning}`,
      fix: "Fix the entry in nifra.check.json",
    })
  }
  if (tc.missingTypeScript === true) {
    // A tsconfig with no reachable `typescript` install is a broken gate, not a benign skip: the
    // contract check the project asked for (by having a tsconfig) silently didn't run. Fail closed.
    diagnostics.push({
      rule: "typecheck",
      severity: "error",
      file: "tsconfig.json",
      message:
        "tsconfig.json is present but no `typescript` install was found from this directory upward - the typecheck gate did NOT run",
      fix: "bun add -d typescript",
      suggestion: {
        kind: "command",
        title: "Install TypeScript so the contract gate can run",
        command: ["bun", "add", "-d", "typescript"],
      },
    })
  }
  if (tc.ran && !tc.ok) {
    const lines = (tc.output ?? "").split("\n")
    let matched = false
    for (const l of lines) {
      const m = TSC_LINE.exec(l.trim())
      if (m) {
        matched = true
        diagnostics.push({
          rule: "typecheck",
          severity: "error",
          file: m[1] as string,
          line: Number(m[2]),
          message: m[3] as string,
          suggestion: {
            kind: "manual",
            title: "Fix the TypeScript contract error",
            steps: [
              "Open the reported file and line.",
              "Align the handler, route schema, or typed-client call with the compiler error.",
              "Run `nifra_check` again after the edit.",
            ],
          },
        })
      }
    }
    if (!matched)
      diagnostics.push({
        rule: "typecheck",
        severity: "error",
        message: tc.output || "typecheck failed",
        suggestion: {
          kind: "manual",
          title: "Fix the TypeScript contract error",
          steps: ["Run `tsc --noEmit` locally for the full compiler output."],
        },
      })
  }
  const routes = staticRouteMap(staticRoutes)
  for (const f of [...fetches].sort(bySite)) {
    diagnostics.push({
      rule: "typed-client",
      severity: "error",
      file: f.file,
      line: f.line,
      message: `${f.snippet} - ${FETCH_HINT}`,
      fix: FETCH_HINT,
      suggestion: ownFetchSuggestion(f, routes),
    })
  }
  for (const f of [...removedImports].sort(bySite)) {
    const entry = REMOVED_IMPORTS.find(
      (candidate) =>
        f.snippet.includes(`"${candidate.specifier}`) ||
        f.snippet.includes(`'${candidate.specifier}`),
    )
    diagnostics.push({
      rule: "removed-import",
      severity: "error",
      file: f.file,
      line: f.line,
      message: `${f.snippet} - removed in nifra ${entry?.since ?? "2.0"}: ${entry?.replacement ?? "see the changelog"}`,
      fix: entry?.replacement ?? "see the changelog",
    })
  }
  for (const f of [...untypedClients].sort(bySite)) {
    diagnostics.push({
      rule: "untyped-client",
      severity: "error",
      file: f.file,
      line: f.line,
      message: `${f.snippet} - ${UNTYPED_CLIENT_HINT}`,
      fix: UNTYPED_CLIENT_HINT,
      suggestion: untypedClientSuggestion(f),
    })
  }
  for (const f of [...serverImports].sort(bySite)) {
    // #4.4: the FULL transitive chain the import-resolution walk found - `route → ../data → ../db →
    // node:crypto`, matching the build leak-guard's depth - instead of just the direct edge. The chain's
    // tail is the actual server-only sink; the head is the route. When a precise resolve wasn't possible
    // (a bare pkg / path alias), `fallback` is set and the chain degrades to the honest direct edge.
    const chain = f.chain
    const sink = chain[chain.length - 1] ?? f.specifier
    diagnostics.push({
      rule: "server-only-import",
      severity: "error",
      file: f.file,
      line: f.line,
      message: `${f.snippet} - server-only "${sink}" reaches the browser bundle via ${chain.join(" → ")}${f.fallback ? " (direct edge - couldn't resolve the transitive chain precisely)" : ""}; ${SERVER_IMPORT_HINT}`,
      fix: SERVER_IMPORT_HINT,
      chain,
      suggestion: serverImportSuggestion(f.specifier, chain, f.fallback),
    })
  }
  if (sqlCompiler === undefined) {
    // A security rule that could not run must say so. Silence here is indistinguishable from a clean
    // result, and this is the one rule whose clean result means "no SQL injection was found".
    diagnostics.push({
      rule: "interpolated-sql",
      severity: "warning",
      message: SQL_COMPILER_MISSING_HINT,
      fix: SQL_COMPILER_MISSING_HINT,
      suggestion: {
        kind: "command",
        title: "Install TypeScript so the SQL rule can run",
        command: ["bun add -d typescript"],
      },
    })
  }
  for (const f of [...interpolatedSql].sort(bySite)) {
    diagnostics.push({
      rule: "interpolated-sql",
      severity: "error",
      file: f.file,
      line: f.line,
      message: `${f.snippet} - ${INTERPOLATED_SQL_HINT}`,
      fix: "bind the value as a parameter instead of interpolating it into the statement",
      suggestion: {
        kind: "manual",
        title: "Bind the value instead of interpolating it",
        steps: [
          "Replace the interpolation with a placeholder your driver understands (`?` for SQLite/MySQL, `$1` for Postgres).",
          "Pass the value as an argument alongside the statement, so the driver binds it.",
          `Or switch to the driver's tagged template (sql\`… ${SQL_INTERPOLATION_EXAMPLE} …\`): the tag receives substitutions separately and binds them.`,
          "An identifier that genuinely cannot be bound (a table or column name) must be checked against an allowlist you control, never taken from the request.",
          "If the statement is dynamic but every value is already bound (generating `($1),($2),…` for a batch insert), mark it with a `// nifra-expect sql-dynamic: <reason>` comment on the line above - the reason is required.",
        ],
      },
    })
  }
  // Advisory - surfaced but NOT folded into `ok`, so it never fails the gate (a raw Response is valid).
  for (const f of [...responseRoutes].sort(bySite)) {
    diagnostics.push({
      rule: "response-route",
      severity: "warning",
      file: f.file,
      line: f.line,
      message: `${f.snippet} - ${RESPONSE_ROUTE_HINT}`,
      fix: RESPONSE_ROUTE_HINT,
      suggestion: responseRouteSuggestion(),
    })
  }
  if (dr.ran) {
    for (const f of dr.findings) {
      diagnostics.push({
        rule: "undeclared-dependency",
        severity: "error",
        file: f.file,
        line: f.line,
        message: `imports ${f.package} which is not declared in package.json - ${UNDECLARED_DEP_HINT}`,
        fix: `add ${f.package} to package.json dependencies`,
        suggestion: {
          kind: "command",
          title: `Declare ${f.package} in package.json`,
          command: ["bun", "add", f.package],
        },
      })
    }
    for (const finding of dr.duplicateInstalls) {
      // One line per physical copy: version, resolved absolute path, and who pulled it in. The
      // absolute path is what a reader pastes into an editor or `rm -rf`; the importer list is what
      // tells them WHICH package.json to fix - a relative path alone answers neither.
      const copyLines = finding.copies.map(
        (copy) =>
          `${finding.package}@${copy.version} at ${copy.absolutePath ?? copy.path} - pulled in by ${copy.importers.join(", ")}`,
      )
      diagnostics.push({
        rule: "duplicate-install",
        severity: "error",
        message: `${finding.package} identity preflight found ${finding.cause} - ${finding.explanation}${finding.topology === undefined ? "" : `. Topology: ${finding.topology}`}${finding.scope === undefined ? "" : `. Scope: ${finding.scope}`}`,
        fix: finding.remediation,
        evidence: copyLines,
        suggestion: {
          kind: "manual",
          title: `Resolve ${finding.package} to one loaded copy`,
          // The renderer prints this block verbatim before the steps: the exact config for fix 2, so
          // the reader pastes instead of transcribing prose into JSON and TOML.
          diff: [
            "package.json:",
            `  "nifra": { "singleCopy": ["${finding.package}"] }`,
            "bunfig.toml:",
            `  preload = ["${SINGLE_COPY_REGISTER_SPECIFIER}"]`,
            "  [test]",
            `  preload = ["${SINGLE_COPY_REGISTER_SPECIFIER}"]`,
          ].join("\n"),
          steps: [
            ...copyLines.map((line) => `Copy: ${line}`),
            "Fix 1 - deduplicate: align workspace dependency and peer ranges on one compatible version, remove stale nested installs, and reinstall from the workspace root so every importer resolves one physical copy.",
            `Fix 2 - declare single-copy: apply the package.json and bunfig.toml config printed above; nifra then rewrites every duplicate to this app's copy.${finding.cause === "version-skew" ? " A declaration only covers same-version duplicates, so fix 1's range alignment must land first." : ""}`,
            "Re-run `nifra check`; the gate stays failing until one fix lands.",
          ],
        },
      })
    }
    // Declared single-copy: the resolver collapses these before anything loads, so the build is sound
    // and the gate stays green. It is still worth a line - the guarantee lives in a declaration now,
    // and a reader who deletes it gets a null hook dispatcher with no obvious cause.
    for (const finding of dr.deduplicatedInstalls ?? []) {
      const copies = finding.copies.map((copy) => copy.path).join("; ")
      diagnostics.push({
        rule: "duplicate-install",
        severity: "warning",
        message: `${finding.package} is installed at ${finding.copies.length} paths (${copies}) and is declared single-copy - nifra resolves every duplicate to this app's copy`,
        fix: finding.remediation,
      })
    }
    // Advisory (never fails the gate): while actively editing a linked package its dist is always
    // momentarily behind. The finding earns its keep when a dev server is about to start against it -
    // Bun reads live `src` while Vite's SSR runner reads the artifact, so a stale one 500s inside
    // framework/shared-package code and reads exactly like an upstream regression.
    for (const f of dr.staleDists) {
      // The rebuild is only actionable with the LOCATION: a workspace link routinely points into a
      // sibling repo, so "rebuild @nifrajs/core" left the developer to go find the checkout and guess
      // the script. Name the directory and the package's own script, or say plainly that it declares
      // none - never suggest a command that would fail.
      const rebuild =
        f.buildScript === undefined
          ? `${f.packageDir} declares no build script - build it the way that package expects`
          : `cd ${f.packageDir} && bun run ${f.buildScript}   (or \`nifra fix --code NF-C010\`)`
      diagnostics.push({
        rule: "stale-workspace-dist",
        severity: "warning",
        message: f.missing
          ? `${f.package} was never built - ${f.distFile} is missing, but its export map serves it to Vite SSR/node consumers while Bun reads src - ${rebuild}`
          : `${f.package} has a stale build artifact - ${f.distFile} is ${f.behindSeconds}s older than ${f.sourceFile}, and Vite SSR/node consumers read the artifact while Bun reads src - ${rebuild}`,
        fix: rebuild,
        evidence: [f.package, f.distFile, f.sourceFile, f.packageDir],
        suggestion: {
          kind: "manual",
          title: `Rebuild ${f.package}`,
          steps: [
            rebuild,
            "Only workspace-linked installs drift; npm tarballs are immutable and never flagged.",
          ],
        },
      })
    }
  }
  // The two-pipeline rule, read from the config as TEXT (doctor collects it - see ./pipeline-report.ts).
  // `loadApp` already refuses a misplaced plugin, but only when something loads the app; a check that
  // never executes project code, and CI that never starts a dev server, would otherwise meet these for
  // the first time as a production server that built cleanly and died at startup.
  for (const f of dr.pipeline?.findings ?? []) {
    diagnostics.push({
      rule: "pipeline",
      severity: f.severity,
      file: f.file,
      ...(f.line !== undefined ? { line: f.line } : {}),
      message: f.message,
      fix: f.fix,
      suggestion: { kind: "manual", title: f.fix, steps: [PIPELINE_DOC_HINT] },
    })
  }
  // #7: a committed server-manifest.ts that drifted from routes/ - name the exact missing/extra routes.
  for (const f of manifestDrift) {
    const parts: string[] = []
    if (f.missing.length > 0) parts.push(`missing from manifest: ${f.missing.join(", ")}`)
    if (f.extra.length > 0) parts.push(`stale in manifest: ${f.extra.join(", ")}`)
    diagnostics.push({
      rule: "server-manifest-drift",
      severity: "error",
      file: f.file,
      message: `${f.file} drifted from routes/ (${parts.join("; ")}) - ${MANIFEST_DRIFT_HINT}`,
      fix: MANIFEST_DRIFT_HINT,
      evidence: [...f.missing, ...f.extra],
      suggestion: {
        kind: "manual",
        title: "Regenerate the committed server manifest",
        steps: [
          "Re-run your build (`nifra build --target <t>` or your build script) - it regenerates server-manifest.ts from the current routes/.",
          "Commit the updated server-manifest.ts.",
        ],
      },
    })
  }

  // G+B+D+F: when the project opts into capability assurance, `nifra check` becomes the static
  // provenance firewall as well as the typed-contract gate. Loading is explicit/config-owned; projects
  // without nifra.assurance.ts retain the historical scan and hot path unchanged.
  const provided = opts.assurance
  let applicationRulePacks: readonly import("./rules/index.ts").RulePack[] = []
  let loadedPolicy = provided
  let loadedCapability: CapabilityProjectReport | undefined = provided?.capability
  const assuranceConfigPath = join(cwd, "nifra.assurance.ts")
  if (provided !== undefined ? provided.present : existsSync(assuranceConfigPath)) {
    try {
      // Either the shared reflection from `collectProjectVerification` (no second pass) or, on the
      // standalone path, loaded + reflected here. Both branches yield the same config + evidence.
      let config: AssuranceConfig
      let project: CapabilityProjectReport | undefined
      let routeAssurance: AssuranceReport | undefined
      let evidence: ProjectEvidenceSnapshot | undefined
      if (provided !== undefined) {
        // A load/evaluate failure travels as `provided.error`; re-throwing lands it in the same
        // capability-config diagnostic the standalone catch produces.
        if (provided.error !== undefined) throw provided.error
        config = provided.config as AssuranceConfig
        project = provided.capability
        routeAssurance = provided.routeAssurance
        evidence = provided.evidence
      } else {
        const { loadAssuranceConfig } = await import("./assure.ts")
        config = await loadAssuranceConfig(cwd)
        if (config.capabilities !== undefined) {
          const { collectCapabilityProjectReport } = await import("./capabilities-tool.ts")
          project = await collectCapabilityProjectReport(cwd, config.source, config.capabilities)
        }
        loadedPolicy = {
          present: true,
          config,
          ...(routeAssurance === undefined ? {} : { routeAssurance }),
          ...(project === undefined ? {} : { capability: project }),
          ...(evidence === undefined ? {} : { evidence }),
        }
        loadedCapability = project
      }
      applicationRulePacks = parseRulePacks(config.rulePacks)
      const capabilityReport = project?.report
      if (config.capabilities !== undefined && project !== undefined) {
        for (const finding of project.report.findings) {
          const violation =
            finding.code === "forbidden-effect-import"
              ? project.violations.find(
                  (candidate) =>
                    candidate.method === finding.method && candidate.path === finding.path,
                )
              : undefined
          const truncation =
            finding.code === "provenance-truncated"
              ? project.truncations.find(
                  (candidate) =>
                    candidate.method === finding.method && candidate.path === finding.path,
                )
              : undefined
          // An unmatched seam is a policy defect, not a route defect: the fix is in the policy file,
          // so it gets its own steps instead of the route-side provenance guidance.
          const seamFix =
            finding.code === "unmatched-provenance-seam"
              ? "Write the seam exactly as the code imports it, or delete the rule."
              : undefined
          diagnostics.push({
            rule: "capability-assurance",
            severity: "error",
            ...(violation !== undefined
              ? { file: violation.module, chain: violation.chain }
              : truncation !== undefined
                ? { chain: truncation.chain }
                : {}),
            message: `${finding.message}${seamFix === undefined ? ` - ${CAPABILITY_HINT}` : ""}`,
            fix: seamFix ?? CAPABILITY_HINT,
            suggestion:
              seamFix === undefined
                ? {
                    kind: "manual",
                    title: "Restore declared effect provenance",
                    steps: [
                      "Route effectful work through an import listed in capabilities.provenance.imports.",
                      "Declare the exact capability token on the route; do not widen unrelated routes in the same file.",
                      "For domain writes, add the adapter the capability definition requires: `schema.idempotency` for the `request` tier, `.use(durableCommand({ journal }))` from @nifrajs/middleware for the `durable` tier.",
                      "Run `nifra capabilities snapshot` only after assurance passes, then review the lockfile diff.",
                    ],
                  }
                : {
                    kind: "manual",
                    title: "Point the provenance rule at a module that exists",
                    steps: [
                      "Copy the specifier from the import statement itself - it is matched as written, with no extension or index resolution.",
                      "Use a trailing `/*` when the seam is a directory of modules (`@myorg/db/*`).",
                      "For a routeModules entry, give the project-relative path of the file that implements the route.",
                      "Delete the rule if the seam it governed is gone; leaving it in place proves nothing.",
                    ],
                  },
          })
        }
      }
      if (config.manifest !== undefined) {
        const { buildNifraManifest, parseNifraManifest, serializeNifraManifest } = await import(
          "@nifrajs/core/manifest"
        )
        const assurance =
          routeAssurance ??
          (await import("@nifrajs/core/assurance")).evaluateRouteAssurance(
            config.source,
            config.policy,
            {
              ...(config.capabilities !== undefined
                ? { definitions: config.capabilities.definitions }
                : {}),
            },
          )
        evidence ??= snapshotProjectEvidence(config.source, {
          assurance,
          ...(capabilityReport !== undefined ? { capabilities: capabilityReport } : {}),
        })
        const path = resolve(cwd, config.manifest.path ?? "nifra.manifest.json")
        let message: string | undefined
        if (!assurance.ok || (capabilityReport !== undefined && !capabilityReport.ok)) {
          message =
            "the configured assurance policy is failing, so a trusted manifest cannot be built"
        } else if (!existsSync(path)) {
          message = "the configured trust manifest is missing"
        } else {
          try {
            const current = await buildNifraManifest({
              evidence,
              assurance,
              ...(capabilityReport !== undefined ? { capabilities: capabilityReport } : {}),
            })
            const storedText = await Bun.file(path).text()
            const stored = await parseNifraManifest(storedText, path)
            const expectedText = `${serializeNifraManifest(current)}\n`
            if (storedText !== expectedText || stored.contentHash !== current.contentHash) {
              message = "the configured trust manifest does not match live route reflection"
            }
          } catch (error) {
            message = `the configured trust manifest is invalid: ${error instanceof Error ? error.message : String(error)}`
          }
        }
        if (message !== undefined) {
          diagnostics.push({
            rule: "manifest-drift",
            severity: "error",
            file: path,
            message: `${message} - ${TRUST_MANIFEST_DRIFT_HINT}`,
            fix: TRUST_MANIFEST_DRIFT_HINT,
            suggestion: {
              kind: "command",
              title: "Regenerate the signed-manifest input artifact",
              command: ["nifra", "manifest", "emit"],
              steps: [
                "Review the route, assurance, capability, and classification delta before committing it.",
              ],
            },
          })
        }
      }
    } catch (err) {
      loadedPolicy = { present: true, error: err }
      diagnostics.push({
        rule: "capability-config",
        severity: "error",
        file: "nifra.assurance.ts",
        message: `capability assurance config could not be evaluated: ${err instanceof Error ? err.message : String(err)}`,
        suggestion: {
          kind: "manual",
          title: "Repair the assurance config",
          steps: [
            "Ensure nifra.assurance.ts default-exports defineAssuranceConfig({ source, policy, capabilities }).",
            "Fix configuration/import errors; the provenance firewall fails closed when its policy cannot load.",
          ],
        },
      })
    }
  }

  try {
    const { checkContractsLock } = await import("./contracts.ts")
    if (!existsSync(join(cwd, "backend.ts")) && !existsSync(join(cwd, "contracts.lock.json"))) {
      throw new Error("contract source not configured")
    }
    const contract = await checkContractsLock(cwd)
    if (!contract.present) {
      structuredExtras.push(
        diagnostic({
          code: "NF-K001",
          severity: "info",
          message: "no contract lock; run `nifra contracts snapshot` to enable drift detection",
          verify: "nifra contracts snapshot",
        }),
      )
    } else {
      if (contract.vacuous) {
        // Every route hashes to the empty-schema digest, so the lock exists but the drift rule guards
        // nothing: it can only ever compare "no schema" to "no schema". Say so, or a green contract check
        // reads as proof of a stable contract when there is no contract to be stable.
        structuredExtras.push(
          diagnostic({
            code: "NF-K001",
            severity: "info",
            message:
              "no route schemas declared - the trust manifest is vacuous: every contract hash is the empty-schema digest, so drift detection guards nothing. Declare route schemas (body/query/params/response) so the lock has a contract to protect.",
            verify: "nifra check --lints-only",
          }),
        )
      }
      for (const finding of contract.diagnostics) {
        diagnostics.push({
          rule: "contract-drift",
          severity: "error",
          code: "NF-K001",
          ...(finding.route !== undefined ? { evidence: [finding.route] } : {}),
          message: finding.message,
          fix: "run `nifra contracts snapshot` after reviewing the contract change",
          verify: "nifra check --lints-only",
        })
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message === "contract source not configured") {
      // API-only source scans have no contract surface to snapshot.
    } else {
      diagnostics.push({
        rule: "contract-drift",
        severity: "error",
        code: "NF-K001",
        message: `contract lock could not be checked: ${error instanceof Error ? error.message : String(error)}`,
        verify: "nifra contracts snapshot",
      })
    }
  }

  const projectFacts = freezeProjectFacts(
    {
      ...factsSeed,
      policies: {
        ...factsSeed.policies,
        ...(loadedPolicy === undefined ? {} : { assurance: loadedPolicy }),
        ...(loadedCapability === undefined ? {} : { capability: loadedCapability }),
        rulePacks: applicationRulePacks,
      },
    },
    diagnostics,
  )
  const ruleContext: RuleContext = {
    root: cwd,
    sources: projectFacts.source,
    project: projectFacts,
  }
  const structuredDiagnostics = [...structuredExtras]
  let registryDiagnostics: Diagnostic[] = []
  try {
    registryDiagnostics = await runRuleRegistry(
      ruleContext,
      [...legacyRules, ...securityRules, ...routeRules, ...islandRules],
      projectFacts.policies.rulePacks,
    )
    structuredDiagnostics.push(...registryDiagnostics)
  } catch (error) {
    registryDiagnostics = [
      diagnostic({
        code: "NF-C017",
        severity: "error",
        message: `rule registry failed closed: ${error instanceof Error ? error.message : String(error)}`,
        fix: { recipe: "rule-pack.repair", command: "nifra check --lints-only" },
        verify: "nifra check --lints-only",
      }),
    ]
    structuredDiagnostics.push(...registryDiagnostics)
  }
  for (const item of registryDiagnostics) {
    // The legacy adapters publish stable structured findings; the human compatibility view already
    // contains their original rule names. Security rules and application packs still need a legacy-view
    // row because they have no pre-registry diagnostic.
    if (legacyRules.some((rule) => rule.code === item.code)) continue
    diagnostics.push({
      rule: item.code,
      severity: item.severity === "error" ? "error" : "warning",
      code: item.code,
      ...(item.file !== undefined ? { file: item.file } : {}),
      ...(item.line !== undefined ? { line: item.line } : {}),
      message: item.message,
      ...(item.evidence !== undefined ? { evidence: item.evidence } : {}),
      ...(item.verify !== undefined ? { verify: item.verify } : {}),
    })
  }

  // Per-rule overrides from `nifra.check.json` `rules`, applied centrally to BOTH diagnostic views
  // before `ok` is computed - never inside individual rules, so no rule can dodge (or double-apply)
  // them. A key matches the legacy rule name or the stable NF- code.
  const overrideFor = (...keys: (string | undefined)[]): RuleOverride | undefined => {
    for (const key of keys) {
      if (key !== undefined && checkConfig.rules[key] !== undefined) return checkConfig.rules[key]
    }
    return undefined
  }
  const ignoreGlobs = new Map<RuleOverride, Glob[]>()
  const dropped = (override: RuleOverride, file: string | undefined): boolean => {
    if (override.severity === "off") return true
    if (override.ignore === undefined || file === undefined) return false
    let globs = ignoreGlobs.get(override)
    if (globs === undefined) {
      globs = override.ignore.map((pattern) => new Glob(pattern))
      ignoreGlobs.set(override, globs)
    }
    return globs.some((glob) => glob.match(file))
  }
  const codeToLegacy = new Map(
    Object.entries(LEGACY_RULE_CODES).map(([name, code]) => [code, name]),
  )
  const finalDiagnostics = diagnostics.flatMap<CheckDiagnostic>((d) => {
    const override = overrideFor(d.rule, d.code, LEGACY_RULE_CODES[d.rule])
    if (override === undefined) return [d]
    if (dropped(override, d.file)) return []
    // "off" is fully handled by `dropped` above - only real severities reach the retag.
    if (override.severity === undefined || override.severity === "off") return [d]
    return [{ ...d, severity: override.severity === "warn" ? "warning" : override.severity }]
  })
  const finalStructured = structuredDiagnostics.flatMap<Diagnostic>((d) => {
    const override = overrideFor(d.code, codeToLegacy.get(d.code))
    if (override === undefined) return [d]
    if (dropped(override, d.file)) return []
    if (override.severity === undefined || override.severity === "off") return [d]
    return [Object.freeze({ ...d, severity: override.severity })]
  })

  // Cap the diagnostics when asked (the MCP path), so a project with thousands of findings can't return a
  // message that breaks the stdio transport. `ok` reflects the FULL set - truncation never flips it.
  const total = finalDiagnostics.length
  const max = opts.maxDiagnostics
  const shown = max !== undefined && total > max ? finalDiagnostics.slice(0, max) : finalDiagnostics
  const result: CheckResult = {
    ok: !finalDiagnostics.some((diagnostic) => diagnostic.severity === "error"),
    typecheck: tc.ran ? (tc.ok ? "pass" : "fail") : "skipped",
    ...(!tc.ran && tc.note !== undefined ? { typecheckNote: tc.note } : {}),
    diagnostics: shown,
    ...(dr.pipeline !== undefined ? { pipeline: dr.pipeline } : {}),
    ...(dr.ran
      ? {
          identityPreflight: {
            ...(dr.identityBasis !== undefined ? { basis: dr.identityBasis } : {}),
            ...(dr.identityScanTruncated === true ? { truncated: true } : {}),
            duplicates: dr.duplicateInstalls,
            deduplicated: dr.deduplicatedInstalls ?? [],
          },
        }
      : {}),
    ...(checkConfig.externalMounts.length > 0
      ? { externalMounts: checkConfig.externalMounts }
      : {}),
    ...(Object.keys(checkConfig.rules).length > 0 ? { ruleOverrides: checkConfig.rules } : {}),
    ...(shown.length < total ? { truncated: { shown: shown.length, total } } : {}),
  }
  Object.defineProperty(result, "structuredDiagnostics", {
    value: finalStructured.slice(0, shown.length + structuredExtras.length),
    enumerable: false,
  })
  return result
}

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { AssuranceConfig, AssuranceReport } from "@nifrajs/core/assurance"
import { type ProjectEvidenceSnapshot, snapshotProjectEvidence } from "@nifrajs/core/evidence"
import { SINGLE_COPY_REGISTER_SPECIFIER } from "@nifrajs/core/single-copy"
import type { CapabilityProjectReport } from "../capabilities-tool.ts"
import type { SourceFinding, StaticRouteFinding } from "../check-scan.ts"
import {
  IDENT,
  parseSimpleFetchCall,
  REMOVED_IMPORTS,
  SIMPLE_REWRITE_METHODS,
} from "../check-scan.ts"
import {
  type Diagnostic,
  type DiagnosticCompatibility,
  type DiagnosticSuggestion,
  diagnostic,
  diagnosticWithCompatibility,
} from "../diagnostics.ts"
import type { DuplicateInstallFinding } from "../doctor.ts"
import type { CheckRule, RuleContext } from "./index.ts"

/** Legacy rule name → stable NF- code. Exported so `nifra.check.json` rule overrides can be keyed
 * by either name and still hit both diagnostic views. */
export const LEGACY_RULE_CODES: Readonly<Record<string, string>> = Object.freeze({
  typecheck: "NF-C001",
  "typed-client": "NF-C002",
  "untyped-client": "NF-C003",
  "server-only-import": "NF-C004",
  "removed-import": "NF-C005",
  "interpolated-sql": "NF-C006",
  "response-route": "NF-C007",
  "undeclared-dependency": "NF-C008",
  "duplicate-install": "NF-C009",
  "stale-workspace-dist": "NF-C010",
  pipeline: "NF-C011",
  "server-manifest-drift": "NF-C012",
  "manifest-drift": "NF-C013",
  "capability-assurance": "NF-C014",
  "capability-config": "NF-C015",
  "check-config": "NF-C016",
  "contract-drift": "NF-K001",
})

const TITLES: Readonly<Record<string, string>> = Object.freeze({
  typecheck: "TypeScript contract check",
  "typed-client": "Typed client check",
  "untyped-client": "Untyped client check",
  "server-only-import": "Server-only import check",
  "removed-import": "Removed import check",
  "interpolated-sql": "Interpolated SQL check",
  "response-route": "Raw response route advisory",
  "undeclared-dependency": "Undeclared dependency check",
  "duplicate-install": "Duplicate install check",
  "stale-workspace-dist": "Stale workspace build check",
  pipeline: "Build pipeline check",
  "server-manifest-drift": "Server manifest drift check",
  "manifest-drift": "Trust manifest drift check",
  "capability-assurance": "Capability assurance check",
  "capability-config": "Assurance configuration check",
  "check-config": "Check configuration check",
  "contract-drift": "Contract snapshot drift",
})

/** The order used by the original human/legacy result. Structured diagnostics keep registry order. */
export const LEGACY_RULE_ORDER: readonly string[] = Object.freeze([
  "check-config",
  "typecheck",
  "typed-client",
  "removed-import",
  "untyped-client",
  "server-only-import",
  "interpolated-sql",
  "response-route",
  "undeclared-dependency",
  "duplicate-install",
  "stale-workspace-dist",
  "pipeline",
  "server-manifest-drift",
  "capability-assurance",
  "manifest-drift",
  "capability-config",
  "contract-drift",
])

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

const TSC_LINE = /^(.+?)\((\d+),\d+\):\s*(?:error|warning)\s+TS\d+:\s*(.+)$/
const UNTYPED_CLIENT_HINT =
  'client("…") without a type argument - write client<typeof app>("…") (or client(contract, url)) so the compiler can catch drift'

type LegacySeverity = "error" | "warning" | "info"

interface LegacyFields {
  readonly severity: LegacySeverity
  readonly file?: string
  readonly line?: number
  readonly message: string
  readonly evidence?: readonly string[]
  readonly chain?: readonly string[]
  readonly fix?: string
  readonly suggestion?: DiagnosticSuggestion
  readonly verify?: string
  readonly includeCode?: boolean
}

function canonicalRecipe(rule: string): Diagnostic["fix"] {
  if (rule === "stale-workspace-dist")
    return { recipe: "workspace-dist.rebuild", command: "nifra fix --code NF-C010" }
  if (rule === "server-manifest-drift")
    return { recipe: "manifest.sync", command: "nifra sync-manifest" }
  if (rule === "contract-drift")
    return { recipe: "contracts.snapshot", command: "nifra contracts snapshot" }
  return undefined
}

/** Build the stable structured diagnostic and attach only the data the legacy renderer needs. */
function legacyDiagnostic(rule: string, fields: LegacyFields): Diagnostic {
  const code = LEGACY_RULE_CODES[rule]
  if (code === undefined) throw new Error(`unknown legacy rule ${rule}`)
  const evidence = fields.evidence ?? fields.chain
  const fix = canonicalRecipe(rule)
  const canonical: Diagnostic = {
    code,
    severity: fields.severity === "warning" ? "warn" : fields.severity,
    message: fields.message,
    ...(fields.file === undefined ? {} : { file: fields.file }),
    ...(fields.line === undefined ? {} : { line: fields.line }),
    ...(evidence === undefined ? {} : { evidence: Object.freeze([...evidence]) }),
    ...(fix === undefined ? {} : { fix }),
    ...(fields.verify === undefined ? {} : { verify: fields.verify }),
  }
  const compatibility: DiagnosticCompatibility = {
    rule,
    ...(fields.fix === undefined ? {} : { fix: fields.fix }),
    ...(fields.suggestion === undefined ? {} : { suggestion: fields.suggestion }),
    ...(fields.chain === undefined ? {} : { chain: fields.chain }),
    ...(fields.includeCode === true ? { includeCode: true } : {}),
  }
  return diagnosticWithCompatibility(canonical, compatibility)
}

const bySite = (a: SourceFinding, b: SourceFinding): number =>
  a.file.localeCompare(b.file) || a.line - b.line

function oneLineDiff(file: string, line: number, before: string, after: string): string {
  return `--- ${file}:${line}\n+++ ${file}:${line}\n@@\n-${before}\n+${after}`
}

function untypedClientSuggestion(f: SourceFinding): DiagnosticSuggestion {
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
): DiagnosticSuggestion | undefined {
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
): DiagnosticSuggestion {
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
): DiagnosticSuggestion {
  const sink = chain[chain.length - 1] ?? specifier
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
      ...(chainStep === undefined ? [] : [chainStep]),
      `Remove the top-level \`import … from "${specifier}"\` from this route module (it's bundled for the browser).`,
      "Access backend/data work through the route `loader`/`action` context (`api`, `env`, or project server context).",
      `If a direct module import is unavoidable, lazy-load it (\`await import("${specifier}")\`) inside the server-only loader/action path.`,
    ],
  }
}

function responseRouteSuggestion(): DiagnosticSuggestion {
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

const typecheckRule: CheckRule = {
  code: LEGACY_RULE_CODES.typecheck!,
  title: TITLES.typecheck!,
  async scan(ctx) {
    const tc = ctx.project.check.typecheck
    const findings: Diagnostic[] = []
    if (tc.missingTypeScript === true) {
      findings.push(
        legacyDiagnostic("typecheck", {
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
        }),
      )
    }
    if (tc.ran && !tc.ok) {
      const lines = (tc.output ?? "").split("\n")
      let matched = false
      for (const line of lines) {
        const match = TSC_LINE.exec(line.trim())
        if (match === null) continue
        matched = true
        findings.push(
          legacyDiagnostic("typecheck", {
            severity: "error",
            file: match[1] as string,
            line: Number(match[2]),
            message: match[3] as string,
            suggestion: {
              kind: "manual",
              title: "Fix the TypeScript contract error",
              steps: [
                "Open the reported file and line.",
                "Align the handler, route schema, or typed-client call with the compiler error.",
                "Run `nifra_check` again after the edit.",
              ],
            },
          }),
        )
      }
      if (!matched) {
        findings.push(
          legacyDiagnostic("typecheck", {
            severity: "error",
            message: tc.output || "typecheck failed",
            suggestion: {
              kind: "manual",
              title: "Fix the TypeScript contract error",
              steps: ["Run `tsc --noEmit` locally for the full compiler output."],
            },
          }),
        )
      }
    }
    return findings
  },
}

const typedClientRule: CheckRule = {
  code: LEGACY_RULE_CODES["typed-client"]!,
  title: TITLES["typed-client"]!,
  async scan(ctx) {
    const routes = staticRouteMap(ctx.project.routes)
    return [...ctx.project.sourceFindings.fetches].sort(bySite).map((finding) =>
      legacyDiagnostic("typed-client", {
        severity: "error",
        file: finding.file,
        line: finding.line,
        message: `${finding.snippet} - ${FETCH_HINT}`,
        fix: FETCH_HINT,
        suggestion: ownFetchSuggestion(finding, routes),
      }),
    )
  },
}

const removedImportRule: CheckRule = {
  code: LEGACY_RULE_CODES["removed-import"]!,
  title: TITLES["removed-import"]!,
  async scan(ctx) {
    return [...ctx.project.sourceFindings.removedImports].sort(bySite).map((finding) => {
      const entry = REMOVED_IMPORTS.find(
        (candidate) =>
          finding.snippet.includes(`"${candidate.specifier}`) ||
          finding.snippet.includes(`'${candidate.specifier}`),
      )
      const replacement = entry?.replacement ?? "see the changelog"
      return legacyDiagnostic("removed-import", {
        severity: "error",
        file: finding.file,
        line: finding.line,
        message: `${finding.snippet} - removed in nifra ${entry?.since ?? "2.0"}: ${replacement}`,
        fix: replacement,
      })
    })
  },
}

const untypedClientRule: CheckRule = {
  code: LEGACY_RULE_CODES["untyped-client"]!,
  title: TITLES["untyped-client"]!,
  async scan(ctx) {
    return [...ctx.project.sourceFindings.untypedClients].sort(bySite).map((finding) =>
      legacyDiagnostic("untyped-client", {
        severity: "error",
        file: finding.file,
        line: finding.line,
        message: `${finding.snippet} - ${UNTYPED_CLIENT_HINT}`,
        fix: UNTYPED_CLIENT_HINT,
        suggestion: untypedClientSuggestion(finding),
      }),
    )
  },
}

const serverOnlyImportRule: CheckRule = {
  code: LEGACY_RULE_CODES["server-only-import"]!,
  title: TITLES["server-only-import"]!,
  async scan(ctx) {
    return [...ctx.project.importGraph].sort(bySite).map((finding) => {
      const chain = finding.chain
      const sink = chain[chain.length - 1] ?? finding.specifier
      return legacyDiagnostic("server-only-import", {
        severity: "error",
        file: finding.file,
        line: finding.line,
        message: `${finding.snippet} - server-only "${sink}" reaches the browser bundle via ${chain.join(" → ")}${finding.fallback ? " (direct edge - couldn't resolve the transitive chain precisely)" : ""}; ${SERVER_IMPORT_HINT}`,
        fix: SERVER_IMPORT_HINT,
        chain,
        suggestion: serverImportSuggestion(finding.specifier, chain, finding.fallback),
      })
    })
  },
}

const interpolatedSqlRule: CheckRule = {
  code: LEGACY_RULE_CODES["interpolated-sql"]!,
  title: TITLES["interpolated-sql"]!,
  async scan(ctx) {
    const findings: Diagnostic[] = []
    if (!ctx.project.check.sqlCompilerAvailable) {
      findings.push(
        legacyDiagnostic("interpolated-sql", {
          severity: "warning",
          message: SQL_COMPILER_MISSING_HINT,
          fix: SQL_COMPILER_MISSING_HINT,
          suggestion: {
            kind: "command",
            title: "Install TypeScript so the SQL rule can run",
            // Keep the one-element command array used by the legacy renderer for exact output.
            command: ["bun add -d typescript"],
          },
        }),
      )
    }
    for (const finding of [...ctx.project.sourceFindings.interpolatedSql].sort(bySite)) {
      findings.push(
        legacyDiagnostic("interpolated-sql", {
          severity: "error",
          file: finding.file,
          line: finding.line,
          message: `${finding.snippet} - ${INTERPOLATED_SQL_HINT}`,
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
        }),
      )
    }
    return findings
  },
}

const responseRouteRule: CheckRule = {
  code: LEGACY_RULE_CODES["response-route"]!,
  title: TITLES["response-route"]!,
  async scan(ctx) {
    return [...ctx.project.sourceFindings.responseRoutes].sort(bySite).map((finding) =>
      legacyDiagnostic("response-route", {
        severity: "warning",
        file: finding.file,
        line: finding.line,
        message: `${finding.snippet} - ${RESPONSE_ROUTE_HINT}`,
        fix: RESPONSE_ROUTE_HINT,
        suggestion: responseRouteSuggestion(),
      }),
    )
  },
}

function copyLines(finding: DuplicateInstallFinding): string[] {
  return finding.copies.map(
    (copy) =>
      `${finding.package}@${copy.version} at ${copy.absolutePath ?? copy.path} - pulled in by ${copy.importers.join(", ")}`,
  )
}

function duplicateSuggestion(finding: DuplicateInstallFinding): DiagnosticSuggestion {
  const lines = copyLines(finding)
  return {
    kind: "manual",
    title: `Resolve ${finding.package} to one loaded copy`,
    diff: [
      "package.json:",
      `  "nifra": { "singleCopy": ["${finding.package}"] }`,
      "bunfig.toml:",
      `  preload = ["${SINGLE_COPY_REGISTER_SPECIFIER}"]`,
      "  [test]",
      `  preload = ["${SINGLE_COPY_REGISTER_SPECIFIER}"]`,
    ].join("\n"),
    steps: [
      ...lines.map((line) => `Copy: ${line}`),
      "Fix 1 - deduplicate: align workspace dependency and peer ranges on one compatible version, remove stale nested installs, and reinstall from the workspace root so every importer resolves one physical copy.",
      `Fix 2 - declare single-copy: apply the package.json and bunfig.toml config printed above; nifra then rewrites every duplicate to this app's copy.${finding.cause === "version-skew" ? " A declaration only covers same-version duplicates, so fix 1's range alignment must land first." : ""}`,
      "Re-run `nifra check`; the gate stays failing until one fix lands.",
    ],
  }
}

const doctorRules: readonly CheckRule[] = Object.freeze([
  {
    code: LEGACY_RULE_CODES["undeclared-dependency"]!,
    title: TITLES["undeclared-dependency"]!,
    async scan(ctx: RuleContext) {
      const doctor = ctx.project.packages.doctor
      if (!doctor.ran) return []
      return doctor.findings.map((finding) =>
        legacyDiagnostic("undeclared-dependency", {
          severity: "error",
          file: finding.file,
          line: finding.line,
          message: `imports ${finding.package} which is not declared in package.json - ${UNDECLARED_DEP_HINT}`,
          fix: `add ${finding.package} to package.json dependencies`,
          suggestion: {
            kind: "command",
            title: `Declare ${finding.package} in package.json`,
            command: ["bun", "add", finding.package],
          },
        }),
      )
    },
  },
  {
    code: LEGACY_RULE_CODES["duplicate-install"]!,
    title: TITLES["duplicate-install"]!,
    async scan(ctx: RuleContext) {
      const doctor = ctx.project.packages.doctor
      if (!doctor.ran) return []
      const findings: Diagnostic[] = []
      for (const finding of doctor.duplicateInstalls) {
        const copies = copyLines(finding)
        findings.push(
          legacyDiagnostic("duplicate-install", {
            severity: "error",
            message: `${finding.package} identity preflight found ${finding.cause} - ${finding.explanation}${finding.topology === undefined ? "" : `. Topology: ${finding.topology}`}${finding.scope === undefined ? "" : `. Scope: ${finding.scope}`}`,
            fix: finding.remediation,
            evidence: copies,
            suggestion: duplicateSuggestion(finding),
          }),
        )
      }
      for (const finding of doctor.deduplicatedInstalls ?? []) {
        const paths = finding.copies.map((copy) => copy.path).join("; ")
        findings.push(
          legacyDiagnostic("duplicate-install", {
            severity: "warning",
            message: `${finding.package} is installed at ${finding.copies.length} paths (${paths}) and is declared single-copy - nifra resolves every duplicate to this app's copy`,
            fix: finding.remediation,
          }),
        )
      }
      return findings
    },
  },
  {
    code: LEGACY_RULE_CODES["stale-workspace-dist"]!,
    title: TITLES["stale-workspace-dist"]!,
    async scan(ctx: RuleContext) {
      const doctor = ctx.project.packages.doctor
      if (!doctor.ran) return []
      return doctor.staleDists.map((finding) => {
        const rebuild =
          finding.buildScript === undefined
            ? `${finding.packageDir} declares no build script - build it the way that package expects`
            : `cd ${finding.packageDir} && bun run ${finding.buildScript}   (or \`nifra fix --code NF-C010\`)`
        return legacyDiagnostic("stale-workspace-dist", {
          severity: "warning",
          message: finding.missing
            ? `${finding.package} was never built - ${finding.distFile} is missing, but its export map serves it to Vite SSR/node consumers while Bun reads src - ${rebuild}`
            : `${finding.package} has a stale build artifact - ${finding.behindSeconds}s older than ${finding.sourceFile}, and Vite SSR/node consumers read the artifact while Bun reads src - ${rebuild}`,
          fix: rebuild,
          evidence: [finding.package, finding.distFile, finding.sourceFile, finding.packageDir],
          suggestion: {
            kind: "manual",
            title: `Rebuild ${finding.package}`,
            steps: [
              rebuild,
              "Only workspace-linked installs drift; npm tarballs are immutable and never flagged.",
            ],
          },
        })
      })
    },
  },
])

const pipelineRule: CheckRule = {
  code: LEGACY_RULE_CODES.pipeline!,
  title: TITLES.pipeline!,
  async scan(ctx) {
    return (ctx.project.packages.doctor.pipeline?.findings ?? []).map((finding) =>
      legacyDiagnostic("pipeline", {
        severity: finding.severity,
        file: finding.file,
        ...(finding.line === undefined ? {} : { line: finding.line }),
        message: finding.message,
        fix: finding.fix,
        suggestion: { kind: "manual", title: finding.fix, steps: [PIPELINE_DOC_HINT] },
      }),
    )
  },
}

const serverManifestRule: CheckRule = {
  code: LEGACY_RULE_CODES["server-manifest-drift"]!,
  title: TITLES["server-manifest-drift"]!,
  async scan(ctx) {
    return ctx.project.packages.manifestDrift.map((finding) => {
      const parts: string[] = []
      if (finding.missing.length > 0)
        parts.push(`missing from manifest: ${finding.missing.join(", ")}`)
      if (finding.extra.length > 0) parts.push(`stale in manifest: ${finding.extra.join(", ")}`)
      return legacyDiagnostic("server-manifest-drift", {
        severity: "error",
        file: finding.file,
        message: `${finding.file} drifted from routes/ (${parts.join("; ")}) - ${MANIFEST_DRIFT_HINT}`,
        fix: MANIFEST_DRIFT_HINT,
        evidence: [...finding.missing, ...finding.extra],
        suggestion: {
          kind: "manual",
          title: "Regenerate the committed server manifest",
          steps: [
            "Re-run your build (`nifra build --target <t>` or your build script) - it regenerates server-manifest.ts from the current routes/.",
            "Commit the updated server-manifest.ts.",
          ],
        },
      })
    })
  },
}

function capabilityContext(ctx: RuleContext):
  | {
      readonly config: AssuranceConfig
      readonly project?: CapabilityProjectReport
      readonly routeAssurance?: AssuranceReport
      readonly evidence?: ProjectEvidenceSnapshot
    }
  | undefined {
  const assurance = ctx.project.policies.assurance
  if (assurance === undefined || !assurance.present || assurance.error !== undefined)
    return undefined
  if (assurance.config === undefined) return undefined
  return {
    config: assurance.config,
    ...(assurance.capability === undefined ? {} : { project: assurance.capability }),
    ...(assurance.routeAssurance === undefined ? {} : { routeAssurance: assurance.routeAssurance }),
    ...(assurance.evidence === undefined ? {} : { evidence: assurance.evidence }),
  }
}

const capabilityAssuranceRule: CheckRule = {
  code: LEGACY_RULE_CODES["capability-assurance"]!,
  title: TITLES["capability-assurance"]!,
  async scan(ctx) {
    const context = capabilityContext(ctx)
    const project = context?.project
    const config = context?.config
    if (project === undefined || config?.capabilities === undefined) return []
    const findings: Diagnostic[] = []
    for (const finding of project.report.findings) {
      const violation =
        finding.code === "forbidden-effect-import"
          ? project.violations.find(
              (candidate) => candidate.method === finding.method && candidate.path === finding.path,
            )
          : undefined
      const truncation =
        finding.code === "provenance-truncated"
          ? project.truncations.find(
              (candidate) => candidate.method === finding.method && candidate.path === finding.path,
            )
          : undefined
      const seamFix =
        finding.code === "unmatched-provenance-seam"
          ? "Write the seam exactly as the code imports it, or delete the rule."
          : undefined
      findings.push(
        legacyDiagnostic("capability-assurance", {
          severity: "error",
          ...(violation === undefined
            ? truncation === undefined
              ? {}
              : { chain: truncation.chain }
            : { file: violation.module, chain: violation.chain }),
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
        }),
      )
    }
    return findings
  },
}

const manifestRule: CheckRule = {
  code: LEGACY_RULE_CODES["manifest-drift"]!,
  title: TITLES["manifest-drift"]!,
  async scan(ctx) {
    const context = capabilityContext(ctx)
    if (context === undefined || context.config.manifest === undefined) return []
    const { config, project, routeAssurance: knownAssurance } = context
    const capabilityReport = project?.report
    let assurance = knownAssurance
    let evidence = context.evidence
    try {
      if (assurance === undefined) {
        const { evaluateRouteAssurance } = await import("@nifrajs/core/assurance")
        assurance = evaluateRouteAssurance(config.source, config.policy, {
          ...(config.capabilities === undefined
            ? {}
            : { definitions: config.capabilities.definitions }),
        })
      }
      evidence ??= snapshotProjectEvidence(config.source, {
        assurance,
        ...(capabilityReport === undefined ? {} : { capabilities: capabilityReport }),
      })
      const manifest = config.manifest
      if (manifest === undefined) return []
      const path = resolve(ctx.root, manifest.path ?? "nifra.manifest.json")
      let message: string | undefined
      if (!assurance.ok || (capabilityReport !== undefined && !capabilityReport.ok)) {
        message =
          "the configured assurance policy is failing, so a trusted manifest cannot be built"
      } else if (!existsSync(path)) {
        message = "the configured trust manifest is missing"
      } else {
        try {
          const { buildNifraManifest, parseNifraManifest, serializeNifraManifest } = await import(
            "@nifrajs/core/manifest"
          )
          const current = await buildNifraManifest({
            evidence,
            assurance,
            ...(capabilityReport === undefined ? {} : { capabilities: capabilityReport }),
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
      if (message === undefined) return []
      return [
        legacyDiagnostic("manifest-drift", {
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
        }),
      ]
    } catch {
      // A config-load failure is owned and reported by capability-config. Do not duplicate it as a
      // manifest failure, because there is no trustworthy input from which to compare a manifest.
      return []
    }
  },
}

const capabilityConfigRule: CheckRule = {
  code: LEGACY_RULE_CODES["capability-config"]!,
  title: TITLES["capability-config"]!,
  async scan(ctx) {
    const assurance = ctx.project.policies.assurance
    if (assurance === undefined || !assurance.present) return []
    if (assurance.error === undefined && assurance.config !== undefined) return []
    const error = assurance.error
    return [
      legacyDiagnostic("capability-config", {
        severity: "error",
        file: "nifra.assurance.ts",
        message: `capability assurance config could not be evaluated: ${error instanceof Error ? error.message : String(error ?? "configuration unavailable")}`,
        suggestion: {
          kind: "manual",
          title: "Repair the assurance config",
          steps: [
            "Ensure nifra.assurance.ts default-exports defineAssuranceConfig({ source, policy, capabilities }).",
            "Fix configuration/import errors; the provenance firewall fails closed when its policy cannot load.",
          ],
        },
      }),
    ]
  },
}

const checkConfigRule: CheckRule = {
  code: LEGACY_RULE_CODES["check-config"]!,
  title: TITLES["check-config"]!,
  async scan(ctx) {
    const { checkConfigError, checkConfigWarnings } = ctx.project.check
    const findings: Diagnostic[] = []
    if (checkConfigError !== undefined) {
      findings.push(
        legacyDiagnostic("check-config", {
          severity: "warning",
          file: "nifra.check.json",
          message: `nifra.check.json could not be parsed (${checkConfigError}) - its external-mount allowlist was ignored`,
          fix: "Fix the JSON syntax in nifra.check.json",
        }),
      )
    }
    for (const warning of checkConfigWarnings) {
      findings.push(
        legacyDiagnostic("check-config", {
          severity: "warning",
          file: "nifra.check.json",
          message: `nifra.check.json: ${warning}`,
          fix: "Fix the entry in nifra.check.json",
        }),
      )
    }
    return findings
  },
}

const contractRule: CheckRule = {
  code: LEGACY_RULE_CODES["contract-drift"]!,
  title: TITLES["contract-drift"]!,
  async scan(ctx) {
    const contract = ctx.project.check.contracts
    if (!contract.present) {
      return [
        diagnostic({
          code: LEGACY_RULE_CODES["contract-drift"]!,
          severity: "info",
          message: "no contract lock; run `nifra contracts snapshot` to enable drift detection",
          verify: "nifra contracts snapshot",
        }),
      ]
    }
    if (contract.vacuous) {
      return [
        diagnostic({
          code: LEGACY_RULE_CODES["contract-drift"]!,
          severity: "info",
          message:
            "no route schemas declared - the trust manifest is vacuous: every contract hash is the empty-schema digest, so drift detection guards nothing. Declare route schemas (body/query/params/response) so the lock has a contract to protect.",
          verify: "nifra check --lints-only",
        }),
      ]
    }
    if (contract.error !== undefined) {
      return [
        legacyDiagnostic("contract-drift", {
          severity: "error",
          message: `contract lock could not be checked: ${contract.error}`,
          includeCode: true,
          verify: "nifra contracts snapshot",
        }),
      ]
    }
    return contract.diagnostics.map((finding) =>
      legacyDiagnostic("contract-drift", {
        severity: "error",
        ...(finding.route === undefined ? {} : { evidence: [finding.route] }),
        message: finding.message,
        fix: "run `nifra contracts snapshot` after reviewing the contract change",
        includeCode: true,
        verify: "nifra check --lints-only",
      }),
    )
  },
}

/** Built-in rules that used to be formatted imperatively in check-diagnostics.ts. */
export const legacyRules: readonly CheckRule[] = Object.freeze([
  typecheckRule,
  typedClientRule,
  untypedClientRule,
  serverOnlyImportRule,
  removedImportRule,
  interpolatedSqlRule,
  responseRouteRule,
  ...doctorRules,
  pipelineRule,
  serverManifestRule,
  manifestRule,
  capabilityAssuranceRule,
  capabilityConfigRule,
  checkConfigRule,
  contractRule,
])

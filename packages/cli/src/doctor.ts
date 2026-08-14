/**
 * `nifra doctor` - catches the Bun-workspace footgun the typed-client lint can't: a package that's
 * IMPORTED in source but NOT declared in `package.json`. Bun resolves it at runtime (via hoisting or a
 * workspace), so tests pass and `bun install` reports "no changes" - false confidence - yet `tsc` fails
 * and a fresh or standalone install can't resolve it. doctor diffs every bare import specifier against
 * the package's declared dependencies and flags the gap, with a stable `--json` shape for agents/CI.
 *
 * Scope is intentionally per-package: it checks the `package.json` at `cwd`, because a dependency must be
 * declared by the package that imports it (for `tsc` and for that package to install on its own) even
 * when a monorepo would hoist it. Relative paths, runtime builtins (node core, `node:`/`bun:`, `bun`),
 * the package's own name, and tsconfig `paths` aliases are excluded - none of them are npm deps.
 *
 * The diff is against DECLARED dependency sets only; what happens to be installed on disk is never
 * consulted. That is the point: a package pulled in transitively by some other dependency resolves fine
 * locally while no manifest declares it, so resolvability is not evidence of declaration. The scan
 * therefore also covers `*.test.ts`/`*.spec.ts`, which `nifra check` skips - `tsc` compiles them, so an
 * undeclared import there fails a clean `bun install --frozen-lockfile` build just the same.
 */
import type { Dirent } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { builtinModules } from "node:module"
import { dirname, join, relative, sep } from "node:path"
import {
  collectIdentityParity,
  displayPath,
  type IdentityParityCopy,
  type IdentityParityFinding,
  resolvedInstalledCopy,
} from "@nifrajs/web/internal/parity"
import { codePositionMask, type SourceFinding, stripComments, walkSource } from "./check.ts"
import { detectToolingDrift, type ToolingDrift } from "./mcp-root.ts"
import { collectPipelineReport, type PipelineReport } from "./pipeline-report.ts"
import { type ResolvedTarget, resolveTarget } from "./port.ts"
import { buildScriptName } from "./workspace-link.ts"

// Runtime-provided modules that are never an npm dependency: Node core (bare + `node:` form) and Bun's
// own `bun` module. `node:`/`bun:`-prefixed specifiers are filtered in packageOf by prefix.
const BUILTINS: ReadonlySet<string> = new Set<string>([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  "bun",
])

// The four specifier-bearing forms: static import/re-export with a source, side-effect import, dynamic
// import, and CJS require. Anchored with `(?<![.\w$])` so `myimport`/`.import`/`foorequire` never match.
// Comments are stripped before these run (see stripComments) - else a doc-comment usage example would be
// flagged as a real import.
const IMPORT_PATTERNS: readonly RegExp[] = [
  /(?<![.\w$])(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /(?<![.\w$])import\s+['"]([^'"]+)['"]/g,
  /(?<![.\w$])import\s*\(\s*['"]([^'"]+)['"]/g,
  /(?<![.\w$])require\s*\(\s*['"]([^'"]+)['"]/g,
]

const NPM_PACKAGE_NAME = /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const

const isNpmPackageName = (name: string): boolean =>
  NPM_PACKAGE_NAME.test(name) &&
  name.split("/").every((part) => part !== "" && part !== "." && part !== "..")

/**
 * Resolve an import specifier to the npm package name it would install as, or `undefined` when it isn't
 * an npm dependency at all (a relative/absolute path, a runtime builtin, or a malformed scope like the
 * `@/…` path-alias convention). `@scope/name/sub` → `@scope/name`; `name/sub` → `name`.
 */
export function packageOf(spec: string): string | undefined {
  if (spec === "" || spec.startsWith(".") || spec.startsWith("/")) return undefined
  if (spec.startsWith("node:") || spec.startsWith("bun:")) return undefined
  if (spec.startsWith("@")) {
    const [scope, name] = spec.split("/")
    if (!scope || scope === "@" || !name) return undefined // `@/alias`, `@foo` - not a real package
    const pkg = `${scope}/${name}`
    return isNpmPackageName(pkg) ? pkg : undefined
  }
  const name = spec.split("/")[0] as string
  if (!isNpmPackageName(name)) return undefined
  return BUILTINS.has(name) ? undefined : name
}

/** Build a predicate matching tsconfig `paths` aliases (e.g. `@/*`, `~/utils`), which resolve to local
 * source, not npm packages - so doctor must not flag them. */
export function aliasMatcher(
  paths: Readonly<Record<string, unknown>> | undefined,
): (spec: string) => boolean {
  const prefixes = Object.keys(paths ?? {})
    .map((k) => k.replace(/\/?\*$/, ""))
    .filter((p) => p !== "")
  return (spec) => prefixes.some((p) => spec === p || spec.startsWith(`${p}/`))
}

/**
 * Scan one file for bare imports whose resolved package is neither `declared` nor a path `alias`. Pure +
 * line-accurate. Deduped per (package, line): the `snippet` carries the undeclared package name.
 */
export function scanUndeclaredImports(
  file: string,
  content: string,
  declared: ReadonlySet<string>,
  isAlias: (spec: string) => boolean,
): SourceFinding[] {
  const out: SourceFinding[] = []
  const seen = new Set<string>()
  const code = stripComments(content) // so doc-comment usage examples aren't read as real imports
  const positions = codePositionMask(content)
  for (const rx of IMPORT_PATTERNS) {
    rx.lastIndex = 0
    for (let m = rx.exec(code); m !== null; m = rx.exec(code)) {
      // The specifier regex must run over quoted literals, but its import/require token must begin in
      // executable code. Otherwise documentation and code-generator strings look like real imports.
      if (positions[m.index] === " ") continue
      const spec = m[1] ?? ""
      if (isAlias(spec)) continue
      const pkg = packageOf(spec)
      if (pkg === undefined || declared.has(pkg)) continue
      const line = content.slice(0, m.index).split("\n").length
      const key = `${pkg}@${line}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ file, line, snippet: pkg })
    }
  }
  return out.sort((a, b) => a.line - b.line || a.snippet.localeCompare(b.snippet))
}

export interface DoctorFinding {
  readonly file: string
  readonly line: number
  /** The undeclared package name - add it to `package.json` dependencies. */
  readonly package: string
}

export interface DoctorResult {
  readonly ok: boolean
  /** `false` when no `package.json` was found at cwd - doctor can't run (reported, not a crash). */
  readonly ran: boolean
  readonly findings: readonly DoctorFinding[]
  /** Packages that resolve to more than one physical install across this workspace. */
  readonly duplicateInstalls: readonly DuplicateInstallFinding[]
  /** Workspace-linked deps whose `default`-condition artifact lags their `bun`-condition source.
   * Advisory (never folded into `ok`): while actively editing a linked package its dist is always
   * momentarily behind - the finding matters when a dev server starts against it. */
  readonly staleDists: readonly StaleDistFinding[]
  /**
   * The running CLI is a different feature version than the `@nifrajs/cli` (or `@nifrajs/core`) the
   * project installs. Advisory (never folded into `ok`): a stale global/bunx binary answering about a
   * project it does not match is an environment problem, not a defect in the project - but every
   * answer it gives (types, checks, docs) reads as authoritative. Present only when `cliVersion` was
   * supplied and the feature versions disagree. Computed by {@link detectToolingDrift}.
   */
  readonly toolingDrift?: ToolingDrift
  /** Static production-readiness evidence for the selected deploy target. */
  readonly readiness?: DoctorReadiness
  /**
   * Which bundler this app's `dev`/`build` phases run on, read statically, plus the config hazards
   * that exist only because there are two. Absent when the directory is not a nifra app.
   *
   * Reported by doctor rather than only by `dev`/`build` because the answer governs how the rest of a
   * project is read - which plugin slot is live, whether `conditions` reach the client bundle, which
   * toolchain compiles a component - and asking for it should not require starting a server.
   */
  readonly pipeline?: PipelineReport
  /** Dependencies written by `--auto-fix` / MCP `autoFix:true`. */
  readonly fixed?: readonly DoctorAppliedFix[]
  /** Findings that were safe to report but not safe to write automatically. */
  readonly skippedFixes?: readonly DoctorSkippedFix[]
}

export type DoctorReadinessStatus = "configured" | "absent" | "not-applicable"

export interface DoctorReadinessItem {
  readonly id:
    | "request-timeout"
    | "admission"
    | "request-id-tracing"
    | "health-route"
    | "log-redaction"
    | "graceful-lifecycle"
  readonly label: string
  readonly status: DoctorReadinessStatus
  readonly evidence?: string
}

export interface DoctorReadiness {
  readonly target: string
  readonly targetSource: ResolvedTarget["source"] | null
  readonly strict: boolean
  /** True when every applicable rule has static evidence. */
  readonly ok: boolean
  readonly items: readonly DoctorReadinessItem[]
}

export interface DuplicateInstallCopy extends IdentityParityCopy {}
export interface DuplicateInstallFinding extends Omit<IdentityParityFinding, "copies"> {
  readonly copies: readonly DuplicateInstallCopy[]
}

export interface DoctorAppliedFix {
  readonly package: string
  readonly field: "dependencies"
  readonly version: string
  readonly source: "ancestor-package-json" | "installed-package-json"
}

export interface DoctorSkippedFix {
  readonly package: string
  readonly reason: string
  readonly command: readonly string[]
}

/** Read + parse a JSON file, or `undefined` if it's missing/unparseable (doctor degrades, never throws). */
async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await Bun.file(path).text()
    const parsed = JSON.parse(text) as unknown
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

const depNames = (pkg: Record<string, unknown>, field: string): string[] => {
  const deps = pkg[field]
  return typeof deps === "object" && deps !== null
    ? Object.keys(deps as Record<string, unknown>)
    : []
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const MAX_WORKSPACE_IMPORTERS = 2_048
function workspacePatterns(pkg: Record<string, unknown>): string[] {
  const raw = pkg.workspaces
  const entries = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.packages)
      ? raw.packages
      : []
  return entries
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .sort()
}

/** Discover package roots declared by npm/Bun's workspace manifest shapes plus nested package
 * boundaries (scaffold templates and benchmark fixtures are commonly real standalone packages even
 * when they are not workspace members). Bounded so a hostile tree cannot make doctor unbounded. */
async function workspaceImporters(
  cwd: string,
  rootPackage: Record<string, unknown>,
  includeNestedPackages = false,
): Promise<Array<{ root: string; package: Record<string, unknown> }>> {
  const manifests = new Set<string>([join(cwd, "package.json")])
  for (const pattern of workspacePatterns(rootPackage)) {
    const packagePattern = `${pattern.replace(/\/$/, "")}/package.json`
    for await (const rel of new Bun.Glob(packagePattern).scan({ cwd, dot: false })) {
      if (rel.split(/[\\/]/).includes("node_modules")) continue
      manifests.add(join(cwd, rel))
      // A pathological workspace pattern should not make doctor unbounded. Duplicate detection is
      // skipped, while the existing source/declaration diagnostic still runs normally.
      if (manifests.size > MAX_WORKSPACE_IMPORTERS) return []
    }
  }
  if (includeNestedPackages) {
    for await (const rel of new Bun.Glob("**/package.json").scan({ cwd, dot: false })) {
      const segments = rel.split(/[\\/]/)
      if (
        segments.some((segment) =>
          ["node_modules", "dist", "build", ".git", ".nifra", ".next", "coverage"].includes(
            segment,
          ),
        )
      ) {
        continue
      }
      manifests.add(join(cwd, rel))
      if (manifests.size > MAX_WORKSPACE_IMPORTERS) return []
    }
  }

  const out: Array<{ root: string; package: Record<string, unknown> }> = []
  for (const manifest of [...manifests].sort()) {
    const pkg = await readJson(manifest)
    if (pkg !== undefined) out.push({ root: dirname(manifest), package: pkg })
  }
  return out
}

interface DoctorPackageScope {
  readonly root: string
  readonly relativeRoot: string
  readonly declared: ReadonlySet<string>
  readonly isAlias: (specifier: string) => boolean
}

const declaredPackages = (pkg: Record<string, unknown>): ReadonlySet<string> => {
  const declared = new Set<string>()
  if (typeof pkg.name === "string") declared.add(pkg.name)
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of depNames(pkg, field)) declared.add(name)
  }
  return declared
}

const tsconfigPaths = async (
  root: string,
): Promise<Readonly<Record<string, unknown>> | undefined> => {
  const tsconfig = await readJson(join(root, "tsconfig.json"))
  const compilerOptions = tsconfig?.compilerOptions as
    | { paths?: Record<string, unknown> }
    | undefined
  return compilerOptions?.paths
}

/** Build per-package declaration scopes for a workspace. Longest roots are first so nested packages
 * own their source; files outside a workspace package remain owned by the root manifest. */
async function doctorPackageScopes(
  cwd: string,
  rootPackage: Record<string, unknown>,
): Promise<readonly DoctorPackageScope[]> {
  const importers = await workspaceImporters(cwd, rootPackage, true)
  const packages = importers.length > 0 ? importers : [{ root: cwd, package: rootPackage }]
  const rootPaths = await tsconfigPaths(cwd)
  const scopes = await Promise.all(
    packages.map(async (entry): Promise<DoctorPackageScope> => {
      const paths = (await tsconfigPaths(entry.root)) ?? rootPaths
      return {
        root: entry.root,
        relativeRoot: relative(cwd, entry.root).split("\\").join("/"),
        declared: declaredPackages(entry.package),
        isAlias: aliasMatcher(paths),
      }
    }),
  )
  return scopes.sort((a, b) => b.relativeRoot.length - a.relativeRoot.length)
}

const scopeForFile = (scopes: readonly DoctorPackageScope[], file: string): DoctorPackageScope =>
  scopes.find(
    (scope) =>
      scope.relativeRoot !== "" &&
      (file === scope.relativeRoot || file.startsWith(`${scope.relativeRoot}/`)),
  ) ?? (scopes.find((scope) => scope.relativeRoot === "") as DoctorPackageScope)

/* Identity-sensitive install resolution is owned by @nifrajs/web/internal/parity. */

/** Find identity-sensitive dependencies that resolve to multiple physical directories. Two copies at
 * the same version still fail: module identity (React hooks, Nifra symbols/registries) is path-based.
 *
 * `cwd` is where the user ran the check; the scan is anchored at the workspace root above it (see
 * The shared parity seam resolves the governing workspace root, while paths are still REPORTED
 * relative to `cwd` so the findings read the way the user's terminal does. */
export async function collectDuplicateInstalls(
  cwd: string,
  rootPackage: Record<string, unknown>,
): Promise<DuplicateInstallFinding[]> {
  const result = await collectIdentityParity(cwd, rootPackage, { useWorkspaceRoot: true })
  return result.findings.map(
    (finding): DuplicateInstallFinding => ({
      ...finding,
      copies: finding.copies.map((copy): DuplicateInstallCopy => ({ ...copy })),
    }),
  )
}

/** A workspace-linked dependency whose build artifact is older than its source. */
export interface StaleDistFinding {
  readonly package: string
  /** Where the linked package actually lives, relative to the doctor root when possible. A workspace
   * link routinely points into a SIBLING repo, so "rebuild it" is not actionable without the path -
   * this is the directory the rebuild runs in. */
  readonly packageDir: string
  /** The package's own build script name (`scripts.build` etc.), or `undefined` when it declares none -
   * then the rebuild cannot be automated and the report says so instead of suggesting a command that
   * would fail. */
  readonly buildScript: string | undefined
  /** The `default`-condition artifact (what Vite's SSR runner, vitest, and node consumers load),
   * relative to the doctor root when possible. `missing: true` means it was never built at all. */
  readonly distFile: string
  readonly missing: boolean
  /** The newest source file under the package's `bun`-condition tree - the proof of staleness. */
  readonly sourceFile: string
  /** How far the artifact lags the newest source, in whole seconds (0 when `missing`). */
  readonly behindSeconds: number
}

/**
 * Resolve one condition through an export-map entry: a string is terminal; an object takes the first
 * key that is the wanted condition or `default` (insertion order, like the runtime), skipping `types`.
 */
function exportTarget(entry: unknown, condition: "bun" | "default"): string | undefined {
  if (typeof entry === "string") return entry
  if (!isRecord(entry)) return undefined
  for (const [key, value] of Object.entries(entry)) {
    if (key === "types") continue
    if (key === condition || key === "default") return exportTarget(value, condition)
  }
  return undefined
}

// Bounded recursive walk for the newest file under a package's source tree. The cap is a runaway
// guard, not a tuning knob - a real `src/` is a few hundred files.
const MAX_SOURCE_FILES = 4_096
async function newestFileUnder(
  dir: string,
): Promise<{ readonly file: string; readonly mtimeMs: number } | undefined> {
  let newest: { file: string; mtimeMs: number } | undefined
  let seen = 0
  const walk = async (current: string): Promise<void> => {
    const entries: Dirent[] = await readdir(current, { withFileTypes: true }).catch(
      () => [] as Dirent[],
    )
    for (const entry of entries) {
      if (seen >= MAX_SOURCE_FILES) return
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith("."))
          continue
        await walk(path)
        continue
      }
      if (!entry.isFile()) continue
      seen++
      const s = await stat(path).catch(() => undefined)
      if (s !== undefined && (newest === undefined || s.mtimeMs > newest.mtimeMs))
        newest = { file: path, mtimeMs: s.mtimeMs }
    }
  }
  await walk(dir)
  return newest
}

/**
 * Find workspace-linked dependencies whose `default`-condition artifact (`dist/…`) has fallen behind
 * their `bun`-condition source (`src/…`).
 *
 * The split export map is what makes this a trap: Bun (the build, the tests, the prod binary) reads
 * live source, while Vite's SSR runner and any node consumer read a build artifact nothing in the dev
 * loop regenerates. `dist/` is gitignored, so the drift never shows in a diff - it surfaces as a 500
 * INSIDE framework/shared-package code and reads like an upstream regression. npm-installed copies are
 * immutable and skipped; only symlinked (workspace) installs can drift.
 */
export async function collectStaleWorkspaceDists(
  cwd: string,
  rootPackage: Record<string, unknown>,
): Promise<StaleDistFinding[]> {
  const findings: StaleDistFinding[] = []
  const seen = new Set<string>()
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of depNames(rootPackage, field)) {
      if (seen.has(name)) continue
      seen.add(name)
      // Boundary "" - never matches a real dir, so the upward walk runs to the filesystem root and
      // finds a hoisted copy wherever the install put it.
      const copy = await resolvedInstalledCopy(cwd, "", name)
      // A real (tarball) install lives under node_modules and cannot drift; only a symlink out of the
      // tree - a workspace/link install whose realpath escapes node_modules - has a live `src`.
      if (copy === undefined || copy.path.includes(`${sep}node_modules${sep}`)) continue
      const meta = await readJson(join(copy.path, "package.json"))
      const exportsMap = meta?.exports
      if (!isRecord(exportsMap)) continue
      // Every subpath with a bun→src / default→dist split; the root "." alone would miss the common
      // "deep subpaths only" layout.
      const pairs: Array<{ readonly bun: string; readonly dist: string }> = []
      const entries = Object.keys(exportsMap).some((k) => k.startsWith("."))
        ? Object.entries(exportsMap)
        : ([[".", exportsMap]] as Array<[string, unknown]>)
      for (const [, entry] of entries) {
        const bun = exportTarget(entry, "bun")
        const dist = exportTarget(entry, "default")
        if (bun !== undefined && dist !== undefined && bun !== dist) pairs.push({ bun, dist })
      }
      if (pairs.length === 0) continue
      // One newest-source probe per package: the bun targets share a source tree (its top directory).
      const sourceDirs = new Set(
        pairs
          .map((p) => p.bun.replace(/^\.\//, "").split("/")[0])
          .filter((d): d is string => d !== undefined && d.length > 0),
      )
      let newest: { file: string; mtimeMs: number } | undefined
      for (const dir of sourceDirs) {
        const candidate = await newestFileUnder(join(copy.path, dir))
        if (candidate !== undefined && (newest === undefined || candidate.mtimeMs > newest.mtimeMs))
          newest = candidate
      }
      if (newest === undefined) continue
      const packageDir = displayPath(cwd, copy.path)
      const buildScript = buildScriptName(meta)
      // Report the package once, anchored on its stalest (or missing) artifact.
      let worst: StaleDistFinding | undefined
      for (const pair of pairs) {
        const distPath = join(copy.path, pair.dist.replace(/^\.\//, ""))
        const distStat = await stat(distPath).catch(() => undefined)
        const finding: StaleDistFinding | undefined =
          distStat === undefined
            ? {
                package: name,
                packageDir,
                buildScript,
                distFile: displayPath(cwd, distPath),
                missing: true,
                sourceFile: displayPath(cwd, newest.file),
                behindSeconds: 0,
              }
            : distStat.mtimeMs < newest.mtimeMs
              ? {
                  package: name,
                  packageDir,
                  buildScript,
                  distFile: displayPath(cwd, distPath),
                  missing: false,
                  sourceFile: displayPath(cwd, newest.file),
                  behindSeconds: Math.round((newest.mtimeMs - distStat.mtimeMs) / 1000),
                }
              : undefined
        if (finding === undefined) continue
        if (
          worst === undefined ||
          (finding.missing && !worst.missing) ||
          finding.behindSeconds > worst.behindSeconds
        )
          worst = finding
      }
      if (worst !== undefined) findings.push(worst)
    }
  }
  return findings.sort((a, b) => a.package.localeCompare(b.package))
}

interface ReadinessSource {
  readonly file: string
  readonly code: string
  readonly source: string
}

function sourceLineAt(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < source.length; i++) if (source[i] === "\n") line++
  return line
}

function readinessEvidence(
  files: readonly ReadinessSource[],
  pattern: RegExp,
  source = "code",
): string | undefined {
  for (const file of files) {
    const content = source === "source" ? file.source : file.code
    const match = pattern.exec(content)
    if (match !== null) return `${file.file}:${sourceLineAt(content, match.index)}`
  }
  return undefined
}

/** Read only source shapes used to report production readiness. Values and secrets are never loaded. */
async function collectDoctorReadiness(
  cwd: string,
  opts: { readonly target?: string; readonly strict?: boolean },
): Promise<DoctorReadiness> {
  const resolved = await resolveTarget(cwd, opts.target)
  const files: ReadinessSource[] = []
  await walkSource(cwd, (file, source) => {
    files.push({ file, source, code: codePositionMask(source) })
  })
  const edgeTarget = /^(?:cf-pages|vercel|workers|edge|static)$/.test(resolved?.target ?? "")
  const configured = (
    id: DoctorReadinessItem["id"],
    label: string,
    pattern: RegExp,
    sourcePattern?: RegExp,
  ): DoctorReadinessItem => {
    const evidence = readinessEvidence(files, pattern)
    const routeEvidence =
      evidence === undefined && sourcePattern !== undefined
        ? readinessEvidence(files, sourcePattern, "source")
        : undefined
    const found = evidence ?? routeEvidence
    return found === undefined
      ? { id, label, status: "absent" }
      : { id, label, status: "configured", evidence: found }
  }

  const items: DoctorReadinessItem[] = [
    configured(
      "request-timeout",
      "request timeout or budget",
      /\b(?:requestTimeoutMs|createRequestBudget|admitDeadline)\s*[:(]/,
    ),
    // `admission: controller`, the shorthand `{ admission }` (trailing comma or closing brace), or
    // the documented constructor call - shorthand is the idiomatic form when the controller is an
    // import or module const.
    configured(
      "admission",
      "capacity admission",
      /\badmission\s*[:,}]|\bcreateAdmissionController\s*\(/,
    ),
    configured(
      "request-id-tracing",
      "request id or tracing middleware",
      /\b(?:requestId|tracing)\s*\(/,
    ),
    configured(
      "health-route",
      "health route",
      /\bhealthcheck\s*\(/,
      // Conventional health paths: /health, /healthz (the k8s form healthcheck() is most often
      // configured to serve), /health-check, and the underscore-prefixed variants, each also
      // matching as a prefix (`/health/live`). `/healthy` etc. stay non-matches: the path must end
      // (closing quote) or continue with a segment right after the recognized name.
      /\.(?:get|head)\s*\(\s*["']\/_?health(?:z|-check)?(?:["']|\/)/,
    ),
    // Asserts "a redacting logger is INSTALLED", so only the call forms count: the redacting
    // constructors, or @nifrajs/middleware's `logger()` structured request logger (which logs only
    // method/path/status/duration - nothing redactable). A bare `logger:` property proves nothing:
    // `logger: console` matches it and redacts nothing.
    configured("log-redaction", "log redaction", /\b(?:jsonLogger|redactLogFields|logger)\s*\(/),
    edgeTarget
      ? { id: "graceful-lifecycle", label: "graceful lifecycle", status: "not-applicable" }
      : configured(
          "graceful-lifecycle",
          "graceful lifecycle",
          /\bgracefulSignals\s*:\s*true\b|\bonStop\s*\(/,
        ),
  ]
  return {
    target: resolved?.target ?? "unknown",
    targetSource: resolved?.source ?? null,
    strict: opts.strict === true,
    ok: items.every((item) => item.status !== "absent"),
    items,
  }
}

function depRecord(
  pkg: Record<string, unknown>,
  field: string,
): Record<string, unknown> | undefined {
  const deps = pkg[field]
  return isRecord(deps) ? deps : undefined
}

function dependencySpec(pkg: Record<string, unknown>, name: string): string | undefined {
  for (const field of DEPENDENCY_FIELDS) {
    const spec = depRecord(pkg, field)?.[name]
    if (typeof spec === "string" && spec.length > 0) return spec
  }
  return undefined
}

async function ancestorDependencySpec(cwd: string, name: string): Promise<string | undefined> {
  for (let dir = dirname(cwd); ; dir = dirname(dir)) {
    const pkg = await readJson(join(dir, "package.json"))
    if (pkg !== undefined) {
      const spec = dependencySpec(pkg, name)
      if (spec !== undefined) return spec
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
  }
}

async function installedPackageSpec(cwd: string, name: string): Promise<string | undefined> {
  if (!isNpmPackageName(name)) return undefined
  const parts = name.split("/")
  for (let dir = cwd; ; dir = dirname(dir)) {
    const meta = await readJson(join(dir, "node_modules", ...parts, "package.json"))
    if (typeof meta?.version === "string" && meta.version.length > 0) {
      return `^${meta.version}`
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
  }
}

async function inferDependencyFix(
  cwd: string,
  name: string,
): Promise<Omit<DoctorAppliedFix, "package" | "field"> | undefined> {
  const ancestorSpec = await ancestorDependencySpec(cwd, name)
  if (ancestorSpec !== undefined) {
    return { version: ancestorSpec, source: "ancestor-package-json" }
  }
  const installedSpec = await installedPackageSpec(cwd, name)
  return installedSpec === undefined
    ? undefined
    : { version: installedSpec, source: "installed-package-json" }
}

/** Run doctor against the project at `cwd`: diff source imports vs declared deps. */
export async function collectDoctorResult(
  cwd: string,
  opts: { readonly target?: string; readonly strict?: boolean; readonly cliVersion?: string } = {},
): Promise<DoctorResult> {
  const pkg = await readJson(join(cwd, "package.json"))
  if (pkg === undefined)
    return { ok: true, ran: false, findings: [], duplicateInstalls: [], staleDists: [] }

  const scopes = await doctorPackageScopes(cwd, pkg)

  const findings: DoctorFinding[] = []
  // `includeTests`: tests are part of the typechecked surface, so an import they declare nowhere is a
  // real break. Excluding them is what let an undeclared `zod` in a `*.test.ts` pass doctor, pass a
  // hoisted local `tsc`, and then fail CI on a clean install with `TS2307: Cannot find module 'zod'`.
  await walkSource(
    cwd,
    (rel, content) => {
      const scope = scopeForFile(scopes, rel)
      for (const f of scanUndeclaredImports(rel, content, scope.declared, scope.isAlias)) {
        findings.push({ file: f.file, line: f.line, package: f.snippet })
      }
    },
    { includeTests: true },
  )
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  const duplicateInstalls = await collectDuplicateInstalls(cwd, pkg)
  const staleDists = await collectStaleWorkspaceDists(cwd, pkg)
  const pipeline = await collectPipelineReport(cwd)
  const pipelineErrors = pipeline.findings.filter((f) => f.severity === "error")
  const readiness = await collectDoctorReadiness(cwd, opts)
  // A stale binary answering about a project it does not match is an environment condition, so like
  // `staleDists` it is reported but never folded into `ok`. Skipped entirely when the caller did not
  // pass its own version (e.g. the MCP server, which already annotates every result with the drift).
  const toolingDrift =
    opts.cliVersion !== undefined ? await detectToolingDrift(cwd, opts.cliVersion) : undefined
  // `staleDists` and `toolingDrift` are advisory (see DoctorResult): they never fail `ok`.
  return {
    ok:
      findings.length === 0 &&
      duplicateInstalls.length === 0 &&
      pipelineErrors.length === 0 &&
      (opts.strict !== true || readiness.ok),
    ran: true,
    findings,
    duplicateInstalls,
    staleDists,
    readiness,
    ...(toolingDrift !== undefined ? { toolingDrift } : {}),
    ...(pipeline.ran ? { pipeline } : {}),
  }
}

/** Safely add undeclared imports to package.json when the version can be inferred without network I/O. */
export async function applyDoctorAutoFix(
  cwd: string,
  opts: { readonly target?: string; readonly strict?: boolean; readonly cliVersion?: string } = {},
): Promise<DoctorResult> {
  const before = await collectDoctorResult(cwd, opts)
  if (!before.ran || before.findings.length === 0) return before

  const rootPackage = await readJson(join(cwd, "package.json"))
  if (rootPackage === undefined) return before
  const scopes = await doctorPackageScopes(cwd, rootPackage)
  const byRoot = new Map<string, Set<string>>()
  for (const finding of before.findings) {
    const root = scopeForFile(scopes, finding.file).root
    const names = byRoot.get(root) ?? new Set<string>()
    names.add(finding.package)
    byRoot.set(root, names)
  }

  const fixed: DoctorAppliedFix[] = []
  const skippedFixes: DoctorSkippedFix[] = []
  for (const [root, names] of [...byRoot.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const pkgPath = join(root, "package.json")
    const pkg = await readJson(pkgPath)
    if (pkg === undefined) continue
    const dependencies = pkg.dependencies
    if (dependencies !== undefined && !isRecord(dependencies)) {
      for (const name of [...names].sort()) {
        skippedFixes.push({
          package: name,
          reason:
            "`dependencies` exists but is not an object; refusing to rewrite it automatically",
          command: ["bun", "add", name],
        })
      }
      continue
    }

    const deps = (dependencies ?? {}) as Record<string, unknown>
    if (dependencies === undefined) pkg.dependencies = deps
    let changed = false
    for (const name of [...names].sort()) {
      if (!isNpmPackageName(name)) {
        skippedFixes.push({
          package: name,
          reason: "package name did not match npm package-name syntax",
          command: ["bun", "add", name],
        })
        continue
      }
      const inferred = await inferDependencyFix(root, name)
      if (inferred === undefined) {
        skippedFixes.push({
          package: name,
          reason: "no declared ancestor version or installed package metadata was found locally",
          command: ["bun", "add", name],
        })
        continue
      }
      deps[name] = inferred.version
      changed = true
      fixed.push({ package: name, field: "dependencies", ...inferred })
    }
    if (changed) await Bun.write(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  }

  const after = fixed.length > 0 ? await collectDoctorResult(cwd, opts) : before
  return {
    ...after,
    ...(fixed.length > 0 ? { fixed } : {}),
    ...(skippedFixes.length > 0 ? { skippedFixes } : {}),
  }
}

/** Run doctor; print a report (`--json` for machine output) and return whether it passed. */
export async function runDoctor(
  cwd: string,
  opts: {
    readonly json?: boolean
    readonly autoFix?: boolean
    readonly strict?: boolean
    readonly target?: string
    /** The running CLI's own version, so doctor can flag a binary that mismatches the project. */
    readonly cliVersion?: string
  } = {},
): Promise<boolean> {
  const result = opts.autoFix
    ? await applyDoctorAutoFix(cwd, opts)
    : await collectDoctorResult(cwd, opts)
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2))
    return result.ok
  }
  console.log("nifra doctor\n")
  if (!result.ran) {
    console.log("• no package.json at this directory - nothing to check")
    return true
  }
  if (result.fixed && result.fixed.length > 0) {
    console.log("✓ updated package.json dependencies:")
    for (const f of result.fixed) {
      console.log(`  ${f.package}@${f.version} (${f.source})`)
    }
    console.log("")
  }
  if (result.skippedFixes && result.skippedFixes.length > 0) {
    console.log("• not auto-fixed:")
    for (const f of result.skippedFixes) {
      console.log(`  ${f.package} - ${f.reason}; run \`${f.command.join(" ")}\``)
    }
    console.log("")
  }
  // Printed before the findings and regardless of ok: which bundler owns this app is the frame the
  // rest of the report is read in, not a footnote to it.
  if (result.pipeline !== undefined) {
    const p = result.pipeline
    console.log(
      p.pipeline === "unknown"
        ? `• bundler: could not be read from ${p.configFile} - ${p.reason}\n`
        : `• bundler: ${p.pipeline} (${p.reason})\n`,
    )
    for (const f of p.findings) {
      console.log(`${f.severity === "error" ? "✗" : "⚠"} ${f.file}:${f.line ?? 0}  ${f.message}`)
      console.log(`      fix: ${f.fix}\n`)
    }
  }
  // Advisory, printed regardless of ok: a stale linked dist doesn't fail doctor, but silently eating
  // it costs an hour of misdiagnosis when the dev server 500s inside the package.
  if (result.staleDists.length > 0) {
    console.log(
      `⚠ ${result.staleDists.length} workspace-linked package(s) with a build artifact older than their source (Bun reads src, Vite SSR/node consumers read dist):\n`,
    )
    for (const f of result.staleDists) {
      console.log(
        f.missing
          ? `  ${f.package} - ${f.distFile} was never built`
          : `  ${f.package} - ${f.distFile} is ${f.behindSeconds}s behind ${f.sourceFile}`,
      )
      console.log(`      rebuild ${f.package}`)
    }
    console.log("")
  }
  if (result.readiness !== undefined) {
    const readiness = result.readiness
    console.log(
      `production readiness (${readiness.target}${readiness.targetSource === null ? "" : `, detected from ${readiness.targetSource}`}):\n`,
    )
    for (const item of readiness.items) {
      const marker =
        item.status === "configured" ? "✓" : item.status === "not-applicable" ? "-" : "✗"
      const evidence = item.evidence === undefined ? "" : ` (${item.evidence})`
      console.log(`  ${marker} ${item.label}: ${item.status}${evidence}`)
    }
    if (readiness.strict && !readiness.ok) {
      console.log("\n  --strict: every applicable readiness rule must be configured")
    }
    console.log("")
  }
  // Advisory, printed regardless of ok: the binary answering is a different feature version than the
  // one the project builds with, so its types/checks/docs describe a surface the code does not have.
  if (result.toolingDrift !== undefined) {
    const drift = result.toolingDrift
    console.log(
      `⚠ this CLI is nifra ${drift.cli}, but the project installs ${drift.package} ${drift.project} - ` +
        "its types, checks, and docs may describe a different version than your code builds with.",
    )
    console.log(
      "      fix: run the project's own CLI (`bunx --bun nifra doctor` from the project directory, " +
        "or ./node_modules/.bin/nifra)\n",
    )
  }
  if (result.ok) {
    console.log(
      "✓ every imported package is declared and identity-sensitive installs are deduplicated",
    )
    return true
  }
  // Group by package so the fix ("add X to dependencies") is stated once with its import sites.
  const byPkg = new Map<string, DoctorFinding[]>()
  for (const f of result.findings) {
    const list = byPkg.get(f.package) ?? []
    list.push(f)
    byPkg.set(f.package, list)
  }
  if (byPkg.size > 0) {
    console.log(`✗ ${byPkg.size} package(s) imported but not declared in package.json:\n`)
    for (const [pkg, sites] of [...byPkg.entries()].sort()) {
      console.log(`  ${pkg} - add to dependencies (\`bun add ${pkg}\`)`)
      for (const s of sites) console.log(`      ${s.file}:${s.line}`)
    }
  }
  if (result.duplicateInstalls.length > 0) {
    console.log(
      `${byPkg.size > 0 ? "\n" : ""}✗ identity-sensitive packages resolve to multiple physical copies:\n`,
    )
    for (const finding of result.duplicateInstalls) {
      console.log(`  ${finding.package} [${finding.cause}]`)
      console.log(`      versions: ${finding.versions.join(", ")}`)
      for (const copy of finding.copies) {
        console.log(`      ${copy.version} at ${copy.path} ← ${copy.importers.join(", ")}`)
      }
      console.log(`      ${finding.explanation}`)
      console.log(`      fix: ${finding.remediation}`)
    }
  }
  if (result.readiness?.strict === true && result.readiness.ok === false) {
    console.log("\n✗ production readiness is incomplete under --strict")
  }
  if (byPkg.size > 0)
    console.log(
      "\nThese resolve at Bun runtime via hoisting/workspace but break `tsc` and a standalone install.",
    )
  return false
}

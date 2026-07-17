/**
 * `nifra doctor` — catches the Bun-workspace footgun the typed-client lint can't: a package that's
 * IMPORTED in source but NOT declared in `package.json`. Bun resolves it at runtime (via hoisting or a
 * workspace), so tests pass and `bun install` reports "no changes" — false confidence — yet `tsc` fails
 * and a fresh or standalone install can't resolve it. doctor diffs every bare import specifier against
 * the package's declared dependencies and flags the gap, with a stable `--json` shape for agents/CI.
 *
 * Scope is intentionally per-package: it checks the `package.json` at `cwd`, because a dependency must be
 * declared by the package that imports it (for `tsc` and for that package to install on its own) even
 * when a monorepo would hoist it. Relative paths, runtime builtins (node core, `node:`/`bun:`, `bun`),
 * the package's own name, and tsconfig `paths` aliases are excluded — none of them are npm deps.
 */
import { realpath } from "node:fs/promises"
import { builtinModules } from "node:module"
import { dirname, join, relative } from "node:path"
import { codePositionMask, type SourceFinding, stripComments, walkSource } from "./check.ts"

// Runtime-provided modules that are never an npm dependency: Node core (bare + `node:` form) and Bun's
// own `bun` module. `node:`/`bun:`-prefixed specifiers are filtered in packageOf by prefix.
const BUILTINS: ReadonlySet<string> = new Set<string>([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  "bun",
])

// The four specifier-bearing forms: static import/re-export with a source, side-effect import, dynamic
// import, and CJS require. Anchored with `(?<![.\w$])` so `myimport`/`.import`/`foorequire` never match.
// Comments are stripped before these run (see stripComments) — else a doc-comment usage example would be
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
    if (!scope || scope === "@" || !name) return undefined // `@/alias`, `@foo` — not a real package
    const pkg = `${scope}/${name}`
    return isNpmPackageName(pkg) ? pkg : undefined
  }
  const name = spec.split("/")[0] as string
  if (!isNpmPackageName(name)) return undefined
  return BUILTINS.has(name) ? undefined : name
}

/** Build a predicate matching tsconfig `paths` aliases (e.g. `@/*`, `~/utils`), which resolve to local
 * source, not npm packages — so doctor must not flag them. */
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
  /** The undeclared package name — add it to `package.json` dependencies. */
  readonly package: string
}

export interface DoctorResult {
  readonly ok: boolean
  /** `false` when no `package.json` was found at cwd — doctor can't run (reported, not a crash). */
  readonly ran: boolean
  readonly findings: readonly DoctorFinding[]
  /** Packages that resolve to more than one physical install across this workspace. */
  readonly duplicateInstalls: readonly DuplicateInstallFinding[]
  /** Dependencies written by `--auto-fix` / MCP `autoFix:true`. */
  readonly fixed?: readonly DoctorAppliedFix[]
  /** Findings that were safe to report but not safe to write automatically. */
  readonly skippedFixes?: readonly DoctorSkippedFix[]
}

export interface DuplicateInstallCopy {
  /** Installed version, or `unknown` when package metadata is incomplete. */
  readonly version: string
  /** Physical package directory, relative to the doctor root when possible. */
  readonly path: string
  /** Workspace package roots whose normal Node/Bun resolution selects this copy. */
  readonly importers: readonly string[]
}

export interface DuplicateInstallFinding {
  readonly package: string
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
const IDENTITY_SENSITIVE_PACKAGES = new Set(["@nifrajs/core", "react", "react-dom"])

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

function duplicateTargets(pkg: Record<string, unknown>): string[] {
  const targets = new Set<string>()
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of depNames(pkg, field)) {
      if (name.startsWith("@nifrajs/") || IDENTITY_SENSITIVE_PACKAGES.has(name)) targets.add(name)
    }
  }
  return [...targets].sort()
}

async function resolvedInstalledCopy(
  importer: string,
  boundary: string,
  name: string,
): Promise<{ path: string; version: string } | undefined> {
  const parts = name.split("/")
  for (let dir = importer; ; dir = dirname(dir)) {
    const packageDir = join(dir, "node_modules", ...parts)
    const meta = await readJson(join(packageDir, "package.json"))
    if (meta !== undefined) {
      try {
        return {
          path: await realpath(packageDir),
          version:
            typeof meta.version === "string" && meta.version.length > 0 ? meta.version : "unknown",
        }
      } catch {
        return undefined
      }
    }
    if (dir === boundary) return undefined
    const parent = dirname(dir)
    if (parent === dir) return undefined
  }
}

const displayPath = (cwd: string, path: string): string => {
  const rel = relative(cwd, path)
  return rel === "" ? "." : rel
}

/** Find identity-sensitive dependencies that resolve to multiple physical directories. Two copies at
 * the same version still fail: module identity (React hooks, Nifra symbols/registries) is path-based. */
export async function collectDuplicateInstalls(
  cwd: string,
  rootPackage: Record<string, unknown>,
): Promise<DuplicateInstallFinding[]> {
  const importers = await workspaceImporters(cwd, rootPackage)
  const byPackage = new Map<string, Map<string, { version: string; importers: Set<string> }>>()
  const record = (
    name: string,
    copy: { path: string; version: string },
    importer: string,
  ): void => {
    let copies = byPackage.get(name)
    if (copies === undefined) {
      copies = new Map()
      byPackage.set(name, copies)
    }
    const entry = copies.get(copy.path) ?? { version: copy.version, importers: new Set<string>() }
    entry.importers.add(importer)
    copies.set(copy.path, entry)
  }

  const targets = new Set<string>()
  for (const importer of importers) {
    for (const name of duplicateTargets(importer.package)) {
      if (importer.package.name === name) continue
      targets.add(name)
      const copy = await resolvedInstalledCopy(importer.root, cwd, name)
      if (copy !== undefined) record(name, copy, displayPath(cwd, importer.root))
    }
  }

  // Probe the workspace root for every target too, even when the root manifest doesn't declare it.
  // A hoisted root copy is reachable from any package that lacks its own nested one, so leaving it
  // out hides the very split it should catch: every declaring package nested onto one copy while the
  // root resolved a different one, which reads as a single copy when only declarers are consulted.
  for (const name of targets) {
    const copy = await resolvedInstalledCopy(cwd, cwd, name)
    if (copy !== undefined) record(name, copy, ".")
  }

  const findings: DuplicateInstallFinding[] = []
  for (const [name, copies] of [...byPackage.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (copies.size < 2) continue
    findings.push({
      package: name,
      copies: [...copies.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, copy]) => ({
          version: copy.version,
          path: displayPath(cwd, path),
          importers: [...copy.importers].sort(),
        })),
    })
  }
  return findings
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
export async function collectDoctorResult(cwd: string): Promise<DoctorResult> {
  const pkg = await readJson(join(cwd, "package.json"))
  if (pkg === undefined) return { ok: true, ran: false, findings: [], duplicateInstalls: [] }

  const scopes = await doctorPackageScopes(cwd, pkg)

  const findings: DoctorFinding[] = []
  await walkSource(cwd, (rel, content) => {
    const scope = scopeForFile(scopes, rel)
    for (const f of scanUndeclaredImports(rel, content, scope.declared, scope.isAlias)) {
      findings.push({ file: f.file, line: f.line, package: f.snippet })
    }
  })
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  const duplicateInstalls = await collectDuplicateInstalls(cwd, pkg)
  return {
    ok: findings.length === 0 && duplicateInstalls.length === 0,
    ran: true,
    findings,
    duplicateInstalls,
  }
}

/** Safely add undeclared imports to package.json when the version can be inferred without network I/O. */
export async function applyDoctorAutoFix(cwd: string): Promise<DoctorResult> {
  const before = await collectDoctorResult(cwd)
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

  const after = fixed.length > 0 ? await collectDoctorResult(cwd) : before
  return {
    ...after,
    ...(fixed.length > 0 ? { fixed } : {}),
    ...(skippedFixes.length > 0 ? { skippedFixes } : {}),
  }
}

/** Run doctor; print a report (`--json` for machine output) and return whether it passed. */
export async function runDoctor(
  cwd: string,
  opts: { readonly json?: boolean; readonly autoFix?: boolean } = {},
): Promise<boolean> {
  const result = opts.autoFix ? await applyDoctorAutoFix(cwd) : await collectDoctorResult(cwd)
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2))
    return result.ok
  }
  console.log("nifra doctor\n")
  if (!result.ran) {
    console.log("• no package.json at this directory — nothing to check")
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
      console.log(`  ${f.package} — ${f.reason}; run \`${f.command.join(" ")}\``)
    }
    console.log("")
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
      console.log(`  ${finding.package}`)
      for (const copy of finding.copies) {
        console.log(`      ${copy.version} at ${copy.path} ← ${copy.importers.join(", ")}`)
      }
    }
    console.log(
      "\n  Align dependency ranges and reinstall from the workspace root; doctor never deletes installs.",
    )
  }
  if (byPkg.size > 0)
    console.log(
      "\nThese resolve at Bun runtime via hoisting/workspace but break `tsc` and a standalone install.",
    )
  return false
}

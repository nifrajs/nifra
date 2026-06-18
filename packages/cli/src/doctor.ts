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
import { builtinModules } from "node:module"
import { dirname, join } from "node:path"
import { type SourceFinding, stripComments, walkSource } from "./check.ts"

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
  for (const rx of IMPORT_PATTERNS) {
    rx.lastIndex = 0
    for (let m = rx.exec(code); m !== null; m = rx.exec(code)) {
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
  /** Dependencies written by `--auto-fix` / MCP `autoFix:true`. */
  readonly fixed?: readonly DoctorAppliedFix[]
  /** Findings that were safe to report but not safe to write automatically. */
  readonly skippedFixes?: readonly DoctorSkippedFix[]
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
  if (pkg === undefined) return { ok: true, ran: false, findings: [] }

  const declared = new Set<string>()
  if (typeof pkg.name === "string") declared.add(pkg.name) // a package may import its own name (exports map)
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of depNames(pkg, field)) declared.add(name)
  }

  const tsconfig = await readJson(join(cwd, "tsconfig.json"))
  const compilerOptions = tsconfig?.compilerOptions as
    | { paths?: Record<string, unknown> }
    | undefined
  const isAlias = aliasMatcher(compilerOptions?.paths)

  const findings: DoctorFinding[] = []
  await walkSource(cwd, (rel, content) => {
    for (const f of scanUndeclaredImports(rel, content, declared, isAlias)) {
      findings.push({ file: f.file, line: f.line, package: f.snippet })
    }
  })
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  return { ok: findings.length === 0, ran: true, findings }
}

/** Safely add undeclared imports to package.json when the version can be inferred without network I/O. */
export async function applyDoctorAutoFix(cwd: string): Promise<DoctorResult> {
  const before = await collectDoctorResult(cwd)
  if (!before.ran || before.findings.length === 0) return before

  const pkgPath = join(cwd, "package.json")
  const pkg = await readJson(pkgPath)
  if (pkg === undefined) return before
  const dependencies = pkg.dependencies
  if (dependencies !== undefined && !isRecord(dependencies)) {
    const skippedFixes = [...new Set(before.findings.map((f) => f.package))].sort().map(
      (name): DoctorSkippedFix => ({
        package: name,
        reason: "`dependencies` exists but is not an object; refusing to rewrite it automatically",
        command: ["bun", "add", name],
      }),
    )
    return { ...before, skippedFixes }
  }

  const deps = (dependencies ?? {}) as Record<string, unknown>
  if (dependencies === undefined) pkg.dependencies = deps

  const fixed: DoctorAppliedFix[] = []
  const skippedFixes: DoctorSkippedFix[] = []
  for (const name of [...new Set(before.findings.map((f) => f.package))].sort()) {
    if (!isNpmPackageName(name)) {
      skippedFixes.push({
        package: name,
        reason: "package name did not match npm package-name syntax",
        command: ["bun", "add", name],
      })
      continue
    }
    const inferred = await inferDependencyFix(cwd, name)
    if (inferred === undefined) {
      skippedFixes.push({
        package: name,
        reason: "no declared ancestor version or installed package metadata was found locally",
        command: ["bun", "add", name],
      })
      continue
    }
    deps[name] = inferred.version
    fixed.push({ package: name, field: "dependencies", ...inferred })
  }

  if (fixed.length > 0) await Bun.write(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
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
    console.log("✓ every imported package is declared in package.json")
    return true
  }
  // Group by package so the fix ("add X to dependencies") is stated once with its import sites.
  const byPkg = new Map<string, DoctorFinding[]>()
  for (const f of result.findings) {
    const list = byPkg.get(f.package) ?? []
    list.push(f)
    byPkg.set(f.package, list)
  }
  console.log(`✗ ${byPkg.size} package(s) imported but not declared in package.json:\n`)
  for (const [pkg, sites] of [...byPkg.entries()].sort()) {
    console.log(`  ${pkg} — add to dependencies (\`bun add ${pkg}\`)`)
    for (const s of sites) console.log(`      ${s.file}:${s.line}`)
  }
  console.log(
    "\nThese resolve at Bun runtime via hoisting/workspace but break `tsc` and a standalone install.",
  )
  return false
}

/** Static effect provenance, capability lockfile, and CLI commands. */

import { existsSync, readFileSync } from "node:fs"
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path"
import { matchesAssuranceSelector } from "@nifrajs/core/assurance"
import {
  type AssuredCapabilityRoute,
  type CapabilityAssuranceReport,
  type CapabilityDefinition,
  type CapabilityFinding,
  type CapabilityPolicy,
  type CapabilitySnapshot,
  type CapabilitySnapshotRoute,
  defineCapabilityPolicy,
  evaluateCapabilityAssurance,
  snapshotCapabilities,
  validCapabilityId,
} from "@nifrajs/core/capabilities"
import { reflectRoutes } from "@nifrajs/core/reflection"
import { scanStaticRouteText, stripComments, walkSource } from "./check.ts"

const EFFECT_IMPORT =
  /\bimport\s+(?!type\b)(?:[^'"();]*?\bfrom\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)|\bexport\s+(?!type\b)[^'";]*?\bfrom\s*["']([^"']+)["']/g
// `\\` is excluded from both inner classes: letting the class also match a lone backslash makes the
// `(A*(\\.A*)*)` shape ambiguous, which is exponential on a run of backslashes.
const TEMPLATE_EFFECT_IMPORT = /\b(?:import|require)\s*\(\s*`([^`$\\]*(?:\\.[^`$\\]*)*)`\s*\)/g

/** Value-bearing import edges relevant to effect provenance, in source order. */
export function scanEffectImports(content: string): string[] {
  const code = stripComments(content)
  const found: Array<{ index: number; specifier: string }> = []
  const re = new RegExp(EFFECT_IMPORT.source, EFFECT_IMPORT.flags)
  for (let match = re.exec(code); match !== null; match = re.exec(code)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4]
    if (specifier !== undefined) found.push({ index: match.index, specifier })
  }
  // `stripComments` intentionally blanks template contents for other lints. Recover only a
  // no-substitution template used directly as import()/require() input, and verify the keyword itself
  // survived stripping so a commented/doc-template example cannot become provenance.
  const templates = new RegExp(TEMPLATE_EFFECT_IMPORT.source, TEMPLATE_EFFECT_IMPORT.flags)
  for (let match = templates.exec(content); match !== null; match = templates.exec(content)) {
    if (code.slice(match.index, match.index + 6).trim() === "") continue
    const specifier = match[1]
    if (specifier !== undefined)
      found.push({ index: match.index, specifier: specifier.replace(/\\`/g, "`") })
  }
  return found.sort((a, b) => a.index - b.index).map((item) => item.specifier)
}

function specifierMatches(pattern: string, specifier: string): boolean {
  return pattern.endsWith("/*") ? specifier.startsWith(pattern.slice(0, -1)) : specifier === pattern
}

const SPECIFIER_EXTENSION = /\.(?:[cm]?[jt]sx?)$/

/** Reduce a specifier to the name a human would recognise: `./services/mail.ts` and `../mail/index.ts`
 * both stem to `mail`, which is what makes a written-vs-actual mismatch suggestible. */
function specifierStem(specifier: string): string {
  const segments = specifier
    .replace(SPECIFIER_EXTENSION, "")
    .split("/")
    .filter((segment) => segment !== "" && segment !== "." && segment !== "..")
  const last = segments.at(-1)
  if (last === undefined) return specifier
  return last === "index" ? (segments.at(-2) ?? last) : last
}

const suggestionSuffix = (suggestions: readonly string[]): string =>
  suggestions.length === 0 ? "" : ` - did you mean ${suggestions.map((s) => `"${s}"`).join(", ")}?`

function nearestSpecifiers(pattern: string, candidates: Iterable<string>): string[] {
  const stem = specifierStem(pattern.endsWith("/*") ? pattern.slice(0, -2) : pattern)
  const near = new Set<string>()
  for (const candidate of candidates) if (specifierStem(candidate) === stem) near.add(candidate)
  return [...near].sort().slice(0, 3)
}

const routeKey = (method: string, path: string): string => `${method.toUpperCase()}\n${path}`

export interface CapabilityImportViolation {
  readonly method: string
  readonly path: string
  readonly module: string
  readonly specifier: string
  readonly reason: string
  readonly chain: readonly string[]
}

export interface CapabilityProjectReport {
  readonly report: CapabilityAssuranceReport
  readonly violations: readonly CapabilityImportViolation[]
  readonly truncations: readonly CapabilityProvenanceTruncation[]
  readonly unmatchedSeams: readonly CapabilityUnmatchedSeam[]
}

/**
 * A provenance rule that names something the project does not contain. Seam specifiers are matched
 * as written, so `"./services/mail.ts"` against `import "./services/mail"` silently governs nothing -
 * the effect stays invisible to assurance and every route using it still passes.
 */
export interface CapabilityUnmatchedSeam {
  readonly kind: "import" | "route-module"
  /** The specifier (import rule) or project-relative module path (routeModules entry) as written. */
  readonly value: string
  /** Closest specifiers/modules actually present, when one is recognisable. */
  readonly suggestions: readonly string[]
}

export interface CapabilityProvenanceTruncation {
  readonly method: string
  readonly path: string
  readonly reason: "depth-limit" | "module-limit"
  readonly chain: readonly string[]
}

export interface CapabilityRouteExplanation {
  readonly ok: boolean
  readonly method: string
  readonly path: string
  readonly route: AssuredCapabilityRoute
  readonly definitions: readonly CapabilityDefinition[]
  readonly findings: readonly CapabilityFinding[]
  readonly violations: readonly CapabilityImportViolation[]
  readonly truncations: readonly CapabilityProvenanceTruncation[]
  /** This command explains declarations and static evidence; it does not infer handler-internal branches. */
  readonly note: string
}

/** Explain one reflected route using only declared capability tokens and collected static evidence. */
export function explainCapabilityRoute(
  policy: CapabilityPolicy,
  project: CapabilityProjectReport,
  methodInput: string,
  path: string,
): CapabilityRouteExplanation | undefined {
  const method = methodInput.toUpperCase()
  const route = project.report.routes.find(
    (candidate) => candidate.method === method && candidate.path === path,
  )
  if (route === undefined) return undefined

  const findings = project.report.findings.filter(
    (finding) =>
      (finding.method === method && finding.path === path) ||
      (finding.method === "*" && finding.path === "*"),
  )
  const violations = project.violations.filter(
    (violation) => violation.method === method && violation.path === path,
  )
  const truncations = project.truncations.filter(
    (truncation) => truncation.method === method && truncation.path === path,
  )
  const ids = new Set<string>([
    ...route.declared,
    ...route.evidence.map((evidence) => evidence.id),
    ...findings.flatMap((finding) =>
      finding.capability === undefined ? [] : [finding.capability],
    ),
  ])
  const definitions = policy.definitions.filter((definition) => ids.has(definition.id))
  return Object.freeze({
    ok: findings.length === 0 && violations.length === 0 && truncations.length === 0,
    method,
    path,
    route,
    definitions: Object.freeze(definitions),
    findings: Object.freeze(findings),
    violations: Object.freeze(violations),
    truncations: Object.freeze(truncations),
    note: "Nifra explains declarations and static provenance only; it does not guess handler-internal branches or runtime data flow.",
  })
}

function resolveLocalModule(
  cwd: string,
  from: string,
  specifier: string,
  sources: Map<string, string>,
): string | undefined {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const base = join(dirname(from), specifier).replaceAll("\\", "/")
    const candidates = extname(base)
      ? [base]
      : [
          base,
          `${base}.ts`,
          `${base}.tsx`,
          `${base}.mts`,
          `${base}.cts`,
          `${base}/index.ts`,
          `${base}/index.tsx`,
        ]
    const found = candidates.find((candidate) => sources.has(candidate))
    if (found !== undefined) return found
  }
  try {
    const fromAbsolute = join(cwd, from)
    const resolved = Bun.resolveSync(specifier, dirname(fromAbsolute))
    const rel = relative(cwd, resolved).replaceAll("\\", "/")
    if (rel.startsWith("../") || isAbsolute(rel)) return undefined
    if (!sources.has(rel) && existsSync(resolved)) {
      try {
        sources.set(rel, readFileSync(resolved, "utf8"))
      } catch {
        return undefined
      }
    }
    return sources.has(rel) ? rel : undefined
  } catch {
    return undefined
  }
}

async function readSources(cwd: string): Promise<Map<string, string>> {
  const sources = new Map<string, string>()
  await walkSource(cwd, (rel, content) => sources.set(rel.replaceAll("\\", "/"), content))
  return sources
}

interface WalkResult {
  readonly covered: boolean
  readonly evidence: Array<{ id: string; kind: "static"; source: string }>
  readonly violations: CapabilityImportViolation[]
  readonly truncations: CapabilityProvenanceTruncation[]
}

const MAX_PROVENANCE_MODULES = 500
const MAX_PROVENANCE_CHAIN = 16

async function walkRouteModules(
  cwd: string,
  modules: readonly string[],
  method: string,
  path: string,
  policy: CapabilityPolicy,
  sources: Map<string, string>,
): Promise<WalkResult> {
  const queue = modules.map((module) => ({ module, chain: [module] as string[] }))
  const visited = new Set<string>()
  const evidence: Array<{ id: string; kind: "static"; source: string }> = []
  const violations: CapabilityImportViolation[] = []
  const truncations: CapabilityProvenanceTruncation[] = []
  let covered = false

  while (queue.length > 0) {
    if (visited.size >= MAX_PROVENANCE_MODULES) {
      const pending = queue[0]
      truncations.push({
        method,
        path,
        reason: "module-limit",
        chain: Object.freeze([
          ...(pending?.chain ?? []),
          `<${MAX_PROVENANCE_MODULES}-module limit>`,
        ]),
      })
      break
    }
    const current = queue.shift()
    if (current === undefined || visited.has(current.module)) continue
    if (current.chain.length > MAX_PROVENANCE_CHAIN) {
      truncations.push({
        method,
        path,
        reason: "depth-limit",
        chain: Object.freeze([...current.chain, `<${MAX_PROVENANCE_CHAIN}-hop limit>`]),
      })
      continue
    }
    visited.add(current.module)
    let content = sources.get(current.module)
    if (content === undefined) {
      try {
        content = await Bun.file(join(cwd, current.module)).text()
        sources.set(current.module, content)
      } catch {
        continue
      }
    }
    covered = true
    for (const specifier of scanEffectImports(content)) {
      let approvedEffectBoundary = false
      for (const rule of policy.provenance.imports) {
        if (!specifierMatches(rule.specifier, specifier)) continue
        approvedEffectBoundary = true
        for (const id of rule.capabilities) {
          if (!evidence.some((item) => item.id === id && item.source === specifier)) {
            evidence.push({ id, kind: "static", source: specifier })
          }
        }
      }
      for (const rule of policy.provenance.forbiddenImports) {
        if (!specifierMatches(rule.specifier, specifier)) continue
        violations.push({
          method,
          path,
          module: current.module,
          specifier,
          reason: rule.reason,
          chain: Object.freeze([...current.chain, specifier]),
        })
      }
      // An explicitly mapped import is the owned effect seam. Its implementation may legitimately
      // import the raw provider; assurance governs whether routes can reach the seam, not its internals.
      if (approvedEffectBoundary) continue
      const local = resolveLocalModule(cwd, current.module, specifier, sources)
      if (local !== undefined && !visited.has(local)) {
        queue.push({ module: local, chain: [...current.chain, specifier] })
      }
    }
  }
  return { covered, evidence, violations, truncations }
}

/** Build coverage-qualified static evidence for every reflected route. */
export async function collectCapabilityProjectReport(
  cwd: string,
  source: unknown,
  policyInput: CapabilityPolicy,
): Promise<CapabilityProjectReport> {
  const policy = defineCapabilityPolicy(policyInput)
  const sources = await readSources(cwd)
  const automatic = new Map<string, Set<string>>()
  for (const [file, content] of sources) {
    for (const route of scanStaticRouteText(file, content)) {
      const modules = automatic.get(routeKey(route.method, route.path)) ?? new Set<string>()
      modules.add(file)
      automatic.set(routeKey(route.method, route.path), modules)
    }
  }

  const evidenceRoutes = []
  const violations: CapabilityImportViolation[] = []
  const truncations: CapabilityProvenanceTruncation[] = []
  for (const route of reflectRoutes(source)) {
    const modules = new Set(automatic.get(routeKey(route.method, route.path)) ?? [])
    for (const association of policy.provenance.routeModules ?? []) {
      if (
        matchesAssuranceSelector(route, {
          ...(association.match.methods !== undefined
            ? { methods: association.match.methods as never }
            : {}),
          ...(association.match.paths !== undefined ? { paths: association.match.paths } : {}),
        })
      ) {
        for (const module of association.modules) modules.add(module)
      }
    }
    const walked = await walkRouteModules(
      cwd,
      [...modules],
      route.method,
      route.path,
      policy,
      sources,
    )
    evidenceRoutes.push({
      method: route.method,
      path: route.path,
      covered: modules.size > 0 && walked.covered,
      evidence: walked.evidence,
    })
    violations.push(...walked.violations)
    truncations.push(...walked.truncations)
  }

  // A seam rule that matches nothing is a policy typo, not a passing project: the effect it was
  // written to govern keeps executing, unwatched, and every route touching it still reports clean.
  // Checked against every scanned source (not just route-reachable ones) so a seam used by a job or
  // a script is not reported as missing.
  const scannedSpecifiers = new Set<string>()
  for (const content of sources.values())
    for (const specifier of scanEffectImports(content)) scannedSpecifiers.add(specifier)
  const unmatchedSeams: CapabilityUnmatchedSeam[] = []
  for (const rule of policy.provenance.imports) {
    if (rule.optional === true) continue
    if ([...scannedSpecifiers].some((specifier) => specifierMatches(rule.specifier, specifier)))
      continue
    unmatchedSeams.push({
      kind: "import",
      value: rule.specifier,
      suggestions: Object.freeze(nearestSpecifiers(rule.specifier, scannedSpecifiers)),
    })
  }
  for (const association of policy.provenance.routeModules ?? []) {
    for (const module of association.modules) {
      const normalized = module.replaceAll("\\", "/")
      if (sources.has(normalized) || existsSync(join(cwd, normalized))) continue
      unmatchedSeams.push({
        kind: "route-module",
        value: module,
        suggestions: Object.freeze(nearestSpecifiers(module, sources.keys())),
      })
    }
  }

  const evaluated = evaluateCapabilityAssurance(source, policy, { routes: evidenceRoutes })
  const report: CapabilityAssuranceReport =
    violations.length === 0 && truncations.length === 0 && unmatchedSeams.length === 0
      ? evaluated
      : Object.freeze({
          ...evaluated,
          ok: false,
          findings: Object.freeze([
            ...evaluated.findings,
            ...violations.map((violation) => ({
              code: "forbidden-effect-import" as const,
              method: violation.method,
              path: violation.path,
              message: `${violation.method} ${violation.path} reaches forbidden ${violation.specifier} via ${violation.chain.join(" → ")}: ${violation.reason}`,
            })),
            ...truncations.map((truncation) => ({
              code: "provenance-truncated" as const,
              method: truncation.method,
              path: truncation.path,
              message: `${truncation.method} ${truncation.path} capability provenance hit the ${truncation.reason === "depth-limit" ? "import-depth" : "module-count"} safety limit via ${truncation.chain.join(" → ")}; assurance cannot prove the remaining graph`,
            })),
            ...unmatchedSeams.map((seam) => ({
              code: "unmatched-provenance-seam" as const,
              method: "*",
              path: "*",
              message:
                seam.kind === "import"
                  ? `capabilities.provenance.imports "${seam.value}" matched no import in this project, so the effect it declares is ungoverned - specifiers are compared exactly (or as a trailing /* prefix), not resolved${suggestionSuffix(seam.suggestions)}`
                  : `capabilities.provenance.routeModules "${seam.value}" is not a file in this project, so the routes it associates stay uncovered${suggestionSuffix(seam.suggestions)}`,
            })),
          ]),
        })
  return Object.freeze({
    report,
    violations: Object.freeze(violations),
    truncations: Object.freeze(truncations),
    unmatchedSeams: Object.freeze(unmatchedSeams),
  })
}

export function parseCapabilityLockfile(content: string, sourcePath: string): CapabilitySnapshot {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error(`[nifra] ${sourcePath} is not valid JSON`)
  }
  const candidate = parsed as Partial<CapabilitySnapshot> | null
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    candidate.nifraCapabilities !== 1 ||
    !Array.isArray(candidate.routes)
  ) {
    throw new Error(
      `[nifra] ${sourcePath} is not a nifra capability lockfile - expected { "nifraCapabilities": 1, "routes": [...] }`,
    )
  }
  for (const route of candidate.routes) {
    if (
      typeof route !== "object" ||
      route === null ||
      typeof (route as CapabilitySnapshotRoute).method !== "string" ||
      typeof (route as CapabilitySnapshotRoute).path !== "string" ||
      !Array.isArray((route as CapabilitySnapshotRoute).declared) ||
      !Array.isArray((route as CapabilitySnapshotRoute).evidenced) ||
      !Array.isArray((route as CapabilitySnapshotRoute).unproven)
    ) {
      throw new Error(`[nifra] ${sourcePath} contains an invalid capability route`)
    }
    for (const [label, values] of [
      ["declared", (route as CapabilitySnapshotRoute).declared],
      ["evidenced", (route as CapabilitySnapshotRoute).evidenced],
      ["unproven", (route as CapabilitySnapshotRoute).unproven],
    ] as const) {
      if (
        values.some((value) => typeof value !== "string" || !validCapabilityId(value)) ||
        new Set(values).size !== values.length ||
        [...values].sort().some((value, index) => value !== values[index])
      ) {
        throw new Error(`[nifra] ${sourcePath} has non-canonical ${label} capability tokens`)
      }
    }
  }
  return candidate as CapabilitySnapshot
}

function routeSnapshotKey(route: CapabilitySnapshotRoute): string {
  return `${route.method}\n${route.path}`
}

function listDelta(label: string, before: readonly string[], after: readonly string[]): string[] {
  const added = after.filter((value) => !before.includes(value))
  const removed = before.filter((value) => !after.includes(value))
  return [
    ...(added.length > 0 ? [`${label} added ${added.join(", ")}`] : []),
    ...(removed.length > 0 ? [`${label} removed ${removed.join(", ")}`] : []),
  ]
}

/** Exact lockfile drift. Human approval is supplied by reviewing the checked-in lockfile change. */
export function diffCapabilitySnapshots(
  before: CapabilitySnapshot,
  after: CapabilitySnapshot,
): readonly string[] {
  const previous = new Map(before.routes.map((route) => [routeSnapshotKey(route), route]))
  const current = new Map(after.routes.map((route) => [routeSnapshotKey(route), route]))
  const changes: string[] = []
  for (const [key, route] of current) {
    const old = previous.get(key)
    const prefix = `${route.method} ${route.path}`
    if (old === undefined) {
      changes.push(`${prefix}: route added`)
      continue
    }
    for (const delta of listDelta("declared", old.declared, route.declared))
      changes.push(`${prefix}: ${delta}`)
    for (const delta of listDelta("evidenced", old.evidenced, route.evidenced))
      changes.push(`${prefix}: ${delta}`)
    for (const delta of listDelta("unproven", old.unproven, route.unproven))
      changes.push(`${prefix}: ${delta}`)
  }
  for (const [key, route] of previous) {
    if (!current.has(key)) changes.push(`${route.method} ${route.path}: route removed`)
  }
  return Object.freeze(changes)
}

async function currentProject(
  cwd: string,
  configPath?: string,
): Promise<{
  readonly policy: CapabilityPolicy
  readonly project: CapabilityProjectReport
}> {
  // Source the capability report from the one project verification that `check`/`assure`/`levels` also
  // read, rather than loading the config and walking the module graph a second time here. `snapshot` and
  // `check` are then thin faces over the shared core; the lockfile write/diff is the only work that stays
  // capability-specific.
  const { collectProjectVerification } = await import("./verification.ts")
  const verification = await collectProjectVerification(
    cwd,
    configPath !== undefined ? { config: configPath } : {},
  )
  // A missing/broken config threw here before; re-throw the same error to keep that contract.
  if (verification.configError !== undefined) throw verification.configError
  const policy = verification.config?.capabilities
  if (policy === undefined) {
    throw new Error("[nifra] assurance config does not define capabilities")
  }
  // The core computes `capability` exactly when the config declares a capabilities policy, so it is
  // present whenever `policy` is.
  return { policy, project: verification.capability as CapabilityProjectReport }
}

function unsafeProject(project: CapabilityProjectReport): boolean {
  return !project.report.ok || project.violations.length > 0 || project.truncations.length > 0
}

export interface CapabilitySnapshotCommandResult {
  readonly ok: boolean
  readonly path: string
  readonly snapshot?: CapabilitySnapshot
  readonly report: CapabilityAssuranceReport
  readonly violations: readonly CapabilityImportViolation[]
  readonly truncations: readonly CapabilityProvenanceTruncation[]
}

export interface CapabilityCheckCommandResult {
  readonly ok: boolean
  readonly report: CapabilityAssuranceReport
  readonly violations: readonly CapabilityImportViolation[]
  readonly truncations: readonly CapabilityProvenanceTruncation[]
  readonly changes: readonly string[]
}

/** Collect the snapshot result without printing. The CLI and command catalog use this pure face. */
export async function collectCapabilitySnapshot(
  cwd: string,
  options: { readonly config?: string; readonly out?: string } = {},
): Promise<CapabilitySnapshotCommandResult> {
  const { policy, project } = await currentProject(cwd, options.config)
  const path = resolve(cwd, options.out ?? policy.lockfile ?? "capabilities.lock.json")
  if (unsafeProject(project)) {
    return {
      ok: false,
      path,
      report: project.report,
      violations: project.violations,
      truncations: project.truncations,
    }
  }
  const snapshot = snapshotCapabilities(project.report)
  await Bun.write(path, `${JSON.stringify(snapshot, null, 2)}\n`)
  return {
    ok: true,
    path,
    snapshot,
    report: project.report,
    violations: project.violations,
    truncations: project.truncations,
  }
}

/** Collect the lockfile gate without printing. */
export async function collectCapabilityCheck(
  cwd: string,
  options: { readonly config?: string; readonly lockfile?: string } = {},
): Promise<CapabilityCheckCommandResult> {
  const { policy, project } = await currentProject(cwd, options.config)
  const path = resolve(cwd, options.lockfile ?? policy.lockfile ?? "capabilities.lock.json")
  if (!existsSync(path)) throw new Error(`[nifra] capability lockfile not found: ${path}`)
  const baseline = parseCapabilityLockfile(await Bun.file(path).text(), path)
  const current = snapshotCapabilities(project.report)
  const changes = diffCapabilitySnapshots(baseline, current)
  return {
    ok: !unsafeProject(project) && changes.length === 0,
    report: project.report,
    violations: project.violations,
    truncations: project.truncations,
    changes,
  }
}

export type CapabilityExplainCommandResult =
  | CapabilityRouteExplanation
  | { readonly ok: false; readonly error: string; readonly routes: readonly string[] }

/** Collect one route explanation without printing. */
export async function collectCapabilityExplanation(
  cwd: string,
  method: string,
  path: string,
  options: { readonly config?: string } = {},
): Promise<CapabilityExplainCommandResult> {
  const { policy, project } = await currentProject(cwd, options.config)
  const explanation = explainCapabilityRoute(policy, project, method, path)
  if (explanation !== undefined) return explanation
  return {
    ok: false,
    error: `[nifra] capability route not found: ${method.toUpperCase()} ${path}`,
    routes: project.report.routes.map((route) => `${route.method} ${route.path}`),
  }
}

/** Write a lockfile only from a clean, fully-covered project report. */
export async function runCapabilitySnapshot(
  cwd: string,
  options: { readonly config?: string; readonly out?: string } = {},
): Promise<boolean> {
  const result = await collectCapabilitySnapshot(cwd, options)
  if (!result.ok) {
    console.error("[nifra] refusing to snapshot failing capability assurance")
    return false
  }
  console.log(`[nifra] wrote capability lockfile to ${result.path}`)
  return true
}

/** Fail on assurance violations or any drift from the checked-in capability lockfile. */
export async function runCapabilityCheck(
  cwd: string,
  options: { readonly config?: string; readonly lockfile?: string; readonly json?: boolean } = {},
): Promise<boolean> {
  const result = await collectCapabilityCheck(cwd, options)
  const ok = result.ok
  if (options.json === true) {
    console.log(
      JSON.stringify(
        {
          ok,
          report: result.report,
          violations: result.violations,
          truncations: result.truncations,
          changes: result.changes,
        },
        null,
        2,
      ),
    )
  } else if (ok) {
    console.log("✓ capability assurance and lockfile are current")
  } else {
    for (const finding of result.report.findings) console.log(`✖ ${finding.message}`)
    for (const violation of result.violations)
      console.log(
        `✖ ${violation.method} ${violation.path}: ${violation.chain.join(" → ")} - ${violation.reason}`,
      )
    for (const truncation of result.truncations)
      console.log(
        `✖ ${truncation.method} ${truncation.path}: ${truncation.chain.join(" → ")} - ${truncation.reason}`,
      )
    for (const change of result.changes) console.log(`✖ capability lock drift: ${change}`)
  }
  return ok
}

function formatCapabilityRouteExplanation(explanation: CapabilityRouteExplanation): string {
  const lines = [
    `${explanation.method} ${explanation.path}`,
    `status: ${explanation.ok ? "assured" : "needs attention"}`,
    `provenance coverage: ${explanation.route.covered ? "covered" : "uncovered"}`,
    `declared: ${explanation.route.declared.length > 0 ? explanation.route.declared.join(", ") : "none"}`,
    `evidence: ${
      explanation.route.evidence.length > 0
        ? explanation.route.evidence
            .map((item) => `${item.id} [${item.kind}] from ${item.source}`)
            .join(", ")
        : "none"
    }`,
    `unproven: ${explanation.route.unproven.length > 0 ? explanation.route.unproven.join(", ") : "none"}`,
  ]
  if (explanation.definitions.length > 0) {
    lines.push("definitions:")
    for (const definition of explanation.definitions) {
      lines.push(
        `  ${definition.id}: zone=${definition.zone}, access=${definition.access}, idempotency=${definition.idempotency ?? "none"}`,
      )
    }
  }
  if (explanation.findings.length > 0) {
    lines.push("findings:")
    for (const finding of explanation.findings) lines.push(`  ✖ ${finding.message}`)
  }
  for (const violation of explanation.violations) {
    lines.push(`  ✖ ${violation.chain.join(" → ")} - ${violation.reason}`)
  }
  for (const truncation of explanation.truncations) {
    lines.push(`  ✖ ${truncation.chain.join(" → ")} - ${truncation.reason}`)
  }
  lines.push(`note: ${explanation.note}`)
  return lines.join("\n")
}

/** Explain one route's token-only capability declaration and static provenance. */
export async function runCapabilityExplain(
  cwd: string,
  method: string,
  path: string,
  options: { readonly config?: string; readonly json?: boolean } = {},
): Promise<boolean> {
  const explanation = await collectCapabilityExplanation(cwd, method, path, options)
  if ("error" in explanation) {
    const message = explanation.error
    if (options.json === true) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            error: message,
            routes: explanation.routes,
          },
          null,
          2,
        ),
      )
    } else {
      console.error(message)
    }
    return false
  }
  if (options.json === true) console.log(JSON.stringify(explanation, null, 2))
  else console.log(formatCapabilityRouteExplanation(explanation))
  return explanation.ok
}

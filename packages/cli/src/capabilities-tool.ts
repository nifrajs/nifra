/** Static effect provenance, capability lockfile, and CLI commands. */

import { existsSync, readFileSync } from "node:fs"
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path"
import { matchesAssuranceSelector } from "@nifrajs/core/assurance"
import {
  type CapabilityAssuranceReport,
  type CapabilityPolicy,
  type CapabilitySnapshot,
  type CapabilitySnapshotRoute,
  defineCapabilityPolicy,
  evaluateCapabilityAssurance,
  snapshotCapabilities,
  validCapabilityId,
} from "@nifrajs/core/capabilities"
import { reflectRoutes } from "@nifrajs/core/reflection"
import { loadAssuranceConfig } from "./assure.ts"
import { scanStaticRouteText, stripComments, walkSource } from "./check.ts"

const EFFECT_IMPORT =
  /\bimport\s+(?!type\b)(?:[^'"();]*?\bfrom\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)|\bexport\s+(?!type\b)[^'";]*?\bfrom\s*["']([^"']+)["']/g
const TEMPLATE_EFFECT_IMPORT = /\b(?:import|require)\s*\(\s*`([^`$]*(?:\\.[^`$]*)*)`\s*\)/g

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
}

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
  let covered = false

  while (queue.length > 0 && visited.size < 500) {
    const current = queue.shift()
    if (current === undefined || visited.has(current.module) || current.chain.length > 16) continue
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
  return { covered, evidence, violations }
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
  }
  const evaluated = evaluateCapabilityAssurance(source, policy, { routes: evidenceRoutes })
  const report: CapabilityAssuranceReport =
    violations.length === 0
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
          ]),
        })
  return Object.freeze({ report, violations: Object.freeze(violations) })
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
      `[nifra] ${sourcePath} is not a nifra capability lockfile — expected { "nifraCapabilities": 1, "routes": [...] }`,
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
  const config = await loadAssuranceConfig(cwd, configPath)
  if (config.capabilities === undefined) {
    throw new Error("[nifra] assurance config does not define capabilities")
  }
  return {
    policy: config.capabilities,
    project: await collectCapabilityProjectReport(cwd, config.source, config.capabilities),
  }
}

function unsafeProject(project: CapabilityProjectReport): boolean {
  return !project.report.ok || project.violations.length > 0
}

/** Write a lockfile only from a clean, fully-covered project report. */
export async function runCapabilitySnapshot(
  cwd: string,
  options: { readonly config?: string; readonly out?: string } = {},
): Promise<boolean> {
  const { policy, project } = await currentProject(cwd, options.config)
  if (unsafeProject(project)) {
    console.error("[nifra] refusing to snapshot failing capability assurance")
    return false
  }
  const snapshot = snapshotCapabilities(project.report)
  const path = resolve(cwd, options.out ?? policy.lockfile ?? "capabilities.lock.json")
  await Bun.write(path, `${JSON.stringify(snapshot, null, 2)}\n`)
  console.log(`[nifra] wrote capability lockfile to ${path}`)
  return true
}

/** Fail on assurance violations or any drift from the checked-in capability lockfile. */
export async function runCapabilityCheck(
  cwd: string,
  options: { readonly config?: string; readonly lockfile?: string; readonly json?: boolean } = {},
): Promise<boolean> {
  const { policy, project } = await currentProject(cwd, options.config)
  const path = resolve(cwd, options.lockfile ?? policy.lockfile ?? "capabilities.lock.json")
  if (!existsSync(path)) throw new Error(`[nifra] capability lockfile not found: ${path}`)
  const baseline = parseCapabilityLockfile(await Bun.file(path).text(), path)
  const current = snapshotCapabilities(project.report)
  const changes = diffCapabilitySnapshots(baseline, current)
  const ok = !unsafeProject(project) && changes.length === 0
  if (options.json === true) {
    console.log(
      JSON.stringify(
        { ok, report: project.report, violations: project.violations, changes },
        null,
        2,
      ),
    )
  } else if (ok) {
    console.log("✓ capability assurance and lockfile are current")
  } else {
    for (const finding of project.report.findings) console.log(`✖ ${finding.message}`)
    for (const violation of project.violations)
      console.log(
        `✖ ${violation.method} ${violation.path}: ${violation.chain.join(" → ")} — ${violation.reason}`,
      )
    for (const change of changes) console.log(`✖ capability lock drift: ${change}`)
  }
  return ok
}

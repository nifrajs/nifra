/**
 * Static verification work graph for agents.
 *
 * The graph is intentionally a compact, token-only description of project structure. It connects
 * reflected routes to schemas, capabilities, assurance evidence, source/test files, and static
 * manifests. It never probes a running application and never persists payloads.
 */

import { existsSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { basename, resolve } from "node:path"
import { type ReflectedRoute, reflectRoutes } from "@nifrajs/core/reflection"
import { Glob } from "bun"
import { digestRoute } from "./contracts.ts"

export type WorkGraphNodeKind =
  | "route"
  | "schema"
  | "capability"
  | "assurance"
  | "test"
  | "file"
  | "manifest"

export interface WorkGraphNode {
  readonly id: string
  readonly kind: WorkGraphNodeKind
  readonly label: string
  readonly digest: string
  readonly files: readonly string[]
}

export interface WorkGraphEdge {
  readonly from: string
  readonly to: string
  readonly relation: "contains" | "declares" | "enforces" | "implements" | "tests" | "describes"
}

export interface WorkGraph {
  readonly version: 1
  readonly digest: string
  readonly nodes: readonly WorkGraphNode[]
  readonly edges: readonly WorkGraphEdge[]
  readonly freshness: BuildFreshness
}

export interface WorkGraphSourceFile {
  readonly path: string
  readonly content: string
  readonly kind?: "source" | "test" | "manifest"
}

export interface WorkGraphBuildInput {
  readonly source: unknown
  readonly files?: readonly WorkGraphSourceFile[]
  readonly freshness?: BuildFreshness
}

export interface BuildFreshness {
  readonly ok: boolean
  readonly buildDir?: string
  readonly newestSourceMs?: number
  readonly newestBuildMs?: number
  readonly reason?: string
}

export class StaleBuildError extends Error {
  constructor(readonly freshness: BuildFreshness) {
    super(freshness.reason ?? "nifra work graph requires a fresh build")
    this.name = "StaleBuildError"
  }
}

export interface ImpactReport {
  readonly changedFiles: readonly string[]
  readonly impactedNodes: readonly string[]
  readonly impactedRoutes: readonly string[]
}

export type ProofKind = "typecheck" | "contract" | "assurance" | "suite"

export interface ProofStep {
  readonly id: string
  readonly kind: ProofKind
  readonly level: number
  readonly cost: number
  readonly command: string
  readonly nodeIds: readonly string[]
  readonly fix?: string
}

export interface ProofPlan {
  readonly steps: readonly ProofStep[]
  readonly targetLevel: number
}

export type ProofStatus = "pass" | "fail" | "skip" | "pending"

export interface ProofEvidence {
  readonly id: string
  readonly status: ProofStatus
  readonly level: number
  readonly nodeIds: readonly string[]
  readonly command: string
  readonly fix?: string
}

export interface EvidenceBundle {
  readonly version: 1
  readonly graphDigest: string
  readonly changedFiles: readonly string[]
  readonly targetLevel: number
  readonly plan: ProofPlan
  readonly proofs: readonly ProofEvidence[]
  readonly stop: {
    readonly done: boolean
    readonly missing: readonly string[]
    readonly next?: ProofStep
  }
}

export interface ProjectWorkGraphResult {
  readonly graph: WorkGraph
  readonly impact: ImpactReport
  readonly plan: ProofPlan
  readonly evidence: EvidenceBundle
}

const SOURCE_GLOB = new Glob("**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,json}")
const IGNORED = /(^|\/)(node_modules|dist|build|\.nifra|\.git|\.wrangler|coverage)\//
const MANIFEST_NAMES = new Set([
  "server-manifest.ts",
  "nifra-manifest.json",
  "nifra-manifest.ts",
  "manifest.json",
])

export function evaluateBuildFreshness(input: {
  readonly hasArtifact: boolean
  readonly newestSourceMs: number
  readonly newestBuildMs: number
  readonly buildDir?: string
}): BuildFreshness {
  if (!input.hasArtifact) {
    return {
      ok: false,
      ...(input.buildDir === undefined ? {} : { buildDir: input.buildDir }),
      newestSourceMs: input.newestSourceMs,
      newestBuildMs: input.newestBuildMs,
      reason: "nifra work graph refused: no built artifact found; run `nifra build` first",
    }
  }
  if (input.newestSourceMs >= input.newestBuildMs) {
    return {
      ok: false,
      ...(input.buildDir === undefined ? {} : { buildDir: input.buildDir }),
      newestSourceMs: input.newestSourceMs,
      newestBuildMs: input.newestBuildMs,
      reason: "nifra work graph refused: the build is stale; run `nifra build` before graphing",
    }
  }
  return {
    ok: true,
    ...(input.buildDir === undefined ? {} : { buildDir: input.buildDir }),
    newestSourceMs: input.newestSourceMs,
    newestBuildMs: input.newestBuildMs,
  }
}

export async function inspectBuildFreshness(cwd: string): Promise<BuildFreshness> {
  const sourcePaths: string[] = []
  for (const name of ["backend.ts", "framework.ts", "nifra.config.ts"]) {
    const path = resolve(cwd, name)
    if (existsSync(path)) sourcePaths.push(path)
  }
  for await (const path of SOURCE_GLOB.scan({ cwd, dot: false })) {
    if (!IGNORED.test(path) && path.startsWith("routes/")) sourcePaths.push(resolve(cwd, path))
  }
  const sourceTimes = await fileTimes(sourcePaths)
  for (const buildDirName of ["dist", "build"]) {
    const buildDir = resolve(cwd, buildDirName)
    if (!existsSync(buildDir)) continue
    const artifacts: string[] = []
    for await (const path of new Glob("**/*.{js,mjs,cjs}").scan({ cwd: buildDir, dot: false })) {
      artifacts.push(resolve(buildDir, path))
    }
    if (artifacts.length === 0) continue
    const buildTimes = await fileTimes(artifacts)
    return evaluateBuildFreshness({
      hasArtifact: true,
      newestSourceMs: sourceTimes,
      newestBuildMs: buildTimes,
      buildDir: buildDirName,
    })
  }
  return evaluateBuildFreshness({
    hasArtifact: false,
    newestSourceMs: sourceTimes,
    newestBuildMs: 0,
  })
}

export async function collectProjectWorkGraph(
  cwd: string,
  options: { readonly changedFiles?: readonly string[]; readonly minLevel?: number } = {},
): Promise<ProjectWorkGraphResult> {
  const freshness = await inspectBuildFreshness(cwd)
  if (!freshness.ok) throw new StaleBuildError(freshness)
  const backendPath = resolve(cwd, "backend.ts")
  if (!existsSync(backendPath)) throw new Error(`[nifra] no backend.ts in ${cwd}`)
  const loadedValue: unknown = await import(`${backendPath}?nifra-work-graph=${Date.now()}`)
  const loaded = recordOf(loadedValue)
  if (loaded?.backend === undefined)
    throw new Error(`[nifra] ${backendPath} does not export backend`)
  const files = await collectProjectFiles(cwd)
  return buildProjectWorkGraph({ source: loaded.backend, files, freshness }, options)
}

export async function buildProjectWorkGraph(
  input: WorkGraphBuildInput,
  options: { readonly changedFiles?: readonly string[]; readonly minLevel?: number } = {},
): Promise<ProjectWorkGraphResult> {
  const freshness = input.freshness ?? { ok: true }
  if (!freshness.ok) throw new StaleBuildError(freshness)
  const graph = await buildWorkGraph(input)
  const impact = queryImpact(graph, options.changedFiles ?? [])
  const plan = planProofs(graph, impact, options.minLevel ?? 1)
  const evidence = createEvidenceBundle(graph, impact, plan)
  return Object.freeze({ graph, impact, plan, evidence })
}

export async function buildWorkGraph(input: WorkGraphBuildInput): Promise<WorkGraph> {
  const routes = reflectRoutes(input.source)
  const files = input.files ?? []
  const nodes = new Map<string, WorkGraphNode>()
  const edges: WorkGraphEdge[] = []
  const addNode = (node: WorkGraphNode): void => {
    if (!nodes.has(node.id)) nodes.set(node.id, node)
  }
  const addEdge = (edge: WorkGraphEdge): void => {
    if (
      !edges.some(
        (item) => item.from === edge.from && item.to === edge.to && item.relation === edge.relation,
      )
    )
      edges.push(edge)
  }
  for (const file of files) {
    const kind =
      file.kind ??
      (isTestFile(file.path)
        ? "test"
        : MANIFEST_NAMES.has(basename(file.path))
          ? "manifest"
          : "source")
    if (kind === "source") addNode(await fileNode(file, "file"))
    if (kind === "test") addNode(await fileNode(file, "test"))
    if (kind === "manifest") addNode(await fileNode(file, "manifest"))
  }
  const sourceFiles = files.filter((file) => (file.kind ?? "source") === "source")
  const testFiles = files.filter(
    (file) => (file.kind ?? "source") === "test" || isTestFile(file.path),
  )
  const manifestFiles = files.filter(
    (file) => (file.kind ?? "source") === "manifest" || MANIFEST_NAMES.has(basename(file.path)),
  )
  for (const route of routes) {
    const routeKey = `${route.method} ${route.path}`
    const routeId = `route:${routeKey}`
    const routeDigest = await digestRoute(route)
    const routeFiles = filesForRoute(route, sourceFiles)
    addNode({
      id: routeId,
      kind: "route",
      label: routeKey,
      digest: await digestJson({ route: routeKey, routeDigest }),
      files: routeFiles,
    })
    for (const file of routeFiles)
      addEdge({ from: `file:${file}`, to: routeId, relation: "implements" })
    if (routeFiles.length === 0 && sourceFiles.some((file) => file.path === "backend.ts"))
      addEdge({ from: "file:backend.ts", to: routeId, relation: "implements" })
    for (const [name, schema] of Object.entries(route.schema ?? {})) {
      if (schema === undefined || name === "errors") continue
      const schemaId = `schema:${routeKey}:${name}`
      addNode({
        id: schemaId,
        kind: "schema",
        label: `${routeKey} ${name}`,
        digest: await digestJson(schema.jsonSchema ?? schema.fields ?? null),
        files: routeFiles,
      })
      addEdge({ from: routeId, to: schemaId, relation: "contains" })
    }
    for (const capability of route.capabilities ?? []) {
      const capabilityId = `capability:${capability}`
      addNode({
        id: capabilityId,
        kind: "capability",
        label: capability,
        digest: await digestJson(capability),
        files: routeFiles,
      })
      addEdge({ from: routeId, to: capabilityId, relation: "declares" })
    }
    for (const assurance of route.assurance ?? []) {
      const assuranceId = `assurance:${routeKey}:${assurance.id}`
      addNode({
        id: assuranceId,
        kind: "assurance",
        label: `${routeKey} ${assurance.id}`,
        digest: await digestJson(assurance),
        files: routeFiles,
      })
      addEdge({ from: routeId, to: assuranceId, relation: "enforces" })
    }
    for (const file of testFiles) {
      if (!mentionsRoute(file.content, route)) continue
      const testId = `test:${file.path}`
      addEdge({ from: testId, to: routeId, relation: "tests" })
    }
    for (const file of manifestFiles)
      addEdge({ from: `manifest:${file.path}`, to: routeId, relation: "describes" })
  }
  const sortedNodes = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id))
  const sortedEdges = edges.sort((a, b) =>
    `${a.from}\n${a.to}\n${a.relation}`.localeCompare(`${b.from}\n${b.to}\n${b.relation}`),
  )
  const digest = await digestJson({ nodes: sortedNodes, edges: sortedEdges })
  return Object.freeze({
    version: 1,
    digest,
    nodes: Object.freeze(sortedNodes),
    edges: Object.freeze(sortedEdges),
    freshness: input.freshness ?? { ok: true },
  })
}

export function queryImpact(graph: WorkGraph, changedFiles: readonly string[]): ImpactReport {
  const normalized = [
    ...new Set(changedFiles.map((file) => file.replace(/^\.\//, "").replaceAll("\\", "/"))),
  ]
  const seeds = new Set<string>()
  for (const file of normalized) {
    for (const node of graph.nodes) {
      if (
        (node.kind === "file" || node.kind === "test" || node.kind === "manifest") &&
        (node.id === `file:${file}` ||
          node.id === `test:${file}` ||
          node.id === `manifest:${file}` ||
          node.files.includes(file))
      )
        seeds.add(node.id)
    }
  }
  if (normalized.includes("backend.ts"))
    for (const node of graph.nodes) if (node.kind === "route") seeds.add(node.id)
  const impacted = new Set(seeds)
  const queue = [...seeds]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const edge of graph.edges) {
      if (edge.from !== current || impacted.has(edge.to)) continue
      impacted.add(edge.to)
      queue.push(edge.to)
    }
  }
  const impactedRoutes = graph.nodes
    .filter((node) => node.kind === "route" && impacted.has(node.id))
    .map((node) => node.label)
    .sort()
  return Object.freeze({
    changedFiles: Object.freeze(normalized.sort()),
    impactedNodes: Object.freeze([...impacted].sort()),
    impactedRoutes: Object.freeze(impactedRoutes),
  })
}

export function planProofs(graph: WorkGraph, impact: ImpactReport, targetLevel = 1): ProofPlan {
  if (!Number.isInteger(targetLevel) || targetLevel < 0 || targetLevel > 4)
    throw new RangeError("work graph: targetLevel must be an integer from 0 to 4")
  const nodeIds = impact.impactedNodes
  const routeIds = graph.nodes
    .filter((node) => node.kind === "route" && nodeIds.includes(node.id))
    .map((node) => node.id)
  const steps: ProofStep[] = []
  if (nodeIds.length > 0) {
    steps.push({
      id: "proof:typecheck",
      kind: "typecheck",
      level: 0,
      cost: 1,
      command: "nifra check --lints-only",
      nodeIds,
    })
    steps.push({
      id: "proof:contract",
      kind: "contract",
      level: 1,
      cost: 2,
      command: "nifra contracts check --json",
      nodeIds: routeIds,
    })
    steps.push({
      id: "proof:assurance",
      kind: "assurance",
      level: 2,
      cost: 3,
      command: "nifra assure --json --strict",
      nodeIds: routeIds,
    })
    steps.push({
      id: "proof:suite",
      kind: "suite",
      level: 3,
      cost: 4,
      command: "nifra test",
      nodeIds,
    })
  }
  return Object.freeze({
    steps: Object.freeze(
      steps.filter((step) => step.level <= Math.max(targetLevel, 0) || targetLevel > 3),
    ),
    targetLevel,
  })
}

export function createEvidenceBundle(
  graph: WorkGraph,
  impact: ImpactReport,
  plan: ProofPlan,
  proofs: readonly ProofEvidence[] = [],
): EvidenceBundle {
  const evidence = [...proofs].sort((a, b) => a.id.localeCompare(b.id))
  // Levels are not cumulative (assure does not typecheck), so every planned step needs its own
  // passing proof; a higher-level pass never subsumes a lower one.
  const done =
    impact.impactedNodes.length === 0 ||
    plan.steps.every((step) =>
      evidence.some((item) => item.id === step.id && item.status === "pass"),
    )
  const missing = done
    ? []
    : plan.steps
        .filter((step) => !evidence.some((item) => item.id === step.id && item.status === "pass"))
        .map((step) => step.command)
  const next = done
    ? undefined
    : plan.steps.find(
        (step) => !evidence.some((item) => item.id === step.id && item.status === "pass"),
      )
  return Object.freeze({
    version: 1,
    graphDigest: graph.digest,
    changedFiles: impact.changedFiles,
    targetLevel: plan.targetLevel,
    plan,
    proofs: Object.freeze(evidence),
    stop: Object.freeze({
      done,
      missing: Object.freeze(missing),
      ...(next === undefined ? {} : { next }),
    }),
  })
}

export function recordProof(bundle: EvidenceBundle, proof: ProofEvidence): EvidenceBundle {
  const graph: WorkGraph = {
    version: 1,
    digest: bundle.graphDigest,
    nodes: [],
    edges: [],
    freshness: { ok: true },
  }
  const impact: ImpactReport = {
    changedFiles: bundle.changedFiles,
    impactedNodes: bundle.stop.done ? [] : ["pending"],
    impactedRoutes: [],
  }
  return createEvidenceBundle(graph, impact, bundle.plan, [
    ...bundle.proofs.filter((item) => item.id !== proof.id),
    proof,
  ])
}

export function renderWorkGraphJson(result: ProjectWorkGraphResult): string {
  return JSON.stringify(result, null, 2)
}

export async function runWorkGraph(
  cwd: string,
  options: {
    readonly changedFiles?: readonly string[]
    readonly minLevel?: number
    readonly json?: boolean
  } = {},
): Promise<boolean> {
  const result = await collectProjectWorkGraph(cwd, options)
  console.log(options.json === false ? renderWorkGraphText(result) : renderWorkGraphJson(result))
  return result.evidence.stop.done
}

export function renderWorkGraphText(result: ProjectWorkGraphResult): string {
  const lines = [
    `work graph ${result.graph.digest.slice(0, 12)} (${result.graph.nodes.length} nodes, ${result.graph.edges.length} edges)`,
    `changed: ${result.impact.changedFiles.length === 0 ? "none" : result.impact.changedFiles.join(", ")}`,
    `impacted routes: ${result.impact.impactedRoutes.length === 0 ? "none" : result.impact.impactedRoutes.join(", ")}`,
    `stop: ${result.evidence.stop.done ? "done" : "pending"}`,
  ]
  if (!result.evidence.stop.done)
    lines.push(`next: ${result.evidence.stop.next?.command ?? "no proof available"}`)
  return lines.join("\n")
}

async function collectProjectFiles(cwd: string): Promise<WorkGraphSourceFile[]> {
  const files: WorkGraphSourceFile[] = []
  for await (const path of SOURCE_GLOB.scan({ cwd, dot: false })) {
    if (IGNORED.test(path)) continue
    const full = resolve(cwd, path)
    try {
      const content = await readFile(full, "utf8")
      files.push({
        path,
        content,
        ...(isTestFile(path)
          ? { kind: "test" as const }
          : MANIFEST_NAMES.has(basename(path))
            ? { kind: "manifest" as const }
            : {}),
      })
    } catch {
      // A file can disappear while an agent is editing. The next graph run sees the settled tree.
    }
  }
  return files
}

async function fileTimes(paths: readonly string[]): Promise<number> {
  let newest = 0
  for (const path of paths) {
    try {
      newest = Math.max(newest, (await stat(path)).mtimeMs)
    } catch {
      // Missing source files are simply absent from the timestamp scan.
    }
  }
  return newest
}

async function fileNode(
  file: WorkGraphSourceFile,
  kind: "file" | "test" | "manifest",
): Promise<WorkGraphNode> {
  return {
    id: `${kind}:${file.path}`,
    kind,
    label: file.path,
    digest: await digestJson(file.content),
    files: [file.path],
  }
}

function filesForRoute(
  route: ReflectedRoute,
  files: readonly WorkGraphSourceFile[],
): readonly string[] {
  const matches = files
    .filter(
      (file) =>
        file.path === "backend.ts" ||
        (file.path.startsWith("routes/") && file.content.includes(route.path)),
    )
    .map((file) => file.path)
  return [...new Set(matches)].sort()
}

/**
 * A missing edge silently drops a test from the proof plan, so matching is recall-first: a literal
 * path mention, or the static prefix of a parameterised path (tests call "/orders/123", not
 * "/orders/:id"). Bare method words are never a signal on their own - "get" appears everywhere.
 */
function mentionsRoute(content: string, route: ReflectedRoute): boolean {
  if (route.path === "/") return /["'`]\/["'`]/.test(content)
  if (content.includes(route.path)) return true
  const prefix = staticPathPrefix(route.path)
  return prefix !== undefined && content.includes(prefix)
}

function staticPathPrefix(path: string): string | undefined {
  const staticSegments: string[] = []
  for (const segment of path.split("/")) {
    if (segment.startsWith(":") || segment.startsWith("*")) break
    if (segment !== "") staticSegments.push(segment)
  }
  return staticSegments.length === 0 ? undefined : `/${staticSegments.join("/")}/`
}

function isTestFile(path: string): boolean {
  return /(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\.[^.]+$/.test(path)
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
}

async function digestJson(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  return [...digest].map((item) => item.toString(16).padStart(2, "0")).join("")
}

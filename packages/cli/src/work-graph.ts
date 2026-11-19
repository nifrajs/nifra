/**
 * Static verification work graph for agents.
 *
 * The graph is intentionally a compact, token-only description of project structure. It connects
 * reflected routes to schemas, capabilities, assurance evidence, source/test files, and static
 * manifests. It never probes a running application and never persists payloads.
 */

import { createReadStream, existsSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { basename, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  type ProjectEvidenceSnapshot,
  reflectedRoutesFromEvidence,
  snapshotProjectEvidence,
} from "@nifrajs/core/evidence"
import type { ReflectedRoute } from "@nifrajs/core/reflection"
import { Glob } from "bun"
import { BACKEND_APP_FILE, CONFIG_FILE, FRAMEWORK_FILE } from "./app-files.ts"
import { digestRoute } from "./contracts.ts"
import { codeUnitOrder } from "./internal/code-unit-order.ts"
import { VERIFICATION_GATES, type VerificationGate } from "./verification-gates.ts"

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
  /** Reuse a canonical route-evidence pass when the caller already has one. */
  readonly evidence?: ProjectEvidenceSnapshot
  readonly files?: readonly WorkGraphSourceFile[]
  readonly freshness?: BuildFreshness
}

export interface BuildFreshness {
  readonly ok: boolean
  readonly buildDir?: string
  readonly newestSourceMs?: number
  readonly newestBuildMs?: number
  readonly buildDigest?: string | undefined
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

export type ProofKind = VerificationGate["kind"]

export interface ProofStep {
  readonly id: string
  readonly kind: ProofKind
  readonly level: number
  readonly cost: number
  readonly command: string
  /** Impact hints. Every ladder gate verifies the project as a whole. */
  readonly nodeIds: readonly string[]
  readonly fix?: string
}

export interface ProofPlan {
  readonly steps: readonly ProofStep[]
  readonly targetLevel: number
}

export type ProofStatus = "pass" | "fail" | "skip" | "pending"

export interface ProofEvidence {
  readonly graphDigest: string
  readonly buildDigest?: string | undefined
  readonly id: string
  readonly status: ProofStatus
  readonly level: number
  readonly nodeIds: readonly string[]
  readonly command: string
  readonly fix?: string | undefined
}

export interface EvidenceBundle {
  readonly version: 2
  readonly graphDigest: string
  readonly buildDigest?: string | undefined
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

// Framework component, content, and style files are app source too: an edit to one makes a build stale.
const SOURCE_GLOB = new Glob(
  "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,json,jsonc,svelte,vue,md,mdx,css,lock,lockb,toml,yaml,yml}",
)
const BUILD_FILES = new Glob("**/*")
const SERVER_ARTIFACT = /\.[cm]?js$/
const IGNORED = /(^|\/)(node_modules|dist|build|\.nifra|\.git|\.wrangler|coverage)\//
const APP_SOURCE_DIR = /^(?:routes|frontend|backend|shared)\//
const BACKEND_SOURCE_DIR = /^(?:backend|shared)\//
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
  for (const name of [BACKEND_APP_FILE, FRAMEWORK_FILE, CONFIG_FILE]) {
    const path = resolve(cwd, name)
    if (existsSync(path)) sourcePaths.push(path)
  }
  for await (const rawPath of SOURCE_GLOB.scan({ cwd, dot: false })) {
    const path = rawPath.replaceAll("\\", "/")
    if (!IGNORED.test(path) && APP_SOURCE_DIR.test(path)) sourcePaths.push(resolve(cwd, path))
  }
  const sourceTimes = await fileTimes(sourcePaths)
  for (const buildDirName of ["dist", "build"]) {
    const buildDir = resolve(cwd, buildDirName)
    if (!existsSync(buildDir)) continue
    const artifacts = [...BUILD_FILES.scanSync({ cwd: buildDir, dot: true })].sort(codeUnitOrder)
    const scripts = artifacts.filter((path) => SERVER_ARTIFACT.test(path))
    if (scripts.length === 0) continue
    const freshness = evaluateBuildFreshness({
      hasArtifact: true,
      newestSourceMs: sourceTimes,
      newestBuildMs: await fileTimes(scripts.map((path) => resolve(buildDir, path))),
      buildDir: buildDirName,
    })
    if (!freshness.ok) return freshness
    const hasher = new Bun.CryptoHasher("sha256")
    for (const path of artifacts) {
      const fileHash = new Bun.CryptoHasher("sha256")
      for await (const chunk of createReadStream(resolve(buildDir, path))) fileHash.update(chunk)
      hasher.update(JSON.stringify([path, fileHash.digest("hex")]))
    }
    return { ...freshness, buildDigest: hasher.digest("hex") }
  }
  return evaluateBuildFreshness({
    hasArtifact: false,
    newestSourceMs: sourceTimes,
    newestBuildMs: 0,
  })
}

interface WorkGraphOptions {
  readonly changedFiles?: readonly string[]
  readonly minLevel?: number
  readonly execute?: boolean
  readonly signal?: AbortSignal
}

export async function collectProjectWorkGraph(
  cwd: string,
  options: WorkGraphOptions = {},
): Promise<ProjectWorkGraphResult> {
  const freshness = await inspectBuildFreshness(cwd)
  if (!freshness.ok) throw new StaleBuildError(freshness)
  const backendPath = resolve(cwd, BACKEND_APP_FILE)
  if (!existsSync(backendPath)) throw new Error(`[nifra] no ${BACKEND_APP_FILE} in ${cwd}`)
  const files = await collectProjectFiles(cwd)
  const backendUrl = pathToFileURL(backendPath)
  backendUrl.searchParams.set("nifra-work-graph", crypto.randomUUID())
  const loadedValue: unknown = await import(backendUrl.href)
  const loaded = recordOf(loadedValue)
  if (loaded?.backend === undefined)
    throw new Error(`[nifra] ${backendPath} does not export backend`)
  const result = await buildProjectWorkGraph({ source: loaded.backend, files, freshness }, options)
  if (options.execute !== true) return result

  const throughLevel = VERIFICATION_GATES.find(
    (gate) => gate.level === result.plan.targetLevel,
  )?.level
  if (throughLevel === undefined) throw new RangeError("invalid proof target level")
  // A fresh process gives assurance the current imports and lets it record route sites on first load.
  const { askProjectChild } = await import("./mcp-isolate.ts")
  const verification = await askProjectChild(
    cwd,
    { op: "proof-gates", level: throughLevel },
    options.signal === undefined
      ? {}
      : { context: { signal: options.signal, requestId: null, reportProgress: () => {} } },
  )
  if (!verification.ok || !("proofGates" in verification))
    throw new Error("nifra prove: verification process did not return gate results")
  const after = await inspectBuildFreshness(cwd)
  if (
    !after.ok ||
    after.buildDigest !== freshness.buildDigest ||
    after.buildDir !== freshness.buildDir ||
    sourceDigest(await collectProjectFiles(cwd)) !== sourceDigest(files)
  ) {
    throw new StaleBuildError({
      ...after,
      ok: false,
      reason: "nifra prove refused: source or build changed during verification; rerun the proof",
    })
  }
  options.signal?.throwIfAborted()
  const proofs = result.plan.steps.map((step): ProofEvidence => {
    const level = verification.proofGates.find((status) => status.level === step.level)
    return {
      ...step,
      graphDigest: result.graph.digest,
      buildDigest: freshness.buildDigest,
      status: level === undefined ? "skip" : level.ok ? "pass" : "fail",
      fix:
        level?.ok === false
          ? `Run nifra ${step.level === 0 ? "check" : "levels"} for diagnostics`
          : undefined,
    }
  })
  return Object.freeze({
    ...result,
    evidence: createEvidenceBundle(result.graph, result.impact, result.plan, proofs),
  })
}

export async function buildProjectWorkGraph(
  input: WorkGraphBuildInput,
  options: { readonly changedFiles?: readonly string[]; readonly minLevel?: number } = {},
): Promise<ProjectWorkGraphResult> {
  const freshness = input.freshness ?? { ok: true }
  if (!freshness.ok) throw new StaleBuildError(freshness)
  const projectEvidence = input.evidence ?? snapshotProjectEvidence(input.source)
  const graph = await buildWorkGraph({ ...input, evidence: projectEvidence })
  const impact = queryImpact(graph, options.changedFiles ?? [])
  const plan = planProofs(graph, impact, options.minLevel ?? 1)
  const evidence = createEvidenceBundle(graph, impact, plan)
  return Object.freeze({ graph, impact, plan, evidence })
}

export async function buildWorkGraph(input: WorkGraphBuildInput): Promise<WorkGraph> {
  const routes = reflectedRoutesFromEvidence(
    input.evidence ?? snapshotProjectEvidence(input.source),
  )
  const files = input.files ?? []
  const nodes = new Map<string, WorkGraphNode>()
  const edges: WorkGraphEdge[] = []
  const edgeKeys = new Set<string>()
  const addNode = (node: WorkGraphNode): void => {
    if (!nodes.has(node.id)) nodes.set(node.id, node)
  }
  const addEdge = (edge: WorkGraphEdge): void => {
    const key = `${edge.from}\n${edge.to}\n${edge.relation}`
    if (edgeKeys.has(key)) return
    edgeKeys.add(key)
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
    if (routeFiles.length === 0 && sourceFiles.some((file) => file.path === BACKEND_APP_FILE))
      addEdge({ from: `file:${BACKEND_APP_FILE}`, to: routeId, relation: "implements" })
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
  const sortedNodes = [...nodes.values()].sort((a, b) => codeUnitOrder(a.id, b.id))
  const sortedEdges = edges.sort((a, b) =>
    codeUnitOrder(`${a.from}\n${a.to}\n${a.relation}`, `${b.from}\n${b.to}\n${b.relation}`),
  )
  const digest = await digestJson({
    nodes: sortedNodes,
    edges: sortedEdges,
    build: input.freshness?.buildDigest,
  })
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
  const unmodeled: string[] = []
  for (const file of normalized) {
    let seeded = false
    for (const node of graph.nodes) {
      if (
        (node.kind === "file" || node.kind === "test" || node.kind === "manifest") &&
        (node.id === `file:${file}` ||
          node.id === `test:${file}` ||
          node.id === `manifest:${file}` ||
          node.files.includes(file))
      ) {
        seeds.add(node.id)
        seeded = true
      }
    }
    // An app file the graph does not model (deleted, or a type it does not read) has an unknown
    // reach, so it stands for itself and impacts every route rather than proving nothing.
    if (!seeded && APP_SOURCE_DIR.test(file)) unmodeled.push(file)
  }
  for (const file of unmodeled) seeds.add(`file:${file}`)
  // Any backend or shared module can reach every handler through backend/app.ts.
  if (unmodeled.length > 0 || normalized.some((file) => BACKEND_SOURCE_DIR.test(file)))
    for (const node of graph.nodes) if (node.kind === "route") seeds.add(node.id)
  const targets = new Map<string, string[]>()
  for (const edge of graph.edges) {
    const from = targets.get(edge.from)
    if (from === undefined) targets.set(edge.from, [edge.to])
    else from.push(edge.to)
  }
  const impacted = new Set(seeds)
  const queue = [...seeds]
  // Iterating an array visits what is pushed onto it meanwhile, so this is the breadth-first walk.
  for (const current of queue) {
    for (const to of targets.get(current) ?? []) {
      if (impacted.has(to)) continue
      impacted.add(to)
      queue.push(to)
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
  const steps = VERIFICATION_GATES.filter((gate) => gate.level <= targetLevel).map(
    (gate): ProofStep => ({
      id: `proof:${gate.kind}`,
      kind: gate.kind,
      level: gate.level,
      cost: gate.level + 1,
      command: `nifra prove --run --min ${gate.level} --json`,
      nodeIds: gate.kind === "typecheck" ? nodeIds : routeIds,
    }),
  )
  return Object.freeze({ steps: Object.freeze(steps), targetLevel })
}

export function createEvidenceBundle(
  graph: WorkGraph,
  impact: ImpactReport,
  plan: ProofPlan,
  proofs: readonly ProofEvidence[] = [],
): EvidenceBundle {
  const byGate = new Map<string, ProofEvidence>()
  for (const proof of proofs) {
    if (proof.graphDigest !== graph.digest || proof.buildDigest !== graph.freshness.buildDigest)
      continue
    const step = plan.steps.find((candidate) => matchesStep(proof, candidate))
    if (step !== undefined) byGate.set(proof.id, { ...proof, nodeIds: step.nodeIds })
  }
  const evidence = [...byGate.values()].sort((a, b) => codeUnitOrder(a.id, b.id))
  const pending = plan.steps.filter(
    (step) => !evidence.some((item) => item.id === step.id && item.status === "pass"),
  )
  const next = pending[0]
  return Object.freeze({
    version: 2,
    graphDigest: graph.digest,
    buildDigest: graph.freshness.buildDigest,
    changedFiles: impact.changedFiles,
    targetLevel: plan.targetLevel,
    plan,
    proofs: Object.freeze(evidence),
    stop: Object.freeze({
      done: next === undefined,
      missing: Object.freeze(pending.map((step) => step.command)),
      ...(next === undefined ? {} : { next }),
    }),
  })
}

function matchesStep(proof: ProofEvidence, step: ProofStep): boolean {
  return proof.id === step.id && proof.level === step.level && proof.command === step.command
}

export function recordProof(bundle: EvidenceBundle, proof: ProofEvidence): EvidenceBundle {
  if (
    proof.graphDigest !== bundle.graphDigest ||
    proof.buildDigest !== bundle.buildDigest ||
    !bundle.plan.steps.some((step) => matchesStep(proof, step))
  ) {
    throw new Error("nifra prove refused: proof belongs to a different snapshot or gate")
  }
  const graph: WorkGraph = {
    version: 1,
    digest: bundle.graphDigest,
    nodes: [],
    edges: [],
    freshness: {
      ok: true,
      buildDigest: bundle.buildDigest,
    },
  }
  return createEvidenceBundle(
    graph,
    { changedFiles: bundle.changedFiles, impactedNodes: [], impactedRoutes: [] },
    bundle.plan,
    [...bundle.proofs.filter((item) => item.id !== proof.id), proof],
  )
}

export function renderWorkGraphJson(result: ProjectWorkGraphResult): string {
  return JSON.stringify(result, null, 2)
}

export async function runWorkGraph(
  cwd: string,
  options: WorkGraphOptions & { readonly json?: boolean } = {},
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
  for (const proof of result.evidence.proofs) {
    lines.push(`L${proof.level} ${proof.status}${proof.fix === undefined ? "" : ` - ${proof.fix}`}`)
  }
  if (!result.evidence.stop.done)
    lines.push(`next: ${result.evidence.stop.next?.command ?? "no proof available"}`)
  return lines.join("\n")
}

async function collectProjectFiles(cwd: string): Promise<WorkGraphSourceFile[]> {
  const files: WorkGraphSourceFile[] = []
  for await (const rawPath of SOURCE_GLOB.scan({ cwd, dot: false })) {
    const path = rawPath.replaceAll("\\", "/")
    if (IGNORED.test(path)) continue
    const bytes = await readFile(resolve(cwd, path))
    files.push({
      path,
      content: path.endsWith(".lockb")
        ? Bun.CryptoHasher.hash("sha256", bytes, "hex")
        : bytes.toString("utf8"),
      ...(isTestFile(path)
        ? { kind: "test" as const }
        : MANIFEST_NAMES.has(basename(path))
          ? { kind: "manifest" as const }
          : {}),
    })
  }
  return files.sort((a, b) => codeUnitOrder(a.path, b.path))
}

function sourceDigest(files: readonly WorkGraphSourceFile[]): string {
  const hash = new Bun.CryptoHasher("sha256")
  for (const { path, content } of files) hash.update(JSON.stringify([path, content]))
  return hash.digest("hex")
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
        file.path === BACKEND_APP_FILE ||
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

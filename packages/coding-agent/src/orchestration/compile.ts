/**
 * Compile a declarative {@link RunPlan} into the existing {@link WorkflowRunner} step tree. There is
 * no second execution engine and no copied scheduler: the plan's top-level DAG is layered
 * (deterministic, id tie-break) into the kernel's `sequence`/`parallel` primitives, and every node -
 * leaf or structural - is lowered onto `task`/`verify`/`approve`/`checkpoint`/`handoff`/`retry`/
 * `branch` steps or, for a `subagent` node, onto a {@link BoundedSubagentRunner}. Effect-key
 * derivation and the artifact sink are wired into each leaf closure at compile time.
 *
 * All structural ceilings (node count, nesting depth, parallel breadth, pinned version, and the
 * capability authority ceiling) are enforced here, before a single node runs.
 */

import type {
  ArtifactContext,
  ArtifactPort,
  ArtifactRef,
  NodeEffectKey,
  RunNode,
  RunPlan,
} from "@nifrajs/agent-protocol"
import { parseRunPlan } from "@nifrajs/agent-protocol"
import { BoundedSubagentRunner } from "../subagents.ts"
import type { WorkflowContext, WorkflowStep } from "../workflows.ts"
import { type CatalogStep, type StepCatalog, type StepRunContext, stepVersion } from "./catalog.ts"
import { deriveNodeEffectKey } from "./effect-key.ts"
import { canonicalJson, sha256HexOf } from "./hash.ts"

/** Thrown when a plan cannot be lowered. `code` is a stable evidence code. */
export class CompileError extends Error {
  constructor(
    reason: string,
    readonly code: string,
  ) {
    super(`orchestration compile: ${reason}`)
    this.name = "CompileError"
  }
}

/** Host-owned ceilings. A plan can only tighten, never widen, these. */
export interface OrchestrationLimits {
  /** Total nodes in the whole tree. Default 256. */
  readonly maxNodes?: number
  /** Maximum structural nesting depth. Default 8. */
  readonly maxDepth?: number
  /** Host concurrency ceiling for any parallel layer or node. Default: the child count. */
  readonly maxParallel?: number
  /** Bounded-subagent child ceiling. Default 4. */
  readonly maxChildren?: number
  /** Capability authority ceiling. `undefined` grants all; otherwise a step's needs must be a subset. */
  readonly allowedCapabilities?: readonly string[]
}

const DEFAULT_MAX_NODES = 256
const DEFAULT_MAX_DEPTH = 8
const DEFAULT_MAX_CHILDREN = 4

/** Stable digest of a plan's canonical form. Structural identity that node effect keys hang from. */
export function digestRunPlan(plan: RunPlan): Promise<string> {
  return sha256HexOf(canonicalJson(plan))
}

/** Wiring the compiler injects into every node closure. */
export interface CompileOptions {
  readonly catalog: StepCatalog
  readonly planDigest: string
  readonly artifactPort: ArtifactPort
  readonly limits?: OrchestrationLimits
  /** Called once a node's content-free effect key is derived (idempotent steps only). */
  onNodeEffect?(nodeId: string, key: NodeEffectKey): void
  /** Called for each artifact ref a node produces through its port. */
  collectArtifact?(nodeId: string, ref: ArtifactRef): void
}

/**
 * Compile `source` (a RunPlan or its serialized form) into a single WorkflowStep. The input is
 * always re-parsed through {@link parseRunPlan}, so a malformed or content-bearing plan fails closed.
 */
export function compileRunPlan(source: RunPlan | unknown, options: CompileOptions): WorkflowStep {
  const layerSteps = compileRunPlanLayers(source, options)
  return layerSteps.length === 1
    ? (layerSteps[0] as WorkflowStep)
    : { type: "sequence", steps: layerSteps }
}

/**
 * Compile `source` into one {@link WorkflowStep} per top-level DAG layer, preserving the same
 * ceilings and lowering as {@link compileRunPlan}. A driver can run the layers in order and hold at
 * a layer boundary (a safe-pause point) without a second scheduler: each layer is still executed by
 * the kernel {@link WorkflowRunner}, and the layer split is the very partition compileRunPlan folds
 * into a single `sequence`.
 */
export function compileRunPlanLayers(
  source: RunPlan | unknown,
  options: CompileOptions,
): readonly WorkflowStep[] {
  const plan = parseRunPlan(source)
  const limits = options.limits ?? {}
  const total = plan.nodes.reduce((sum, node) => sum + countNodes(node), 0)
  const maxNodes = limits.maxNodes ?? DEFAULT_MAX_NODES
  if (total > maxNodes)
    throw new CompileError(`plan has ${total} nodes over the ${maxNodes} ceiling`, "E_MAX_NODES")

  const layers = layerTopLevel(plan.nodes)
  return layers.map((layer) => compileLayer(layer, options, 1))
}

/** Recursive node count over the whole tree. */
function countNodes(node: RunNode): number {
  switch (node.kind) {
    case "sequence":
    case "parallel":
      return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0)
    case "retry":
      return 1 + countNodes(node.child)
    case "branch":
      return 1 + countNodes(node.then) + (node.otherwise ? countNodes(node.otherwise) : 0)
    default:
      return 1
  }
}

/**
 * Kahn layering of the top-level DAG. Each layer is every node whose dependencies are already
 * emitted, sorted by id for determinism. A layer with more than one node becomes a bounded parallel.
 */
function layerTopLevel(nodes: readonly RunNode[]): readonly (readonly RunNode[])[] {
  const byId = new Map(nodes.map((node) => [node.id, node] as const))
  const remaining = new Set(nodes.map((node) => node.id))
  const emitted = new Set<string>()
  const layers: RunNode[][] = []
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((id) => (byId.get(id)?.dependsOn ?? []).every((dep) => emitted.has(dep)))
      .sort()
    if (ready.length === 0) throw new CompileError("run plan has a dependency cycle", "E_CYCLE")
    for (const id of ready) {
      emitted.add(id)
      remaining.delete(id)
    }
    layers.push(ready.map((id) => byId.get(id) as RunNode))
  }
  return layers
}

function compileLayer(
  layer: readonly RunNode[],
  options: CompileOptions,
  depth: number,
): WorkflowStep {
  if (layer.length === 1) return compileNode(layer[0] as RunNode, options, depth)
  const steps = layer.map((node) => compileNode(node, options, depth))
  return { type: "parallel", steps, maxConcurrency: concurrency(steps.length, undefined, options) }
}

/** Effective concurrency: the lower of plan request, host ceiling, and child count. */
function concurrency(
  breadth: number,
  requested: number | undefined,
  options: CompileOptions,
): number {
  const host = options.limits?.maxParallel ?? breadth
  return Math.max(1, Math.min(breadth, requested ?? breadth, host))
}

function compileNode(node: RunNode, options: CompileOptions, depth: number): WorkflowStep {
  const maxDepth = options.limits?.maxDepth ?? DEFAULT_MAX_DEPTH
  if (depth > maxDepth)
    throw new CompileError(
      `node '${node.id}' nests past the ${maxDepth} depth ceiling`,
      "E_MAX_DEPTH",
    )

  switch (node.kind) {
    case "sequence":
      return {
        type: "sequence",
        steps: node.children.map((c) => compileNode(c, options, depth + 1)),
      }
    case "parallel": {
      const steps = node.children.map((c) => compileNode(c, options, depth + 1))
      return {
        type: "parallel",
        steps,
        maxConcurrency: concurrency(steps.length, node.maxConcurrency, options),
      }
    }
    case "retry": {
      const step: WorkflowStep = {
        type: "retry",
        step: compileNode(node.child, options, depth + 1),
        attempts: node.attempts,
        ...(node.backoffMs !== undefined ? { backoffMs: node.backoffMs } : {}),
      }
      return step
    }
    case "branch": {
      const predicate = resolveStep(node, options)
      if (typeof predicate.when !== "function")
        throw new CompileError(
          `branch node '${node.id}' step declares no predicate`,
          "E_MISSING_HANDLER",
        )
      return {
        type: "branch",
        id: node.id,
        when: (wf) => Promise.resolve(predicate.when!(makeContext(node, options, wf))),
        // biome-ignore lint/suspicious/noThenProperty: the workflow branch step names its arms then/otherwise.
        then: compileNode(node.then, options, depth + 1),
        ...(node.otherwise !== undefined
          ? { otherwise: compileNode(node.otherwise, options, depth + 1) }
          : {}),
      }
    }
    default:
      return compileLeaf(node, options)
  }
}

/** Resolve and validate the catalog step behind a leaf or branch node. */
function resolveStep(
  node: Extract<RunNode, { readonly step: string }>,
  options: CompileOptions,
): CatalogStep {
  const step = options.catalog.get(node.step)
  if (step === undefined)
    throw new CompileError(
      `node '${node.id}' references unknown step '${node.step}'`,
      "E_UNKNOWN_STEP",
    )
  if (step.kind !== node.kind)
    throw new CompileError(
      `node '${node.id}' kind '${node.kind}' does not match catalog step kind '${step.kind}'`,
      "E_KIND_MISMATCH",
    )
  if (
    "stepVersion" in node &&
    node.stepVersion !== undefined &&
    stepVersion(step) !== node.stepVersion
  )
    throw new CompileError(
      `node '${node.id}' pins step version ${node.stepVersion} but catalog has ${stepVersion(step)}`,
      "E_VERSION_DRIFT",
    )
  const allowed = options.limits?.allowedCapabilities
  if (allowed !== undefined) {
    const granted = new Set(allowed)
    const denied = (step.capabilities ?? []).find((cap) => !granted.has(cap))
    if (denied !== undefined)
      throw new CompileError(
        `node '${node.id}' needs ungranted capability '${denied}'`,
        "E_CAPABILITY",
      )
  }
  return step
}

function compileLeaf(
  node: Extract<RunNode, { readonly step: string; readonly kind: string }>,
  options: CompileOptions,
): WorkflowStep {
  const step = resolveStep(node, options)
  const base = buildLeafStep(node, step, options)
  const retry = "retry" in node ? node.retry : undefined
  if (retry === undefined) return base
  return {
    type: "retry",
    step: base,
    attempts: retry.attempts,
    ...(retry.backoffMs !== undefined ? { backoffMs: retry.backoffMs } : {}),
  }
}

function buildLeafStep(node: RunNode, step: CatalogStep, options: CompileOptions): WorkflowStep {
  const id = node.id
  switch (node.kind) {
    case "subagent": {
      if (step.executor === undefined || typeof step.spec !== "function")
        throw new CompileError(
          `subagent node '${id}' step declares no executor or spec`,
          "E_MISSING_HANDLER",
        )
      return { type: "task", id, run: (wf) => runSubagent(node, step, options, wf) }
    }
    case "verify":
      return { type: "verify", id, run: (wf) => runLeaf(node, step, options, wf) }
    case "approve":
      return {
        type: "approve",
        id,
        reason: "reason" in node && node.reason !== undefined ? node.reason : "",
        run: (wf) => runLeaf(node, step, options, wf),
      }
    case "checkpoint":
      return { type: "checkpoint", id, run: (wf) => runLeaf(node, step, options, wf) }
    case "handoff":
      return { type: "handoff", id, run: (wf) => runLeaf(node, step, options, wf) }
    default:
      return { type: "task", id, run: (wf) => runLeaf(node, step, options, wf) }
  }
}

/** Build the step context, wiring the artifact collector and effect-key derivation. */
function makeContext(node: RunNode, options: CompileOptions, wf: WorkflowContext): StepRunContext {
  const artifact: ArtifactPort = {
    put: async (payload: Uint8Array, ctx: ArtifactContext): Promise<ArtifactRef> => {
      const ref = await options.artifactPort.put(payload, ctx)
      options.collectArtifact?.(node.id, ref)
      return ref
    },
  }
  return {
    nodeId: node.id,
    planDigest: options.planDigest,
    signal: wf.signal,
    artifact,
    values: wf.values,
    set: (name, value) => wf.set(name, value),
  }
}

async function deriveEffect(
  node: RunNode,
  step: CatalogStep,
  options: CompileOptions,
  wf: WorkflowContext,
): Promise<void> {
  if (step.selectEffect === undefined) return
  const selector = step.selectEffect({
    nodeId: node.id,
    planDigest: options.planDigest,
    values: wf.values,
  })
  const key = await deriveNodeEffectKey({
    planDigest: options.planDigest,
    nodeId: node.id,
    selector,
  })
  options.onNodeEffect?.(node.id, key)
}

async function runLeaf(
  node: RunNode,
  step: CatalogStep,
  options: CompileOptions,
  wf: WorkflowContext,
): Promise<unknown> {
  if (typeof step.run !== "function")
    throw new CompileError(`node '${node.id}' step declares no run body`, "E_MISSING_HANDLER")
  const context = makeContext(node, options, wf)
  await deriveEffect(node, step, options, wf)
  return step.run(context)
}

async function runSubagent(
  node: RunNode,
  step: CatalogStep,
  options: CompileOptions,
  wf: WorkflowContext,
): Promise<unknown> {
  const context = makeContext(node, options, wf)
  await deriveEffect(node, step, options, wf)
  const runner = new BoundedSubagentRunner(step.executor!, {
    maxChildren: options.limits?.maxChildren ?? DEFAULT_MAX_CHILDREN,
    signal: wf.signal,
    ...(options.limits?.allowedCapabilities !== undefined
      ? { allowedCapabilities: options.limits.allowedCapabilities }
      : {}),
  })
  const spec = await step.spec!(context)
  const result = await runner.run(spec)
  if (!result.ok) throw new Error(result.error ?? `subagent '${node.id}' failed`)
  return result.output
}

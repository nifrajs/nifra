/**
 * Compile a declarative {@link RunPlan} into the existing {@link WorkflowRunner} step tree. There is
 * no second execution engine: the plan's DAG is topologically ordered (deterministic, id tie-break)
 * and lowered onto the kernel's task/verify/approve/checkpoint/handoff primitives. Effect-key
 * derivation and the artifact sink are wired into each node's closure at compile time.
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
import type { WorkflowContext, WorkflowStep } from "../workflows.ts"
import type { CatalogStep, StepCatalog, StepRunContext } from "./catalog.ts"
import { deriveNodeEffectKey } from "./effect-key.ts"
import { canonicalJson, sha256HexOf } from "./hash.ts"

/** Thrown when a plan cannot be lowered: unknown step, kind mismatch, or a dependency cycle. */
export class CompileError extends Error {
  constructor(reason: string) {
    super(`orchestration compile: ${reason}`)
    this.name = "CompileError"
  }
}

/** Stable digest of a plan's canonical form. Structural identity that node effect keys hang from. */
export function digestRunPlan(plan: RunPlan): Promise<string> {
  return sha256HexOf(canonicalJson(plan))
}

/** Wiring the compiler injects into every node closure. */
export interface CompileOptions {
  readonly catalog: StepCatalog
  readonly planDigest: string
  readonly artifactPort: ArtifactPort
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
  const plan = parseRunPlan(source)
  const order = topoSort(plan)
  const steps = order.map((node) => compileNode(node, options))
  return steps.length === 1 ? (steps[0] as WorkflowStep) : { type: "sequence", steps }
}

/** Deterministic topological order; lexicographic node-id tie-break. Throws on a cycle. */
function topoSort(plan: RunPlan): readonly RunNode[] {
  const byId = new Map(plan.nodes.map((node) => [node.id, node] as const))
  const emitted = new Set<string>()
  const remaining = new Set(plan.nodes.map((node) => node.id))
  const out: RunNode[] = []
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((id) => (byId.get(id)?.dependsOn ?? []).every((dep) => emitted.has(dep)))
      .sort()
    const next = ready[0]
    if (next === undefined) throw new CompileError("run plan has a dependency cycle")
    out.push(byId.get(next) as RunNode)
    emitted.add(next)
    remaining.delete(next)
  }
  return out
}

function compileNode(node: RunNode, options: CompileOptions): WorkflowStep {
  const step = options.catalog.get(node.step)
  if (step === undefined)
    throw new CompileError(`node '${node.id}' references unknown step '${node.step}'`)
  if (step.kind !== node.kind)
    throw new CompileError(
      `node '${node.id}' kind '${node.kind}' does not match catalog step kind '${step.kind}'`,
    )

  const invoke = (wf: WorkflowContext): Promise<unknown> => runNode(node, step, options, wf)

  switch (node.kind) {
    case "task":
      return { type: "task", id: node.id, run: invoke }
    case "verify":
      return { type: "verify", id: node.id, run: invoke }
    case "approve":
      return { type: "approve", id: node.id, reason: node.reason ?? "", run: invoke }
    case "checkpoint":
      return { type: "checkpoint", id: node.id, run: invoke }
    case "handoff":
      return { type: "handoff", id: node.id, run: invoke }
  }
}

async function runNode(
  node: RunNode,
  step: CatalogStep,
  options: CompileOptions,
  wf: WorkflowContext,
): Promise<unknown> {
  const artifact: ArtifactPort = {
    put: async (payload: Uint8Array, ctx: ArtifactContext): Promise<ArtifactRef> => {
      const ref = await options.artifactPort.put(payload, ctx)
      options.collectArtifact?.(node.id, ref)
      return ref
    },
  }
  const context: StepRunContext = {
    nodeId: node.id,
    planDigest: options.planDigest,
    signal: wf.signal,
    artifact,
    values: wf.values,
    set: (name, value) => wf.set(name, value),
  }
  if (step.selectEffect !== undefined) {
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
  return step.run(context)
}

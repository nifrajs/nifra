/**
 * The end-to-end tracer: compile a {@link RunPlan}, run it through the {@link WorkflowRunner}, and
 * project each transition into content-free {@link RunEvidence}. Every emitted record is re-parsed
 * through {@link parseRunEvidence}, so the tracer itself proves the stream carries no payload and
 * stays under the size cap. The terminal digest is a deterministic hash of the evidence stream:
 * identical plan + catalog + inputs yield an identical digest, which is the deterministic-eval anchor.
 */

import type {
  ArtifactPort,
  ArtifactRef,
  NodeEffectKey,
  RunEvidence,
  RunNode,
  RunNodeKind,
  RunPlan,
} from "@nifrajs/agent-protocol"
import { parseRunEvidence, parseRunPlan, RUN_PLAN_VERSION } from "@nifrajs/agent-protocol"
import { type WorkflowEvent, WorkflowRunner } from "../workflows.ts"
import { noopArtifactPort } from "./artifact-port.ts"
import type { StepCatalog } from "./catalog.ts"
import { compileRunPlan, digestRunPlan } from "./compile.ts"
import { canonicalJson, sha256HexOf } from "./hash.ts"

/** A verify/approve node whose output is not a pass. Other kinds never gate. */
function isGateRejection(kind: RunNodeKind | undefined, output: unknown): boolean {
  if (kind === "verify") {
    if (output === true) return false
    return !(
      typeof output === "object" &&
      output !== null &&
      (output as { ok?: unknown }).ok === true
    )
  }
  if (kind === "approve") return output !== true
  return false
}

export interface RunTraceOptions {
  /** Caller-supplied, so a trace is fully reproducible. No clock or randomness is read here. */
  readonly runId: string
  readonly catalog: StepCatalog
  /** Defaults to {@link noopArtifactPort} (hash-and-discard). */
  readonly artifactPort?: ArtifactPort
  readonly signal?: AbortSignal
  readonly maxSteps?: number
  readonly maxDepth?: number
}

export interface RunTraceResult {
  readonly ok: boolean
  readonly runId: string
  readonly planDigest: string
  readonly evidence: readonly RunEvidence[]
  /** SHA-256 hex of the canonical evidence stream. Deterministic across identical runs. */
  readonly terminalDigest: string
  readonly error?: string
}

/** Run a plan and return its content-free evidence stream plus a deterministic terminal digest. */
export async function runTrace(
  source: RunPlan | unknown,
  options: RunTraceOptions,
): Promise<RunTraceResult> {
  const plan = parseRunPlan(source)
  const planDigest = await digestRunPlan(plan)
  const artifactPort = options.artifactPort ?? noopArtifactPort()

  const effectKeys = new Map<string, NodeEffectKey>()
  const artifacts = new Map<string, ArtifactRef[]>()
  const idempotent = new Map<string, boolean>()
  const kindById = new Map<string, RunNodeKind>()
  const nodeIds = new Set<string>()
  const walk = (node: RunNode): void => {
    nodeIds.add(node.id)
    kindById.set(node.id, node.kind)
    const step = "step" in node ? options.catalog.get(node.step) : undefined
    idempotent.set(node.id, step?.selectEffect !== undefined)
    switch (node.kind) {
      case "sequence":
      case "parallel":
        for (const child of node.children) walk(child)
        break
      case "retry":
        walk(node.child)
        break
      case "branch":
        walk(node.then)
        if (node.otherwise !== undefined) walk(node.otherwise)
        break
    }
  }
  for (const node of plan.nodes) walk(node)

  const step = compileRunPlan(plan, {
    catalog: options.catalog,
    planDigest,
    artifactPort,
    onNodeEffect: (nodeId, key) => effectKeys.set(nodeId, key),
    collectArtifact: (nodeId, ref) => {
      const list = artifacts.get(nodeId)
      if (list === undefined) artifacts.set(nodeId, [ref])
      else list.push(ref)
    },
  })

  const evidence: RunEvidence[] = []
  let seq = 0
  const push = (record: RunEvidence): void => {
    // Re-parse each record: proves it is content-free and within the size cap before it is kept.
    evidence.push(parseRunEvidence(record))
  }

  const onEvent = (event: WorkflowEvent): void => {
    if (!("id" in event) || !nodeIds.has(event.id)) return
    const base = {
      version: RUN_PLAN_VERSION,
      runId: options.runId,
      planDigest,
      nodeId: event.id,
      seq: seq++,
      idempotent: idempotent.get(event.id) ?? false,
    } as const
    if (event.type === "step.started") {
      push({ ...base, status: "started" })
      return
    }
    if (event.type === "step.completed") {
      const key = effectKeys.get(event.id)
      const refs = artifacts.get(event.id)
      // A verify/approve gate reports pass/fail through its output, then the kernel aborts the run on
      // a non-pass. Project that as a failed record so the evidence reflects the gate's verdict.
      if (isGateRejection(kindById.get(event.id), event.output)) {
        push({
          ...base,
          status: "failed",
          errorCode: "GATE_REJECTED",
          ...(key !== undefined ? { effectKey: key.digest } : {}),
        })
        return
      }
      push({
        ...base,
        status: "completed",
        ...(key !== undefined ? { effectKey: key.digest } : {}),
        ...(refs !== undefined && refs.length > 0 ? { artifacts: refs } : {}),
      })
      return
    }
    if (event.type === "step.failed") {
      const key = effectKeys.get(event.id)
      push({
        ...base,
        status: "failed",
        errorCode: "STEP_FAILED",
        ...(key !== undefined ? { effectKey: key.digest } : {}),
      })
    }
  }

  const result = await new WorkflowRunner({
    onEvent,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
    ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
  }).run(step)

  const terminalDigest = await sha256HexOf(canonicalJson(evidence))
  return {
    ok: result.ok,
    runId: options.runId,
    planDigest,
    evidence,
    terminalDigest,
    ...(result.error !== undefined ? { error: result.error } : {}),
  }
}

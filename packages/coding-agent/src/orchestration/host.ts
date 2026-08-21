/**
 * The OrchestrationHost: the lifecycle owner for a compiled {@link RunPlan}. It does not schedule
 * work itself - each top-level DAG layer is handed to a kernel {@link WorkflowRunner}, exactly as
 * {@link compileRunPlan} would fold them into one `sequence`. Driving layer by layer gives a safe
 * pause boundary (in-flight nodes finish; no new layer starts) and a cancellation seam (the layer's
 * runner and any bounded subagent share the run's abort signal) without a second engine.
 *
 * Every transition is guarded by an explicit state machine: an illegal transition returns a stable
 * code and mutates nothing. A terminal run is frozen - a late completion from an aborted layer
 * cannot change its status, counters, or digest. Terminal results expose status, completed node ids,
 * an order-independent evidence digest, artifact refs, counters, and a failure code only: never a
 * step output, prompt, or payload.
 */

import type {
  ArtifactPort,
  ArtifactRef,
  NodeEffectKey,
  RunNode,
  RunNodeKind,
  RunPlan,
} from "@nifrajs/agent-protocol"
import { parseRunPlan, RUN_PLAN_VERSION } from "@nifrajs/agent-protocol"
import type { WorkflowStep } from "../workflows.ts"
import { type WorkflowEvent, WorkflowRunner } from "../workflows.ts"
import { noopArtifactPort } from "./artifact-port.ts"
import type { StepCatalog } from "./catalog.ts"
import { compileRunPlanLayers, digestRunPlan, type OrchestrationLimits } from "./compile.ts"
import { type EvidenceCounters, type EvidenceStore, MemoryEvidenceStore } from "./evidence-store.ts"

export type RunState = "submitted" | "running" | "paused" | "succeeded" | "failed" | "cancelled"

const TERMINAL: ReadonlySet<RunState> = new Set(["succeeded", "failed", "cancelled"])

function isTerminal(state: RunState): boolean {
  return TERMINAL.has(state)
}

/** Thrown on an illegal lifecycle transition or an unknown run. `code` is stable. */
export class OrchestrationStateError extends Error {
  constructor(
    reason: string,
    readonly code: string,
  ) {
    super(`orchestration host: ${reason}`)
    this.name = "OrchestrationStateError"
  }
}

/** Content-free progress view of a run. */
export interface RunStatus {
  readonly runId: string
  readonly state: RunState
  readonly planDigest: string
  readonly layerIndex: number
  readonly layerCount: number
  readonly counters: EvidenceCounters
}

/** Deterministic terminal result. Outcome identity only - no step output, prompt, or payload. */
export interface RunResult {
  readonly runId: string
  readonly status: "succeeded" | "failed" | "cancelled"
  readonly planDigest: string
  readonly completedNodeIds: readonly string[]
  readonly evidenceDigest: string
  readonly artifacts: readonly ArtifactRef[]
  readonly counters: EvidenceCounters
  readonly failureCode?: string
}

export interface SubmitOptions {
  /** Caller-supplied for reproducibility; defaults to a per-host monotonic id (no clock, no random). */
  readonly runId?: string
  /** Caller-owned payload sink. Defaults to hash-and-discard. */
  readonly artifactPort?: ArtifactPort
  /** Evidence store for this run. Defaults to a bounded {@link MemoryEvidenceStore}. */
  readonly store?: EvidenceStore
}

export interface OrchestrationHostOptions {
  readonly catalog: StepCatalog
  readonly limits?: OrchestrationLimits
  /** Kernel step ceiling per layer. Generous by default so a full 256-node layer runs. */
  readonly maxSteps?: number
  readonly maxDepth?: number
}

const DEFAULT_MAX_STEPS = 100_000
const DEFAULT_MAX_DEPTH = 64

interface RunRecord {
  readonly runId: string
  readonly planDigest: string
  readonly layers: readonly WorkflowStep[]
  readonly store: EvidenceStore
  readonly controller: AbortController
  readonly kindById: ReadonlyMap<string, RunNodeKind>
  readonly idempotentById: ReadonlyMap<string, boolean>
  readonly nodeIds: ReadonlySet<string>
  readonly effectKeys: Map<string, NodeEffectKey>
  readonly artifacts: Map<string, ArtifactRef[]>
  state: RunState
  layerIndex: number
  seq: number
  cancelRequested: boolean
  failureCode: string | undefined
  gate: { readonly promise: Promise<void>; readonly resolve: () => void } | undefined
  done: Promise<void>
  finish: () => void
}

/** Owns run lifecycle and evidence projection over the kernel WorkflowRunner. */
export class OrchestrationHost {
  private readonly catalog: StepCatalog
  private readonly limits: OrchestrationLimits | undefined
  private readonly maxSteps: number
  private readonly maxDepth: number
  private readonly runs = new Map<string, RunRecord>()
  private counter = 0

  constructor(options: OrchestrationHostOptions) {
    this.catalog = options.catalog
    this.limits = options.limits
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  }

  /**
   * Parse, compile, and register a run in `submitted`. All structural ceilings and capability
   * authority are enforced here (a `CompileError` with a stable code), so an over-limit or
   * unauthorized plan never reaches `running`.
   */
  async submit(source: RunPlan | unknown, options: SubmitOptions = {}): Promise<string> {
    const plan = parseRunPlan(source)
    const planDigest = await digestRunPlan(plan)
    const runId = options.runId ?? `run-${++this.counter}`
    if (this.runs.has(runId))
      throw new OrchestrationStateError(`run '${runId}' already exists`, "E_DUPLICATE_RUN")

    const artifactPort = options.artifactPort ?? noopArtifactPort()
    const effectKeys = new Map<string, NodeEffectKey>()
    const artifacts = new Map<string, ArtifactRef[]>()
    const layers = compileRunPlanLayers(plan, {
      catalog: this.catalog,
      planDigest,
      artifactPort,
      ...(this.limits !== undefined ? { limits: this.limits } : {}),
      onNodeEffect: (nodeId, key) => effectKeys.set(nodeId, key),
      collectArtifact: (nodeId, ref) => {
        const list = artifacts.get(nodeId)
        if (list === undefined) artifacts.set(nodeId, [ref])
        else list.push(ref)
      },
    })

    const { kindById, idempotentById, nodeIds } = this.indexPlan(plan)
    let finish!: () => void
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    this.runs.set(runId, {
      runId,
      planDigest,
      layers,
      store: options.store ?? new MemoryEvidenceStore(),
      controller: new AbortController(),
      kindById,
      idempotentById,
      nodeIds,
      effectKeys,
      artifacts,
      state: "submitted",
      layerIndex: 0,
      seq: 0,
      cancelRequested: false,
      failureCode: undefined,
      gate: undefined,
      done,
      finish,
    })
    return runId
  }

  /** Content-free progress view. Throws `E_NOT_FOUND` for an unknown run. */
  inspect(runId: string): RunStatus {
    const run = this.require(runId)
    return {
      runId,
      state: run.state,
      planDigest: run.planDigest,
      layerIndex: run.layerIndex,
      layerCount: run.layers.length,
      counters: run.store.counters(),
    }
  }

  /** `submitted` -> `running`. Begins the driver. */
  start(runId: string): void {
    const run = this.require(runId)
    this.transition(run, "start", ["submitted"], "running")
    void this.drive(run)
  }

  /** `running` -> `paused`. Takes effect at the next layer boundary; in-flight nodes finish. */
  pause(runId: string): void {
    const run = this.require(runId)
    this.transition(run, "pause", ["running"], "paused")
    let resolve!: () => void
    const promise = new Promise<void>((r) => {
      resolve = r
    })
    run.gate = { promise, resolve }
  }

  /** `paused` -> `running`. Releases the layer boundary. */
  resume(runId: string): void {
    const run = this.require(runId)
    this.transition(run, "resume", ["paused"], "running")
    run.gate?.resolve()
    run.gate = undefined
  }

  /**
   * Cancel from any non-terminal state. Aborts the in-flight layer and any bounded subagent, frees a
   * paused gate, and freezes the run in `cancelled`. A late completion cannot revive it.
   */
  cancel(runId: string): void {
    const run = this.require(runId)
    if (isTerminal(run.state))
      throw new OrchestrationStateError(
        `run '${runId}' cannot cancel from terminal '${run.state}'`,
        "E_ILLEGAL_TRANSITION",
      )
    run.cancelRequested = true
    run.state = "cancelled"
    run.failureCode = "E_CANCELLED"
    run.controller.abort()
    run.gate?.resolve()
    run.gate = undefined
    run.finish()
  }

  /** Terminal result. Throws `E_NOT_TERMINAL` while the run is still live. */
  async result(runId: string): Promise<RunResult> {
    const run = this.require(runId)
    if (!isTerminal(run.state))
      throw new OrchestrationStateError(
        `run '${runId}' is '${run.state}', not terminal`,
        "E_NOT_TERMINAL",
      )
    return this.buildResult(run)
  }

  /** Await the run reaching a terminal state, then return its result. */
  async settled(runId: string): Promise<RunResult> {
    const run = this.require(runId)
    await run.done
    return this.buildResult(run)
  }

  private require(runId: string): RunRecord {
    const run = this.runs.get(runId)
    if (run === undefined)
      throw new OrchestrationStateError(`unknown run '${runId}'`, "E_NOT_FOUND")
    return run
  }

  private transition(run: RunRecord, op: string, from: readonly RunState[], to: RunState): void {
    if (!from.includes(run.state))
      throw new OrchestrationStateError(
        `cannot ${op} run '${run.runId}' from '${run.state}'`,
        "E_ILLEGAL_TRANSITION",
      )
    run.state = to
  }

  private async buildResult(run: RunRecord): Promise<RunResult> {
    const status = run.state as "succeeded" | "failed" | "cancelled"
    return {
      runId: run.runId,
      status,
      planDigest: run.planDigest,
      completedNodeIds: run.store.completedNodeIds(),
      evidenceDigest: await run.store.digest(),
      artifacts: run.store.artifacts(),
      counters: run.store.counters(),
      ...(run.failureCode !== undefined ? { failureCode: run.failureCode } : {}),
    }
  }

  private async drive(run: RunRecord): Promise<void> {
    try {
      for (; run.layerIndex < run.layers.length; run.layerIndex++) {
        while (run.state === "paused") await run.gate?.promise
        if (isTerminal(run.state)) return // cancelled while paused
        const layer = run.layers[run.layerIndex] as WorkflowStep
        const result = await new WorkflowRunner({
          signal: run.controller.signal,
          maxSteps: this.maxSteps,
          maxDepth: this.maxDepth,
          onEvent: (event) => this.project(run, event),
        }).run(layer)
        if (isTerminal(run.state)) return // cancelled mid-layer: ignore the late result
        if (!result.ok) {
          run.state = "failed"
          run.failureCode = run.failureCode ?? "E_STEP_FAILED"
          return
        }
      }
      if (!isTerminal(run.state)) run.state = "succeeded"
    } finally {
      if (!isTerminal(run.state)) run.state = "failed"
      run.finish()
    }
  }

  /** Project one kernel event into a content-free evidence record. Frozen once the run is terminal. */
  private async project(run: RunRecord, event: WorkflowEvent): Promise<void> {
    if (isTerminal(run.state)) return // a late completion cannot mutate a terminal run
    if (!("id" in event) || !run.nodeIds.has(event.id)) return
    const base = {
      version: RUN_PLAN_VERSION,
      runId: run.runId,
      planDigest: run.planDigest,
      nodeId: event.id,
      seq: run.seq++,
      idempotent: run.idempotentById.get(event.id) ?? false,
    } as const
    const key = run.effectKeys.get(event.id)
    const effect = key !== undefined ? { effectKey: key.digest } : {}

    if (event.type === "step.started") {
      await run.store.append({ ...base, status: "started" })
      return
    }
    if (event.type === "step.completed") {
      if (isGateRejection(run.kindById.get(event.id), event.output)) {
        run.failureCode = "E_GATE_REJECTED"
        await run.store.append({ ...base, status: "failed", errorCode: "GATE_REJECTED", ...effect })
        return
      }
      const refs = run.artifacts.get(event.id)
      await run.store.append({
        ...base,
        status: "completed",
        ...effect,
        ...(refs !== undefined && refs.length > 0 ? { artifacts: refs } : {}),
      })
      return
    }
    if (event.type === "step.failed") {
      run.failureCode = "E_STEP_FAILED"
      await run.store.append({ ...base, status: "failed", errorCode: "STEP_FAILED", ...effect })
    }
  }

  /** Walk the plan tree once: node kinds, idempotency flags, and the full id set. */
  private indexPlan(plan: RunPlan): {
    readonly kindById: ReadonlyMap<string, RunNodeKind>
    readonly idempotentById: ReadonlyMap<string, boolean>
    readonly nodeIds: ReadonlySet<string>
  } {
    const kindById = new Map<string, RunNodeKind>()
    const idempotentById = new Map<string, boolean>()
    const nodeIds = new Set<string>()
    const walk = (node: RunNode): void => {
      nodeIds.add(node.id)
      kindById.set(node.id, node.kind)
      const step = "step" in node ? this.catalog.get(node.step) : undefined
      idempotentById.set(node.id, step?.selectEffect !== undefined)
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
    return { kindById, idempotentById, nodeIds }
  }
}

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

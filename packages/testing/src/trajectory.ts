import {
  type AgentDefinition,
  type AgentModelPort,
  type AgentPorts,
  type AgentRunResult,
  type AgentTranscript,
  type AgentTurnInput,
  type AgentTurnState,
  runAgent,
} from "@nifrajs/agent"
import type { StandardSchemaV1 } from "@nifrajs/core/schema"
import { createToolBudget, type ToolBudget, type ToolContract } from "@nifrajs/core/tool-contract"
import { createFailureLab, type FailureEvidence } from "./failure-lab.ts"
import type { FaultProfile, FaultProfileFault, FaultProfileFaultKind } from "./fault-profile.ts"

export interface TrajectoryTranscript {
  readonly version: 1
  readonly digest: string
  readonly turn: AgentTranscript
  readonly faultProfile?: string
  readonly seed?: number
}

export interface CreateTrajectoryTranscriptOptions {
  readonly faultProfile?: string
  readonly seed?: number
}

export interface TrajectoryRun<Output> {
  readonly result: AgentRunResult<Output>
  readonly transcript: TrajectoryTranscript
}

export interface ReplayTrajectoryOptions {
  readonly state: AgentTurnState
  readonly maxTurns?: number
  readonly goal?: (output: unknown) => boolean
  readonly faultProfile?: FaultProfile
  readonly seed?: number
}

export type TrajectoryInvariantId =
  | "ledger-evidence"
  | "capability-admission"
  | "budget-monotonic"
  | "bounded-stop"
  | "resumable-suspension"

export interface TrajectoryInvariantResult {
  readonly id: TrajectoryInvariantId
  readonly ok: boolean
  readonly code?: string
}

export interface TrajectoryReplayResult<Output> {
  readonly result: AgentRunResult<Output>
  readonly transcript: TrajectoryTranscript
  readonly faults: readonly FailureEvidence[]
  readonly invariants: readonly TrajectoryInvariantResult[]
  readonly regressionIds: readonly string[]
}

export interface TrajectoryInvariantOptions {
  readonly maxSteps?: number
  /** Remaining budget snapshots, used when the caller owns a budget adapter. */
  readonly budgetSnapshots?: readonly Readonly<Record<string, number>>[]
}

const DEFAULT_SEED = 0x4e_49_46_52
const FAULT_KINDS: readonly FaultProfileFaultKind[] = [
  "tool-error",
  "malformed-model-output",
  "budget-pressure",
  "approval-denial",
  "cancellation",
]

/** Record the transcript emitted by a turn without adding a second execution recording path. */
export async function createTrajectoryTranscript(
  transcript: AgentTranscript,
  options: CreateTrajectoryTranscriptOptions = {},
): Promise<TrajectoryTranscript> {
  validateAgentTranscript(transcript)
  const payload = {
    version: 1,
    turn: transcript,
    ...(options.faultProfile === undefined ? {} : { faultProfile: options.faultProfile }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  }
  return Object.freeze({ ...payload, version: 1 as const, digest: await digest(payload) })
}

/** Alias that reads naturally at a call site which has just completed a run. */
export const recordTrajectory = createTrajectoryTranscript

export async function runTrajectory<
  InputSchema extends StandardSchemaV1,
  OutputSchema extends StandardSchemaV1,
>(
  definition: AgentDefinition<InputSchema, OutputSchema>,
  input: AgentTurnInput,
  ports: AgentPorts,
  options: {
    readonly state: AgentTurnState
    readonly maxTurns?: number
    readonly goal?: (output: unknown) => boolean
  },
): Promise<TrajectoryRun<NonNullable<OutputSchema["~standard"]["types"]>["output"]>> {
  const result = await runAgent(definition, input, ports, options)
  const transcript = await createTrajectoryTranscript(result.transcript)
  return Object.freeze({ result, transcript })
}

/**
 * Replay a recorded run with local model decisions and dry-run tools. The supplied model port is
 * never called. Fault schedules use the existing deterministic failure-lab controller.
 */
export async function replayTrajectory<
  InputSchema extends StandardSchemaV1,
  OutputSchema extends StandardSchemaV1,
>(
  definition: AgentDefinition<InputSchema, OutputSchema>,
  input: AgentTurnInput,
  ports: Omit<AgentPorts, "model">,
  transcript: TrajectoryTranscript,
  options: ReplayTrajectoryOptions,
): Promise<TrajectoryReplayResult<NonNullable<OutputSchema["~standard"]["types"]>["output"]>> {
  validateAgentTranscript(transcript.turn)
  const profile = options.faultProfile
  const seed = options.seed ?? DEFAULT_SEED
  const lab = createFailureLab({ seed, schedule: profile?.schedule ?? [] })
  const faults = profile?.faults ?? []
  const counts = new Map<string, number>()
  const controller = new AbortController()
  if (ports.signal?.aborted === true) controller.abort()
  ports.signal?.addEventListener("abort", () => controller.abort(), { once: true })
  let responseIndex = 0
  let idSequence = 0
  const takeFault = (
    point: FaultProfileFault["point"],
    kind?: FaultProfileFaultKind,
  ): FaultProfileFault | undefined => {
    for (const candidateKind of kind === undefined ? FAULT_KINDS : [kind]) {
      const key = `${point}:${candidateKind}`
      const occurrence = (counts.get(key) ?? 0) + 1
      counts.set(key, occurrence)
      const fault = faults.find(
        (candidate) =>
          candidate.point === point &&
          candidate.kind === candidateKind &&
          (candidate.occurrence ?? 1) === occurrence,
      )
      if (fault !== undefined) return fault
    }
    return undefined
  }
  const model: AgentModelPort = {
    complete: async (): Promise<unknown> => {
      lab.checkpoint("trajectory.model")
      const fault = takeFault("model")
      if (fault?.kind === "malformed-model-output") return { kind: "invalid" }
      if (fault?.kind === "cancellation") {
        controller.abort()
        throw new Error("trajectory cancellation")
      }
      if (fault?.kind === "budget-pressure") throw new Error("trajectory budget pressure")
      const response = transcript.turn.responses[responseIndex++]
      if (response === undefined) throw new Error("trajectory transcript ended")
      return lab.provider("trajectory.model", () => response)
    },
  }
  const tools = definition.tools.map((tool) => wrapTool(tool, lab, () => takeFault("tool")))
  const replayDefinition: AgentDefinition<InputSchema, OutputSchema> = { ...definition, tools }
  let effectiveApproval = ports.approval
  if (effectiveApproval !== undefined) {
    const approval = effectiveApproval
    effectiveApproval = {
      request: async (request) => {
        const fault = takeFault("effect", "approval-denial")
        if (fault !== undefined) return { status: "denied", reason: "trajectory fault" }
        return approval.request(request)
      },
    }
  }
  const pressuredBudget: ToolBudget = createToolBudget({ limits: { calls: 0 } })
  const effectivePorts: AgentPorts = {
    ...ports,
    model,
    dryRun: true,
    signal: controller.signal,
    idFactory: () => `trajectory-${seed}-${++idSequence}`,
    ...(effectiveApproval === undefined ? {} : { approval: effectiveApproval }),
    ...(faults.some((fault) => fault.kind === "budget-pressure")
      ? { budget: pressuredBudget }
      : {}),
  }
  const result = await runAgent(replayDefinition, input, effectivePorts, {
    state: options.state,
    ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
    ...(options.goal === undefined ? {} : { goal: options.goal }),
  })
  const invariantResults = checkTrajectoryInvariants(result)
  const regressionIds = await Promise.all(
    invariantResults.map((invariant) =>
      trajectoryRegressionId(transcript, profile?.name ?? "none", invariant.id),
    ),
  )
  return Object.freeze({
    result,
    transcript,
    faults: lab.evidence(),
    invariants: Object.freeze(invariantResults),
    regressionIds: Object.freeze(regressionIds),
  })
}

export function checkTrajectoryInvariants(
  result: AgentRunResult<unknown>,
  options: TrajectoryInvariantOptions = {},
): readonly TrajectoryInvariantResult[] {
  const evidence = result.evidence
  const committedTools = evidence.filter(
    (item) => item.kind === "tool" && item.outcome === "committed",
  )
  const ledger = committedTools.every(
    (item) => typeof item.ledgerHead === "string" && item.ledgerHead.length > 0,
  )
  const deniedEffects = new Set(
    evidence
      .filter((item) => item.code === "capability_denied" && item.effectId !== undefined)
      .map((item) => item.effectId),
  )
  const capability = committedTools.every(
    (item) => item.effectId === undefined || !deniedEffects.has(item.effectId),
  )
  const bounded =
    evidence.length <= (options.maxSteps ?? 256) &&
    (result.status === "completed" || result.status === "suspended")
  const resumable =
    result.status !== "suspended" ||
    (result.state.status === "suspended" && result.pending.effectId.length > 0)
  const snapshots = options.budgetSnapshots ?? []
  const budget = snapshots.every((snapshot, index) => {
    const values = Object.values(snapshot)
    if (values.some((value) => !Number.isFinite(value) || value < 0)) return false
    if (index === 0) return true
    const previous = snapshots[index - 1] ?? {}
    return Object.entries(snapshot).every(([axis, value]) => value <= (previous[axis] ?? value))
  })
  return Object.freeze([
    { id: "ledger-evidence", ok: ledger, ...(ledger ? {} : { code: "effect_without_ledger" }) },
    {
      id: "capability-admission",
      ok: capability,
      ...(capability ? {} : { code: "capability_admission_failed" }),
    },
    { id: "budget-monotonic", ok: budget, ...(budget ? {} : { code: "budget_negative" }) },
    { id: "bounded-stop", ok: bounded, ...(bounded ? {} : { code: "stop_bound_exceeded" }) },
    {
      id: "resumable-suspension",
      ok: resumable,
      ...(resumable ? {} : { code: "suspension_not_resumable" }),
    },
  ])
}

export function assertTrajectoryInvariants(
  result: AgentRunResult<unknown>,
  options: TrajectoryInvariantOptions = {},
): void {
  const failures = checkTrajectoryInvariants(result, options).filter((invariant) => !invariant.ok)
  if (failures.length > 0)
    throw new Error(
      `trajectory invariants failed: ${failures.map((invariant) => invariant.code ?? invariant.id).join(",")}`,
    )
}

export async function trajectoryRegressionId(
  transcript: TrajectoryTranscript,
  faultProfile: string,
  invariant: TrajectoryInvariantId,
): Promise<string> {
  if (faultProfile.trim() === "") throw new TypeError("trajectory: fault profile name is required")
  return digest({ transcript: transcript.digest, faultProfile, invariant })
}

function wrapTool<Input, Output>(
  tool: ToolContract<Input, Output>,
  lab: ReturnType<typeof createFailureLab>,
  nextFault: () => FaultProfileFault | undefined,
): ToolContract<Input, Output> {
  return Object.freeze({
    ...tool,
    execute: async (
      input: Input,
      context: Parameters<ToolContract<Input, Output>["execute"]>[1],
    ) => {
      lab.checkpoint(`trajectory.tool.${tool.name}`)
      const fault = nextFault()
      if (fault?.kind === "tool-error" || fault?.kind === "budget-pressure")
        throw new Error("trajectory tool fault")
      if (fault?.kind === "cancellation") throw new Error("trajectory cancellation")
      lab.checkpoint(`trajectory.effect.${tool.name}`)
      return tool.execute(input, context)
    },
  })
}

function validateAgentTranscript(value: AgentTranscript): void {
  if (
    value === null ||
    typeof value !== "object" ||
    value.version !== 1 ||
    typeof value.turnId !== "string" ||
    !Array.isArray(value.responses) ||
    !Array.isArray(value.evidence)
  ) {
    throw new TypeError("trajectory: invalid agent transcript")
  }
}

async function digest(value: unknown): Promise<string> {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError("trajectory: value is not serializable")
  const bytes = new TextEncoder().encode(serialized)
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  return [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * Provider-neutral agent turns.
 *
 * One turn makes one model decision and may execute one {@link ToolContract}. The multi-turn runner
 * is intentionally bounded. The state adapter stores token-only evidence and cursor metadata; model
 * input, tool input, and tool output remain transient caller data. A model port may additionally
 * stream progressive output (text, reasoning, tool-call arguments) through the request's optional
 * `onDelta` callback when the caller wires an {@link AgentDeltaSink} into the ports - deltas are
 * transient observer data for live UIs, never evidence, and are never persisted by the runtime.
 */

import { canAttempt, type RequestBudget } from "@nifrajs/core/budget"
import type { ExecutionPolicyAdapter } from "@nifrajs/core/execution-policy"
import type { EffectCost } from "@nifrajs/core/ledger"
import { type StandardIssue, type StandardSchemaV1, validateStandard } from "@nifrajs/core/schema"
import { type ToolCatalogEntry, toCatalogEntry } from "@nifrajs/core/tool-catalog"
import {
  executeTool,
  type ToolApproval,
  type ToolBudget,
  type ToolCallResult,
  type ToolContract,
  type ToolError,
  type ToolIdempotencyStore,
} from "@nifrajs/core/tool-contract"

export {
  createLocalProcessAdapter,
  type ExecutionPolicy,
  type ExecutionPolicyAdapter,
  LOCAL_PROCESS_LIMITATION,
  type LocalProcessAdapter,
  type LocalProcessAdapterOptions,
  LocalProcessPolicyError,
  type LocalProcessRequest,
  type LocalProcessResult,
} from "./execution-policy.ts"

export type AgentStatus = "continue" | "completed" | "suspended"
export type AgentPendingKind = "approval" | "budget" | "model" | "cancelled"

export interface AgentDefinition<
  InputSchema extends StandardSchemaV1,
  OutputSchema extends StandardSchemaV1,
> {
  readonly name: string
  readonly instruction: string
  readonly input: InputSchema
  readonly output: OutputSchema
  readonly tools: readonly AgentToolContract[]
  /** Dimensionless counters charged once per model decision. */
  readonly modelCost?: EffectCost
}

/** Heterogeneous tool collection used by an agent definition. Runtime schemas remain authoritative. */
// biome-ignore lint/suspicious/noExplicitAny: a heterogeneous tool list is erased at this boundary; each contract validates at execution.
export type AgentToolContract = ToolContract<any, any>

/** The model-facing descriptor is the complete descriptive catalog entry. */
export type AgentToolDescriptor = ToolCatalogEntry

export interface AgentTurnState {
  readonly version: 1
  readonly turnId: string
  readonly step: number
  readonly status: "ready" | "suspended" | "completed"
  readonly evidence: readonly AgentStepEvidence[]
  readonly pending?: {
    readonly kind: AgentPendingKind
    readonly tool?: string
    readonly effectId: string
  }
}

export interface AgentStepEvidence {
  readonly seq: number
  readonly at: number
  readonly kind: "model" | "tool" | "approval" | "budget" | "state"
  readonly outcome: "started" | "passed" | "failed" | "denied" | "suspended" | "committed"
  readonly name?: string
  readonly effectId?: string
  readonly code?: string
  readonly ledgerHead?: string
}

export interface AgentModelRequest {
  readonly agent: string
  readonly instruction: string
  readonly input: unknown
  readonly state: AgentTurnState
  readonly tools: readonly AgentToolDescriptor[]
  readonly toolResult?: AgentToolResult
  readonly previousOutput?: unknown
  readonly signal: AbortSignal
  /** Wall-clock budget shared with the parent request. Use withDeadlineHeader for outbound requests. */
  readonly deadline?: RequestBudget
  /**
   * Present when an observer asked for progressive output (see {@link AgentPorts.deltas}). A
   * streaming port calls it per chunk while producing the decision; emitting is optional and
   * best-effort - a port that returns only complete responses ignores it, and callback failures
   * never reach the port. Deltas are transient observer data, not evidence: they are not
   * validated, not persisted, and not replayed.
   */
  readonly onDelta?: (delta: AgentModelDelta) => void
}

export type AgentModelResponse =
  | { readonly kind: "output"; readonly value: unknown }
  | { readonly kind: "tool"; readonly name: string; readonly input: unknown }

export interface AgentModelPort {
  /** Provider output is unknown until the response parser accepts it. */
  complete(request: AgentModelRequest): unknown | PromiseLike<unknown>
}

/**
 * One progressive chunk of a model decision in flight: user-visible text, reasoning text, or the
 * raw argument text of the tool call being formed (`name` on the first chunk when the provider
 * announces it). A `usage` delta reports the decision's token counts once the provider settles
 * them, optionally attributed to a provider and model - observers sum across decisions. Chunks
 * are provider output surface, not evidence - the runtime never stores them.
 */
export type AgentModelDelta =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "reasoning"; readonly text: string }
  | { readonly kind: "tool-args"; readonly name?: string; readonly argsText: string }
  | {
      readonly kind: "usage"
      readonly provider?: string
      readonly model?: string
      readonly inputTokens?: number
      readonly outputTokens?: number
      readonly totalTokens?: number
      readonly reasoningTokens?: number
      readonly cachedInputTokens?: number
    }

/** A transient observer of model deltas - an SSE bridge, a live console, a progress meter. */
export interface AgentDeltaSink {
  delta(delta: AgentModelDelta): void
}

/**
 * Fan model deltas out to several sinks - a protocol bridge and a logger can watch the same run.
 * `undefined` entries are skipped, and the combined sink is `undefined` when none remain. Each
 * sink is isolated: one sink throwing never starves the others.
 */
export function combineAgentDeltaSinks(
  ...sinks: readonly (AgentDeltaSink | undefined)[]
): AgentDeltaSink | undefined {
  const live = sinks.filter((sink): sink is AgentDeltaSink => sink !== undefined)
  if (live.length === 0) return undefined
  if (live.length === 1) return live[0]
  return {
    delta(delta) {
      for (const sink of live) {
        try {
          sink.delta(delta)
        } catch {
          // Deltas are best-effort observability; a failing sink must not affect its peers.
        }
      }
    },
  }
}

export interface AgentToolResult {
  readonly name: string
  readonly ok: boolean
  readonly output?: unknown
  readonly error?:
    | ToolError
    | { readonly code: "unknown_tool" | "invalid_model_response"; readonly stage: "execution" }
}

export interface AgentPendingContinuation {
  readonly kind: AgentPendingKind
  readonly tool?: string
  readonly input?: unknown
  readonly effectId: string
}

export type AgentApprovalResult =
  | { readonly status: "approved"; readonly approval: ToolApproval }
  | { readonly status: "denied"; readonly reason?: string }
  | { readonly status: "pending"; readonly effectId: string }

export interface AgentApprovalPort {
  request(input: {
    readonly turnId: string
    readonly effectId: string
    readonly tool: string
    readonly capability: string
    readonly signal: AbortSignal
    /** Wall-clock budget reserved for this approval hop and the following tool execution. */
    readonly deadline?: RequestBudget
  }): AgentApprovalResult | PromiseLike<AgentApprovalResult>
}

export interface AgentStateStore {
  load(turnId: string): AgentTurnState | undefined | PromiseLike<AgentTurnState | undefined>
  save(state: AgentTurnState): void | PromiseLike<void>
}

export class MemoryAgentStateStore implements AgentStateStore {
  private readonly states = new Map<string, AgentTurnState>()

  load(turnId: string): AgentTurnState | undefined {
    return this.states.get(turnId)
  }

  save(state: AgentTurnState): void {
    this.states.set(state.turnId, freezeState(state))
  }
}

export interface AgentTelemetryPort {
  step(evidence: AgentStepEvidence): void | PromiseLike<void>
}

/**
 * Fan one run's step evidence out to several telemetry ports - an SSE evidence stream and an
 * exporter can observe the same turn. Ports are awaited in argument order; `undefined` entries are
 * skipped, and the combined port is `undefined` when none remain.
 */
export function combineAgentTelemetry(
  ...ports: readonly (AgentTelemetryPort | undefined)[]
): AgentTelemetryPort | undefined {
  const live = ports.filter((port): port is AgentTelemetryPort => port !== undefined)
  if (live.length === 0) return undefined
  if (live.length === 1) return live[0]
  return {
    async step(evidence) {
      for (const port of live) await port.step(evidence)
    },
  }
}

/** One RFC 6902 operation from the applied subset: `add`, `replace`, `remove`. */
export type AgentStatePatchOp =
  | { readonly op: "add" | "replace"; readonly path: string; readonly value: unknown }
  | { readonly op: "remove"; readonly path: string }

/**
 * A shared, observable state document for one run - the state a live UI mirrors while the agent
 * works. App code (a model port, a tool executor) calls `patch` with RFC 6902 operations; every
 * subscriber sees the applied ops, and protocol bridges project them onto their wire (AG-UI
 * `STATE_SNAPSHOT`/`STATE_DELTA`). The document is transient per-run observer data - it is not
 * turn state, not evidence, and never persisted by the runtime.
 */
export interface AgentSharedState<State = unknown> {
  /** A defensive deep copy of the current document. */
  snapshot(): State
  /** Apply ops atomically - on an invalid op the whole batch is rejected with a TypeError. */
  patch(ops: readonly AgentStatePatchOp[]): void
  /** Observe applied patches. Returns the unsubscribe function. Listener failures are isolated. */
  subscribe(listener: (ops: readonly AgentStatePatchOp[]) => void): () => void
}

export function createAgentSharedState<State>(initial: State): AgentSharedState<State> {
  let document: unknown = structuredClone(initial)
  const listeners = new Set<(ops: readonly AgentStatePatchOp[]) => void>()
  return {
    snapshot() {
      return structuredClone(document) as State
    },
    patch(ops) {
      // Validate-then-apply on a copy so a mid-batch failure never leaves a half-patched document.
      let next = structuredClone(document)
      for (const op of ops) next = applyStatePatchOp(next, op)
      document = next
      const applied = Object.freeze([...ops])
      for (const listener of listeners) {
        try {
          listener(applied)
        } catch {
          // Observer failures must not affect the document or the other observers.
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** JSON Pointer segments that would graft onto the prototype chain are rejected outright. */
const FORBIDDEN_STATE_KEYS = new Set(["__proto__", "constructor", "prototype"])

function applyStatePatchOp(document: unknown, op: AgentStatePatchOp): unknown {
  if (op === null || typeof op !== "object" || typeof op.path !== "string")
    throw new TypeError("agent: invalid patch op")
  if (op.op !== "add" && op.op !== "replace" && op.op !== "remove")
    throw new TypeError("agent: unsupported patch op")
  if (op.path === "") {
    if (op.op === "remove") throw new TypeError("agent: cannot remove the document root")
    return op.value
  }
  if (!op.path.startsWith("/")) throw new TypeError("agent: patch path must be a JSON Pointer")
  const segments = op.path
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
  let parent: unknown = document
  for (let index = 0; index < segments.length - 1; index += 1)
    parent = stateChild(parent, segments[index] as string)
  const key = segments[segments.length - 1] as string
  if (Array.isArray(parent)) {
    if (op.op === "add" && key === "-") {
      parent.push(op.value)
      return document
    }
    const index = asStateIndex(key, parent.length + (op.op === "add" ? 1 : 0))
    if (op.op === "add") parent.splice(index, 0, op.value)
    else if (op.op === "replace") parent[index] = op.value
    else parent.splice(index, 1)
    return document
  }
  const record = asStateRecord(parent)
  if (FORBIDDEN_STATE_KEYS.has(key)) throw new TypeError("agent: forbidden patch path segment")
  if (op.op === "remove") {
    if (!Object.hasOwn(record, key)) throw new TypeError("agent: patch path does not exist")
    delete record[key]
    return document
  }
  if (op.op === "replace" && !Object.hasOwn(record, key))
    throw new TypeError("agent: patch path does not exist")
  record[key] = op.value
  return document
}

function stateChild(parent: unknown, segment: string): unknown {
  if (Array.isArray(parent)) return parent[asStateIndex(segment, parent.length)]
  const record = asStateRecord(parent)
  if (FORBIDDEN_STATE_KEYS.has(segment) || !Object.hasOwn(record, segment))
    throw new TypeError("agent: patch path does not exist")
  return record[segment]
}

function asStateIndex(segment: string, bound: number): number {
  if (!/^(0|[1-9]\d{0,9})$/.test(segment)) throw new TypeError("agent: invalid array index")
  const index = Number(segment)
  if (index >= bound) throw new TypeError("agent: array index out of bounds")
  return index
}

function asStateRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("agent: patch path does not exist")
  return value as Record<string, unknown>
}

/** A sink failure must surface as neither a model failure nor a dropped run. */
function guardedDelta(sink: AgentDeltaSink): (delta: AgentModelDelta) => void {
  return (delta) => {
    try {
      sink.delta(delta)
    } catch {
      // Deltas are best-effort observability.
    }
  }
}

export interface AgentPorts {
  readonly model: AgentModelPort
  readonly capabilities: readonly string[]
  readonly budget?: ToolBudget
  /** Wall-clock budget shared with the parent request. Distinct from `budget`, which is cost. */
  readonly deadline?: RequestBudget
  readonly idempotency?: ToolIdempotencyStore
  readonly state?: AgentStateStore
  readonly approval?: AgentApprovalPort
  readonly telemetry?: AgentTelemetryPort
  /** Receives model deltas when the model port streams. Transient - nothing here is persisted. */
  readonly deltas?: AgentDeltaSink
  readonly clock?: () => number
  /** Adapter used to satisfy execution policies declared by tool contracts. */
  readonly executionPolicy?: ExecutionPolicyAdapter
  /** Injectable token generator for deterministic replay and tests. */
  readonly idFactory?: () => string
  readonly signal?: AbortSignal
  /** Replay mode skips every tool executor and marks the call dry-run. */
  readonly dryRun?: boolean
}

export interface AgentTurnInput {
  readonly value: unknown
  readonly toolResult?: AgentToolResult
  readonly previousOutput?: unknown
  readonly resume?: {
    readonly continuation: AgentPendingContinuation
    readonly approval?: ToolApproval
  }
}

export interface AgentTurnBaseResult {
  readonly state: AgentTurnState
  readonly evidence: readonly AgentStepEvidence[]
  readonly transcript: AgentTranscript
}

export interface AgentTurnError {
  readonly code: "input_invalid" | "output_invalid" | "model_failed"
  readonly issues?: readonly StandardIssue[]
}

export type AgentTurnResult<Output> =
  | (AgentTurnBaseResult & {
      readonly status: "completed"
      readonly output: Output
      readonly error?: never
    })
  | (AgentTurnBaseResult & {
      readonly status: "completed"
      readonly error: AgentTurnError
      readonly output?: never
    })
  | (AgentTurnBaseResult & { readonly status: "continue"; readonly toolResult: AgentToolResult })
  | (AgentTurnBaseResult & {
      readonly status: "suspended"
      readonly pending: AgentPendingContinuation
      readonly reason: "approval" | "budget" | "model" | "cancelled"
    })

export interface AgentTranscript {
  readonly version: 1
  readonly turnId: string
  readonly responses: readonly AgentModelResponse[]
  readonly evidence: readonly AgentStepEvidence[]
}

export interface RunAgentOptions {
  readonly state: AgentTurnState
  readonly maxTurns?: number
  readonly goal?: (output: unknown) => boolean
}

export type AgentRunResult<Output> =
  | AgentTurnResult<Output>
  | (AgentTurnBaseResult & {
      readonly status: "suspended"
      readonly pending: AgentPendingContinuation
      readonly reason: "max_turns"
    })

export function createAgentState(turnId: string): AgentTurnState {
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(turnId))
    throw new TypeError("agent: turnId must be a bounded token")
  return Object.freeze({
    version: 1,
    turnId,
    step: 0,
    status: "ready",
    evidence: Object.freeze([]),
  })
}

const AGENT_SETTLE_RESERVE_MS = 5

function costMilliseconds(cost: EffectCost | undefined): number {
  const value = cost?.ms
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
}

export async function turn<
  InputSchema extends StandardSchemaV1,
  OutputSchema extends StandardSchemaV1,
>(
  definition: AgentDefinition<InputSchema, OutputSchema>,
  state: AgentTurnState,
  input: AgentTurnInput,
  ports: AgentPorts,
): Promise<AgentTurnResult<NonNullable<OutputSchema["~standard"]["types"]>["output"]>> {
  const signal = ports.signal ?? new AbortController().signal
  const clock = ports.clock ?? (() => performance.now())
  const newId = ports.idFactory ?? (() => crypto.randomUUID())
  const evidence: AgentStepEvidence[] = [...state.evidence]
  const responses: AgentModelResponse[] = []
  const add = async (
    kind: AgentStepEvidence["kind"],
    outcome: AgentStepEvidence["outcome"],
    fields: Omit<AgentStepEvidence, "seq" | "at" | "kind" | "outcome"> = {},
  ): Promise<AgentStepEvidence> => {
    const at = clock()
    if (!Number.isFinite(at) || at < 0)
      throw new TypeError("agent: clock must return a finite non-negative number")
    const item = Object.freeze({ seq: evidence.length, at, kind, outcome, ...fields })
    evidence.push(item)
    await ports.telemetry?.step(item)
    return item
  }
  const save = async (next: AgentTurnState): Promise<void> => {
    await ports.state?.save(next)
  }
  const suspended = async (
    next: AgentTurnState,
    pending: AgentPendingContinuation,
    reason: "approval" | "budget" | "model" | "cancelled",
  ): Promise<AgentTurnResult<NonNullable<OutputSchema["~standard"]["types"]>["output"]>> => {
    await add("state", "suspended", { effectId: pending.effectId, code: reason })
    const saved = freezeState({
      ...next,
      status: "suspended",
      pending: {
        kind: pending.kind,
        ...(pending.tool === undefined ? {} : { tool: pending.tool }),
        effectId: pending.effectId,
      },
      evidence,
    })
    await save(saved)
    return {
      status: "suspended",
      state: saved,
      pending,
      reason,
      evidence: saved.evidence,
      transcript: {
        version: 1,
        turnId: state.turnId,
        responses: Object.freeze([...responses]),
        evidence: saved.evidence,
      },
    }
  }

  const inputResult = await validateStandard(definition.input, input.value)
  if (!inputResult.ok) {
    await add("model", "failed", { code: "input_invalid" })
    const saved = freezeState({ ...state, status: "completed", step: state.step + 1, evidence })
    await save(saved)
    return completedError(saved, responses, evidence, "input_invalid", inputResult.issues)
  }
  if (signal.aborted) return suspended(state, { kind: "cancelled", effectId: newId() }, "cancelled")

  if (state.status === "suspended") {
    if (input.resume !== undefined) {
      return resumeTool(
        definition,
        state,
        ports,
        input.resume,
        evidence,
        responses,
        add,
        save,
        suspended,
      )
    }
    // Model failures and budget suspensions have no persisted payload to replay. Once the
    // caller supplies a live signal/budget again, retry the model step from the token-only state.
    // Tool suspensions retain no tool input in state, so they still require an explicit continuation.
    if (state.pending?.tool === undefined) state = readyState(state)
    else
      return suspended(
        state,
        {
          kind: state.pending?.kind ?? "cancelled",
          ...(state.pending?.tool === undefined ? {} : { tool: state.pending.tool }),
          effectId: state.pending?.effectId ?? newId(),
        },
        state.pending?.kind ?? "cancelled",
      )
  }
  const modelMs = costMilliseconds(definition.modelCost)
  if (
    ports.deadline !== undefined &&
    !canAttempt(ports.deadline, modelMs, AGENT_SETTLE_RESERVE_MS)
  ) {
    await add("budget", "denied", { code: "deadline_exceeded" })
    return suspended(state, { kind: "budget", effectId: newId() }, "budget")
  }
  if (ports.budget !== undefined && !ports.budget.consume(definition.modelCost)) {
    await add("budget", "denied", { code: "budget_exceeded" })
    return suspended(state, { kind: "budget", effectId: newId() }, "budget")
  }
  await add("model", "started")
  let response: AgentModelResponse | undefined
  try {
    const rawResponse = await ports.model.complete({
      agent: definition.name,
      instruction: definition.instruction,
      input: inputResult.value,
      state,
      tools: definition.tools.map((tool) => toCatalogEntry(tool)),
      ...(input.toolResult === undefined ? {} : { toolResult: input.toolResult }),
      ...(input.previousOutput === undefined ? {} : { previousOutput: input.previousOutput }),
      signal,
      ...(ports.deadline === undefined
        ? {}
        : { deadline: ports.deadline.child(AGENT_SETTLE_RESERVE_MS) }),
      ...(ports.deltas === undefined ? {} : { onDelta: guardedDelta(ports.deltas) }),
    })
    response = parseModelResponse(rawResponse)
  } catch {
    await add("model", "failed", { code: signal.aborted ? "cancelled" : "model_failed" })
    return suspended(
      state,
      { kind: signal.aborted ? "cancelled" : "model", effectId: newId() },
      signal.aborted ? "cancelled" : "model",
    )
  }
  if (ports.deadline !== undefined && !canAttempt(ports.deadline, 0, AGENT_SETTLE_RESERVE_MS)) {
    await add("budget", "denied", { code: "deadline_exceeded" })
    return suspended(state, { kind: "budget", effectId: newId() }, "budget")
  }
  if (response === undefined) {
    await add("model", "failed", { code: "invalid_model_response" })
    return continueWithToolError(
      state,
      evidence,
      responses,
      { name: "model", ok: false, error: { code: "invalid_model_response", stage: "execution" } },
      save,
    )
  }
  responses.push(response)
  if (response.kind === "output") {
    const outputResult = await validateStandard(definition.output, response.value)
    if (!outputResult.ok) {
      await add("model", "failed", { code: "output_invalid" })
      const saved = freezeState({ ...state, status: "completed", step: state.step + 1, evidence })
      await save(saved)
      return completedError(saved, responses, evidence, "output_invalid", outputResult.issues)
    }
    await add("model", "passed")
    const saved = freezeState({ ...state, status: "completed", step: state.step + 1, evidence })
    await save(saved)
    return {
      status: "completed",
      output: outputResult.value,
      state: saved,
      evidence: saved.evidence,
      transcript: {
        version: 1,
        turnId: state.turnId,
        responses: Object.freeze([...responses]),
        evidence: saved.evidence,
      },
    }
  }
  const tool = definition.tools.find((candidate) => candidate.name === response.name)
  if (tool === undefined) {
    await add("tool", "denied", { name: response.name, code: "unknown_tool" })
    return continueWithToolError(
      state,
      evidence,
      responses,
      { name: response.name, ok: false, error: { code: "unknown_tool", stage: "execution" } },
      save,
    )
  }
  return executeToolStep(
    state,
    tool,
    response.input,
    ports,
    evidence,
    responses,
    add,
    save,
    suspended,
  )
}

export async function runAgent<
  InputSchema extends StandardSchemaV1,
  OutputSchema extends StandardSchemaV1,
>(
  definition: AgentDefinition<InputSchema, OutputSchema>,
  input: AgentTurnInput,
  ports: AgentPorts,
  options: RunAgentOptions,
): Promise<AgentRunResult<NonNullable<OutputSchema["~standard"]["types"]>["output"]>> {
  const maxTurns = options.maxTurns ?? 8
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1)
    throw new RangeError("agent: maxTurns must be a positive safe integer")
  let state = options.state
  let nextInput = input
  let last: AgentTurnResult<NonNullable<OutputSchema["~standard"]["types"]>["output"]> | undefined
  const recordedResponses: AgentModelResponse[] = []
  for (let count = 0; count < maxTurns; count++) {
    last = await turn(definition, state, nextInput, ports)
    recordedResponses.push(...last.transcript.responses)
    if (last.status === "completed") {
      if (last.error !== undefined || options.goal === undefined || options.goal(last.output)) {
        return withTranscript(last, recordedResponses)
      }
      state = readyState(last.state)
      nextInput = { value: input.value, previousOutput: last.output }
      continue
    }
    if (last.status === "suspended") return withTranscript(last, recordedResponses)
    state = last.state
    nextInput = { value: input.value, toolResult: last.toolResult }
  }
  const fallback = last
  if (fallback === undefined) throw new Error("agent: no turn was executed")
  return {
    status: "suspended",
    reason: "max_turns",
    pending: { kind: "cancelled", effectId: (ports.idFactory ?? (() => crypto.randomUUID()))() },
    state: fallback.state,
    evidence: fallback.evidence,
    transcript: {
      version: 1,
      turnId: fallback.state.turnId,
      responses: Object.freeze([...recordedResponses]),
      evidence: fallback.evidence,
    },
  }
}

/** Load a saved token-only state record and continue a bounded run. */
export async function resumeAgent<
  InputSchema extends StandardSchemaV1,
  OutputSchema extends StandardSchemaV1,
>(
  definition: AgentDefinition<InputSchema, OutputSchema>,
  turnId: string,
  input: AgentTurnInput,
  ports: AgentPorts,
  options: Omit<RunAgentOptions, "state"> = {},
): Promise<AgentRunResult<NonNullable<OutputSchema["~standard"]["types"]>["output"]>> {
  if (ports.state === undefined) throw new Error("agent: resume requires a state store")
  const state = await ports.state.load(turnId)
  if (state === undefined) throw new Error("agent: no saved state for turn")
  return runAgent(definition, input, ports, { ...options, state })
}

export async function replayAgent<
  InputSchema extends StandardSchemaV1,
  OutputSchema extends StandardSchemaV1,
>(
  definition: AgentDefinition<InputSchema, OutputSchema>,
  input: AgentTurnInput,
  ports: Omit<AgentPorts, "model">,
  transcript: AgentTranscript,
  options: RunAgentOptions,
): Promise<AgentRunResult<NonNullable<OutputSchema["~standard"]["types"]>["output"]>> {
  let index = 0
  const model: AgentModelPort = {
    complete: () => {
      const response = transcript.responses[index++]
      if (response === undefined)
        throw new Error("agent replay: transcript ended before the model response")
      return response
    },
  }
  return runAgent(definition, input, { ...ports, model, dryRun: true }, options)
}

async function executeToolStep<OutputSchema extends StandardSchemaV1>(
  state: AgentTurnState,
  tool: AgentToolContract,
  input: unknown,
  ports: AgentPorts,
  evidence: AgentStepEvidence[],
  responses: AgentModelResponse[],
  add: (
    kind: AgentStepEvidence["kind"],
    outcome: AgentStepEvidence["outcome"],
    fields?: Omit<AgentStepEvidence, "seq" | "at" | "kind" | "outcome">,
  ) => Promise<AgentStepEvidence>,
  save: (state: AgentTurnState) => Promise<void>,
  suspended: (
    state: AgentTurnState,
    pending: AgentPendingContinuation,
    reason: "approval" | "budget" | "model" | "cancelled",
  ) => Promise<AgentTurnResult<NonNullable<OutputSchema["~standard"]["types"]>["output"]>>,
  effectIdOverride?: string,
): Promise<AgentTurnResult<NonNullable<OutputSchema["~standard"]["types"]>["output"]>> {
  const effectId = effectIdOverride ?? (ports.idFactory ?? (() => crypto.randomUUID()))()
  const toolMs = costMilliseconds(tool.cost)
  if (
    ports.deadline !== undefined &&
    !canAttempt(ports.deadline, toolMs, AGENT_SETTLE_RESERVE_MS)
  ) {
    await add("budget", "denied", {
      name: tool.name,
      effectId,
      code: "deadline_exceeded",
    })
    return suspended(state, { kind: "budget", tool: tool.name, input, effectId }, "budget")
  }
  let approval: ToolApproval | undefined
  if (tool.approval.kind !== "none") {
    if (ports.approval === undefined)
      return suspended(state, { kind: "approval", tool: tool.name, input, effectId }, "approval")
    const result = await ports.approval.request({
      turnId: state.turnId,
      effectId,
      tool: tool.name,
      capability: tool.capability,
      signal: ports.signal ?? new AbortController().signal,
      ...(ports.deadline === undefined
        ? {}
        : {
            deadline: ports.deadline.child(toolMs + AGENT_SETTLE_RESERVE_MS),
          }),
    })
    if (result.status === "pending")
      return suspended(
        state,
        { kind: "approval", tool: tool.name, input, effectId: result.effectId },
        "approval",
      )
    if (result.status === "denied")
      approval = {
        granted: false,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      }
    else approval = result.approval
    await add("approval", result.status === "approved" ? "passed" : "denied", {
      name: tool.name,
      effectId,
      ...(result.status === "denied" ? { code: "approval_denied" } : {}),
    })
  }
  if (
    ports.deadline !== undefined &&
    !canAttempt(ports.deadline, toolMs, AGENT_SETTLE_RESERVE_MS)
  ) {
    await add("budget", "denied", {
      name: tool.name,
      effectId,
      code: "deadline_exceeded",
    })
    return suspended(state, { kind: "budget", tool: tool.name, input, effectId }, "budget")
  }
  const result = await executeTool(tool, input, {
    effectId,
    capabilities: ports.capabilities,
    ...(approval === undefined ? {} : { approval }),
    ...(ports.budget === undefined ? {} : { budget: ports.budget }),
    ...(ports.idempotency === undefined ? {} : { idempotency: ports.idempotency }),
    ...(ports.executionPolicy === undefined ? {} : { executionPolicy: ports.executionPolicy }),
    ...(ports.signal === undefined ? {} : { signal: ports.signal }),
    ...(ports.deadline === undefined
      ? {}
      : { deadline: ports.deadline.child(AGENT_SETTLE_RESERVE_MS) }),
    ...(ports.dryRun === undefined ? {} : { dryRun: ports.dryRun }),
    ...(ports.clock === undefined ? {} : { clock: ports.clock }),
  })
  const toolResult = toolResultOf(tool.name, result)
  await add("tool", result.ok ? "committed" : "failed", {
    name: tool.name,
    effectId,
    ...(result.ok ? {} : { code: result.error.code }),
    ...(result.ledger.chain?.head === undefined ? {} : { ledgerHead: result.ledger.chain.head }),
  })
  if (!result.ok && result.error.code === "budget_exceeded") {
    await add("budget", "denied", { name: tool.name, effectId, code: "budget_exceeded" })
    return suspended(state, { kind: "budget", tool: tool.name, input, effectId }, "budget")
  }
  return continueWithToolError(state, evidence, responses, toolResult, save)
}

async function resumeTool<
  InputSchema extends StandardSchemaV1,
  OutputSchema extends StandardSchemaV1,
>(
  definition: AgentDefinition<InputSchema, OutputSchema>,
  state: AgentTurnState,
  ports: AgentPorts,
  resume: NonNullable<AgentTurnInput["resume"]>,
  evidence: AgentStepEvidence[],
  responses: AgentModelResponse[],
  add: (
    kind: AgentStepEvidence["kind"],
    outcome: AgentStepEvidence["outcome"],
    fields?: Omit<AgentStepEvidence, "seq" | "at" | "kind" | "outcome">,
  ) => Promise<AgentStepEvidence>,
  save: (state: AgentTurnState) => Promise<void>,
  suspended: (
    state: AgentTurnState,
    pending: AgentPendingContinuation,
    reason: "approval" | "budget" | "model" | "cancelled",
  ) => Promise<AgentTurnResult<NonNullable<OutputSchema["~standard"]["types"]>["output"]>>,
): Promise<AgentTurnResult<NonNullable<OutputSchema["~standard"]["types"]>["output"]>> {
  const tool =
    resume.continuation.tool === undefined
      ? undefined
      : definition.tools.find((candidate) => candidate.name === resume.continuation.tool)
  if (tool === undefined || !Object.hasOwn(resume.continuation, "input"))
    return continueWithToolError(
      state,
      evidence,
      responses,
      {
        name: resume.continuation.tool ?? "unknown",
        ok: false,
        error: { code: "unknown_tool", stage: "execution" },
      },
      save,
    )
  const approvalPorts: AgentPorts =
    resume.approval === undefined
      ? ports
      : {
          ...ports,
          approval: { request: () => ({ status: "approved", approval: resume.approval! }) },
        }
  return executeToolStep(
    { ...state, status: "ready" },
    tool,
    resume.continuation.input,
    approvalPorts,
    evidence,
    responses,
    add,
    save,
    suspended,
    resume.continuation.effectId,
  )
}

async function continueWithToolError<Output>(
  state: AgentTurnState,
  evidence: readonly AgentStepEvidence[],
  responses: readonly AgentModelResponse[],
  toolResult: AgentToolResult,
  save: (state: AgentTurnState) => Promise<void>,
): Promise<AgentTurnResult<Output>> {
  const { pending: _pending, ...withoutPending } = state
  const next = freezeState({ ...withoutPending, status: "ready", step: state.step + 1, evidence })
  await save(next)
  return {
    status: "continue",
    state: next,
    toolResult,
    evidence: next.evidence,
    transcript: {
      version: 1,
      turnId: state.turnId,
      responses: Object.freeze([...responses]),
      evidence: next.evidence,
    },
  }
}

function toolResultOf(name: string, result: ToolCallResult<unknown>): AgentToolResult {
  return result.ok
    ? { name, ok: true, ...(result.output === undefined ? {} : { output: result.output }) }
    : { name, ok: false, error: result.error }
}

function completedError(
  state: AgentTurnState,
  responses: readonly AgentModelResponse[],
  evidence: readonly AgentStepEvidence[],
  code: "input_invalid" | "output_invalid",
  issues: readonly StandardIssue[],
): AgentTurnBaseResult & {
  readonly status: "completed"
  readonly error: AgentTurnError
  readonly output?: never
} {
  return {
    status: "completed",
    error: { code, issues },
    state,
    evidence,
    transcript: {
      version: 1,
      turnId: state.turnId,
      responses: Object.freeze([...responses]),
      evidence,
    },
  }
}

function parseModelResponse(value: unknown): AgentModelResponse | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = Object.fromEntries(Object.entries(value))
  if (record.kind === "output" && Object.hasOwn(record, "value")) {
    return Object.freeze({ kind: "output", value: record.value })
  }
  if (record.kind === "tool" && typeof record.name === "string" && Object.hasOwn(record, "input")) {
    return Object.freeze({ kind: "tool", name: record.name, input: record.input })
  }
  return undefined
}

function readyState(state: AgentTurnState): AgentTurnState {
  const { pending: _pending, ...withoutPending } = state
  return freezeState({ ...withoutPending, status: "ready" })
}

function withTranscript<Output>(
  result: AgentTurnResult<Output>,
  responses: readonly AgentModelResponse[],
): AgentTurnResult<Output> {
  return {
    ...result,
    transcript: {
      version: 1,
      turnId: result.state.turnId,
      responses: Object.freeze([...responses]),
      evidence: result.evidence,
    },
  }
}

function freezeState(state: AgentTurnState): AgentTurnState {
  return Object.freeze({
    ...state,
    evidence: Object.freeze([...state.evidence]),
    ...(state.pending === undefined ? {} : { pending: Object.freeze({ ...state.pending }) }),
  })
}

/**
 * Presentation-safe projections of the agent protocol.
 *
 * A backend event or session snapshot carries prompt text, tool inputs and outputs, model
 * completions, diagnostic reports, and filesystem paths. None of that may reach browser-facing code.
 * These view models expose only stable identifiers, lifecycle statuses, counters, and opaque
 * references - never the content itself. A prompt becomes a character count; a tool result becomes an
 * `ok` flag and an error *code*; a compaction becomes before/after token counts. The projection is the
 * boundary: an upstream consumer sees enough to render progress and resolve interactions, and nothing
 * it could use to reconstruct a payload.
 */

import {
  type AgentEvent,
  type AgentSessionSnapshot,
  type AgentSessionStatus,
  type ApprovalLifecycleState,
  type BoundaryCommand,
  type HandoffLifecycleState,
  type HandoffSnapshot,
  isAgentEvent,
  nextApprovalState,
  nextHandoffState,
  type RunSnapshot,
} from "@nifrajs/agent-protocol"

/** A session reduced to lifecycle and capability facts. The working directory is deliberately omitted. */
export interface SessionView {
  readonly id: string
  readonly backend: string
  readonly status: AgentSessionStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastSeq: number
  readonly activeTurnId?: string
  readonly extensionRevision?: string
  readonly capabilities: readonly string[]
}

export function toSessionView(snapshot: AgentSessionSnapshot): SessionView {
  return Object.freeze({
    id: snapshot.id,
    backend: snapshot.backend,
    status: snapshot.status,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    lastSeq: snapshot.lastSeq,
    ...(snapshot.activeTurnId === undefined ? {} : { activeTurnId: snapshot.activeTurnId }),
    ...(snapshot.extensionRevision === undefined
      ? {}
      : { extensionRevision: snapshot.extensionRevision }),
    capabilities: [...snapshot.capabilities],
  })
}

interface EventViewBase {
  readonly kind: AgentEvent["type"]
  readonly seq: number
  readonly at: number
}

export interface SessionLifecycleView extends EventViewBase {
  readonly kind: "session.started" | "session.updated" | "session.completed"
  readonly session: SessionView
}

export interface TurnStartedView extends EventViewBase {
  readonly kind: "turn.started"
  readonly turnId: string
}

export interface AssistantChunkView extends EventViewBase {
  readonly kind: "assistant.delta" | "assistant.message"
  readonly turnId: string
  /** Length of the assistant text. The text itself is never carried. */
  readonly chars: number
}

export interface ToolStartedView extends EventViewBase {
  readonly kind: "tool.started"
  readonly turnId: string
  readonly callId: string
  readonly name: string
  readonly hasInput: boolean
}

export interface ToolDeltaView extends EventViewBase {
  readonly kind: "tool.delta"
  readonly turnId: string
  readonly callId: string
  readonly chars: number
}

export interface ToolCompletedView extends EventViewBase {
  readonly kind: "tool.completed"
  readonly turnId: string
  readonly callId: string
  readonly name: string
  readonly ok: boolean
  /** Error *code* only; the human-readable message is content and is dropped. */
  readonly errorCode?: string
}

export interface ApprovalRequiredView extends EventViewBase {
  readonly kind: "approval.required"
  readonly turnId: string
  readonly approvalId: string
  readonly action: string
  readonly capability: string
}

export interface ApprovalResolvedView extends EventViewBase {
  readonly kind: "approval.resolved"
  readonly turnId?: string
  readonly approvalId: string
  readonly approved: boolean
}

export interface RepairRequiredView extends EventViewBase {
  readonly kind: "repair.required"
  readonly turnId?: string
  readonly taskId: string
  readonly verification: "check" | "assure" | "test"
  readonly capabilities: readonly string[]
}

export interface VerificationCompletedView extends EventViewBase {
  readonly kind: "verification.completed"
  readonly name: string
  readonly ok: boolean
}

export interface MemoryCompactedView extends EventViewBase {
  readonly kind: "memory.compacted"
  readonly before: number
  readonly after: number
  readonly reason: "manual" | "threshold" | "overflow" | "workflow"
}

export interface ExtensionReloadedView extends EventViewBase {
  readonly kind: "extension.reloaded"
  readonly revision: string
  readonly loadedCount: number
  readonly disabledCount: number
  readonly rolledBack: boolean
}

export interface SessionFailedView extends EventViewBase {
  readonly kind: "session.failed"
  readonly errorCode: string
  readonly recoverable: boolean
}

export interface SessionStoppedView extends EventViewBase {
  readonly kind: "session.stopped"
}

export type AgentEventView =
  | SessionLifecycleView
  | TurnStartedView
  | AssistantChunkView
  | ToolStartedView
  | ToolDeltaView
  | ToolCompletedView
  | ApprovalRequiredView
  | ApprovalResolvedView
  | RepairRequiredView
  | VerificationCompletedView
  | MemoryCompactedView
  | ExtensionReloadedView
  | SessionFailedView
  | SessionStoppedView

/** Project one protocol event to its content-free view. Total over the event union - never returns undefined. */
export function toEventView(event: AgentEvent): AgentEventView {
  // Keep this boundary total even when a caller bypasses the transport's parser with an
  // untrusted cast. The protocol validator is discriminated and bounded; throwing only this
  // generic message prevents malformed payloads from reaching content projections or error text.
  if (!isAgentEvent(event)) throw new TypeError("agent event is invalid")
  const base = { seq: event.seq, at: event.at }
  switch (event.type) {
    case "session.started":
    case "session.updated":
    case "session.completed":
      return Object.freeze({ ...base, kind: event.type, session: toSessionView(event.snapshot) })
    case "turn.started":
      return Object.freeze({ ...base, kind: event.type, turnId: event.turnId })
    case "assistant.delta":
    case "assistant.message":
      return Object.freeze({
        ...base,
        kind: event.type,
        turnId: event.turnId,
        chars: event.text.length,
      })
    case "tool.started":
      return Object.freeze({
        ...base,
        kind: event.type,
        turnId: event.turnId,
        callId: event.callId,
        name: event.name,
        hasInput: event.input !== undefined,
      })
    case "tool.delta":
      return Object.freeze({
        ...base,
        kind: event.type,
        turnId: event.turnId,
        callId: event.callId,
        chars: event.text.length,
      })
    case "tool.completed":
      return Object.freeze({
        ...base,
        kind: event.type,
        turnId: event.turnId,
        callId: event.callId,
        name: event.name,
        ok: event.ok,
        ...(event.error === undefined ? {} : { errorCode: event.error.code }),
      })
    case "approval.required":
      return Object.freeze({
        ...base,
        kind: event.type,
        turnId: event.turnId,
        approvalId: event.approvalId,
        action: event.action,
        capability: event.capability,
      })
    case "approval.resolved":
      return Object.freeze({
        ...base,
        kind: event.type,
        approvalId: event.approvalId,
        approved: event.approved,
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
      })
    case "repair.required":
      return Object.freeze({
        ...base,
        kind: event.type,
        taskId: event.task.id,
        verification: event.task.verification,
        capabilities: [...event.task.capabilities],
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
      })
    case "verification.completed":
      return Object.freeze({ ...base, kind: event.type, name: event.name, ok: event.ok })
    case "memory.compacted":
      return Object.freeze({
        ...base,
        kind: event.type,
        before: event.before,
        after: event.after,
        reason: event.reason,
      })
    case "extension.reloaded":
      return Object.freeze({
        ...base,
        kind: event.type,
        revision: event.revision,
        loadedCount: event.loaded.length,
        disabledCount: event.disabled.length,
        rolledBack: event.rolledBack,
      })
    case "session.failed":
      return Object.freeze({
        ...base,
        kind: event.type,
        errorCode: event.error.code,
        recoverable: event.recoverable,
      })
    case "session.stopped":
      return Object.freeze({ ...base, kind: event.type })
  }
}

/** A run reduced to plan reference, lifecycle state, and progress counters - no node payloads. */
export interface RunView {
  readonly runId: string
  readonly planId: string
  readonly planDigest: string
  readonly nodeCount: number
  readonly state: RunSnapshot["state"]
  readonly cursor: number
  readonly total: number
  readonly completed: number
  readonly failed: number
  readonly updatedAt: number
  readonly failureCode?: string
}

export function toRunView(snapshot: RunSnapshot): RunView {
  return Object.freeze({
    runId: snapshot.runId,
    planId: snapshot.plan.id,
    planDigest: snapshot.plan.digest,
    nodeCount: snapshot.plan.nodeCount,
    state: snapshot.state,
    cursor: snapshot.cursor,
    total: snapshot.counters.total,
    completed: snapshot.counters.completed,
    failed: snapshot.counters.failed,
    updatedAt: snapshot.updatedAt,
    ...(snapshot.failureCode === undefined ? {} : { failureCode: snapshot.failureCode }),
  })
}

/** A handoff reduced to routing identifiers and status - the reason string is content and is dropped. */
export interface HandoffView {
  readonly runId: string
  readonly nodeId: string
  readonly seq: number
  readonly from: string
  readonly to: string
  readonly status: HandoffSnapshot["status"]
}

export function toHandoffView(snapshot: HandoffSnapshot): HandoffView {
  return Object.freeze({
    runId: snapshot.runId,
    nodeId: snapshot.nodeId,
    seq: snapshot.seq,
    from: snapshot.from,
    to: snapshot.to,
    status: snapshot.status,
  })
}

/**
 * A registry capability projected to its content-free identity card.
 *
 * The registry lists the invokable capabilities a host admits. A view carries only structural facts -
 * kind, identifier, version, the schema *digest* (a hash, never the schema), the required capability
 * tokens, and the host classes (approval, retry, idempotency, isolation). It never carries an input
 * schema, a description, an instruction, a prompt, or any other content field; any such field on the
 * raw record is simply dropped by the projection rather than surfaced.
 */
export interface RegistryCapabilityView {
  readonly kind: "tool" | "mcp-tool" | "extension" | "model-adapter" | "deployment-adapter"
  readonly name: string
  readonly version: string
  readonly schemaDigest: string
  readonly requiredCapabilities: readonly string[]
  readonly approval: "none" | "required" | "threshold"
  /** Present only for a `threshold` approval class. A numeric level is a bound, not content. */
  readonly approvalLevel?: number
  readonly retry: "none" | "idempotent"
  readonly idempotency: "none" | "request" | "durable"
  readonly isolation: "inherit" | "process" | "sandbox"
}

const REGISTRY_KINDS: ReadonlySet<string> = new Set([
  "tool",
  "mcp-tool",
  "extension",
  "model-adapter",
  "deployment-adapter",
])
const REGISTRY_RETRY: ReadonlySet<string> = new Set(["none", "idempotent"])
const REGISTRY_IDEMPOTENCY: ReadonlySet<string> = new Set(["none", "request", "durable"])
const REGISTRY_ISOLATION: ReadonlySet<string> = new Set(["inherit", "process", "sandbox"])
const HEX64 = /^[0-9a-f]{64}$/

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readApproval(
  value: unknown,
): { readonly approval: RegistryCapabilityView["approval"]; readonly level?: number } | undefined {
  if (!isRecordValue(value)) return undefined
  const kind = value.kind
  if (kind === "none" || kind === "required") return { approval: kind }
  if (kind === "threshold" && typeof value.level === "number" && Number.isSafeInteger(value.level))
    return { approval: "threshold", level: value.level }
  return undefined
}

/**
 * Project one raw registry descriptor to a content-free {@link RegistryCapabilityView}, or `undefined`
 * when a required identifier is missing or malformed. Only whitelisted structural fields are read, so
 * an unexpected content field on the record can never reach the returned view.
 */
export function toRegistryCapabilityView(value: unknown): RegistryCapabilityView | undefined {
  if (!isRecordValue(value)) return undefined
  const { kind, name, version, schemaDigest, requiredCapabilities, retry, idempotency, isolation } =
    value
  if (
    typeof kind !== "string" ||
    !REGISTRY_KINDS.has(kind) ||
    typeof name !== "string" ||
    name.length === 0 ||
    typeof version !== "string" ||
    version.length === 0 ||
    typeof schemaDigest !== "string" ||
    !HEX64.test(schemaDigest) ||
    !Array.isArray(requiredCapabilities) ||
    !requiredCapabilities.every((entry) => typeof entry === "string") ||
    typeof retry !== "string" ||
    !REGISTRY_RETRY.has(retry) ||
    typeof idempotency !== "string" ||
    !REGISTRY_IDEMPOTENCY.has(idempotency) ||
    typeof isolation !== "string" ||
    !REGISTRY_ISOLATION.has(isolation)
  )
    return undefined
  const approval = readApproval(value.approval)
  if (approval === undefined) return undefined
  return Object.freeze({
    kind: kind as RegistryCapabilityView["kind"],
    name,
    version,
    schemaDigest,
    requiredCapabilities: Object.freeze([...requiredCapabilities]),
    approval: approval.approval,
    ...(approval.level === undefined ? {} : { approvalLevel: approval.level }),
    retry: retry as RegistryCapabilityView["retry"],
    idempotency: idempotency as RegistryCapabilityView["idempotency"],
    isolation: isolation as RegistryCapabilityView["isolation"],
  })
}

/** The minimal boundary facts a decision needs. A `BoundaryItemView` from the client satisfies it. */
export interface BoundaryStateView {
  readonly kind: "approval" | "handoff"
  readonly state: string
  /** Absolute epoch-ms expiry. At or past it, the boundary is stale and offers no command. */
  readonly expiresAt: number
}

const APPROVAL_STATES: ReadonlySet<string> = new Set([
  "pending",
  "approved",
  "denied",
  "expired",
  "cancelled",
])
const HANDOFF_STATES: ReadonlySet<string> = new Set([
  "pending",
  "assigned",
  "accepted",
  "declined",
  "resolved",
  "expired",
  "cancelled",
])
/** UI verbs per boundary kind, in display order. `cancel` is shared; a numeric level never appears. */
const APPROVAL_UI_OPS = ["approve", "deny", "cancel"] as const
const HANDOFF_UI_OPS = ["assign", "resolve", "cancel"] as const

/** True once `now` reaches or passes the boundary's expiry. A stale boundary fails every command closed. */
export function boundaryIsStale(item: BoundaryStateView, now: number): boolean {
  return now >= item.expiresAt
}

/**
 * The boundary commands a UI may currently offer for one item. A command appears only when the host
 * has negotiated the `inbox` feature, the boundary has not expired, and the op is a legal transition
 * from the boundary's live state. An unknown or terminal state yields no commands, so a stale,
 * unsupported, or already-settled boundary can never present an actionable control.
 */
export function boundaryCommands(
  item: BoundaryStateView,
  options: { readonly inbox: boolean; readonly now: number },
): readonly BoundaryCommand[] {
  if (!options.inbox || boundaryIsStale(item, options.now)) return []
  if (item.kind === "approval") {
    if (!APPROVAL_STATES.has(item.state)) return []
    const state = item.state as ApprovalLifecycleState
    return Object.freeze(APPROVAL_UI_OPS.filter((op) => nextApprovalState(state, op) !== undefined))
  }
  if (!HANDOFF_STATES.has(item.state)) return []
  const state = item.state as HandoffLifecycleState
  return Object.freeze(HANDOFF_UI_OPS.filter((op) => nextHandoffState(state, op) !== undefined))
}

/**
 * Orders events by their sequence number and suppresses duplicates before they reach the UI.
 *
 * A live SSE stream can redeliver an event after a reconnect, or hand two frames to a consumer out of
 * order. {@link offer} returns only the events that are newly deliverable, in sequence order. Events
 * whose seq was already delivered, or is already buffered, are dropped as duplicates. A bounded
 * `maxPending` guards against an unbounded hole: once more than `maxPending` out-of-order events are
 * held waiting for a missing seq, the buffer skips the gap to the lowest pending seq and records the
 * skipped count on {@link dropped}, so a permanently lost event cannot stall the view forever.
 */
export class OrderedEventBuffer {
  private next: number | undefined
  private readonly pending = new Map<number, AgentEventView>()
  private readonly maxPending: number
  private droppedCount = 0

  /**
   * @param options.from Last already-delivered seq; the next expected event is `from + 1`. Omit for a
   *   fresh buffer that adopts the first offered event's seq as its starting point.
   * @param options.maxPending Out-of-order events held before the buffer skips a gap. Default 256.
   */
  constructor(options?: { readonly from?: number; readonly maxPending?: number }) {
    if (options?.from !== undefined) {
      if (!Number.isSafeInteger(options.from))
        throw new TypeError("OrderedEventBuffer: from must be a safe integer")
      this.next = options.from + 1
    }
    this.maxPending = options?.maxPending ?? 256
    if (!Number.isSafeInteger(this.maxPending) || this.maxPending < 1)
      throw new TypeError("OrderedEventBuffer: maxPending must be a positive integer")
  }

  /** Count of events skipped to recover from an unfilled gap. */
  get dropped(): number {
    return this.droppedCount
  }

  /** Seq the buffer will emit next, or `undefined` before the first event is seen. */
  get expected(): number | undefined {
    return this.next
  }

  offer(view: AgentEventView): readonly AgentEventView[] {
    if (this.next === undefined) this.next = view.seq
    if (view.seq < this.next) return [] // already delivered
    if (this.pending.has(view.seq)) return [] // duplicate still waiting
    this.pending.set(view.seq, view)
    return this.drain()
  }

  private drain(): readonly AgentEventView[] {
    const out: AgentEventView[] = []
    const emitContiguous = () => {
      for (let held = this.pending.get(this.next as number); held !== undefined; ) {
        out.push(held)
        this.pending.delete(this.next as number)
        this.next = (this.next as number) + 1
        held = this.pending.get(this.next as number)
      }
    }
    emitContiguous()
    if (this.pending.size > this.maxPending) {
      const lowest = Math.min(...this.pending.keys())
      this.droppedCount += lowest - (this.next as number)
      this.next = lowest
      emitContiguous()
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// Run studio projections
// ---------------------------------------------------------------------------

export type RunStudioNodeState =
  | "pending"
  | "running"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "recovered"

export interface RunStudioNodeView {
  readonly nodeId: string
  readonly dependsOn: readonly string[]
  readonly state: RunStudioNodeState
  readonly attempt: number
  readonly retryCount: number
  readonly checkpointed: boolean
  readonly cancelled: boolean
  readonly recovered: boolean
}

export interface RunStudioView {
  readonly runId: string
  readonly planId: string
  readonly planDigest: string
  readonly cursor: number
  readonly state: RunStudioNodeState
  readonly nodes: readonly RunStudioNodeView[]
  readonly activeNodes: number
  readonly terminalNodes: number
  readonly traceRef?: string
  readonly replayRef?: string
}

export interface EvidenceTimelineView {
  readonly seq: number
  readonly eventId: string
  readonly runId: string
  readonly nodeId: string
  readonly status:
    | "started"
    | "checkpointed"
    | "retrying"
    | "recovered"
    | "completed"
    | "failed"
    | "cancelled"
    | "dead-lettered"
  readonly attempt: number
  readonly traceRef?: string
  readonly replayRef?: string
  readonly scheduleToken?: string
}

export type EvalComparisonViewCode =
  | "equal"
  | "improved"
  | "tolerated"
  | "regressed"
  | "missing"
  | "incomparable"

export interface EvalComparisonView {
  readonly suiteId: string
  readonly comparisons: readonly {
    readonly caseId: string
    readonly rubricId: string
    readonly code: EvalComparisonViewCode
    readonly regressionId: string
  }[]
  readonly regressionIds: readonly string[]
}

export interface FaultInjectionView {
  readonly id: string
  readonly kind: string
  readonly scheduleToken: string
  readonly regressionId: string
  readonly ok: boolean
}

const STUDIO_TOKEN = /^[-A-Za-z0-9._:/]{1,128}$/
const STUDIO_DIGEST = /^[0-9a-f]{64}$/
const STUDIO_STATES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
  "recovered",
])
const STUDIO_STATUSES: ReadonlySet<string> = new Set([
  "started",
  "checkpointed",
  "retrying",
  "recovered",
  "completed",
  "failed",
  "cancelled",
  "dead-lettered",
])
const STUDIO_CODES: ReadonlySet<string> = new Set([
  "equal",
  "improved",
  "tolerated",
  "regressed",
  "missing",
  "incomparable",
])
const STUDIO_FORBIDDEN: ReadonlySet<string> = new Set([
  "prompt",
  "message",
  "text",
  "input",
  "output",
  "arguments",
  "body",
  "response",
  "secret",
  "credential",
  "diagnostic",
  "stack",
  "content",
  "transcript",
  "artifact",
  "path",
])

function studioRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function studioToken(value: unknown): value is string {
  return typeof value === "string" && STUDIO_TOKEN.test(value)
}

function studioInt(value: unknown, min = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min
}

function studioSafeKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every(
    (key) => !STUDIO_FORBIDDEN.has(key.toLowerCase()) && allowed.has(key),
  )
}

/** Project an evidence-only run graph; malformed or content-bearing input is rejected. */
export function toRunStudioView(value: unknown): RunStudioView | undefined {
  if (!studioRecord(value)) return undefined
  const allowed = new Set([
    "runId",
    "planId",
    "planDigest",
    "cursor",
    "state",
    "nodes",
    "traceRef",
    "replayRef",
  ])
  if (
    !studioSafeKeys(value, allowed) ||
    !studioToken(value.runId) ||
    !studioToken(value.planId) ||
    typeof value.planDigest !== "string" ||
    !STUDIO_DIGEST.test(value.planDigest) ||
    !studioInt(value.cursor) ||
    typeof value.state !== "string" ||
    !STUDIO_STATES.has(value.state) ||
    !Array.isArray(value.nodes)
  )
    return undefined
  if (value.traceRef !== undefined && !studioToken(value.traceRef)) return undefined
  if (value.replayRef !== undefined && !studioToken(value.replayRef)) return undefined
  const nodes: RunStudioNodeView[] = []
  for (const raw of value.nodes) {
    if (
      !studioRecord(raw) ||
      !studioSafeKeys(
        raw,
        new Set([
          "nodeId",
          "dependsOn",
          "state",
          "attempt",
          "retryCount",
          "checkpointed",
          "cancelled",
          "recovered",
        ]),
      )
    )
      return undefined
    if (
      !studioToken(raw.nodeId) ||
      !Array.isArray(raw.dependsOn) ||
      !raw.dependsOn.every(studioToken) ||
      typeof raw.state !== "string" ||
      !STUDIO_STATES.has(raw.state) ||
      !studioInt(raw.attempt, 1) ||
      !studioInt(raw.retryCount) ||
      typeof raw.checkpointed !== "boolean" ||
      typeof raw.cancelled !== "boolean" ||
      typeof raw.recovered !== "boolean"
    )
      return undefined
    nodes.push(
      Object.freeze({
        nodeId: raw.nodeId,
        dependsOn: Object.freeze([...raw.dependsOn].sort()),
        state: raw.state as RunStudioNodeState,
        attempt: raw.attempt,
        retryCount: raw.retryCount,
        checkpointed: raw.checkpointed,
        cancelled: raw.cancelled,
        recovered: raw.recovered,
      }),
    )
  }
  nodes.sort((a, b) => a.nodeId.localeCompare(b.nodeId))
  return Object.freeze({
    runId: value.runId,
    planId: value.planId,
    planDigest: value.planDigest,
    cursor: value.cursor,
    state: value.state as RunStudioNodeState,
    nodes: Object.freeze(nodes),
    activeNodes: nodes.filter((node) => node.state === "running" || node.state === "paused").length,
    terminalNodes: nodes.filter(
      (node) => node.state === "succeeded" || node.state === "failed" || node.state === "cancelled",
    ).length,
    ...(value.traceRef === undefined ? {} : { traceRef: value.traceRef }),
    ...(value.replayRef === undefined ? {} : { replayRef: value.replayRef }),
  })
}

/** Drop every field except bounded timeline evidence and sort by sequence. */
export function toEvidenceTimelineView(value: unknown): readonly EvidenceTimelineView[] {
  if (!Array.isArray(value)) return []
  const rows: EvidenceTimelineView[] = []
  for (const raw of value) {
    if (
      !studioRecord(raw) ||
      !studioSafeKeys(
        raw,
        new Set([
          "seq",
          "eventId",
          "runId",
          "nodeId",
          "status",
          "attempt",
          "traceRef",
          "replayRef",
          "scheduleToken",
        ]),
      )
    )
      continue
    if (
      !studioInt(raw.seq) ||
      !studioToken(raw.eventId) ||
      !studioToken(raw.runId) ||
      !studioToken(raw.nodeId) ||
      typeof raw.status !== "string" ||
      !STUDIO_STATUSES.has(raw.status) ||
      !studioInt(raw.attempt, 1)
    )
      continue
    if (raw.traceRef !== undefined && !studioToken(raw.traceRef)) continue
    if (raw.replayRef !== undefined && !studioToken(raw.replayRef)) continue
    if (raw.scheduleToken !== undefined && !studioToken(raw.scheduleToken)) continue
    rows.push(
      Object.freeze({
        seq: raw.seq,
        eventId: raw.eventId,
        runId: raw.runId,
        nodeId: raw.nodeId,
        status: raw.status as EvidenceTimelineView["status"],
        attempt: raw.attempt,
        ...(raw.traceRef === undefined ? {} : { traceRef: raw.traceRef }),
        ...(raw.replayRef === undefined ? {} : { replayRef: raw.replayRef }),
        ...(raw.scheduleToken === undefined ? {} : { scheduleToken: raw.scheduleToken }),
      }),
    )
  }
  rows.sort((a, b) => a.seq - b.seq)
  return Object.freeze(rows)
}

export function toEvalComparisonView(value: unknown): EvalComparisonView | undefined {
  if (
    !studioRecord(value) ||
    !studioSafeKeys(value, new Set(["suiteId", "comparisons", "regressions"])) ||
    !studioToken(value.suiteId) ||
    !Array.isArray(value.comparisons) ||
    !Array.isArray(value.regressions) ||
    !value.regressions.every(studioToken)
  )
    return undefined
  const comparisons: Array<EvalComparisonView["comparisons"][number]> = []
  for (const raw of value.comparisons) {
    if (
      !studioRecord(raw) ||
      !studioSafeKeys(raw, new Set(["caseId", "rubricId", "code", "regressionId"])) ||
      !studioToken(raw.caseId) ||
      !studioToken(raw.rubricId) ||
      typeof raw.code !== "string" ||
      !STUDIO_CODES.has(raw.code) ||
      !studioToken(raw.regressionId)
    )
      return undefined
    comparisons.push(
      Object.freeze({
        caseId: raw.caseId,
        rubricId: raw.rubricId,
        code: raw.code as EvalComparisonViewCode,
        regressionId: raw.regressionId,
      }),
    )
  }
  return Object.freeze({
    suiteId: value.suiteId,
    comparisons: Object.freeze(comparisons),
    regressionIds: Object.freeze([...value.regressions]),
  })
}

export function toFaultInjectionViews(value: unknown): readonly FaultInjectionView[] {
  if (!Array.isArray(value)) return []
  const views: FaultInjectionView[] = []
  for (const raw of value) {
    if (
      !studioRecord(raw) ||
      !studioSafeKeys(raw, new Set(["id", "kind", "scheduleToken", "regressionId", "ok"])) ||
      !studioToken(raw.id) ||
      !studioToken(raw.kind) ||
      !studioToken(raw.scheduleToken) ||
      !studioToken(raw.regressionId) ||
      typeof raw.ok !== "boolean"
    )
      continue
    views.push(
      Object.freeze({
        id: raw.id,
        kind: raw.kind,
        scheduleToken: raw.scheduleToken,
        regressionId: raw.regressionId,
        ok: raw.ok,
      }),
    )
  }
  return Object.freeze(views)
}

/** Keep browser work bounded when a run has more than 1,000 evidence rows. */
export function virtualizeEvidenceRows<T>(
  rows: readonly T[],
  cursor: number,
  windowSize = 100,
): { readonly offset: number; readonly rows: readonly T[] } {
  if (!Number.isSafeInteger(cursor) || cursor < 0)
    throw new RangeError("evidence cursor must be non-negative")
  if (!Number.isSafeInteger(windowSize) || windowSize < 1 || windowSize > 256)
    throw new RangeError("evidence window size is invalid")
  const offset = Math.min(
    Math.max(0, cursor - Math.floor(windowSize / 2)),
    Math.max(0, rows.length - windowSize),
  )
  return Object.freeze({ offset, rows: Object.freeze(rows.slice(offset, offset + windowSize)) })
}

// ---------------------------------------------------------------------------
// Review projections
// ---------------------------------------------------------------------------

export type ReviewViewStatus = "pass" | "fail" | "inconclusive" | "unavailable"

export interface ReviewViewEvidence {
  readonly source: string
  readonly token: string
  readonly digest: string
  readonly path?: string
}

export interface ReviewViewFinding {
  readonly id: string
  readonly check: string
  readonly code: string
  readonly severity: "error" | "warning" | "info"
  readonly category: string
  readonly location?: { readonly path: string; readonly line?: number }
  readonly evidence: readonly ReviewViewEvidence[]
  readonly fix?: { readonly recipe: string }
}

export interface ReviewViewCheck {
  readonly id: string
  readonly required: boolean
  readonly status: "pass" | "fail" | "skipped" | "unavailable" | "error"
  readonly findings: number
  readonly errors: number
  readonly warnings: number
  readonly info: number
  readonly outOfScope: number
  readonly reasonCode?: string
}

export interface ReviewView {
  readonly version: 1
  readonly status: ReviewViewStatus
  readonly ok: boolean
  readonly strict: boolean
  readonly blocking: number
  readonly digest?: string
  readonly processStatus?: number | null
  readonly reasonCode?: "invalid-report" | "unavailable" | "process-failed"
  readonly scope?: {
    readonly kind: "project" | "diff"
    readonly state: "valid" | "invalid"
    readonly pathDigest: string
    readonly changedPathCount: number
    readonly outOfScopeCount: number
  }
  readonly checks: readonly ReviewViewCheck[]
  readonly findings: readonly ReviewViewFinding[]
  readonly fixes: readonly {
    readonly recipe: string
    readonly status: "planned" | "changed" | "no-op" | "failed"
  }[]
}

const REVIEW_VIEW_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const REVIEW_VIEW_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/
const REVIEW_VIEW_DIGEST = /^[0-9a-f]{64}$/
const REVIEW_VIEW_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const REVIEW_VIEW_EVIDENCE_SOURCES = new Set([
  "check",
  "assurance",
  "capability",
  "manifest",
  "contract",
  "coverage",
  "git-scope",
  "collector",
])
const REVIEW_VIEW_REASONS = new Set([
  "not-configured",
  "config-missing",
  "config-invalid",
  "collector-error",
  "collector-unavailable",
  "diagnostics-truncated",
  "missing-typescript",
  "invalid-target",
  "invalid-git-ref",
  "invalid-git-scope",
  "filtered-out-of-scope",
  "fix-failed",
  "fix-no-op",
  "unsupported",
])
const REVIEW_VIEW_FIX_RECIPES = new Set(["manifest.sync", "workspace-dist.rebuild"])
const REVIEW_VIEW_FIX_STATUSES = new Set(["planned", "changed", "no-op", "failed"])
const REVIEW_VIEW_RPC_ERRORS = new Set([
  "timeout",
  "output-truncated",
  "invalid-report",
  "spawn-failed",
])
const REVIEW_VIEW_CHECKS = new Set([
  "typecheck",
  "typed-client",
  "server-boundary",
  "route-boundary",
  "pipeline",
  "security",
  "route-assurance",
  "capability-provenance",
  "manifest",
  "dependency",
  "contract-witness",
  "coverage",
  "hydration",
  "configuration",
])
const REVIEW_VIEW_STATUSES = new Set(["pass", "fail", "skipped", "unavailable", "error"])
const REVIEW_VIEW_SEVERITIES = new Set(["error", "warning", "info"])
const REVIEW_VIEW_CATEGORIES = new Set([
  "correctness",
  "security",
  "boundary",
  "assurance",
  "capability",
  "contract",
  "dependency",
  "hydration",
  "coverage",
  "configuration",
  "operational",
])
const REVIEW_VIEW_FORBIDDEN = new Set([
  "prompt",
  "message",
  "text",
  "input",
  "output",
  "arguments",
  "body",
  "response",
  "secret",
  "credential",
  "diagnostic",
  "stack",
  "content",
  "transcript",
  "request",
  "payload",
])

function reviewViewRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function reviewViewSafeKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every(
    (key) => !REVIEW_VIEW_FORBIDDEN.has(key.toLowerCase()) && allowed.has(key),
  )
}

function reviewViewEvidence(value: unknown): value is ReviewViewEvidence {
  if (!reviewViewRecord(value)) return false
  return (
    reviewViewSafeKeys(value, new Set(["source", "token", "digest", "path"])) &&
    typeof value.source === "string" &&
    REVIEW_VIEW_EVIDENCE_SOURCES.has(value.source) &&
    typeof value.token === "string" &&
    REVIEW_VIEW_TOKEN.test(value.token) &&
    typeof value.digest === "string" &&
    REVIEW_VIEW_DIGEST.test(value.digest) &&
    (value.path === undefined || reviewViewPath(value.path))
  )
}

function reviewViewReason(value: unknown): value is string {
  return typeof value === "string" && REVIEW_VIEW_REASONS.has(value)
}

function reviewViewPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    !value.includes("\\") &&
    !value.includes("\u0000") &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/.test(value) &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  )
}

function reviewViewInt(value: unknown, min = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min
}

function reviewUnavailableView(
  processStatus: number | null,
  reasonCode: "invalid-report" | "unavailable" | "process-failed",
): ReviewView {
  return Object.freeze({
    version: 1,
    status: "unavailable",
    ok: false,
    strict: false,
    blocking: 0,
    processStatus,
    reasonCode,
    checks: Object.freeze([]),
    findings: Object.freeze([]),
    fixes: Object.freeze([]),
  })
}

function parseReviewViewReport(value: Record<string, unknown>): ReviewView | undefined {
  if (
    !reviewViewSafeKeys(
      value,
      new Set([
        "version",
        "strict",
        "scope",
        "checks",
        "findings",
        "fixes",
        "blocking",
        "ok",
        "status",
        "digest",
      ]),
    ) ||
    value.version !== 1 ||
    typeof value.strict !== "boolean" ||
    (value.status !== "pass" && value.status !== "fail" && value.status !== "inconclusive") ||
    typeof value.ok !== "boolean" ||
    value.ok !== (value.status === "pass") ||
    !reviewViewInt(value.blocking) ||
    typeof value.digest !== "string" ||
    !REVIEW_VIEW_DIGEST.test(value.digest) ||
    !Array.isArray(value.checks) ||
    !Array.isArray(value.findings) ||
    value.scope === undefined
  )
    return undefined

  let scope: ReviewView["scope"]
  if (value.scope !== undefined) {
    if (
      !reviewViewRecord(value.scope) ||
      !reviewViewSafeKeys(
        value.scope,
        new Set([
          "kind",
          "state",
          "gitRef",
          "changedPaths",
          "pathDigest",
          "outOfScopeCount",
          "reasonCode",
        ]),
      ) ||
      (value.scope.kind !== "project" && value.scope.kind !== "diff") ||
      (value.scope.state !== "valid" && value.scope.state !== "invalid") ||
      !Array.isArray(value.scope.changedPaths) ||
      !value.scope.changedPaths.every(reviewViewPath) ||
      typeof value.scope.pathDigest !== "string" ||
      !REVIEW_VIEW_DIGEST.test(value.scope.pathDigest) ||
      !reviewViewInt(value.scope.outOfScopeCount)
    )
      return undefined
    if (value.scope.gitRef !== undefined && !REVIEW_VIEW_TOKEN.test(String(value.scope.gitRef)))
      return undefined
    if (value.scope.state === "invalid") {
      if (!reviewViewReason(value.scope.reasonCode)) return undefined
    } else if (value.scope.reasonCode !== undefined) return undefined
    scope = Object.freeze({
      kind: value.scope.kind,
      state: value.scope.state,
      pathDigest: value.scope.pathDigest,
      changedPathCount: value.scope.changedPaths.length,
      outOfScopeCount: value.scope.outOfScopeCount,
    })
  }

  if (value.checks.length > 512 || value.findings.length > 4096) return undefined
  const checks: ReviewViewCheck[] = []
  const checkFindingIds = new Map<string, readonly string[]>()
  for (const raw of value.checks) {
    if (
      !reviewViewRecord(raw) ||
      !reviewViewSafeKeys(
        raw,
        new Set([
          "id",
          "required",
          "status",
          "duration",
          "counts",
          "findingIds",
          "evidence",
          "reasonCode",
        ]),
      ) ||
      typeof raw.id !== "string" ||
      !REVIEW_VIEW_CHECKS.has(raw.id) ||
      checks.some((check) => check.id === raw.id) ||
      typeof raw.required !== "boolean" ||
      typeof raw.status !== "string" ||
      !REVIEW_VIEW_STATUSES.has(raw.status) ||
      !reviewViewRecord(raw.counts) ||
      !reviewViewSafeKeys(
        raw.counts,
        new Set(["findings", "errors", "warnings", "info", "outOfScope"]),
      ) ||
      !reviewViewInt(raw.counts.findings) ||
      !reviewViewInt(raw.counts.errors) ||
      !reviewViewInt(raw.counts.warnings) ||
      !reviewViewInt(raw.counts.info) ||
      !reviewViewInt(raw.counts.outOfScope) ||
      !Array.isArray(raw.findingIds) ||
      !raw.findingIds.every((id) => typeof id === "string" && REVIEW_VIEW_ID.test(id)) ||
      new Set(raw.findingIds).size !== raw.findingIds.length ||
      !Array.isArray(raw.evidence) ||
      raw.evidence.length === 0 ||
      raw.evidence.length > 1024 ||
      !raw.evidence.every(reviewViewEvidence)
    )
      return undefined
    if (raw.status === "skipped") {
      if (raw.required || raw.reasonCode !== "not-configured") return undefined
    } else if (raw.status === "unavailable" || raw.status === "error") {
      if (!reviewViewReason(raw.reasonCode)) return undefined
    } else if (raw.reasonCode !== undefined) return undefined
    checkFindingIds.set(raw.id, [...raw.findingIds])
    checks.push(
      Object.freeze({
        id: raw.id,
        required: raw.required,
        status: raw.status as ReviewViewCheck["status"],
        findings: raw.counts.findings,
        errors: raw.counts.errors,
        warnings: raw.counts.warnings,
        info: raw.counts.info,
        outOfScope: raw.counts.outOfScope,
        ...(raw.reasonCode === undefined ? {} : { reasonCode: raw.reasonCode as string }),
      }),
    )
  }

  const findings: ReviewViewFinding[] = []
  for (const raw of value.findings) {
    if (
      !reviewViewRecord(raw) ||
      !reviewViewSafeKeys(
        raw,
        new Set(["id", "check", "code", "severity", "category", "location", "evidence", "fix"]),
      ) ||
      typeof raw.id !== "string" ||
      !REVIEW_VIEW_ID.test(raw.id) ||
      findings.some((finding) => finding.id === raw.id) ||
      typeof raw.check !== "string" ||
      !REVIEW_VIEW_CHECKS.has(raw.check) ||
      typeof raw.code !== "string" ||
      !REVIEW_VIEW_CODE.test(raw.code) ||
      typeof raw.severity !== "string" ||
      !REVIEW_VIEW_SEVERITIES.has(raw.severity) ||
      typeof raw.category !== "string" ||
      !REVIEW_VIEW_CATEGORIES.has(raw.category) ||
      !Array.isArray(raw.evidence) ||
      raw.evidence.length === 0 ||
      raw.evidence.length > 32
    )
      return undefined
    let location: ReviewViewFinding["location"]
    if (raw.location !== undefined) {
      if (
        !reviewViewRecord(raw.location) ||
        !reviewViewSafeKeys(raw.location, new Set(["path", "line", "column"])) ||
        !reviewViewPath(raw.location.path) ||
        (raw.location.line !== undefined && !reviewViewInt(raw.location.line, 1)) ||
        (raw.location.column !== undefined && !reviewViewInt(raw.location.column, 1))
      )
        return undefined
      location = Object.freeze({
        path: raw.location.path,
        ...(raw.location.line === undefined ? {} : { line: raw.location.line }),
      })
    }
    const evidence: ReviewViewEvidence[] = []
    for (const rawEvidence of raw.evidence) {
      if (!reviewViewEvidence(rawEvidence)) return undefined
      evidence.push(
        Object.freeze({
          source: rawEvidence.source,
          token: rawEvidence.token,
          digest: rawEvidence.digest,
          ...(rawEvidence.path === undefined ? {} : { path: rawEvidence.path }),
        }),
      )
    }
    let fix: ReviewViewFinding["fix"]
    if (raw.fix !== undefined) {
      if (
        !reviewViewRecord(raw.fix) ||
        !reviewViewSafeKeys(raw.fix, new Set(["recipe"])) ||
        typeof raw.fix.recipe !== "string" ||
        !REVIEW_VIEW_FIX_RECIPES.has(raw.fix.recipe)
      )
        return undefined
      fix = Object.freeze({ recipe: raw.fix.recipe })
    }
    findings.push(
      Object.freeze({
        id: raw.id,
        check: raw.check,
        code: raw.code,
        severity: raw.severity as ReviewViewFinding["severity"],
        category: raw.category,
        ...(location === undefined ? {} : { location }),
        evidence: Object.freeze(evidence),
        ...(fix === undefined ? {} : { fix }),
      }),
    )
  }

  const fixes: Array<ReviewView["fixes"][number]> = []
  if (value.fixes !== undefined) {
    if (!Array.isArray(value.fixes) || value.fixes.length > 256) return undefined
    for (const raw of value.fixes) {
      if (
        !reviewViewRecord(raw) ||
        !reviewViewSafeKeys(raw, new Set(["recipe", "status", "changedPaths", "reasonCode"])) ||
        typeof raw.recipe !== "string" ||
        !REVIEW_VIEW_FIX_RECIPES.has(raw.recipe) ||
        typeof raw.status !== "string" ||
        !REVIEW_VIEW_FIX_STATUSES.has(raw.status) ||
        (raw.changedPaths !== undefined &&
          (!Array.isArray(raw.changedPaths) || !raw.changedPaths.every(reviewViewPath)))
      )
        return undefined
      if (raw.status === "no-op" || raw.status === "failed") {
        if (!reviewViewReason(raw.reasonCode)) return undefined
      } else if (raw.reasonCode !== undefined) return undefined
      fixes.push(
        Object.freeze({
          recipe: raw.recipe,
          status: raw.status as (typeof fixes)[number]["status"],
        }),
      )
    }
  }

  const findingById = new Map(findings.map((finding) => [finding.id, finding]))
  const referenced = new Set<string>()
  for (const check of checks) {
    const ids = checkFindingIds.get(check.id) ?? []
    const ownFindings = findings.filter((finding) => finding.check === check.id)
    if (
      ownFindings.length !== ids.length ||
      check.findings !== ownFindings.length ||
      check.errors !== ownFindings.filter((finding) => finding.severity === "error").length ||
      check.warnings !== ownFindings.filter((finding) => finding.severity === "warning").length ||
      check.info !== ownFindings.filter((finding) => finding.severity === "info").length
    )
      return undefined
    for (const id of ids) {
      const finding = findingById.get(id)
      if (finding === undefined || finding.check !== check.id || referenced.has(id))
        return undefined
      referenced.add(id)
    }
  }
  if (referenced.size !== findings.length) return undefined

  const errorCount = findings.filter((finding) => finding.severity === "error").length
  const warningCount = findings.filter((finding) => finding.severity === "warning").length
  const unresolvedFixes = fixes.filter(
    (fix) => fix.status === "no-op" || fix.status === "failed",
  ).length
  const expectedBlocking = errorCount + (value.strict ? warningCount : 0) + unresolvedFixes
  const expectedInconclusive =
    value.scope.state === "invalid" ||
    checks.some(
      (check) => check.required && (check.status === "unavailable" || check.status === "error"),
    )
  const expectedStatus = expectedInconclusive
    ? "inconclusive"
    : expectedBlocking > 0
      ? "fail"
      : "pass"
  if (value.blocking !== expectedBlocking || value.status !== expectedStatus) return undefined

  checks.sort((left, right) => left.id.localeCompare(right.id))
  findings.sort((left, right) => left.id.localeCompare(right.id))
  return Object.freeze({
    version: 1,
    status: value.status,
    ok: value.ok,
    strict: value.strict,
    blocking: value.blocking,
    digest: value.digest,
    ...(scope === undefined ? {} : { scope }),
    checks: Object.freeze(checks),
    findings: Object.freeze(findings),
    fixes: Object.freeze(fixes),
  })
}

/** Project a review report or host RPC result into a bounded, content-free browser view. */
export function toReviewView(value: unknown): ReviewView | undefined {
  if (!reviewViewRecord(value)) return undefined
  if (
    !Object.hasOwn(value, "report") &&
    Object.hasOwn(value, "ok") &&
    Object.hasOwn(value, "status") &&
    (value.status === null || typeof value.status === "number")
  ) {
    if (
      !reviewViewSafeKeys(value, new Set(["ok", "status", "errorCode"])) ||
      typeof value.ok !== "boolean" ||
      (value.status !== null && !reviewViewInt(value.status)) ||
      (value.errorCode !== undefined &&
        (typeof value.errorCode !== "string" || !REVIEW_VIEW_RPC_ERRORS.has(value.errorCode)))
    )
      return reviewUnavailableView(null, "invalid-report")
    const reason =
      value.errorCode === "invalid-report"
        ? "invalid-report"
        : value.errorCode === undefined
          ? value.ok
            ? "invalid-report"
            : "unavailable"
          : "process-failed"
    return reviewUnavailableView(value.status as number | null, reason)
  }
  if (Object.hasOwn(value, "report")) {
    if (
      !reviewViewSafeKeys(value, new Set(["ok", "status", "report", "errorCode"])) ||
      (value.status !== null && !reviewViewInt(value.status)) ||
      typeof value.ok !== "boolean" ||
      (value.errorCode !== undefined &&
        (typeof value.errorCode !== "string" || !REVIEW_VIEW_RPC_ERRORS.has(value.errorCode))) ||
      value.errorCode !== undefined
    )
      return reviewUnavailableView(null, "invalid-report")
    if (value.report === undefined)
      return reviewUnavailableView(
        value.status as number | null,
        value.ok ? "invalid-report" : "unavailable",
      )
    const report = toReviewView(value.report)
    return report === undefined
      ? reviewUnavailableView(value.status as number | null, "invalid-report")
      : Object.freeze({
          ...report,
          ...(value.status === undefined ? {} : { processStatus: value.status as number | null }),
        })
  }
  return parseReviewViewReport(value)
}

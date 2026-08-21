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

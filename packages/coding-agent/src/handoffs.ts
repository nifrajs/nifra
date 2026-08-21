/**
 * Handoff coordinator: the typed state machine for a delegated boundary within a run.
 *
 * This sits beside {@link ApprovalManager} rather than inside it. An approval answers a yes/no gate;
 * a handoff moves ownership of a paused node between roles (open, optionally assign an owner, then
 * accept, decline, resolve, expire, or cancel). The coordinator composes an {@link ApprovalManager}
 * when a handoff also needs a yes/no gate, so existing approval semantics are extended, never
 * weakened.
 *
 * Every boundary is addressed by a content-free {@link DecisionCoordinate}. A decision that names a
 * different run, node, capability, or request id fails `identity_mismatch`; one carrying a superseded
 * child vector fails `stale_vector`; one arriving at or past expiry expires the boundary closed and
 * fails `expired`; one whose transition is absent from the {@link nextHandoffState} table fails
 * `illegal_transition`; and one that would let a non-owner act on an assigned boundary fails
 * `authority_expanded`. Nothing here stores or returns a prompt, a free-text reason, tool data, or a
 * payload - only structural coordinates and a state.
 */

import {
  coordinateIsFresh,
  coordinatesMatch,
  type DecisionCoordinate,
  type HandoffLifecycleState,
  nextHandoffState,
} from "@nifrajs/agent-protocol"
import type { ApprovalManager } from "./approvals.ts"
import { ChildVectorTracker } from "./orchestration/policy.ts"

const ID_TOKEN = /^[A-Za-z0-9._:-]{1,128}$/

/** Stable, content-free reasons the coordinator refuses a handoff request or decision. */
export type HandoffRejection =
  | "unknown_boundary"
  | "identity_mismatch"
  | "stale_vector"
  | "expired"
  | "illegal_transition"
  | "authority_expanded"
  | "duplicate"
  | "invalid_handoff"

/** Thrown on any refused handoff operation. `code` is the machine-addressable reason. */
export class HandoffError extends Error {
  readonly code: HandoffRejection

  constructor(code: HandoffRejection) {
    super(`handoff: ${code}`)
    this.code = code
    this.name = "HandoffError"
  }
}

/** Content-free projection of one handoff boundary for a list/inspect view. */
export interface HandoffView {
  readonly requestId: string
  readonly runId: string
  readonly nodeId: string
  readonly capability: string
  readonly vector: number
  readonly expiresAt: number
  readonly state: HandoffLifecycleState
  /** Opaque origin role. */
  readonly from: string
  /** Opaque owner role once assigned. */
  readonly to?: string
}

export interface OpenHandoffInput {
  readonly runId: string
  readonly nodeId: string
  readonly capability: string
  readonly requestId: string
  /** Opaque origin role. */
  readonly from: string
  /** Milliseconds until the boundary expires closed. Falls back to the coordinator default. */
  readonly expiresInMs?: number
  /** When true, a paired approval is opened on the composed {@link ApprovalManager}, if present. */
  readonly requireApproval?: boolean
  readonly sessionId?: string
}

/** A decision against a live boundary. The coordinate must match the boundary exactly. */
export interface HandoffDecision {
  readonly coordinate: DecisionCoordinate
  /** Owner role to assign (for `assign`) or the actor claiming to own the boundary (accept/resolve). */
  readonly by?: string
}

export interface HandoffCoordinatorOptions {
  readonly vectors?: ChildVectorTracker
  readonly approvals?: ApprovalManager
  readonly defaultTtlMs?: number
  readonly maxPending?: number
  /** Injectable clock (epoch ms). Defaults to {@link Date.now}. */
  readonly now?: () => number
}

interface HandoffRecord {
  coordinate: DecisionCoordinate
  state: HandoffLifecycleState
  readonly from: string
  to: string | undefined
  readonly sessionId: string | undefined
  readonly requireApproval: boolean
}

const DEFAULT_TTL_MS = 5 * 60_000
const DEFAULT_MAX_PENDING = 64

export class HandoffCoordinator {
  private readonly vectors: ChildVectorTracker
  private readonly approvals: ApprovalManager | undefined
  private readonly defaultTtlMs: number
  private readonly maxPending: number
  private readonly now: () => number
  private readonly records = new Map<string, HandoffRecord>()

  constructor(options: HandoffCoordinatorOptions = {}) {
    this.vectors = options.vectors ?? new ChildVectorTracker()
    this.approvals = options.approvals
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING
    this.now = options.now ?? Date.now
    if (!Number.isSafeInteger(this.defaultTtlMs) || this.defaultTtlMs < 1)
      throw new RangeError("handoff: defaultTtlMs must be positive")
    if (!Number.isSafeInteger(this.maxPending) || this.maxPending < 1)
      throw new RangeError("handoff: maxPending must be positive")
  }

  /** Open a pending handoff. Allocates the run's next monotonic child vector. */
  open(input: OpenHandoffInput): HandoffView {
    if (
      !ID_TOKEN.test(input.runId) ||
      !ID_TOKEN.test(input.nodeId) ||
      !ID_TOKEN.test(input.requestId) ||
      !input.capability ||
      input.capability.length > 128 ||
      !input.from ||
      input.from.length > 128
    )
      throw new HandoffError("invalid_handoff")
    if (this.records.has(input.requestId)) throw new HandoffError("duplicate")
    if (this.activeCount() >= this.maxPending) throw new HandoffError("invalid_handoff")

    const ttl = input.expiresInMs ?? this.defaultTtlMs
    if (!Number.isSafeInteger(ttl) || ttl < 1) throw new HandoffError("invalid_handoff")
    const coordinate: DecisionCoordinate = Object.freeze({
      runId: input.runId,
      nodeId: input.nodeId,
      capability: input.capability,
      requestId: input.requestId,
      vector: this.vectors.open(input.runId),
      expiresAt: this.now() + ttl,
    })
    const record: HandoffRecord = {
      coordinate,
      state: "pending",
      from: input.from,
      to: undefined,
      sessionId: input.sessionId,
      requireApproval: input.requireApproval === true,
    }
    this.records.set(input.requestId, record)

    if (record.requireApproval && this.approvals !== undefined)
      void this.approvals.offer({
        id: input.requestId,
        sessionId: input.sessionId ?? input.runId,
        action: "handoff",
        capability: input.capability,
      })
    return this.view(record)
  }

  /** Every boundary, or - with `activeOnly` - just those still awaiting a decision. */
  list(activeOnly = false): readonly HandoffView[] {
    const views: HandoffView[] = []
    for (const record of this.records.values()) {
      if (activeOnly && this.isTerminal(record.state)) continue
      views.push(this.view(record))
    }
    return Object.freeze(views)
  }

  /** Inspect one boundary by request id, or `undefined` when unknown. */
  inspect(requestId: string): HandoffView | undefined {
    const record = this.records.get(requestId)
    return record === undefined ? undefined : this.view(record)
  }

  assign(decision: HandoffDecision): HandoffView {
    if (decision.by === undefined || !decision.by || decision.by.length > 128)
      throw new HandoffError("invalid_handoff")
    return this.drive("assign", decision, decision.by)
  }

  accept(decision: HandoffDecision): HandoffView {
    return this.drive("accept", decision)
  }

  decline(decision: HandoffDecision): HandoffView {
    return this.drive("decline", decision)
  }

  /** Resolve a boundary, resuming exactly the one matching paused node. */
  resolve(decision: HandoffDecision): HandoffView {
    return this.drive("resolve", decision)
  }

  expire(decision: HandoffDecision): HandoffView {
    return this.drive("expire", decision)
  }

  cancel(decision: HandoffDecision): HandoffView {
    return this.drive("cancel", decision)
  }

  private drive(
    op: "assign" | "accept" | "decline" | "resolve" | "expire" | "cancel",
    decision: HandoffDecision,
    assignee?: string,
  ): HandoffView {
    const record = this.records.get(decision.coordinate.requestId)
    if (record === undefined) throw new HandoffError("unknown_boundary")

    if (!coordinatesMatch(record.coordinate, decision.coordinate)) {
      throw new HandoffError(
        record.coordinate.vector !== decision.coordinate.vector
          ? "stale_vector"
          : "identity_mismatch",
      )
    }

    // Expiry is checked before the transition and, except for an explicit `expire`/`cancel`, is
    // terminal: a decision that arrives at or past the deadline expires the boundary closed and
    // resumes no work.
    if (op !== "expire" && op !== "cancel" && !coordinateIsFresh(record.coordinate, this.now())) {
      if (!this.isTerminal(record.state)) this.settle(record, "expired")
      throw new HandoffError("expired")
    }

    // An assigned boundary may only be acted on by its owner. A different actor is an authority
    // expansion, not a routine mismatch.
    if (
      record.to !== undefined &&
      (op === "accept" || op === "decline" || op === "resolve") &&
      decision.by !== record.to
    )
      throw new HandoffError("authority_expanded")

    const next = nextHandoffState(record.state, op)
    if (next === undefined) throw new HandoffError("illegal_transition")

    if (op === "assign") record.to = assignee
    record.state = next
    if (this.isTerminal(next)) this.settleApproval(record, op)
    return this.view(record)
  }

  private settle(record: HandoffRecord, state: HandoffLifecycleState): void {
    record.state = state
    this.settleApproval(record, "expire")
  }

  private settleApproval(record: HandoffRecord, op: string): void {
    if (!record.requireApproval || this.approvals === undefined) return
    this.approvals.resolve(record.coordinate.requestId, op === "accept" || op === "resolve")
  }

  private isTerminal(state: HandoffLifecycleState): boolean {
    return (
      state === "accepted" ||
      state === "declined" ||
      state === "resolved" ||
      state === "expired" ||
      state === "cancelled"
    )
  }

  private activeCount(): number {
    let count = 0
    for (const record of this.records.values()) if (!this.isTerminal(record.state)) count++
    return count
  }

  private view(record: HandoffRecord): HandoffView {
    return Object.freeze({
      requestId: record.coordinate.requestId,
      runId: record.coordinate.runId,
      nodeId: record.coordinate.nodeId,
      capability: record.coordinate.capability,
      vector: record.coordinate.vector,
      expiresAt: record.coordinate.expiresAt,
      state: record.state,
      from: record.from,
      ...(record.to === undefined ? {} : { to: record.to }),
    })
  }
}

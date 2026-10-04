import {
  type AgentApprovalRequiredEvent,
  type AgentApprovalResolvedEvent,
  coordinateIsFresh,
  coordinatesMatch,
  type DecisionCoordinate,
  nextApprovalState,
} from "@nifrajs/agent-protocol"

export interface ApprovalRequest {
  readonly id: string
  readonly sessionId: string
  readonly turnId?: string
  readonly action: string
  readonly capability: string
  readonly reason?: string
  /**
   * Optional decision-boundary coordinate. When present, {@link ApprovalManager.resolveMatched}
   * admits a decision only if it names this exact run, node, capability, request id, and vector, and
   * arrives before expiry. Coordinate-less approvals keep their original untyped {@link resolve} path.
   */
  readonly coordinate?: DecisionCoordinate
  readonly createdAt: number
  readonly expiresAt: number
}

/** Stable, content-free reasons a coordinate-matched resolution is refused. */
export type ApprovalMatchRejection =
  | "unknown_boundary"
  | "identity_mismatch"
  | "stale_vector"
  | "expired"
  | "illegal_transition"

export type ApprovalMatchResult =
  | { readonly ok: true; readonly decision: ApprovalDecision }
  | { readonly ok: false; readonly code: ApprovalMatchRejection }

export interface ApprovalDecision {
  readonly approvalId: string
  readonly approved: boolean
  readonly reason?: string
  readonly at: number
}

export interface ApprovalManagerOptions {
  readonly maxPending?: number
  readonly timeoutMs?: number
  readonly onRequired?: (request: ApprovalRequest) => void | PromiseLike<void>
  readonly onResolved?: (decision: ApprovalDecision) => void | PromiseLike<void>
}

interface PendingApproval {
  readonly request: ApprovalRequest
  /** Settles with the decision; it exists before `onRequired` runs, so no decision can miss it. */
  readonly decided: Promise<boolean>
  readonly settle: (approved: boolean) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/** The agent protocol's token alphabet, so every protocol-valid id is accepted here too. */
const ID_TOKEN = /^[A-Za-z0-9._:/-]{1,128}$/
const MAX_ACTION_LENGTH = 512

/**
 * Small approval broker shared by RPC, Workbench, and workflow extensions.
 *
 * Approval state is deliberately bounded and expires closed (denied) by default. It is a policy
 * seam, not a security boundary: filesystem/process isolation still belongs to the host or OS.
 */
export class ApprovalManager {
  private readonly options: Required<Pick<ApprovalManagerOptions, "maxPending" | "timeoutMs">> &
    ApprovalManagerOptions
  private readonly pendingApprovals = new Map<string, PendingApproval>()

  constructor(options: ApprovalManagerOptions = {}) {
    this.options = {
      ...options,
      maxPending: options.maxPending ?? 32,
      timeoutMs: options.timeoutMs ?? 5 * 60_000,
    }
    if (!Number.isSafeInteger(this.options.maxPending) || this.options.maxPending < 1)
      throw new RangeError("approvals: maxPending must be positive")
    if (
      !Number.isSafeInteger(this.options.timeoutMs) ||
      this.options.timeoutMs < 1 ||
      this.options.timeoutMs > 24 * 60 * 60_000
    )
      throw new RangeError("approvals: timeoutMs must be between 1ms and 24h")
  }

  get pending(): readonly ApprovalRequest[] {
    return Object.freeze([...this.pendingApprovals.values()].map(({ request }) => request))
  }

  /** Convert a streamed backend approval event into a resolvable pending request. */
  async observe(event: AgentApprovalRequiredEvent): Promise<ApprovalRequest | undefined> {
    const existing = this.pendingApprovals.get(event.approvalId)
    if (existing !== undefined) return existing.request
    const pending = await this.create({
      id: event.approvalId,
      sessionId: event.sessionId,
      turnId: event.turnId,
      // The protocol bounds text more loosely; a long label must not fail the backend's turn.
      action: event.action.slice(0, MAX_ACTION_LENGTH),
      capability: event.capability,
      ...(event.reason === undefined ? {} : { reason: event.reason }),
    })
    return pending?.request
  }

  /**
   * Publish a pending approval without waiting for its decision (useful for transports). Returns
   * `undefined` when the broker is full or an approval with the same id is still pending.
   */
  async offer(
    input: Omit<ApprovalRequest, "createdAt" | "expiresAt">,
  ): Promise<ApprovalRequest | undefined> {
    return (await this.create(input))?.request
  }

  /**
   * Create a host-owned approval that can be awaited by a workflow or extension. Resolves `false`
   * when the broker is full or an approval with the same id is still pending.
   */
  async request(input: Omit<ApprovalRequest, "createdAt" | "expiresAt">): Promise<boolean> {
    const pending = await this.create(input)
    return pending === undefined ? false : pending.decided
  }

  /**
   * Resolve an approval that was opened with a {@link DecisionCoordinate}, admitting the decision only
   * when it matches the live boundary and is still fresh. Every failure is content-free and fails
   * closed: an unknown id, a coordinate-less approval, a mismatched or superseded coordinate, or an
   * expired boundary resumes no work. This adds a typed path alongside the untyped {@link resolve}; it
   * never loosens it.
   */
  resolveMatched(
    coordinate: DecisionCoordinate,
    approved: boolean,
    now: number = Date.now(),
  ): ApprovalMatchResult {
    const pending = this.pendingApprovals.get(coordinate.requestId)
    if (pending === undefined) return { ok: false, code: "unknown_boundary" }
    const bound = pending.request.coordinate
    if (bound === undefined) return { ok: false, code: "identity_mismatch" }
    if (!coordinatesMatch(bound, coordinate))
      return {
        ok: false,
        code: bound.vector !== coordinate.vector ? "stale_vector" : "identity_mismatch",
      }
    if (!coordinateIsFresh(bound, now)) {
      this.settle(coordinate.requestId, false, "approval expired")
      return { ok: false, code: "expired" }
    }
    if (nextApprovalState("pending", approved ? "approve" : "deny") === undefined)
      return { ok: false, code: "illegal_transition" }
    const decision = this.settle(coordinate.requestId, approved)
    if (decision === undefined) return { ok: false, code: "unknown_boundary" }
    return { ok: true, decision }
  }

  /**
   * Settle a pending approval by id. An approval opened with a coordinate is approved only through
   * {@link resolveMatched}; this untyped path can still deny it, and returns `undefined` for an
   * approve.
   */
  resolve(approvalId: string, approved: boolean, reason?: string): ApprovalDecision | undefined {
    if (
      approved === true &&
      this.pendingApprovals.get(approvalId)?.request.coordinate !== undefined
    )
      return undefined
    return this.settle(approvalId, approved, reason)
  }

  close(): void {
    for (const approvalId of this.pendingApprovals.keys())
      this.settle(approvalId, false, "approval manager closed")
  }

  private settle(
    approvalId: string,
    approved: boolean,
    reason?: string,
  ): ApprovalDecision | undefined {
    const pending = this.pendingApprovals.get(approvalId)
    if (pending === undefined) return undefined
    clearTimeout(pending.timer)
    this.pendingApprovals.delete(approvalId)
    pending.settle(approved === true)
    const decision: ApprovalDecision = {
      approvalId,
      approved: approved === true,
      ...(reason === undefined ? {} : { reason: reason.slice(0, 512) }),
      at: Date.now(),
    }
    // A failing broadcast must not become an unhandled rejection in the host.
    Promise.resolve(this.options.onResolved?.(decision)).catch(() => {})
    return decision
  }

  private async create(
    input: Omit<ApprovalRequest, "createdAt" | "expiresAt">,
  ): Promise<PendingApproval | undefined> {
    if (this.pendingApprovals.size >= this.options.maxPending) return undefined
    if (!ID_TOKEN.test(input.id)) throw new TypeError("approvals: approval id is invalid")
    if (!ID_TOKEN.test(input.sessionId)) throw new TypeError("approvals: session id is invalid")
    if (!input.action || input.action.length > MAX_ACTION_LENGTH)
      throw new TypeError("approvals: action is empty or too long")
    if (!input.capability || input.capability.length > 128)
      throw new TypeError("approvals: capability is empty or too long")
    // Replacing a pending id would orphan the waiter of the request already holding it.
    if (this.pendingApprovals.has(input.id)) return undefined
    const createdAt = Date.now()
    const request: ApprovalRequest = Object.freeze({
      ...input,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      ...(input.reason === undefined ? {} : { reason: input.reason.slice(0, 512) }),
      ...(input.coordinate === undefined ? {} : { coordinate: input.coordinate }),
      createdAt,
      expiresAt: createdAt + this.options.timeoutMs,
    })
    let settle = (_approved: boolean): void => {}
    const decided = new Promise<boolean>((resolve) => {
      settle = resolve
    })
    const timer = setTimeout(() => {
      this.settle(request.id, false, "approval timed out")
    }, this.options.timeoutMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    const pending: PendingApproval = { request, decided, settle, timer }
    this.pendingApprovals.set(request.id, pending)
    await this.options.onRequired?.(request)
    return pending
  }
}

export function approvalRequestFromEvent(event: AgentApprovalRequiredEvent): ApprovalRequest {
  return Object.freeze({
    id: event.approvalId,
    sessionId: event.sessionId,
    turnId: event.turnId,
    action: event.action,
    capability: event.capability,
    ...(event.reason === undefined ? {} : { reason: event.reason }),
    createdAt: event.at,
    expiresAt: event.at + 5 * 60_000,
  })
}

export function approvalResolvedEvent(
  sessionId: string,
  seq: number,
  decision: ApprovalDecision,
  turnId?: string,
): AgentApprovalResolvedEvent {
  return Object.freeze({
    version: 1 as const,
    sessionId,
    seq,
    at: decision.at,
    type: "approval.resolved" as const,
    ...(turnId === undefined ? {} : { turnId }),
    approvalId: decision.approvalId,
    approved: decision.approved,
    ...(decision.reason === undefined ? {} : { reason: decision.reason }),
  })
}

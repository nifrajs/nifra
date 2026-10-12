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
  /**
   * Absolute epoch-ms after which the approval is denied as timed out. An approval opened with a
   * `"never"` timeout reports {@link APPROVAL_NEVER_EXPIRES_AT}, so `now < expiresAt` keeps treating
   * it as live.
   */
  readonly expiresAt: number
}

/**
 * How long an approval may wait: whole milliseconds from 1 ms to 24 h, or `"never"` for no timer. A
 * `"never"` approval still settles on an answer, a cancel, the end of its turn, and close.
 */
export type ApprovalTimeout = number | "never"

/**
 * The `expiresAt` of an approval that never times out: the largest epoch-ms a `Date` holds
 * (+275760-09-13). It survives JSON, unlike `Infinity`, and `new Date(expiresAt)` stays valid.
 */
export const APPROVAL_NEVER_EXPIRES_AT = 8_640_000_000_000_000

const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60_000
const MAX_APPROVAL_TIMEOUT_MS = 24 * 60 * 60_000

/** True for `"never"` or a whole number of milliseconds from 1 ms to 24 h. */
export function isApprovalTimeout(value: unknown): value is ApprovalTimeout {
  return (
    value === "never" ||
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 1 &&
      value <= MAX_APPROVAL_TIMEOUT_MS)
  )
}

function approvalExpiresAt(createdAt: number, timeoutMs: ApprovalTimeout): number {
  return timeoutMs === "never" ? APPROVAL_NEVER_EXPIRES_AT : createdAt + timeoutMs
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
  /**
   * How long an approval waits before it is denied as timed out (default 5 minutes, at most 24 h).
   * `"never"` removes the timer; `maxPending` still bounds how many approvals can wait.
   */
  readonly timeoutMs?: ApprovalTimeout
  readonly onRequired?: (request: ApprovalRequest) => void | PromiseLike<void>
  readonly onResolved?: (decision: ApprovalDecision) => void | PromiseLike<void>
}

interface PendingApproval {
  readonly request: ApprovalRequest
  /** Settles with the decision; it exists before `onRequired` runs, so no decision can miss it. */
  readonly decided: Promise<boolean>
  readonly settle: (approved: boolean) => void
  readonly timer: ReturnType<typeof setTimeout> | undefined
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
      timeoutMs: options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
    }
    if (!Number.isSafeInteger(this.options.maxPending) || this.options.maxPending < 1)
      throw new RangeError("approvals: maxPending must be positive")
    if (!isApprovalTimeout(this.options.timeoutMs))
      throw new RangeError('approvals: timeoutMs must be between 1ms and 24h, or "never"')
  }

  /** The configured timeout, for {@link approvalRequestFromEvent}. */
  get timeoutMs(): ApprovalTimeout {
    return this.options.timeoutMs
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
      expiresAt: approvalExpiresAt(createdAt, this.options.timeoutMs),
    })
    const { promise: decided, resolve: settle } = Promise.withResolvers<boolean>()
    const timeoutMs = this.options.timeoutMs
    let timer: ReturnType<typeof setTimeout> | undefined
    if (timeoutMs !== "never") {
      timer = setTimeout(() => {
        this.settle(request.id, false, "approval timed out")
      }, timeoutMs)
      ;(timer as unknown as { unref?: () => void }).unref?.()
    }
    const pending: PendingApproval = { request, decided, settle, timer }
    this.pendingApprovals.set(request.id, pending)
    await this.options.onRequired?.(request)
    return pending
  }
}

/**
 * Project a backend approval event into a request. Pass the broker's timeout
 * (`ApprovalManager.timeoutMs`) so `expiresAt` matches when it will actually be denied; the default
 * is the broker's default of 5 minutes.
 */
export function approvalRequestFromEvent(
  event: AgentApprovalRequiredEvent,
  timeoutMs: ApprovalTimeout = DEFAULT_APPROVAL_TIMEOUT_MS,
): ApprovalRequest {
  if (!isApprovalTimeout(timeoutMs))
    throw new RangeError('approvals: timeoutMs must be between 1ms and 24h, or "never"')
  return Object.freeze({
    id: event.approvalId,
    sessionId: event.sessionId,
    turnId: event.turnId,
    action: event.action,
    capability: event.capability,
    ...(event.reason === undefined ? {} : { reason: event.reason }),
    createdAt: event.at,
    expiresAt: approvalExpiresAt(event.at, timeoutMs),
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

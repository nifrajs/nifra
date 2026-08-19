import type {
  AgentApprovalRequiredEvent,
  AgentApprovalResolvedEvent,
} from "@nifrajs/agent-protocol"

export interface ApprovalRequest {
  readonly id: string
  readonly sessionId: string
  readonly turnId?: string
  readonly action: string
  readonly capability: string
  readonly reason?: string
  readonly createdAt: number
  readonly expiresAt: number
}

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
  readonly resolve: (approved: boolean) => void
  readonly timer: ReturnType<typeof setTimeout>
}

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
    if (this.pendingApprovals.has(event.approvalId))
      return this.pendingApprovals.get(event.approvalId)?.request
    return this.create({
      id: event.approvalId,
      sessionId: event.sessionId,
      turnId: event.turnId,
      action: event.action,
      capability: event.capability,
      ...(event.reason === undefined ? {} : { reason: event.reason }),
    })
  }

  /** Publish a pending approval without waiting for its decision (useful for transports). */
  async offer(
    input: Omit<ApprovalRequest, "createdAt" | "expiresAt">,
  ): Promise<ApprovalRequest | undefined> {
    return this.create(input)
  }

  /** Create a host-owned approval that can be awaited by a workflow or extension. */
  async request(input: Omit<ApprovalRequest, "createdAt" | "expiresAt">): Promise<boolean> {
    const request = await this.offer(input)
    if (request === undefined) return false
    const pending = this.pendingApprovals.get(request.id)
    if (pending === undefined) return false
    return new Promise<boolean>((resolve) => {
      // Replace the resolver only for this host-owned request; observed backend requests are
      // intentionally notification-only and are resolved through `resolve`.
      const current = this.pendingApprovals.get(request.id)
      if (current === undefined) return resolve(false)
      this.pendingApprovals.set(request.id, { ...current, resolve })
    })
  }

  resolve(approvalId: string, approved: boolean, reason?: string): ApprovalDecision | undefined {
    const pending = this.pendingApprovals.get(approvalId)
    if (pending === undefined) return undefined
    clearTimeout(pending.timer)
    this.pendingApprovals.delete(approvalId)
    pending.resolve(approved === true)
    const decision: ApprovalDecision = {
      approvalId,
      approved: approved === true,
      ...(reason === undefined ? {} : { reason: reason.slice(0, 512) }),
      at: Date.now(),
    }
    void this.options.onResolved?.(decision)
    return decision
  }

  close(): void {
    for (const approvalId of this.pendingApprovals.keys())
      this.resolve(approvalId, false, "approval manager closed")
  }

  private async create(
    input: Omit<ApprovalRequest, "createdAt" | "expiresAt">,
  ): Promise<ApprovalRequest | undefined> {
    if (this.pendingApprovals.size >= this.options.maxPending) return undefined
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.id))
      throw new TypeError("approvals: approval id is invalid")
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.sessionId))
      throw new TypeError("approvals: session id is invalid")
    if (!input.action || input.action.length > 512)
      throw new TypeError("approvals: action is empty or too long")
    if (!input.capability || input.capability.length > 128)
      throw new TypeError("approvals: capability is empty or too long")
    const createdAt = Date.now()
    const request: ApprovalRequest = Object.freeze({
      ...input,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      ...(input.reason === undefined ? {} : { reason: input.reason.slice(0, 512) }),
      createdAt,
      expiresAt: createdAt + this.options.timeoutMs,
    })
    let resolveApproval = (_approved: boolean): void => {}
    const timer = setTimeout(() => {
      this.resolve(request.id, false, "approval timed out")
    }, this.options.timeoutMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    const pending: PendingApproval = {
      request,
      resolve: (approved) => resolveApproval(approved),
      timer,
    }
    this.pendingApprovals.set(request.id, pending)
    await this.options.onRequired?.(request)
    // A backend-observed request is resolved through `resolve`; a host request swaps this closure
    // from the promise below before returning to the workflow.
    resolveApproval = (_approved: boolean): void => {}
    return request
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

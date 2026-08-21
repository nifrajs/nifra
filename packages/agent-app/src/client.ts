/**
 * The Agent App client: a presentation-safe façade over an agent host.
 *
 * It negotiates the feature set with the host on session creation, drives turns as an ordered,
 * deduplicated stream of content-free {@link AgentEventView}s, resumes a persisted log by cursor with
 * gap detection, and resolves approvals and handoffs. Everything it returns upward is a view model -
 * identifiers, statuses, counters, opaque references - so an untyped browser app built on this client
 * can never touch prompt text, tool payloads, model output, or filesystem paths. Host-specific surfaces
 * beyond the negotiated contract are reachable through the raw {@link AgentAppClient.command} escape
 * hatch, which still returns a bounded {@link CommandOutcome} and never leaks the caller credential.
 */

import {
  type AgentSessionSnapshot,
  negotiateFeatures,
  parseHandoffSnapshot,
  parseRunSnapshot,
} from "@nifrajs/agent-protocol"
import type { AgentTransport, CommandOutcome } from "./transport.ts"
import {
  type AgentEventView,
  type HandoffView,
  OrderedEventBuffer,
  type RunView,
  type SessionView,
  toEventView,
  toHandoffView,
  toRunView,
  toSessionView,
} from "./view-models.ts"

/** Interaction features the client knows how to drive. A host grants the subset it supports. */
export const AGENT_APP_FEATURES = [
  "approvals",
  "checkpoint",
  "fork",
  "handoff",
  "reload",
  "resume",
  "workflows",
] as const

export class AgentAppError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AgentAppError"
  }
}

export interface AgentAppClientOptions {
  /** Features the client will request at negotiation. Defaults to {@link AGENT_APP_FEATURES}. */
  readonly features?: readonly string[]
  /** Bound on out-of-order live events held before a gap is skipped. Forwarded to the event buffer. */
  readonly maxPending?: number
}

export interface CreateSessionInput {
  readonly cwd?: string
  readonly backend?: string
  readonly capabilities?: readonly string[]
  readonly sessionId?: string
}

export interface ResumeInput {
  /** Last delivered seq. Omit or pass `-1` to replay the whole retained window. */
  readonly cursor?: number
  readonly limit?: number
}

/** One persisted log record reduced to ordering and a type label - never its payload. */
export interface ReplayEntryView {
  readonly seq: number
  readonly at: number
  readonly type: string
}

export type ReplayResult =
  | {
      readonly status: "ok"
      readonly nextCursor: number
      readonly entries: readonly ReplayEntryView[]
      readonly session?: SessionView
    }
  | {
      readonly status: "resync_required"
      readonly reason: string
      readonly earliest: number
      readonly latest: number
    }

export interface PendingApprovalView {
  readonly approvalId: string
  readonly action: string
  readonly capability: string
  readonly turnId?: string
}

export interface ResolveHandoffInput {
  readonly runId: string
  readonly nodeId: string
  readonly accept: boolean
  readonly reason?: string
}

export class AgentAppClient {
  private readonly transport: AgentTransport
  private readonly requested: readonly string[]
  private readonly maxPending: number | undefined
  private currentSession: SessionView | undefined
  private granted = new Set<string>()

  constructor(transport: AgentTransport, options?: AgentAppClientOptions) {
    this.transport = transport
    this.requested = options?.features ?? AGENT_APP_FEATURES
    this.maxPending = options?.maxPending
  }

  /** The current session view, or `undefined` before {@link createSession}/{@link resume}. */
  get session(): SessionView | undefined {
    return this.currentSession
  }

  /** Features the host granted at negotiation. */
  get features(): readonly string[] {
    return [...this.granted]
  }

  supports(feature: string): boolean {
    return this.granted.has(feature)
  }

  requireFeature(feature: string): void {
    if (!this.granted.has(feature))
      throw new AgentAppError(`host did not grant the "${feature}" feature`)
  }

  /** Open a session and negotiate the feature set against the host's advertised capabilities. */
  async createSession(input: CreateSessionInput = {}): Promise<SessionView> {
    const outcome = await this.transport.command<unknown>({
      method: "session.create",
      params: input,
    })
    const snapshot = this.expectSnapshot(outcome, "session.create")
    this.adoptSnapshot(snapshot)
    return this.currentSession as SessionView
  }

  /**
   * Stream a turn as ordered, deduplicated view models. The underlying transport receives the host's
   * full event stream, but every value yielded here is content-free.
   */
  async *send(message: string, options?: { signal?: AbortSignal }): AsyncIterable<AgentEventView> {
    if (this.currentSession === undefined)
      throw new AgentAppError("createSession must be called before send")
    const buffer = new OrderedEventBuffer({
      from: this.currentSession.lastSeq,
      ...(this.maxPending === undefined ? {} : { maxPending: this.maxPending }),
    })
    const stream = this.transport.stream({
      method: "turn.send",
      params: { message },
      ...(options?.signal ? { signal: options.signal } : {}),
    })
    for await (const event of stream) {
      for (const view of buffer.offer(toEventView(event))) yield view
    }
  }

  /** Resume a persisted log by cursor. A cursor whose next record was evicted asks for a resync. */
  async resume(input: ResumeInput = {}): Promise<ReplayResult> {
    this.requireFeature("resume")
    const params: Record<string, number> = { cursor: input.cursor ?? -1 }
    if (input.limit !== undefined) params.limit = input.limit
    const outcome = await this.transport.command<unknown>({ method: "session.events", params })
    if (!outcome.ok) throw commandError("session.events", outcome)
    return this.decodeResume(outcome.value)
  }

  /** List approvals awaiting a decision, projected to their identifiers only. */
  async listApprovals(): Promise<readonly PendingApprovalView[]> {
    this.requireFeature("approvals")
    const outcome = await this.transport.command<unknown>({ method: "approval.list" })
    if (!outcome.ok) throw commandError("approval.list", outcome)
    const pending = isRecord(outcome.value) ? outcome.value.pending : undefined
    if (!Array.isArray(pending)) return []
    const views: PendingApprovalView[] = []
    for (const item of pending) {
      if (!isRecord(item)) continue
      const { approvalId, action, capability, turnId } = item
      if (
        typeof approvalId !== "string" ||
        typeof action !== "string" ||
        typeof capability !== "string"
      )
        continue
      views.push(
        Object.freeze({
          approvalId,
          action,
          capability,
          ...(typeof turnId === "string" ? { turnId } : {}),
        }),
      )
    }
    return views
  }

  /** Approve or decline a pending approval. Returns the host's recorded decision. */
  async resolveApproval(approvalId: string, approved: boolean, reason?: string): Promise<boolean> {
    this.requireFeature("approvals")
    const outcome = await this.transport.command<unknown>({
      method: "approval.resolve",
      params: { approvalId, approved, ...(reason === undefined ? {} : { reason }) },
    })
    if (!outcome.ok) throw commandError("approval.resolve", outcome)
    return isRecord(outcome.value) && outcome.value.approved === true
  }

  /** Accept or decline a handoff. Returns the resulting handoff view when the host reports one. */
  async resolveHandoff(input: ResolveHandoffInput): Promise<HandoffView | undefined> {
    this.requireFeature("handoff")
    const outcome = await this.transport.command<unknown>({
      method: "handoff.resolve",
      params: {
        runId: input.runId,
        nodeId: input.nodeId,
        accept: input.accept,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      },
    })
    if (!outcome.ok) throw commandError("handoff.resolve", outcome)
    if (!isRecord(outcome.value) || outcome.value.handoff === undefined) return undefined
    return toHandoffView(parseHandoffSnapshot(outcome.value.handoff))
  }

  /** Fetch a run snapshot by id, projected to a content-free {@link RunView}. */
  async runSnapshot(runId: string): Promise<RunView> {
    const outcome = await this.transport.command<unknown>({
      method: "run.snapshot",
      params: { runId },
    })
    if (!outcome.ok) throw commandError("run.snapshot", outcome)
    const value =
      isRecord(outcome.value) && outcome.value.snapshot !== undefined
        ? outcome.value.snapshot
        : outcome.value
    return toRunView(parseRunSnapshot(value))
  }

  /** Cancel the active turn / stop the session. */
  async cancel(reason?: string): Promise<void> {
    const outcome = await this.transport.command<unknown>({
      method: "session.stop",
      params: reason === undefined ? {} : { reason },
    })
    if (!outcome.ok) throw commandError("session.stop", outcome)
  }

  /**
   * Escape hatch for host-specific commands outside the negotiated contract. Returns a bounded
   * {@link CommandOutcome}; the caller is responsible for keeping whatever it renders content-free.
   */
  command<T = unknown>(
    method: string,
    params?: unknown,
    signal?: AbortSignal,
  ): Promise<CommandOutcome<T>> {
    return this.transport.command<T>({
      method,
      ...(params === undefined ? {} : { params }),
      ...(signal ? { signal } : {}),
    })
  }

  private adoptSnapshot(snapshot: AgentSessionSnapshot): void {
    this.currentSession = toSessionView(snapshot)
    this.granted = new Set(negotiateFeatures(snapshot.capabilities, this.requested).granted)
  }

  private expectSnapshot(outcome: CommandOutcome<unknown>, method: string): AgentSessionSnapshot {
    if (!outcome.ok) throw commandError(method, outcome)
    const value = outcome.value
    if (
      !isRecord(value) ||
      typeof value.id !== "string" ||
      typeof value.backend !== "string" ||
      typeof value.status !== "string" ||
      typeof value.createdAt !== "number" ||
      typeof value.updatedAt !== "number" ||
      typeof value.lastSeq !== "number" ||
      !Array.isArray(value.capabilities)
    )
      throw new AgentAppError(`${method} did not return a session snapshot`)
    return value as unknown as AgentSessionSnapshot
  }

  private decodeResume(value: unknown): ReplayResult {
    if (!isRecord(value)) throw new AgentAppError("session.events returned a non-object")
    const resume = isRecord(value.resume) ? value.resume : value
    const session =
      isRecord(value.snapshot) && typeof value.snapshot.id === "string"
        ? toSessionView(value.snapshot as unknown as AgentSessionSnapshot)
        : undefined
    if (resume.status === "resync_required") {
      return Object.freeze({
        status: "resync_required",
        reason: typeof resume.reason === "string" ? resume.reason : "stale_cursor",
        earliest: typeof resume.earliest === "number" ? resume.earliest : 0,
        latest: typeof resume.latest === "number" ? resume.latest : 0,
      })
    }
    const source = Array.isArray(resume.events)
      ? resume.events
      : Array.isArray(value.entries)
        ? value.entries
        : []
    const entries: ReplayEntryView[] = []
    for (const item of source) {
      if (!isRecord(item)) continue
      if (
        typeof item.seq !== "number" ||
        typeof item.at !== "number" ||
        typeof item.type !== "string"
      )
        continue
      entries.push(Object.freeze({ seq: item.seq, at: item.at, type: item.type }))
    }
    const tail = entries.at(-1)
    const nextCursor =
      typeof resume.nextCursor === "number"
        ? resume.nextCursor
        : typeof resume.cursor === "number"
          ? resume.cursor
          : (tail?.seq ?? -1)
    return Object.freeze({
      status: "ok",
      nextCursor,
      entries,
      ...(session === undefined ? {} : { session }),
    })
  }
}

function commandError(method: string, outcome: { status: number; error: string }): AgentAppError {
  return new AgentAppError(`${method} failed (${outcome.status}): ${outcome.error}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

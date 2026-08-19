/**
 * Backend-neutral protocol for local coding-agent hosts.
 *
 * This package deliberately has no runtime dependencies. A Pi adapter, a Nifra-native backend,
 * the CLI, and the Workbench can all implement or consume these contracts without pulling any
 * framework, model provider, or UI code into an application.
 */

export const AGENT_PROTOCOL_VERSION = 1 as const

export type AgentSessionStatus = "idle" | "running" | "waiting" | "completed" | "failed" | "stopped"

export type AgentEventType =
  | "session.started"
  | "session.updated"
  | "turn.started"
  | "assistant.delta"
  | "assistant.message"
  | "tool.started"
  | "tool.delta"
  | "tool.completed"
  | "approval.required"
  | "approval.resolved"
  | "repair.required"
  | "verification.completed"
  | "memory.compacted"
  | "extension.reloaded"
  | "session.completed"
  | "session.failed"
  | "session.stopped"

export interface AgentSessionSnapshot {
  readonly version: typeof AGENT_PROTOCOL_VERSION
  readonly id: string
  readonly backend: string
  readonly cwd: string
  readonly status: AgentSessionStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastSeq: number
  readonly activeTurnId?: string
  readonly extensionRevision?: string
  readonly capabilities: readonly string[]
}

export interface AgentBackendInfo {
  readonly name: string
  readonly version?: string
  readonly capabilities: readonly string[]
}

export interface AgentSessionEventBase {
  readonly version: typeof AGENT_PROTOCOL_VERSION
  readonly sessionId: string
  readonly seq: number
  readonly at: number
  readonly type: AgentEventType
}

export interface AgentSessionStartedEvent extends AgentSessionEventBase {
  readonly type: "session.started"
  readonly snapshot: AgentSessionSnapshot
}

export interface AgentSessionUpdatedEvent extends AgentSessionEventBase {
  readonly type: "session.updated"
  readonly snapshot: AgentSessionSnapshot
}

export interface AgentTurnStartedEvent extends AgentSessionEventBase {
  readonly type: "turn.started"
  readonly turnId: string
  readonly prompt: string
}

export interface AgentAssistantDeltaEvent extends AgentSessionEventBase {
  readonly type: "assistant.delta"
  readonly turnId: string
  readonly text: string
}

export interface AgentAssistantMessageEvent extends AgentSessionEventBase {
  readonly type: "assistant.message"
  readonly turnId: string
  readonly text: string
}

export interface AgentToolStartedEvent extends AgentSessionEventBase {
  readonly type: "tool.started"
  readonly turnId: string
  readonly callId: string
  readonly name: string
  readonly input?: unknown
}

export interface AgentToolDeltaEvent extends AgentSessionEventBase {
  readonly type: "tool.delta"
  readonly turnId: string
  readonly callId: string
  readonly text: string
}

export interface AgentToolCompletedEvent extends AgentSessionEventBase {
  readonly type: "tool.completed"
  readonly turnId: string
  readonly callId: string
  readonly name: string
  readonly ok: boolean
  readonly output?: unknown
  readonly error?: AgentError
}

export interface AgentApprovalRequiredEvent extends AgentSessionEventBase {
  readonly type: "approval.required"
  readonly turnId: string
  readonly approvalId: string
  readonly action: string
  readonly capability: string
  readonly reason?: string
}

export interface AgentApprovalResolvedEvent extends AgentSessionEventBase {
  readonly type: "approval.resolved"
  readonly turnId?: string
  readonly approvalId: string
  readonly approved: boolean
  readonly reason?: string
}

export interface AgentRepairTask {
  readonly id: string
  readonly verification: "check" | "assure" | "test"
  readonly cwd: string
  readonly reason: string
  readonly capabilities: readonly string[]
  readonly output?: string
  readonly report?: unknown
}

export interface AgentRepairRequiredEvent extends AgentSessionEventBase {
  readonly type: "repair.required"
  readonly turnId?: string
  readonly task: AgentRepairTask
}

export interface AgentVerificationCompletedEvent extends AgentSessionEventBase {
  readonly type: "verification.completed"
  readonly name: string
  readonly ok: boolean
  readonly report?: unknown
}

export interface AgentMemoryCompactedEvent extends AgentSessionEventBase {
  readonly type: "memory.compacted"
  readonly before: number
  readonly after: number
  readonly reason: "manual" | "threshold" | "overflow" | "workflow"
}

export interface AgentExtensionReloadedEvent extends AgentSessionEventBase {
  readonly type: "extension.reloaded"
  readonly revision: string
  readonly loaded: readonly string[]
  readonly disabled: readonly string[]
  readonly rolledBack: boolean
}

export interface AgentSessionCompletedEvent extends AgentSessionEventBase {
  readonly type: "session.completed"
  readonly snapshot: AgentSessionSnapshot
}

export interface AgentSessionFailedEvent extends AgentSessionEventBase {
  readonly type: "session.failed"
  readonly error: AgentError
  readonly recoverable: boolean
}

export interface AgentSessionStoppedEvent extends AgentSessionEventBase {
  readonly type: "session.stopped"
  readonly reason?: string
}

export type AgentEvent =
  | AgentSessionStartedEvent
  | AgentSessionUpdatedEvent
  | AgentTurnStartedEvent
  | AgentAssistantDeltaEvent
  | AgentAssistantMessageEvent
  | AgentToolStartedEvent
  | AgentToolDeltaEvent
  | AgentToolCompletedEvent
  | AgentApprovalRequiredEvent
  | AgentApprovalResolvedEvent
  | AgentRepairRequiredEvent
  | AgentVerificationCompletedEvent
  | AgentMemoryCompactedEvent
  | AgentExtensionReloadedEvent
  | AgentSessionCompletedEvent
  | AgentSessionFailedEvent
  | AgentSessionStoppedEvent

/** Event payload before the transport adds protocol version, session id, sequence, and timestamp. */
export type AgentEventPayload =
  | Omit<AgentSessionStartedEvent, "version" | "sessionId" | "seq" | "at">
  | Omit<AgentSessionUpdatedEvent, "version" | "sessionId" | "seq" | "at">
  | Omit<AgentTurnStartedEvent, "version" | "sessionId" | "seq" | "at">
  | Omit<AgentAssistantDeltaEvent, "version" | "sessionId" | "seq" | "at">
  | Omit<AgentAssistantMessageEvent, "version" | "sessionId" | "seq" | "at">
  | Omit<AgentToolStartedEvent, "version" | "sessionId" | "seq" | "at">
  | Omit<AgentToolDeltaEvent, "version" | "sessionId" | "seq" | "at">
  | Omit<AgentToolCompletedEvent, "version" | "sessionId" | "seq" | "at">
  | Omit<AgentApprovalRequiredEvent, "version" | "sessionId" | "seq" | "at">
  | Omit<AgentApprovalResolvedEvent, "version" | "sessionId" | "seq" | "at">
  | Omit<AgentRepairRequiredEvent, "version" | "sessionId" | "seq" | "at">
  | Omit<AgentVerificationCompletedEvent, "version" | "sessionId" | "seq" | "at">
  | Omit<AgentMemoryCompactedEvent, "version" | "sessionId" | "seq" | "at">
  | Omit<AgentExtensionReloadedEvent, "version" | "sessionId" | "seq" | "at">
  | Omit<AgentSessionCompletedEvent, "version" | "sessionId" | "seq" | "at">
  | Omit<AgentSessionFailedEvent, "version" | "sessionId" | "seq" | "at">
  | Omit<AgentSessionStoppedEvent, "version" | "sessionId" | "seq" | "at">

export interface AgentError {
  readonly code: string
  readonly message: string
  readonly details?: unknown
}

export interface CreateSessionInput {
  readonly cwd: string
  readonly backend?: string
  readonly capabilities?: readonly string[]
  readonly sessionId?: string
}

export interface SendMessageInput {
  readonly sessionId: string
  readonly message: string
  readonly signal?: AbortSignal
}

export interface ForkSessionInput {
  readonly sessionId: string
  readonly targetSessionId?: string
}

export interface ForkSessionResult {
  readonly sessionId: string
  readonly parentSessionId: string
}

export interface AgentSessionCheckpoint {
  readonly version: 1
  readonly sessionId: string
  readonly at: number
  readonly payload?: unknown
}

export interface ReloadResult {
  readonly revision: string
  readonly loaded: readonly string[]
  readonly disabled: readonly string[]
  readonly rolledBack: boolean
  readonly error?: AgentError
}

export interface AgentBackend {
  readonly info: AgentBackendInfo
  createSession(input: CreateSessionInput): Promise<AgentSessionSnapshot>
  send(input: SendMessageInput): AsyncIterable<AgentEvent>
  cancel(sessionId: string, reason?: string): Promise<void>
  snapshot(sessionId: string): Promise<AgentSessionSnapshot>
  /** Backends may provide native branching; the host can fall back to its session store. */
  fork?(input: ForkSessionInput): Promise<ForkSessionResult>
  checkpoint?(sessionId: string, payload?: unknown): Promise<AgentSessionCheckpoint>
  reload(sessionId: string): Promise<ReloadResult>
  /** Resolve an approval surfaced by a backend UI/tool, when that backend supports interactive approvals. */
  resolveApproval?(
    sessionId: string,
    approvalId: string,
    approved: boolean,
    reason?: string,
  ): Promise<boolean | undefined>
  close(sessionId: string): Promise<void>
}

export interface AgentEventSink {
  push(event: AgentEvent): void
  complete(): void
  fail(error: unknown): void
}

export interface AgentEventStream extends AgentEventSink, AsyncIterableIterator<AgentEvent> {
  readonly dropped: number
}

/**
 * Small bounded event stream for RPC clients and UIs. The authoritative event history belongs to
 * the backend/session store; this live view may drop old transient events if a consumer falls behind.
 */
export function createAgentEventStream(maxQueueSize = 256): AgentEventStream {
  if (!Number.isSafeInteger(maxQueueSize) || maxQueueSize < 1)
    throw new RangeError("agent event stream: maxQueueSize must be a positive safe integer")

  const queue: AgentEvent[] = []
  const waiters: Array<{
    readonly resolve: (result: IteratorResult<AgentEvent>) => void
    readonly reject: (reason?: unknown) => void
  }> = []
  let completed = false
  let failure: unknown
  let failed = false
  let dropped = 0

  const finish = (): void => {
    if (!completed || queue.length > 0) return
    while (waiters.length > 0) {
      const waiter = waiters.shift()
      if (failed) waiter?.reject(failure)
      else waiter?.resolve({ done: true, value: undefined })
    }
  }

  const stream: AgentEventStream = {
    get dropped() {
      return dropped
    },
    push(event) {
      if (completed) return
      const waiter = waiters.shift()
      if (waiter !== undefined) {
        waiter.resolve({ done: false, value: event })
        return
      }
      if (queue.length >= maxQueueSize) {
        queue.shift()
        dropped += 1
      }
      queue.push(event)
    },
    complete() {
      completed = true
      finish()
    },
    fail(error) {
      if (completed) return
      failure = error
      failed = true
      completed = true
      finish()
    },
    next() {
      const event = queue.shift()
      if (event !== undefined) return Promise.resolve({ done: false, value: event })
      if (completed) {
        if (failed) return Promise.reject(failure)
        return Promise.resolve({ done: true, value: undefined })
      }
      return new Promise<IteratorResult<AgentEvent>>((resolve, reject) =>
        waiters.push({ resolve, reject }),
      )
    },
    return() {
      queue.length = 0
      completed = true
      finish()
      return Promise.resolve({ done: true, value: undefined })
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }
  return stream
}

export function agentError(code: string, message: string, details?: unknown): AgentError {
  return details === undefined ? { code, message } : { code, message, details }
}

export function isAgentEvent(value: unknown): value is AgentEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    record.version === AGENT_PROTOCOL_VERSION &&
    typeof record.sessionId === "string" &&
    typeof record.seq === "number" &&
    Number.isSafeInteger(record.seq) &&
    typeof record.at === "number" &&
    Number.isFinite(record.at) &&
    typeof record.type === "string" &&
    record.type.includes(".")
  )
}

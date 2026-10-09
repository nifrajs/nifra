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
  | "reasoning.delta"
  | "plan.updated"
  | "context.usage"
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
  | AgentExtensionEventType

/**
 * The type of an event the protocol does not define: `x-<vendor>.<name>`, lowercase, at most 64
 * characters, such as `x-codex.plan` or `x-acme.context.usage`. See {@link isAgentExtensionEventType}.
 */
export type AgentExtensionEventType = `x-${string}`

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

/** A piece of the model's reasoning. `itemId` groups the pieces of one reasoning block. */
export interface AgentReasoningDeltaEvent extends AgentSessionEventBase {
  readonly type: "reasoning.delta"
  readonly turnId: string
  readonly itemId?: string
  readonly text: string
}

export type AgentPlanEntryStatus = "pending" | "in_progress" | "completed"

export interface AgentPlanEntry {
  readonly content: string
  readonly status: AgentPlanEntryStatus
  readonly priority?: "high" | "medium" | "low"
}

/** The agent's whole current plan: each event replaces the one before. */
export interface AgentPlanUpdatedEvent extends AgentSessionEventBase {
  readonly type: "plan.updated"
  readonly turnId: string
  /** The tool call that carried the plan, when a tool did. */
  readonly callId?: string
  readonly explanation?: string
  readonly entries: readonly AgentPlanEntry[]
}

/** How full the model's context is after its latest request. Token counts only. */
export interface AgentContextUsageEvent extends AgentSessionEventBase {
  readonly type: "context.usage"
  readonly turnId?: string
  /** Tokens the latest request used: its prompt plus its answer. */
  readonly usedTokens: number
  /** The model's context window, when known. */
  readonly windowTokens?: number
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cachedInputTokens?: number
  readonly reasoningTokens?: number
  /** True when the provider reported no usage and the counts are an estimate. */
  readonly estimated?: boolean
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

/**
 * A backend's own event, such as a vendor's plan or reasoning frames. Hosts that do not know the
 * type pass it through; `data` is a display copy inside the payload bounds, like a tool's output.
 */
export interface AgentExtensionEvent extends AgentSessionEventBase {
  readonly type: AgentExtensionEventType
  readonly turnId?: string
  readonly data?: unknown
}

export type AgentEvent =
  | AgentSessionStartedEvent
  | AgentSessionUpdatedEvent
  | AgentTurnStartedEvent
  | AgentAssistantDeltaEvent
  | AgentAssistantMessageEvent
  | AgentReasoningDeltaEvent
  | AgentPlanUpdatedEvent
  | AgentContextUsageEvent
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
  | AgentExtensionEvent

/** Event payload before the transport adds protocol version, session id, sequence, and timestamp. */
export type AgentEventPayload =
  | Omit<AgentSessionStartedEvent, "version" | "sessionId" | "seq" | "at">
  | Omit<AgentSessionUpdatedEvent, "version" | "sessionId" | "seq" | "at">
  | Omit<AgentTurnStartedEvent, "version" | "sessionId" | "seq" | "at">
  | Omit<AgentAssistantDeltaEvent, "version" | "sessionId" | "seq" | "at">
  | Omit<AgentAssistantMessageEvent, "version" | "sessionId" | "seq" | "at">
  | Omit<AgentReasoningDeltaEvent, "version" | "sessionId" | "seq" | "at">
  | Omit<AgentPlanUpdatedEvent, "version" | "sessionId" | "seq" | "at">
  | Omit<AgentContextUsageEvent, "version" | "sessionId" | "seq" | "at">
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
  | Omit<AgentExtensionEvent, "version" | "sessionId" | "seq" | "at">

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
  /**
   * Resolve an approval surfaced by a backend UI/tool, when that backend supports interactive
   * approvals. Returns a boolean once the backend has taken the answer, or `undefined` when it does not
   * know the approval (never asked, already settled, or its turn ended).
   */
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

const MAX_AGENT_EVENT_QUEUE_SIZE = 65_536

/**
 * Small bounded event stream for RPC clients and UIs. The authoritative event history belongs to
 * the backend/session store; this live view may drop old transient events if a consumer falls behind.
 */
export function createAgentEventStream(maxQueueSize = 256): AgentEventStream {
  if (
    !Number.isSafeInteger(maxQueueSize) ||
    maxQueueSize < 1 ||
    maxQueueSize > MAX_AGENT_EVENT_QUEUE_SIZE
  )
    throw new RangeError(
      `agent event stream: maxQueueSize must be between 1 and ${MAX_AGENT_EVENT_QUEUE_SIZE}`,
    )

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

/**
 * Orchestration value contracts (run plans, content-free evidence, artifact refs, effect keys).
 * Additive to the session protocol; carries no behavior and no payload content.
 */
export * from "./orchestration.ts"

/**
 * Additive run-lifecycle contracts (run snapshots, evidence-event envelopes, handoff snapshots,
 * feature negotiation, cursor resume). Additive to the session protocol; carries no payload content.
 */
export * from "./run-lifecycle.ts"

/** Shared fail-closed byte-limit policy used by independent HTTP adapters. */
export * from "./transport-policy.ts"

const AGENT_TOKEN_RE = /^[A-Za-z0-9._:/-]{1,128}$/
const AGENT_EXTENSION_TYPE_RE = /^x-[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:[._-][a-z0-9]+)*$/
const AGENT_MAX_EXTENSION_TYPE = 64
const AGENT_MAX_TEXT = 256 * 1024
const AGENT_MAX_PAYLOAD_TEXT = 64 * 1024
const AGENT_MAX_ARRAY = 256
const AGENT_MAX_OBJECT_KEYS = 256
const AGENT_MAX_PAYLOAD_DEPTH = 6
const AGENT_STATUSES: ReadonlySet<string> = new Set([
  "idle",
  "running",
  "waiting",
  "completed",
  "failed",
  "stopped",
])
const AGENT_PLAN_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"])
const AGENT_PLAN_PRIORITIES: ReadonlySet<string> = new Set(["high", "medium", "low"])
const AGENT_MAX_PLAN_ENTRY = 4_096
const AGENT_COMPACTION_REASONS: ReadonlySet<string> = new Set([
  "manual",
  "threshold",
  "overflow",
  "workflow",
])

/** Longest `text`, `prompt`, or error message an event may carry, in UTF-16 code units. */
export const AGENT_MAX_EVENT_TEXT = AGENT_MAX_TEXT
/** Longest string an event's `input`, `output`, or `details` value may carry. */
export const AGENT_MAX_PAYLOAD_STRING = AGENT_MAX_PAYLOAD_TEXT

const AGENT_TRUNCATED = "…[truncated]"
const AGENT_REPLACEMENT = String.fromCodePoint(0xfffd)
// Soft budget for the strings of one bounded value, so a display copy stays near one text field.
const AGENT_MAX_VALUE_CHARS = AGENT_MAX_TEXT

/**
 * Split text into pieces that each fit an event's text field, so a long reply travels as
 * consecutive events instead of failing validation. Joined, the pieces give back the text with
 * each NUL replaced by U+FFFD. A piece ends after a line break when one falls in its last
 * quarter, and never between the halves of a surrogate pair. Empty text gives one empty piece.
 */
export function splitAgentText(text: string, maxChars: number = AGENT_MAX_TEXT): string[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 2 || maxChars > AGENT_MAX_TEXT)
    throw new RangeError(`splitAgentText: maxChars must be between 2 and ${AGENT_MAX_TEXT}`)
  const clean = text.replaceAll("\0", AGENT_REPLACEMENT)
  if (clean.length <= maxChars) return [clean]
  const pieces: string[] = []
  let start = 0
  while (clean.length - start > maxChars) {
    let end = start + maxChars
    const searchFrom = start + Math.floor((maxChars * 3) / 4)
    const lineEnd = clean.slice(searchFrom, end).lastIndexOf("\n")
    if (lineEnd !== -1) end = searchFrom + lineEnd + 1
    else if (isHighSurrogate(clean.charCodeAt(end - 1)) && isLowSurrogate(clean.charCodeAt(end)))
      end -= 1
    pieces.push(clean.slice(start, end))
    start = end
  }
  pieces.push(clean.slice(start))
  return pieces
}

/**
 * Bound text for one event field: NUL becomes U+FFFD and text past `maxChars` is cut, ending
 * in a truncation marker, never between the halves of a surrogate pair.
 */
export function boundAgentText(text: string, maxChars: number = AGENT_MAX_TEXT): string {
  if (
    !Number.isSafeInteger(maxChars) ||
    maxChars < AGENT_TRUNCATED.length ||
    maxChars > AGENT_MAX_TEXT
  )
    throw new RangeError(
      `boundAgentText: maxChars must be between ${AGENT_TRUNCATED.length} and ${AGENT_MAX_TEXT}`,
    )
  const clean = text.replaceAll("\0", AGENT_REPLACEMENT)
  return clean.length <= maxChars ? clean : truncateAgentText(clean, maxChars)
}

/**
 * A copy of a JSON-like value that fits an event's `input`, `output`, or `details`, for display
 * only: the tool, model, or store keeps the full value. Strings are cut with a truncation marker
 * (and their NULs replaced); arrays keep their first items and end with a marker string; objects
 * keep their first keys and drop entries whose key the protocol refuses; a container too deep
 * becomes a marker string; numbers past the safe-integer range become strings, non-finite ones
 * null; functions, symbols, bigints, and `undefined` are dropped (null inside an array). Returns
 * `undefined` when the value itself is one of those.
 */
export function boundAgentValue(value: unknown): unknown {
  const copy = copyBoundedAgentValue(value, 0, { nodes: 2_048, chars: AGENT_MAX_VALUE_CHARS })
  return copy === AGENT_OMIT ? undefined : copy
}

interface AgentValueBudget {
  nodes: number
  chars: number
}

const AGENT_OMIT: unique symbol = Symbol("omit")

function copyBoundedAgentValue(
  value: unknown,
  depth: number,
  budget: AgentValueBudget,
): unknown | typeof AGENT_OMIT {
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  )
    return AGENT_OMIT
  if (budget.nodes <= 0) return AGENT_OMIT
  budget.nodes -= 1
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null
    return Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : String(value)
  }
  if (typeof value === "string") {
    const clean = value.replaceAll("\0", AGENT_REPLACEMENT)
    const limit = Math.max(AGENT_TRUNCATED.length, Math.min(AGENT_MAX_PAYLOAD_TEXT, budget.chars))
    const bounded = clean.length <= limit ? clean : truncateAgentText(clean, limit)
    budget.chars = Math.max(0, budget.chars - bounded.length)
    return bounded
  }
  if (typeof value !== "object") return AGENT_OMIT
  if (Array.isArray(value)) {
    if (depth >= AGENT_MAX_PAYLOAD_DEPTH) return value.length === 0 ? [] : AGENT_TRUNCATED
    const copy: unknown[] = []
    for (const [index, item] of value.entries()) {
      if (copy.length === AGENT_MAX_ARRAY - 1 && value.length > AGENT_MAX_ARRAY) {
        const marker = copyBoundedAgentValue(
          `…[${value.length - index} more items]`,
          depth + 1,
          budget,
        )
        if (marker !== AGENT_OMIT) copy.push(marker)
        break
      }
      // An item JSON has no form for stands as null, which costs a node like any other.
      const child = copyBoundedAgentValue(item, depth + 1, budget)
      const kept = child === AGENT_OMIT ? copyBoundedAgentValue(null, depth + 1, budget) : child
      if (kept === AGENT_OMIT) break
      copy.push(kept)
    }
    return copy
  }
  const entries = Object.entries(value)
  if (depth >= AGENT_MAX_PAYLOAD_DEPTH) return entries.length === 0 ? {} : AGENT_TRUNCATED
  const copy: Record<string, unknown> = {}
  let keys = 0
  for (const [key, item] of entries) {
    if (keys === AGENT_MAX_OBJECT_KEYS || budget.nodes <= 0) break
    if (!agentText(key, 128, false)) continue
    const child = copyBoundedAgentValue(item, depth + 1, budget)
    if (child === AGENT_OMIT) continue
    // A "__proto__" key from parsed JSON must stay an own entry, not replace the prototype.
    Object.defineProperty(copy, key, {
      value: child,
      enumerable: true,
      writable: true,
      configurable: true,
    })
    keys += 1
  }
  return copy
}

function truncateAgentText(text: string, maxChars: number): string {
  let end = Math.max(0, maxChars - AGENT_TRUNCATED.length)
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1
  return `${text.slice(0, end)}${AGENT_TRUNCATED}`
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

function agentRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function agentToken(value: unknown): value is string {
  return typeof value === "string" && AGENT_TOKEN_RE.test(value)
}

function agentText(value: unknown, max = AGENT_MAX_TEXT, allowEmpty = true): value is string {
  return (
    typeof value === "string" &&
    value.length <= max &&
    (allowEmpty || value.length > 0) &&
    !value.includes("\0")
  )
}

function agentCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function boundedAgentValue(
  value: unknown,
  depth = 0,
  state: { remaining: number } = { remaining: 2_048 },
): boolean {
  if (state.remaining-- <= 0 || depth > AGENT_MAX_PAYLOAD_DEPTH) return false
  if (value === null || typeof value === "boolean") return true
  if (typeof value === "string") return agentText(value, AGENT_MAX_PAYLOAD_TEXT)
  if (typeof value === "number")
    return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER
  if (Array.isArray(value))
    return (
      value.length <= AGENT_MAX_ARRAY &&
      value.every((item) => boundedAgentValue(item, depth + 1, state))
    )
  if (!agentRecord(value) || Object.keys(value).length > AGENT_MAX_OBJECT_KEYS) return false
  return Object.entries(value).every(
    ([key, child]) => agentText(key, 128, false) && boundedAgentValue(child, depth + 1, state),
  )
}

type AgentProblem = string | undefined

function tokenProblem(value: unknown, field: string): AgentProblem {
  return agentToken(value) ? undefined : `${field} must be 1-128 characters of [A-Za-z0-9._:/-]`
}

function optionalTokenProblem(value: unknown, field: string): AgentProblem {
  return value === undefined ? undefined : tokenProblem(value, field)
}

function textProblem(
  value: unknown,
  field: string,
  max = AGENT_MAX_TEXT,
  allowEmpty = true,
): AgentProblem {
  if (typeof value !== "string") return `${field} must be a string`
  if (value.length > max) return `${field} is longer than ${max} characters`
  if (!allowEmpty && value.length === 0) return `${field} must not be empty`
  return value.includes("\0") ? `${field} contains NUL` : undefined
}

function optionalTextProblem(value: unknown, field: string): AgentProblem {
  return value === undefined ? undefined : textProblem(value, field)
}

function countProblem(value: unknown, field: string): AgentProblem {
  return agentCount(value) ? undefined : `${field} must be a non-negative safe integer`
}

function booleanProblem(value: unknown, field: string): AgentProblem {
  return typeof value === "boolean" ? undefined : `${field} must be a boolean`
}

function tokenListProblem(value: unknown, field: string): AgentProblem {
  if (!Array.isArray(value) || value.length > AGENT_MAX_ARRAY)
    return `${field} must be an array of at most ${AGENT_MAX_ARRAY} tokens`
  return value.every(agentToken) ? undefined : `${field} must hold only tokens`
}

function valueProblem(record: Record<string, unknown>, key: string, field: string): AgentProblem {
  return !Object.hasOwn(record, key) || boundedAgentValue(record[key])
    ? undefined
    : `${field} is outside the payload bounds (strings ${AGENT_MAX_PAYLOAD_TEXT} characters, ${AGENT_MAX_ARRAY} items or keys, depth ${AGENT_MAX_PAYLOAD_DEPTH})`
}

function optionalCountProblem(value: unknown, field: string): AgentProblem {
  return value === undefined ? undefined : countProblem(value, field)
}

function planEntriesProblem(value: unknown, field: string): AgentProblem {
  if (!Array.isArray(value) || value.length > AGENT_MAX_ARRAY)
    return `${field} must be an array of at most ${AGENT_MAX_ARRAY} entries`
  for (const [index, entry] of value.entries()) {
    const at = `${field}[${index}]`
    if (!agentRecord(entry)) return `${at} must be an object`
    const problem =
      textProblem(entry.content, `${at}.content`, AGENT_MAX_PLAN_ENTRY) ??
      (typeof entry.status === "string" && AGENT_PLAN_STATUSES.has(entry.status)
        ? undefined
        : `${at}.status must be one of ${[...AGENT_PLAN_STATUSES].join(", ")}`) ??
      (entry.priority === undefined ||
      (typeof entry.priority === "string" && AGENT_PLAN_PRIORITIES.has(entry.priority))
        ? undefined
        : `${at}.priority must be one of ${[...AGENT_PLAN_PRIORITIES].join(", ")}`)
    if (problem !== undefined) return problem
  }
  return undefined
}

function errorProblem(value: unknown, field: string): AgentProblem {
  if (!agentRecord(value)) return `${field} must be an object`
  return (
    tokenProblem(value.code, `${field}.code`) ??
    textProblem(value.message, `${field}.message`, AGENT_MAX_TEXT, false) ??
    valueProblem(value, "details", `${field}.details`)
  )
}

function snapshotProblem(value: unknown, sessionId: unknown, field: string): AgentProblem {
  if (!agentRecord(value)) return `${field} must be an object`
  if (value.version !== AGENT_PROTOCOL_VERSION)
    return `${field}.version must be ${AGENT_PROTOCOL_VERSION}`
  if (value.id !== sessionId) return `${field}.id must be the event's sessionId`
  return (
    tokenProblem(value.backend, `${field}.backend`) ??
    textProblem(value.cwd, `${field}.cwd`, 4_096, false) ??
    (typeof value.status === "string" && AGENT_STATUSES.has(value.status)
      ? undefined
      : `${field}.status must be one of ${[...AGENT_STATUSES].join(", ")}`) ??
    countProblem(value.createdAt, `${field}.createdAt`) ??
    countProblem(value.updatedAt, `${field}.updatedAt`) ??
    countProblem(value.lastSeq, `${field}.lastSeq`) ??
    tokenListProblem(value.capabilities, `${field}.capabilities`) ??
    optionalTokenProblem(value.activeTurnId, `${field}.activeTurnId`) ??
    optionalTokenProblem(value.extensionRevision, `${field}.extensionRevision`)
  )
}

function repairTaskProblem(value: unknown, field: string): AgentProblem {
  if (!agentRecord(value)) return `${field} must be an object`
  return (
    tokenProblem(value.id, `${field}.id`) ??
    (value.verification === "check" ||
    value.verification === "assure" ||
    value.verification === "test"
      ? undefined
      : `${field}.verification must be check, assure, or test`) ??
    textProblem(value.cwd, `${field}.cwd`, 4_096, false) ??
    textProblem(value.reason, `${field}.reason`, AGENT_MAX_TEXT, false) ??
    tokenListProblem(value.capabilities, `${field}.capabilities`) ??
    optionalTextProblem(value.output, `${field}.output`) ??
    valueProblem(value, "report", `${field}.report`)
  )
}

/**
 * Whether `type` names an extension event: `x-<vendor>.<name>` in lowercase letters, digits, and
 * single `-`, `.`, or `_` separators, at most 64 characters.
 */
export function isAgentExtensionEventType(type: unknown): type is AgentExtensionEventType {
  return (
    typeof type === "string" &&
    type.length <= AGENT_MAX_EXTENSION_TYPE &&
    AGENT_EXTENSION_TYPE_RE.test(type)
  )
}

/** Validate the complete discriminated event union before a projection or UI consumer sees it. */
export function isAgentEvent(value: unknown): value is AgentEvent {
  return agentEventProblem(value) === undefined
}

/**
 * Why `value` is not a valid agent event, naming the field and the limit it broke but never its
 * content, so the text is safe to log or show; `undefined` when it is valid.
 */
export function agentEventProblem(value: unknown): string | undefined {
  if (!agentRecord(value)) return "event must be an object"
  if (value.version !== AGENT_PROTOCOL_VERSION) return `version must be ${AGENT_PROTOCOL_VERSION}`
  const base =
    tokenProblem(value.sessionId, "sessionId") ??
    countProblem(value.seq, "seq") ??
    countProblem(value.at, "at")
  if (base !== undefined) return base
  if (typeof value.type !== "string") return "type must be a string"
  const type = value.type
  switch (type) {
    case "session.started":
    case "session.updated":
    case "session.completed":
      return snapshotProblem(value.snapshot, value.sessionId, `${type}.snapshot`)
    case "turn.started":
      return (
        tokenProblem(value.turnId, `${type}.turnId`) ?? textProblem(value.prompt, `${type}.prompt`)
      )
    case "assistant.delta":
    case "assistant.message":
      return tokenProblem(value.turnId, `${type}.turnId`) ?? textProblem(value.text, `${type}.text`)
    case "reasoning.delta":
      return (
        tokenProblem(value.turnId, `${type}.turnId`) ??
        optionalTokenProblem(value.itemId, `${type}.itemId`) ??
        textProblem(value.text, `${type}.text`)
      )
    case "plan.updated":
      return (
        tokenProblem(value.turnId, `${type}.turnId`) ??
        optionalTokenProblem(value.callId, `${type}.callId`) ??
        (value.explanation === undefined
          ? undefined
          : textProblem(value.explanation, `${type}.explanation`, AGENT_MAX_PAYLOAD_TEXT)) ??
        planEntriesProblem(value.entries, `${type}.entries`)
      )
    case "context.usage":
      return (
        optionalTokenProblem(value.turnId, `${type}.turnId`) ??
        countProblem(value.usedTokens, `${type}.usedTokens`) ??
        optionalCountProblem(value.windowTokens, `${type}.windowTokens`) ??
        optionalCountProblem(value.inputTokens, `${type}.inputTokens`) ??
        optionalCountProblem(value.outputTokens, `${type}.outputTokens`) ??
        optionalCountProblem(value.cachedInputTokens, `${type}.cachedInputTokens`) ??
        optionalCountProblem(value.reasoningTokens, `${type}.reasoningTokens`) ??
        (value.estimated === undefined
          ? undefined
          : booleanProblem(value.estimated, `${type}.estimated`))
      )
    case "tool.started":
      return (
        tokenProblem(value.turnId, `${type}.turnId`) ??
        tokenProblem(value.callId, `${type}.callId`) ??
        tokenProblem(value.name, `${type}.name`) ??
        valueProblem(value, "input", `${type}.input`)
      )
    case "tool.delta":
      return (
        tokenProblem(value.turnId, `${type}.turnId`) ??
        tokenProblem(value.callId, `${type}.callId`) ??
        textProblem(value.text, `${type}.text`)
      )
    case "tool.completed":
      return (
        tokenProblem(value.turnId, `${type}.turnId`) ??
        tokenProblem(value.callId, `${type}.callId`) ??
        tokenProblem(value.name, `${type}.name`) ??
        booleanProblem(value.ok, `${type}.ok`) ??
        valueProblem(value, "output", `${type}.output`) ??
        (value.error === undefined ? undefined : errorProblem(value.error, `${type}.error`))
      )
    case "approval.required":
      return (
        tokenProblem(value.turnId, `${type}.turnId`) ??
        tokenProblem(value.approvalId, `${type}.approvalId`) ??
        textProblem(value.action, `${type}.action`, AGENT_MAX_TEXT, false) ??
        tokenProblem(value.capability, `${type}.capability`) ??
        optionalTextProblem(value.reason, `${type}.reason`)
      )
    case "approval.resolved":
      return (
        optionalTokenProblem(value.turnId, `${type}.turnId`) ??
        tokenProblem(value.approvalId, `${type}.approvalId`) ??
        booleanProblem(value.approved, `${type}.approved`) ??
        optionalTextProblem(value.reason, `${type}.reason`)
      )
    case "repair.required":
      return (
        optionalTokenProblem(value.turnId, `${type}.turnId`) ??
        repairTaskProblem(value.task, `${type}.task`)
      )
    case "verification.completed":
      return (
        (value.name === "check" || value.name === "assure" || value.name === "test"
          ? undefined
          : `${type}.name must be check, assure, or test`) ??
        booleanProblem(value.ok, `${type}.ok`) ??
        valueProblem(value, "report", `${type}.report`)
      )
    case "memory.compacted":
      return (
        countProblem(value.before, `${type}.before`) ??
        countProblem(value.after, `${type}.after`) ??
        (typeof value.reason === "string" && AGENT_COMPACTION_REASONS.has(value.reason)
          ? undefined
          : `${type}.reason must be one of ${[...AGENT_COMPACTION_REASONS].join(", ")}`)
      )
    case "extension.reloaded":
      return (
        tokenProblem(value.revision, `${type}.revision`) ??
        tokenListProblem(value.loaded, `${type}.loaded`) ??
        tokenListProblem(value.disabled, `${type}.disabled`) ??
        booleanProblem(value.rolledBack, `${type}.rolledBack`)
      )
    case "session.failed":
      return (
        errorProblem(value.error, `${type}.error`) ??
        booleanProblem(value.recoverable, `${type}.recoverable`)
      )
    case "session.stopped":
      return optionalTextProblem(value.reason, `${type}.reason`)
    default:
      if (isAgentExtensionEventType(type))
        return (
          optionalTokenProblem(value.turnId, `${type}.turnId`) ??
          valueProblem(value, "data", `${type}.data`)
        )
      if (type.startsWith("x-"))
        return "extension event type must be x-<vendor>.<name>, lowercase, at most 64 characters"
      return agentToken(type) ? `unknown event type ${type}` : "unknown event type"
  }
}

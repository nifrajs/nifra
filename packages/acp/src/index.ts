import { isAbsolute } from "node:path"
import {
  type AgentBackend,
  type AgentBackendInfo,
  type AgentError,
  type AgentEvent,
  type AgentEventPayload,
  type AgentEventStream,
  type AgentPlanEntry,
  type AgentSessionSnapshot,
  agentError,
  agentEventProblem,
  boundAgentText,
  boundAgentValue,
  type CreateSessionInput,
  childProcessBaseEnv,
  childProcessEnv,
  createAgentEventStream,
  isAgentExtensionEventType,
  type ReloadResult,
  type SendMessageInput,
  splitAgentText,
} from "@nifrajs/agent-protocol"

export interface AcpClientInfo {
  readonly name: string
  readonly title?: string
  readonly version: string
}

export interface AcpBackendOptions {
  /** The agent's executable, such as `claude-code-acp`, `codex-acp`, or `gemini`. */
  readonly command: string
  /** Arguments for the agent, such as `["--experimental-acp"]`. */
  readonly args?: readonly string[]
  /**
   * Variables the agent runs with on top of `PATH`, `HOME`, locale, terminal, user, shell, and temp.
   * Nothing else from the parent environment passes, model credentials included; a key mapped to
   * `undefined` is withheld even when the parent has it.
   */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** One of the `authMethods` ids the agent's `initialize` answer lists, sent with `authenticate`. */
  readonly authMethod?: string
  /** MCP servers handed to `session/new`, in ACP's shape. Default none. */
  readonly mcpServers?: readonly unknown[]
  /** How the client names itself in `initialize`. Default `{ name: "nifra", version: "4" }`. */
  readonly clientInfo?: AcpClientInfo
  /** Longest wait for `initialize`, `authenticate`, and `session/new`. Default 30 seconds. */
  readonly startupTimeoutMs?: number
  /** How long a cancelled turn may take to end before the agent is stopped. Default 2 seconds. */
  readonly cancelGraceMs?: number
  readonly maxEventQueueSize?: number
  /** Most UTF-8 bytes in one JSON-RPC line from the agent. Default 1 MiB. */
  readonly maxRecordBytes?: number
  /** Longest message `send` accepts. Default 64 KiB. */
  readonly maxMessageChars?: number
}

const INFO: AgentBackendInfo = Object.freeze({
  name: "acp",
  capabilities: Object.freeze(["sessions", "approvals", "streaming", "acp"]),
})

const PROTOCOL_VERSION = 1
const DEFAULT_CLIENT_INFO: AcpClientInfo = Object.freeze({ name: "nifra", version: "4" })
const DEFAULT_MAX_RECORD_BYTES = 1024 * 1024
const MAX_RECORD_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_MESSAGE_CHARS = 64 * 1024
const MAX_MESSAGE_CHARS = 4 * 1024 * 1024
const MAX_EVENT_QUEUE_SIZE = 65_536
const MAX_PENDING_APPROVALS = 128
const MAX_TOOL_CALLS = 4_096
const MAX_REPLY_CHARS = 1024 * 1024
const MAX_PLAN_ENTRIES = 256
const MAX_STDERR_LINE = 8 * 1024
// How long an exit waits for stderr's end, which a child the agent left behind can hold open.
const STDERR_DRAIN_MS = 500
const KILL_GRACE_MS = 2_000
const CANCELLED_OUTCOME = Object.freeze({ outcome: Object.freeze({ outcome: "cancelled" }) })
// JSON-RPC: the method is not one this client serves, its params are wrong, the request was cancelled.
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const REQUEST_CANCELLED = -32800
const AUTH_REQUIRED = -32000

type RpcId = number | string

interface PermissionOption {
  readonly optionId: string
  readonly kind: string
}

interface PendingApproval {
  readonly rpcId: RpcId
  readonly options: readonly PermissionOption[]
}

interface ToolCall {
  readonly callId: string
  readonly name: string
  done: boolean
}

// Mutable payloads, so an absent input or output is left out rather than sent as undefined.
interface ToolStartedPayload {
  type: "tool.started"
  turnId: string
  callId: string
  name: string
  input?: unknown
}

interface ToolCompletedPayload {
  type: "tool.completed"
  turnId: string
  callId: string
  name: string
  ok: boolean
  output?: unknown
  error?: AgentError
}

interface AcpTurn {
  readonly id: string
  readonly stream: AgentEventStream
  readonly ended: PromiseWithResolvers<void>
  readonly tools: Map<string, ToolCall>
  readonly approvals: Map<string, PendingApproval>
  reply: string
  cancelReason: string | undefined
  cleanup: (() => void) | undefined
}

interface AcpSession {
  readonly id: string
  readonly connection: AcpConnection
  readonly acpSessionId: string
  snapshot: AgentSessionSnapshot
  seq: number
  turn: AcpTurn | undefined
  closed: boolean
}

/**
 * Drive an agent that speaks the Agent Client Protocol (version 1) over stdio, one agent process per
 * session, and translate its session updates into the Nifra agent protocol.
 *
 * The client side is deliberately small: it offers no filesystem or terminal methods, so the agent
 * uses its own tools, and every tool call it asks permission for surfaces as `approval.required`.
 */
export class AcpBackend implements AgentBackend {
  readonly info = INFO
  private readonly options: AcpBackendOptions
  private readonly maxRecordBytes: number
  private readonly maxMessageChars: number
  private readonly startupTimeoutMs: number
  private readonly cancelGraceMs: number
  private readonly sessions = new Map<string, AcpSession>()

  constructor(options: AcpBackendOptions) {
    if (typeof options.command !== "string" || options.command.length === 0)
      throw new TypeError("acp backend: command is required")
    this.maxRecordBytes = bounded(
      "maxRecordBytes",
      options.maxRecordBytes,
      DEFAULT_MAX_RECORD_BYTES,
      1_024,
      MAX_RECORD_BYTES,
    )
    this.maxMessageChars = bounded(
      "maxMessageChars",
      options.maxMessageChars,
      DEFAULT_MAX_MESSAGE_CHARS,
      256,
      MAX_MESSAGE_CHARS,
    )
    this.startupTimeoutMs = bounded(
      "startupTimeoutMs",
      options.startupTimeoutMs,
      30_000,
      1,
      600_000,
    )
    this.cancelGraceMs = bounded("cancelGraceMs", options.cancelGraceMs, 2_000, 0, 60_000)
    bounded("maxEventQueueSize", options.maxEventQueueSize, 256, 1, MAX_EVENT_QUEUE_SIZE)
    this.options = Object.freeze({ ...options })
  }

  async createSession(input: CreateSessionInput): Promise<AgentSessionSnapshot> {
    if (
      typeof input.cwd !== "string" ||
      input.cwd.length === 0 ||
      input.cwd.length > 4_096 ||
      input.cwd.includes("\0") ||
      !isAbsolute(input.cwd)
    )
      throw new TypeError("acp backend: cwd must be a bounded absolute path")
    if (
      input.capabilities !== undefined &&
      (!Array.isArray(input.capabilities) ||
        input.capabilities.length > 256 ||
        !input.capabilities.every(isToken))
    )
      throw new TypeError("acp backend: capabilities must be bounded tokens")
    const id = input.sessionId ?? crypto.randomUUID()
    if (!isToken(id)) throw new TypeError("acp backend: sessionId must be a bounded token")
    if (this.sessions.has(id)) throw new Error(`acp backend: session already exists: ${id}`)

    const env = filteredEnv(this.options.env)
    const connection = new AcpConnection(
      Bun.spawn([this.options.command, ...(this.options.args ?? [])], {
        cwd: input.cwd,
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }),
      this.maxRecordBytes,
      redactor(env),
    )
    let acpSessionId: string
    try {
      acpSessionId = await this.start(connection, input.cwd)
    } catch (error) {
      await connection.kill()
      throw error
    }
    const now = Date.now()
    const session: AcpSession = {
      id,
      connection,
      acpSessionId,
      snapshot: Object.freeze({
        version: 1,
        id,
        backend: INFO.name,
        cwd: input.cwd,
        status: "idle",
        createdAt: now,
        updatedAt: now,
        lastSeq: 0,
        capabilities: Object.freeze([...(input.capabilities ?? INFO.capabilities)]),
      }),
      seq: 0,
      turn: undefined,
      closed: false,
    }
    this.sessions.set(id, session)
    connection.handler = {
      request: (rpcId, method, params) => this.onRequest(session, rpcId, method, params),
      notification: (method, params) => this.onNotification(session, method, params),
      fault: (error) => this.onFault(session, error),
    }
    return session.snapshot
  }

  send(input: SendMessageInput): AsyncIterable<AgentEvent> {
    const session = this.requireSession(input.sessionId)
    if (session.closed) return failedStream(agentError("SESSION_CLOSED", "ACP session is closed"))
    if (session.turn !== undefined)
      return failedStream(agentError("SESSION_BUSY", "ACP session already has an active turn"))
    if (input.message.length === 0 || input.message.length > this.maxMessageChars)
      return failedStream(
        agentError("MESSAGE_BOUNDED", "message is empty or exceeds the configured limit"),
      )

    const turn: AcpTurn = {
      id: crypto.randomUUID(),
      stream: createAgentEventStream(this.options.maxEventQueueSize ?? 256),
      ended: Promise.withResolvers<void>(),
      tools: new Map(),
      approvals: new Map(),
      reply: "",
      cancelReason: undefined,
      cleanup: undefined,
    }
    session.turn = turn
    this.setStatus(session, "running")
    this.emit(session, {
      type: "turn.started",
      turnId: turn.id,
      prompt: boundAgentText(input.message),
    })
    const signal = input.signal
    if (signal?.aborted === true) {
      this.finishTurn(session, turn, "stopped", { type: "session.stopped", reason: "cancelled" })
      return turn.stream
    }
    if (signal !== undefined) {
      const onAbort = (): void => {
        if (session.turn === turn) void this.cancelTurn(session, turn, "cancelled")
      }
      signal.addEventListener("abort", onAbort, { once: true })
      turn.cleanup = () => signal.removeEventListener("abort", onAbort)
    }
    session.connection
      .request("session/prompt", {
        sessionId: session.acpSessionId,
        prompt: [{ type: "text", text: input.message }],
      })
      .then(
        (result) => this.endTurn(session, turn, recordOf(result)?.stopReason),
        (error: unknown) => this.failTurn(session, turn, promptError(error)),
      )
    return turn.stream
  }

  async cancel(sessionId: string, reason = "cancelled"): Promise<void> {
    const session = this.sessions.get(sessionId)
    const turn = session?.turn
    if (session === undefined || turn === undefined) return
    await this.cancelTurn(session, turn, reason)
  }

  async snapshot(sessionId: string): Promise<AgentSessionSnapshot> {
    return this.requireSession(sessionId).snapshot
  }

  async reload(): Promise<ReloadResult> {
    return {
      revision: "acp",
      loaded: [],
      disabled: [],
      rolledBack: false,
      error: agentError("FEATURE_UNSUPPORTED", "an ACP agent has no extension reload"),
    }
  }

  async resolveApproval(
    sessionId: string,
    approvalId: string,
    approved: boolean,
  ): Promise<boolean | undefined> {
    const session = this.sessions.get(sessionId)
    const pending = session?.turn?.approvals.get(approvalId)
    if (session === undefined || pending === undefined) return undefined
    session.turn?.approvals.delete(approvalId)
    // Only one-time options: an "always" answer would outlive the host's own approval policy.
    const option = pending.options.find(
      (candidate) => candidate.kind === (approved ? "allow_once" : "reject_once"),
    )
    session.connection.respond(
      pending.rpcId,
      option === undefined
        ? CANCELLED_OUTCOME
        : { outcome: { outcome: "selected", optionId: option.optionId } },
    )
    return option === undefined ? false : approved
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return
    this.sessions.delete(sessionId)
    session.closed = true
    const turn = session.turn
    if (turn !== undefined) {
      this.settleApprovals(session, turn)
      this.finishTurn(session, turn, "stopped", {
        type: "session.stopped",
        reason: "session closed",
      })
    }
    await session.connection.kill()
  }

  private async start(connection: AcpConnection, cwd: string): Promise<string> {
    const timeout = this.startupTimeoutMs
    const init = recordOf(
      await connection.request(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
        },
        timeout,
      ),
    )
    if (init?.protocolVersion !== PROTOCOL_VERSION)
      throw new Error(
        `acp backend: the agent speaks ACP version ${boundAgentText(String(init?.protocolVersion), 32)}; this adapter speaks ${PROTOCOL_VERSION}`,
      )
    if (this.options.authMethod !== undefined)
      await connection.request("authenticate", { methodId: this.options.authMethod }, timeout)
    let created: Record<string, unknown> | undefined
    try {
      created = recordOf(
        await connection.request(
          "session/new",
          { cwd, mcpServers: this.options.mcpServers ?? [] },
          timeout,
        ),
      )
    } catch (error) {
      if (error instanceof AcpRpcError && error.code === AUTH_REQUIRED)
        throw new Error(
          `acp backend: the agent requires authentication; pass authMethod (${authMethods(init.authMethods)})`,
        )
      throw error
    }
    const acpSessionId = created?.sessionId
    if (
      typeof acpSessionId !== "string" ||
      acpSessionId.length === 0 ||
      acpSessionId.length > 1_024
    )
      throw new Error("acp backend: session/new answered without a sessionId")
    return acpSessionId
  }

  private requireSession(id: string): AcpSession {
    const session = this.sessions.get(id)
    if (session === undefined) throw new Error(`acp backend: unknown session: ${id}`)
    return session
  }

  private onRequest(session: AcpSession, rpcId: RpcId, method: string, params: unknown): void {
    if (method !== "session/request_permission") {
      session.connection.respondError(
        rpcId,
        METHOD_NOT_FOUND,
        `${boundAgentText(method, 128)} is not offered by this client`,
      )
      return
    }
    if (!isRecord(params)) {
      session.connection.respondError(rpcId, INVALID_PARAMS, "params must be an object")
      return
    }
    const turn = session.turn
    if (
      turn === undefined ||
      turn.cancelReason !== undefined ||
      params.sessionId !== session.acpSessionId ||
      turn.approvals.size >= MAX_PENDING_APPROVALS
    ) {
      session.connection.respond(rpcId, CANCELLED_OUTCOME)
      return
    }
    const options: PermissionOption[] = []
    if (Array.isArray(params.options))
      for (const option of params.options.slice(0, 32)) {
        const record = recordOf(option)
        if (typeof record?.optionId === "string" && typeof record.kind === "string")
          options.push({ optionId: record.optionId, kind: record.kind })
      }
    const toolCall = recordOf(params.toolCall)
    const kind = isToken(toolCall?.kind) ? toolCall.kind : "other"
    const title = typeof toolCall?.title === "string" ? toolCall.title.trim() : ""
    const approvalId = crypto.randomUUID()
    turn.approvals.set(approvalId, { rpcId, options })
    this.flushReply(session, turn)
    this.emit(session, {
      type: "approval.required",
      turnId: turn.id,
      approvalId,
      action: title.length > 0 ? boundAgentText(title, 512) : `${kind} tool call`,
      capability: `acp.${kind}`,
    })
  }

  private onNotification(session: AcpSession, method: string, params: unknown): void {
    const turn = session.turn
    if (turn === undefined || !isRecord(params)) return
    if (method === "$/cancel_request") {
      this.withdrawApproval(session, turn, params.requestId)
      return
    }
    if (method !== "session/update" || params.sessionId !== session.acpSessionId) return
    const update = recordOf(params.update)
    if (update === undefined) return
    const kind = update.sessionUpdate
    switch (kind) {
      case "agent_message_chunk": {
        const text = contentText(update.content)
        if (text.length === 0) return
        if (turn.reply.length < MAX_REPLY_CHARS)
          turn.reply += text.slice(0, MAX_REPLY_CHARS - turn.reply.length)
        for (const piece of splitAgentText(text))
          this.emit(session, { type: "assistant.delta", turnId: turn.id, text: piece })
        return
      }
      case "agent_thought_chunk": {
        for (const piece of splitAgentText(contentText(update.content)))
          if (piece.length > 0)
            this.emit(session, { type: "reasoning.delta", turnId: turn.id, text: piece })
        return
      }
      case "tool_call":
      case "tool_call_update": {
        this.flushReply(session, turn)
        const tool = this.startTool(session, turn, update)
        if (tool !== undefined && (update.status === "completed" || update.status === "failed"))
          this.completeTool(session, turn, tool, update)
        return
      }
      case "plan": {
        const entries = planEntries(update.entries)
        if (entries !== undefined)
          this.emit(session, { type: "plan.updated", turnId: turn.id, entries })
        return
      }
      case "usage_update": {
        if (!isCount(update.used)) return
        this.emit(
          session,
          isCount(update.size)
            ? {
                type: "context.usage",
                turnId: turn.id,
                usedTokens: update.used,
                windowTokens: update.size,
              }
            : { type: "context.usage", turnId: turn.id, usedTokens: update.used },
        )
        return
      }
      default: {
        const type = typeof kind === "string" ? `x-acp.${kind}` : ""
        if (isAgentExtensionEventType(type))
          this.emit(session, { type, turnId: turn.id, data: boundAgentValue(update) })
      }
    }
  }

  private onFault(session: AcpSession, error: AgentError): void {
    if (session.closed) return
    if (error.code === "ACP_EXITED") {
      session.closed = true
      this.sessions.delete(session.id)
    }
    const turn = session.turn
    if (turn !== undefined) this.failTurn(session, turn, error)
    else if (error.code === "ACP_EXITED") this.setStatus(session, "failed")
  }

  private startTool(
    session: AcpSession,
    turn: AcpTurn,
    update: Record<string, unknown>,
  ): ToolCall | undefined {
    const acpId = update.toolCallId
    if (typeof acpId !== "string" || acpId.length === 0) return undefined
    const known = turn.tools.get(acpId)
    if (known !== undefined || turn.tools.size >= MAX_TOOL_CALLS) return known
    const tool: ToolCall = {
      callId: isToken(acpId) ? acpId : `acp-tool-${turn.tools.size + 1}`,
      name: isToken(update.kind) ? update.kind : "tool",
      done: false,
    }
    turn.tools.set(acpId, tool)
    const started: ToolStartedPayload = {
      type: "tool.started",
      turnId: turn.id,
      callId: tool.callId,
      name: tool.name,
    }
    const input = boundAgentValue(update.rawInput)
    if (input !== undefined) started.input = input
    this.emit(session, started)
    return tool
  }

  private completeTool(
    session: AcpSession,
    turn: AcpTurn,
    tool: ToolCall,
    update: Record<string, unknown>,
  ): void {
    if (tool.done) return
    tool.done = true
    const completed: ToolCompletedPayload = {
      type: "tool.completed",
      turnId: turn.id,
      callId: tool.callId,
      name: tool.name,
      ok: update.status === "completed",
    }
    const output = boundAgentValue(update.rawOutput ?? update.content)
    if (output !== undefined) completed.output = output
    if (!completed.ok)
      completed.error = agentError("ACP_TOOL_FAILED", "the agent's tool call failed")
    this.emit(session, completed)
  }

  private withdrawApproval(session: AcpSession, turn: AcpTurn, requestId: unknown): void {
    for (const [approvalId, pending] of turn.approvals) {
      if (pending.rpcId !== requestId) continue
      turn.approvals.delete(approvalId)
      session.connection.respondError(pending.rpcId, REQUEST_CANCELLED, "request cancelled")
      this.emit(session, {
        type: "approval.resolved",
        turnId: turn.id,
        approvalId,
        approved: false,
        reason: "the agent withdrew the request",
      })
      return
    }
  }

  /** Answer every approval still open as cancelled, as ACP requires before a turn ends. */
  private settleApprovals(session: AcpSession, turn: AcpTurn): void {
    for (const pending of turn.approvals.values())
      session.connection.respond(pending.rpcId, CANCELLED_OUTCOME)
    turn.approvals.clear()
  }

  private async cancelTurn(session: AcpSession, turn: AcpTurn, reason: string): Promise<void> {
    if (turn.cancelReason === undefined) {
      turn.cancelReason = boundAgentText(reason, 512) || "cancelled"
      this.settleApprovals(session, turn)
      session.connection.notify("session/cancel", { sessionId: session.acpSessionId })
    }
    if (await settlesWithin(turn.ended.promise, this.cancelGraceMs)) return
    if (session.turn !== turn) return
    // The agent did not end the turn when asked; stop it, so the turn cannot go on unseen.
    session.closed = true
    this.sessions.delete(session.id)
    this.finishTurn(session, turn, "stopped", {
      type: "session.stopped",
      reason: turn.cancelReason,
    })
    await session.connection.kill()
  }

  private endTurn(session: AcpSession, turn: AcpTurn, stopReason: unknown): void {
    if (session.turn !== turn) return
    if (turn.cancelReason !== undefined || stopReason === "cancelled") {
      this.flushReply(session, turn)
      this.finishTurn(session, turn, "stopped", {
        type: "session.stopped",
        reason: turn.cancelReason ?? "cancelled",
      })
      return
    }
    if (typeof stopReason !== "string") {
      this.failTurn(
        session,
        turn,
        agentError("ACP_PROTOCOL", "session/prompt answered without a stopReason"),
      )
      return
    }
    if (stopReason === "refusal") {
      this.failTurn(session, turn, agentError("ACP_REFUSAL", "the agent refused the prompt"))
      return
    }
    this.flushReply(session, turn)
    if (stopReason !== "end_turn" && isToken(stopReason))
      this.emit(session, { type: "x-acp.stop_reason", turnId: turn.id, data: { stopReason } })
    this.setStatus(session, "idle")
    this.finishTurn(session, turn, "idle", {
      type: "session.completed",
      snapshot: session.snapshot,
    })
  }

  private failTurn(session: AcpSession, turn: AcpTurn, error: AgentError): void {
    if (session.turn !== turn) return
    this.settleApprovals(session, turn)
    this.flushReply(session, turn)
    this.finishTurn(session, turn, "failed", { type: "session.failed", error, recoverable: true })
  }

  private finishTurn(
    session: AcpSession,
    turn: AcpTurn,
    status: AgentSessionSnapshot["status"],
    terminal: AgentEventPayload,
  ): void {
    if (session.turn !== turn) return
    turn.cleanup?.()
    turn.cleanup = undefined
    this.setStatus(session, status)
    this.emit(session, terminal)
    session.turn = undefined
    turn.stream.complete()
    turn.ended.resolve()
  }

  private flushReply(session: AcpSession, turn: AcpTurn): void {
    if (turn.reply.length === 0) return
    const reply = turn.reply
    turn.reply = ""
    for (const text of splitAgentText(reply))
      this.emit(session, { type: "assistant.message", turnId: turn.id, text })
  }

  private setStatus(session: AcpSession, status: AgentSessionSnapshot["status"]): void {
    const { activeTurnId: _activeTurnId, ...rest } = session.snapshot
    const next = { ...rest, status, updatedAt: Date.now(), lastSeq: session.seq }
    const turnId = session.turn?.id
    session.snapshot = Object.freeze(
      status === "running" && turnId !== undefined ? { ...next, activeTurnId: turnId } : next,
    )
  }

  private emit(session: AcpSession, payload: AgentEventPayload): void {
    const turn = session.turn
    if (turn === undefined) return
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: one payload member under the envelope is its own AgentEvent member; TS cannot distribute the spread, and agentEventProblem checks the result below.
    const event = Object.freeze({
      version: 1,
      sessionId: session.id,
      seq: session.seq,
      at: Date.now(),
      ...payload,
    }) as AgentEvent
    const problem = agentEventProblem(event)
    if (problem !== undefined) {
      // A terminal event is built here from bounded values, so only an agent's update can fail.
      if (payload.type !== "session.failed")
        this.failTurn(
          session,
          turn,
          agentError("ACP_PROTOCOL", `the agent sent an update the protocol refuses: ${problem}`),
        )
      return
    }
    session.seq += 1
    turn.stream.push(event)
  }
}

interface AcpHandler {
  readonly request: (id: RpcId, method: string, params: unknown) => void
  readonly notification: (method: string, params: unknown) => void
  readonly fault: (error: AgentError) => void
}

class AcpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
    this.name = "AcpRpcError"
  }
}

/** Newline-delimited JSON-RPC 2.0 over an agent process's stdio. */
class AcpConnection {
  handler: AcpHandler | undefined
  private readonly pending = new Map<number, PromiseWithResolvers<unknown>>()
  private nextId = 1
  private buffer = ""
  private lastError: string | undefined
  private exitError: Error | undefined

  constructor(
    private readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">,
    private readonly maxRecordBytes: number,
    private readonly redact: (text: string) => string,
  ) {
    void this.readStdout()
    // Settled either way: a stderr read that fails must not stop the exit from being reported.
    const stderrDone = Promise.allSettled([this.readStderr()])
    void process.exited.then(async (code) => {
      // The exit can land before the reader has taken the agent's last stderr line, the one that
      // says why it stopped.
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        stderrDone,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, STDERR_DRAIN_MS)
        }),
      ])
      clearTimeout(timer)
      const detail = this.lastError === undefined ? "" : `: ${this.lastError}`
      const error = new Error(`the ACP agent exited with code ${code}${detail}`)
      this.exitError = error
      this.rejectAll(error)
      this.handler?.fault(agentError("ACP_EXITED", error.message))
    })
  }

  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.exitError !== undefined) return Promise.reject(this.exitError)
    const id = this.nextId++
    const answer = Promise.withResolvers<unknown>()
    this.pending.set(id, answer)
    if (!this.write({ jsonrpc: "2.0", id, method, params })) {
      this.pending.delete(id)
      return Promise.reject(new Error(`acp backend: could not send ${method}`))
    }
    if (timeoutMs === undefined) return answer.promise
    const timer = setTimeout(() => {
      this.pending.delete(id)
      answer.reject(new Error(`acp backend: ${method} got no answer within ${timeoutMs} ms`))
    }, timeoutMs)
    return answer.promise.finally(() => clearTimeout(timer))
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params })
  }

  respond(id: RpcId, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result })
  }

  respondError(id: RpcId, code: number, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message } })
  }

  async kill(): Promise<void> {
    if (this.exitError !== undefined) return
    this.process.kill()
    if (!(await settlesWithin(this.process.exited, KILL_GRACE_MS))) this.process.kill("SIGKILL")
    await this.process.exited
  }

  private write(message: Record<string, unknown>): boolean {
    if (this.exitError !== undefined) return false
    try {
      this.process.stdin.write(`${JSON.stringify(message)}\n`)
      void this.process.stdin.flush()
      return true
    } catch {
      // The agent closed its stdin; the exit path reports that.
      return false
    }
  }

  private rejectAll(error: Error): void {
    for (const answer of this.pending.values()) answer.reject(error)
    this.pending.clear()
  }

  private fail(message: string): void {
    const error = agentError("ACP_PROTOCOL", message)
    if (this.handler === undefined) this.rejectAll(new Error(`acp backend: ${message}`))
    else this.handler.fault(error)
  }

  private async readStdout(): Promise<void> {
    const decoder = new TextDecoder()
    for await (const chunk of this.process.stdout)
      this.consume(decoder.decode(chunk, { stream: true }))
    this.consume(decoder.decode())
    if (this.buffer.length > 0) {
      this.buffer = ""
      this.fail("the agent ended stdout inside a JSON-RPC message")
    }
  }

  private consume(text: string): void {
    const buffered = this.buffer + text
    let start = 0
    for (
      let newline = buffered.indexOf("\n", start);
      newline !== -1;
      newline = buffered.indexOf("\n", start)
    ) {
      const line = buffered.slice(start, newline).trim()
      start = newline + 1
      if (line.length === 0) continue
      if (Buffer.byteLength(line, "utf8") > this.maxRecordBytes) {
        this.fail("the agent sent an oversized JSON-RPC message")
        continue
      }
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        this.fail("the agent wrote something other than JSON-RPC to stdout")
        continue
      }
      this.dispatch(message)
    }
    // The cap is per message: each complete line was measured above; what remains is still arriving.
    this.buffer = buffered.slice(start)
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxRecordBytes) {
      this.buffer = ""
      this.fail("the agent sent an oversized JSON-RPC message")
    }
  }

  private dispatch(message: unknown): void {
    if (!isRecord(message)) {
      this.fail("the agent sent a JSON-RPC message that is not an object")
      return
    }
    const id = message.id
    if (typeof message.method === "string") {
      if (typeof id === "number" || typeof id === "string") {
        if (this.handler === undefined)
          this.respondError(id, METHOD_NOT_FOUND, "the session is not ready")
        else this.handler.request(id, message.method, message.params)
      } else this.handler?.notification(message.method, message.params)
      return
    }
    if (typeof id !== "number") return
    const answer = this.pending.get(id)
    if (answer === undefined) return
    this.pending.delete(id)
    const error = recordOf(message.error)
    if (error === undefined) answer.resolve(message.result)
    else
      answer.reject(
        new AcpRpcError(
          typeof error.code === "number" ? error.code : 0,
          this.redact(
            boundAgentText(String(error.message ?? "the agent refused the request"), 1_024),
          ),
        ),
      )
  }

  /** Keep the last error-looking stderr line, so an exit can say why. */
  private async readStderr(): Promise<void> {
    const decoder = new TextDecoder()
    let partial = ""
    for await (const chunk of this.process.stderr) {
      const lines = (partial + decoder.decode(chunk, { stream: true })).split("\n")
      partial = (lines.pop() ?? "").slice(-MAX_STDERR_LINE)
      for (const line of lines) this.noteStderr(line)
    }
    this.noteStderr(partial + decoder.decode())
  }

  private noteStderr(line: string): void {
    const clean = line.replace(ANSI_ESCAPE, "").trim()
    if (ERROR_LINE.test(clean)) this.lastError = this.redact(boundAgentText(clean, 512))
  }
}

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g")
const ERROR_LINE =
  /\b(?:error|fatal|panic|failed|denied|unauthori[sz]ed|forbidden|invalid|not found|exception)\b/i

// A provider's error can echo a credential back; the error keeps the reason, not the key.
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgsk_[A-Za-z0-9]{20,}/g,
  /\bxai-[A-Za-z0-9]{20,}/g,
  /\bhf_[A-Za-z0-9]{20,}/g,
  /\bnvapi-[A-Za-z0-9_-]{20,}/g,
]

const ACP_ENV = ["USER", "LOGNAME", "SHELL", "TMPDIR"]
const BASE_ENV = [...childProcessBaseEnv(process.platform), ...ACP_ENV]

function filteredEnv(
  values: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string> {
  return childProcessEnv({ env: process.env, platform: process.platform, names: ACP_ENV, values })
}

/** Masks the values handed to the agent (the base set aside) and common credential shapes. */
function redactor(env: Readonly<Record<string, string>>): (text: string) => string {
  const base = new Set(BASE_ENV)
  const secrets = Object.entries(env)
    .filter(([name, value]) => !base.has(name) && value.length >= 6)
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length)
  return (text) => {
    let masked = text
    for (const secret of secrets) masked = masked.replaceAll(secret, "[REDACTED]")
    for (const pattern of CREDENTIAL_PATTERNS) masked = masked.replace(pattern, "[REDACTED]")
    return masked
  }
}

function promptError(error: unknown): AgentError {
  if (error instanceof AcpRpcError)
    return error.code === AUTH_REQUIRED
      ? agentError("ACP_AUTH_REQUIRED", error.message)
      : agentError("ACP_PROMPT_FAILED", error.message)
  return agentError(
    "ACP_EXITED",
    error instanceof Error ? error.message : "the ACP agent stopped answering",
  )
}

function authMethods(value: unknown): string {
  const ids = Array.isArray(value)
    ? value
        .map((method) => recordOf(method)?.id)
        .filter(isToken)
        .slice(0, 8)
    : []
  return ids.length === 0 ? "the agent listed none" : `one of: ${ids.join(", ")}`
}

function contentText(value: unknown): string {
  const content = recordOf(value)
  return content?.type === "text" && typeof content.text === "string" ? content.text : ""
}

function planEntries(value: unknown): AgentPlanEntry[] | undefined {
  if (!Array.isArray(value)) return undefined
  const entries: AgentPlanEntry[] = []
  for (const item of value.slice(0, MAX_PLAN_ENTRIES)) {
    const entry = recordOf(item)
    const status = entry?.status
    if (
      typeof entry?.content !== "string" ||
      (status !== "pending" && status !== "in_progress" && status !== "completed")
    )
      continue
    const content = boundAgentText(entry.content, 4_096)
    const priority = entry.priority
    entries.push(
      priority === "high" || priority === "medium" || priority === "low"
        ? { content, status, priority }
        : { content, status },
    )
  }
  return entries
}

function failedStream(error: AgentError): AgentEventStream {
  const stream = createAgentEventStream()
  stream.fail(error)
  return stream
}

function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  return Promise.race([promise.then(() => true), timeout]).finally(() => clearTimeout(timer))
}

function bounded(
  name: string,
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max)
    throw new RangeError(`acp backend: ${name} must be between ${min} and ${max}`)
  return resolved
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:/-]{1,128}$/.test(value)
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

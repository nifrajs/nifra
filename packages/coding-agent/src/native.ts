import {
  type ModelGateway,
  type ModelRoutePolicy,
  runModelGateway,
  structuredOutputParser,
} from "@nifrajs/agent"
import {
  type AgentBackend,
  type AgentBackendInfo,
  type AgentEvent,
  type AgentEventStream,
  type AgentSessionSnapshot,
  agentError,
  type CreateSessionInput,
  createAgentEventStream,
  isAgentEvent,
  type ReloadResult,
  type SendMessageInput,
} from "@nifrajs/agent-protocol"

export interface NativeMessage {
  readonly role: "user" | "assistant" | "tool"
  readonly text: string
  readonly name?: string
}

export interface NativeTool {
  readonly name: string
  readonly description: string
  readonly capabilities?: readonly string[]
  readonly requiresApproval?: boolean | ((input: unknown) => boolean | PromiseLike<boolean>)
  readonly execute: (
    input: unknown,
    context: { readonly cwd: string; readonly signal: AbortSignal },
  ) => unknown | PromiseLike<unknown>
}

export interface NativeModelRequest {
  readonly sessionId: string
  readonly cwd: string
  readonly messages: readonly NativeMessage[]
  readonly tools: readonly Pick<NativeTool, "name" | "description" | "capabilities">[]
  readonly signal: AbortSignal
}

export type NativeModelResponse =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool"; readonly name: string; readonly input: unknown }

export type NativeModelChunk =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "response"; readonly response: NativeModelResponse }

export interface NativeModelPort {
  complete(
    request: NativeModelRequest,
  ): NativeModelResponse | PromiseLike<NativeModelResponse> | AsyncIterable<NativeModelChunk>
}

export interface NativeGatewayModelPortOptions {
  readonly gateway: ModelGateway
  readonly policy: ModelRoutePolicy
  readonly routeId?: string
}

/** Adapt the provider-neutral gateway to the native backend without making it the default path. */
export function createNativeGatewayModelPort(
  options: NativeGatewayModelPortOptions,
): NativeModelPort {
  const parser = structuredOutputParser<NativeModelResponse>((value) =>
    parseNativeModelResponse(value),
  )
  return {
    complete(request) {
      return runModelGateway(
        options.gateway,
        {
          input: request,
          ...(options.routeId === undefined ? {} : { routeId: options.routeId }),
          parser,
          signal: request.signal,
        },
        options.policy,
      ).then((result) => {
        if (!result.ok) throw new Error(`native gateway failed: ${result.error.code}`)
        return result.output
      })
    },
  }
}

function parseNativeModelResponse(value: unknown): NativeModelResponse {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("native model response is invalid")
  const record = value as Record<string, unknown>
  if (record.type === "text" && typeof record.text === "string")
    return Object.freeze({ type: "text", text: record.text })
  if (record.type === "tool" && typeof record.name === "string" && Object.hasOwn(record, "input"))
    return Object.freeze({ type: "tool", name: record.name, input: record.input })
  throw new TypeError("native model response is invalid")
}

export interface NativeApprovalPort {
  request(input: {
    readonly sessionId: string
    /** Stable, bounded identifier for this approval boundary. */
    readonly approvalId: string
    readonly turnId: string
    readonly callId: string
    readonly action: string
    readonly capability: string
    readonly tool: NativeTool
    readonly input: unknown
    readonly signal: AbortSignal
  }): boolean | PromiseLike<boolean>
}

export interface NifraBackendOptions {
  readonly model: NativeModelPort
  readonly tools?: readonly NativeTool[]
  readonly approval?: NativeApprovalPort
  /** Maximum time a protocol-visible native approval may remain unresolved. */
  readonly approvalTimeoutMs?: number
  readonly maxSteps?: number
  readonly maxMessageChars?: number
  readonly now?: () => number
}

type NativeApprovalFailureCode =
  | "APPROVAL_DENIED"
  | "APPROVAL_CANCELLED"
  | "APPROVAL_TIMEOUT"
  | "APPROVAL_CLOSED"
  | "APPROVAL_FAILED"

interface NativeApprovalResolution {
  readonly approved: boolean
  readonly reason?: string
  readonly errorCode?: NativeApprovalFailureCode
}

interface NativePendingApproval {
  readonly id: string
  readonly sessionId: string
  readonly turnId: string
  readonly callId: string
  readonly action: string
  readonly capability: string
  readonly resolve: (resolution: NativeApprovalResolution) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly onAbort: () => void
  readonly signal: AbortSignal
}

interface NativeSession {
  readonly id: string
  readonly cwd: string
  readonly messages: NativeMessage[]
  controller: AbortController
  snapshot: AgentSessionSnapshot
  active: AgentEventStream | undefined
  turnId: string | undefined
  turnAbortCleanup: (() => void) | undefined
  seq: number
  extensionRevision: number
  closed: boolean
  cancelled: boolean
}

/**
 * Small provider port for a future Nifra-native backend.
 *
 * It deliberately knows only messages, tools, and the protocol. Provider SDKs, credentials, UI,
 * and framework packages stay outside this module. A model may return one response or stream
 * deltas followed by a final response.
 */
export class NifraBackend implements AgentBackend {
  readonly info: AgentBackendInfo = Object.freeze({
    name: "nifra",
    capabilities: Object.freeze(["sessions", "extensions", "reload", "approvals", "streaming"]),
  })
  private readonly options: Required<Pick<NifraBackendOptions, "maxSteps" | "maxMessageChars">> &
    NifraBackendOptions
  private readonly sessions = new Map<string, NativeSession>()
  private readonly pendingApprovals = new Map<string, NativePendingApproval>()

  constructor(options: NifraBackendOptions) {
    this.options = Object.freeze({
      ...options,
      maxSteps: options.maxSteps ?? 32,
      maxMessageChars: options.maxMessageChars ?? 64 * 1024,
      tools: Object.freeze([...(options.tools ?? [])]),
    })
    if (
      !Number.isSafeInteger(this.options.maxSteps) ||
      this.options.maxSteps < 1 ||
      this.options.maxSteps > 512
    )
      throw new RangeError("nifra backend: maxSteps must be between 1 and 512")
    if (!Number.isSafeInteger(this.options.maxMessageChars) || this.options.maxMessageChars < 256)
      throw new RangeError("nifra backend: maxMessageChars must be at least 256")
    if (
      this.options.approvalTimeoutMs !== undefined &&
      (!Number.isSafeInteger(this.options.approvalTimeoutMs) ||
        this.options.approvalTimeoutMs < 1 ||
        this.options.approvalTimeoutMs > 24 * 60 * 60_000)
    )
      throw new RangeError("nifra backend: approvalTimeoutMs must be between 1ms and 24h")
  }

  async createSession(input: CreateSessionInput): Promise<AgentSessionSnapshot> {
    if (
      typeof input.cwd !== "string" ||
      input.cwd.length === 0 ||
      input.cwd.length > 4_096 ||
      input.cwd.includes("\0")
    )
      throw new TypeError("nifra backend: cwd must be a bounded non-empty path")
    if (
      input.capabilities !== undefined &&
      (!Array.isArray(input.capabilities) ||
        input.capabilities.length > 256 ||
        !input.capabilities.every((value) => boundedApprovalToken(value)))
    )
      throw new TypeError("nifra backend: capabilities must be bounded tokens")
    const id = input.sessionId ?? crypto.randomUUID()
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(id))
      throw new TypeError("nifra backend: sessionId must be a bounded token")
    if (this.sessions.has(id)) throw new Error(`nifra backend: session already exists: ${id}`)
    const now = this.now()
    const snapshot: AgentSessionSnapshot = {
      version: 1,
      id,
      backend: this.info.name,
      cwd: input.cwd,
      status: "idle",
      createdAt: now,
      updatedAt: now,
      lastSeq: 0,
      capabilities: Object.freeze([...(input.capabilities ?? this.info.capabilities)]),
    }
    const session: NativeSession = {
      id,
      cwd: input.cwd,
      messages: [],
      controller: new AbortController(),
      snapshot,
      active: undefined,
      turnId: undefined,
      turnAbortCleanup: undefined,
      seq: 0,
      extensionRevision: 0,
      closed: false,
      cancelled: false,
    }
    this.sessions.set(id, session)
    return snapshot
  }

  send(input: SendMessageInput): AsyncIterable<AgentEvent> {
    const session = this.requireSession(input.sessionId)
    if (session.closed) return failedStream(agentError("SESSION_CLOSED", "Nifra session is closed"))
    if (session.active !== undefined)
      return failedStream(agentError("SESSION_BUSY", "Nifra session is busy"))
    if (input.message.length === 0 || input.message.length > this.options.maxMessageChars)
      return failedStream(
        agentError("MESSAGE_BOUNDED", "message is empty or exceeds the configured limit"),
      )
    const stream = createAgentEventStream()
    session.active = stream
    session.cancelled = false
    session.controller = new AbortController()
    const signal = session.controller.signal
    const turnId = crypto.randomUUID()
    session.turnId = turnId
    if (input.signal !== undefined) {
      const externalSignal = input.signal
      const onAbort = (): void => {
        // Capture the turn identity. A request signal must never abort a later turn that reused
        // this session after the original stream settled.
        if (
          session.active !== stream ||
          session.turnId !== turnId ||
          session.controller.signal !== signal
        )
          return
        void this.cancelTurn(session, stream, turnId, "cancelled")
      }
      if (externalSignal.aborted) onAbort()
      else {
        externalSignal.addEventListener("abort", onAbort, { once: true })
        session.turnAbortCleanup = () => externalSignal.removeEventListener("abort", onAbort)
        // Abort can race the registration between the check above and addEventListener.
        if (externalSignal.aborted) onAbort()
      }
    }
    void this.run(session, input.message, stream, signal, turnId)
    return stream
  }

  async cancel(sessionId: string, reason = "cancelled"): Promise<void> {
    const session = this.requireSession(sessionId)
    if (session.closed) return
    if (session.active === undefined) return
    await this.cancelTurn(session, session.active, session.turnId, reason)
  }

  async snapshot(sessionId: string): Promise<AgentSessionSnapshot> {
    return this.requireSession(sessionId).snapshot
  }

  async reload(sessionId: string): Promise<ReloadResult> {
    const session = this.requireSession(sessionId)
    if (session.active !== undefined)
      return {
        revision: session.snapshot.extensionRevision ?? "unchanged",
        loaded: [],
        disabled: [],
        rolledBack: false,
        error: agentError("SESSION_BUSY", "Nifra session is busy"),
      }
    session.extensionRevision += 1
    const revision = `nifra:${session.extensionRevision}`
    session.snapshot = Object.freeze({
      ...session.snapshot,
      extensionRevision: revision,
      updatedAt: this.now(),
    })
    return { revision, loaded: [], disabled: [], rolledBack: false }
  }

  async resolveApproval(
    sessionId: string,
    approvalId: string,
    approved: boolean,
    reason?: string,
  ): Promise<boolean | undefined> {
    const session = this.requireSession(sessionId)
    if (session.closed || session.cancelled) return undefined
    const pending = this.pendingApprovals.get(approvalId)
    if (pending === undefined || pending.sessionId !== sessionId) return undefined
    const resolution = this.settleApproval(
      session,
      approvalId,
      approved === true,
      approved === true ? reason : (reason ?? "approval denied"),
      approved === true ? undefined : "APPROVAL_DENIED",
    )
    return resolution?.approved
  }

  async close(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId)
    if (session.closed) return
    session.closed = true
    session.cancelled = true
    session.turnAbortCleanup?.()
    session.turnAbortCleanup = undefined
    session.controller.abort("closed")
    session.active?.complete()
    session.active = undefined
    session.turnId = undefined
    this.sessions.delete(sessionId)
  }

  private async run(
    session: NativeSession,
    message: string,
    stream: AgentEventStream,
    signal: AbortSignal,
    turnId: string,
  ): Promise<void> {
    if (!this.isCurrentTurn(session, stream, turnId, signal)) {
      stream.complete()
      return
    }
    this.update(session, "running", turnId)
    this.emit(session, { type: "turn.started", turnId, prompt: message })
    session.messages.push({ role: "user", text: message })
    try {
      for (let step = 0; step < this.options.maxSteps; step++) {
        this.assertCurrentTurn(session, stream, turnId, signal)
        const raw = this.options.model.complete({
          sessionId: session.id,
          cwd: session.cwd,
          messages: Object.freeze(session.messages.map((item) => Object.freeze({ ...item }))),
          tools: Object.freeze(
            this.options.tools!.map((tool) => ({
              name: tool.name,
              description: tool.description,
              ...(tool.capabilities === undefined ? {} : { capabilities: tool.capabilities }),
            })),
          ),
          signal,
        })
        const response = await this.consumeModel(raw, session, stream, turnId, signal)
        this.assertCurrentTurn(session, stream, turnId, signal)
        if (response.type === "text") {
          const text = boundedText(response.text, this.options.maxMessageChars)
          session.messages.push({ role: "assistant", text })
          this.emit(session, { type: "assistant.message", turnId, text })
          this.finish(session, stream)
          return
        }
        const tool = this.options.tools!.find((candidate) => candidate.name === response.name)
        if (tool === undefined) {
          this.emit(session, {
            type: "tool.completed",
            turnId,
            callId: crypto.randomUUID(),
            name: response.name,
            ok: false,
            error: agentError("UNKNOWN_TOOL", `unknown native tool: ${response.name}`),
          })
          session.messages.push({ role: "tool", name: response.name, text: "unknown tool" })
          continue
        }
        const callId = crypto.randomUUID()
        const execute = tool.execute
        this.emit(session, {
          type: "tool.started",
          turnId,
          callId,
          name: tool.name,
          input: response.input,
        })
        const needsApproval =
          typeof tool.requiresApproval === "function"
            ? await tool.requiresApproval(response.input)
            : tool.requiresApproval === true
        this.assertCurrentTurn(session, stream, turnId, signal)
        if (needsApproval) {
          const resolution = await this.requestApproval(
            session,
            turnId,
            callId,
            tool,
            response.input,
            signal,
          )
          this.assertCurrentTurn(session, stream, turnId, signal)
          if (!resolution.approved) {
            const code = resolution.errorCode ?? "APPROVAL_DENIED"
            this.emit(session, {
              type: "tool.completed",
              turnId,
              callId,
              name: tool.name,
              ok: false,
              error: agentError(code, boundedApprovalMessage(code, tool.name, resolution.reason)),
            })
            session.messages.push({ role: "tool", name: tool.name, text: code })
            continue
          }
        }
        try {
          const output = await execute(response.input, { cwd: session.cwd, signal })
          this.assertCurrentTurn(session, stream, turnId, signal)
          const text = boundedText(output)
          session.messages.push({ role: "tool", name: tool.name, text })
          this.emit(session, {
            type: "tool.completed",
            turnId,
            callId,
            name: tool.name,
            ok: true,
            output: text,
          })
        } catch (error) {
          if (signal.aborted || !this.isCurrentTurn(session, stream, turnId, signal)) throw error
          const message = boundedText(
            error instanceof Error ? error.message : error,
            this.options.maxMessageChars,
          )
          session.messages.push({ role: "tool", name: tool.name, text: message })
          this.emit(session, {
            type: "tool.completed",
            turnId,
            callId,
            name: tool.name,
            ok: false,
            error: agentError("TOOL_FAILED", message),
          })
        }
      }
      throw new Error("native turn exceeded maxSteps")
    } catch (error) {
      if (!this.isCurrentTurn(session, stream, turnId, signal)) {
        stream.complete()
        return
      }
      if (signal.aborted || session.cancelled) {
        await this.cancelTurn(session, stream, turnId, "cancelled")
        return
      }
      this.update(session, "failed")
      this.emit(session, {
        type: "session.failed",
        error: agentError(
          "NATIVE_TURN_FAILED",
          boundedText(error instanceof Error ? error.message : error, 4_096),
        ),
        recoverable: true,
      })
      stream.complete()
      this.clearTurn(session, stream, turnId)
    }
  }

  private async consumeModel(
    raw: ReturnType<NativeModelPort["complete"]>,
    session: NativeSession,
    stream: AgentEventStream,
    turnId: string,
    signal: AbortSignal,
  ): Promise<NativeModelResponse> {
    if (isAsyncIterable<NativeModelChunk>(raw)) {
      let response: NativeModelResponse | undefined
      for await (const chunk of raw) {
        this.assertCurrentTurn(session, stream, turnId, signal)
        if (chunk.type === "text_delta")
          this.emit(session, { type: "assistant.delta", turnId, text: chunk.text })
        else response = chunk.response
      }
      if (response === undefined) throw new Error("native model stream ended without a response")
      this.assertCurrentTurn(session, stream, turnId, signal)
      return response
    }
    const response = await raw
    this.assertCurrentTurn(session, stream, turnId, signal)
    return response
  }

  private finish(session: NativeSession, stream: AgentEventStream): void {
    this.update(session, "idle")
    this.emit(session, { type: "session.completed", snapshot: session.snapshot })
    stream.complete()
    this.clearTurn(session, stream, session.turnId)
  }

  private requestApproval(
    session: NativeSession,
    turnId: string,
    callId: string,
    tool: NativeTool,
    input: unknown,
    signal: AbortSignal,
  ): Promise<NativeApprovalResolution> {
    const approvalId = `nifra-approval-${crypto.randomUUID()}`
    const action = boundedApprovalText(tool.name, 512)
    const capability = boundedApprovalText(tool.capabilities?.[0] ?? `tool:${tool.name}`, 128)
    let pending!: NativePendingApproval
    const promise = new Promise<NativeApprovalResolution>((resolve) => {
      const onAbort = (): void => {
        this.settleApproval(
          session,
          approvalId,
          false,
          session.closed ? "approval closed" : "approval cancelled",
          session.closed ? "APPROVAL_CLOSED" : "APPROVAL_CANCELLED",
        )
      }
      const timer = setTimeout(
        () => {
          this.settleApproval(session, approvalId, false, "approval timed out", "APPROVAL_TIMEOUT")
        },
        this.options.approvalTimeoutMs ?? 5 * 60_000,
      )
      ;(timer as unknown as { unref?: () => void }).unref?.()
      pending = {
        id: approvalId,
        sessionId: session.id,
        turnId,
        callId,
        action,
        capability,
        resolve,
        timer,
        onAbort,
        signal,
      }
      this.pendingApprovals.set(approvalId, pending)
      signal.addEventListener("abort", onAbort, { once: true })
    })

    this.emit(session, {
      type: "approval.required",
      turnId,
      approvalId,
      action,
      capability,
    })

    if (signal.aborted) pending.onAbort()
    else if (this.options.approval !== undefined) {
      try {
        void Promise.resolve(
          this.options.approval.request({
            sessionId: session.id,
            approvalId,
            turnId,
            callId,
            action,
            capability,
            tool,
            input,
            signal,
          }),
        ).then(
          (approved) =>
            this.settleApproval(
              session,
              approvalId,
              approved === true,
              approved === true ? undefined : "approval denied",
              approved === true ? undefined : "APPROVAL_DENIED",
            ),
          () =>
            this.settleApproval(
              session,
              approvalId,
              false,
              "approval callback failed",
              "APPROVAL_FAILED",
            ),
        )
      } catch {
        this.settleApproval(
          session,
          approvalId,
          false,
          "approval callback failed",
          "APPROVAL_FAILED",
        )
      }
    }
    return promise
  }

  private settleApproval(
    session: NativeSession,
    approvalId: string,
    approved: boolean,
    reason: string | undefined,
    errorCode: NativeApprovalFailureCode | undefined,
  ): NativeApprovalResolution | undefined {
    const pending = this.pendingApprovals.get(approvalId)
    if (pending === undefined || pending.sessionId !== session.id) return undefined
    clearTimeout(pending.timer)
    pending.signal.removeEventListener("abort", pending.onAbort)
    this.pendingApprovals.delete(approvalId)
    const boundedReason = reason === undefined ? undefined : boundedApprovalText(reason, 512)
    const resolution: NativeApprovalResolution = Object.freeze({
      approved,
      ...(boundedReason === undefined ? {} : { reason: boundedReason }),
      ...(errorCode === undefined ? {} : { errorCode }),
    })
    this.emit(session, {
      type: "approval.resolved",
      turnId: pending.turnId,
      approvalId,
      approved,
      ...(boundedReason === undefined ? {} : { reason: boundedReason }),
    })
    pending.resolve(resolution)
    return resolution
  }

  private async cancelTurn(
    session: NativeSession,
    expectedStream: AgentEventStream | undefined,
    expectedTurnId: string | undefined,
    reason: string,
  ): Promise<void> {
    if (
      expectedStream !== undefined &&
      (session.active !== expectedStream || session.turnId !== expectedTurnId)
    )
      return
    const stream = session.active
    const turnId = session.turnId
    const stopReason = boundedText(reason, 512) || "cancelled"
    session.cancelled = true
    this.clearTurnSignal(session)
    try {
      session.controller.abort(stopReason)
    } catch {
      // AbortController.abort is normally infallible; lifecycle cleanup must still complete if a
      // host supplies an unusual controller implementation.
    }
    this.update(session, "stopped")
    this.emit(session, { type: "session.stopped", reason: stopReason })
    stream?.complete()
    this.clearTurn(session, stream, turnId)
  }

  private clearTurnSignal(session: NativeSession): void {
    session.turnAbortCleanup?.()
    session.turnAbortCleanup = undefined
  }

  private clearTurn(
    session: NativeSession,
    stream: AgentEventStream | undefined,
    turnId: string | undefined,
  ): void {
    if (stream !== undefined && session.active !== stream) return
    if (turnId !== undefined && session.turnId !== turnId) return
    this.clearTurnSignal(session)
    if (stream === undefined || session.active === stream) session.active = undefined
    if (turnId === undefined || session.turnId === turnId) session.turnId = undefined
  }

  private isCurrentTurn(
    session: NativeSession,
    stream: AgentEventStream,
    turnId: string,
    signal: AbortSignal,
  ): boolean {
    return (
      !session.closed &&
      !session.cancelled &&
      session.active === stream &&
      session.turnId === turnId &&
      session.controller.signal === signal
    )
  }

  private assertCurrentTurn(
    session: NativeSession,
    stream: AgentEventStream,
    turnId: string,
    signal: AbortSignal,
  ): void {
    if (signal.aborted || !this.isCurrentTurn(session, stream, turnId, signal))
      throw new Error("native turn cancelled")
  }

  private emit(
    session: NativeSession,
    payload: import("@nifrajs/agent-protocol").AgentEventPayload,
  ): void {
    const event = Object.freeze({
      version: 1 as const,
      sessionId: session.id,
      seq: session.seq++,
      at: this.now(),
      ...payload,
    }) as AgentEvent
    if (!isAgentEvent(event))
      throw new Error("nifra backend emitted an event outside protocol bounds")
    session.snapshot = Object.freeze({
      ...session.snapshot,
      lastSeq: event.seq,
      updatedAt: event.at,
    })
    session.active?.push(event)
  }

  private update(
    session: NativeSession,
    status: AgentSessionSnapshot["status"],
    turnId?: string,
  ): void {
    const next = { ...session.snapshot, status, updatedAt: this.now(), lastSeq: session.seq }
    session.snapshot = Object.freeze(
      status === "running" && turnId !== undefined
        ? { ...next, activeTurnId: turnId }
        : removeActiveTurn(next),
    )
    if (session.active !== undefined)
      this.emit(session, { type: "session.updated", snapshot: session.snapshot })
  }

  private requireSession(id: string): NativeSession {
    const session = this.sessions.get(id)
    if (session === undefined) throw new Error(`nifra backend: unknown session: ${id}`)
    return session
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return value !== null && typeof value === "object" && Symbol.asyncIterator in value
}

function boundedText(value: unknown, maxChars = 64 * 1024): string {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value)
    if (typeof text !== "string") return "[unserializable tool output]"
    const suffix = "…[truncated]"
    return text.length > maxChars
      ? `${text.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`
      : text
  } catch {
    return "[unserializable tool output]"
  }
}

function boundedApprovalToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:/-]{1,128}$/.test(value)
}

function boundedApprovalText(value: string, maxChars: number): string {
  const text = value.trim()
  if (text.length === 0) return "native tool"
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text
}

function boundedApprovalMessage(
  code: NativeApprovalFailureCode,
  toolName: string,
  reason: string | undefined,
): string {
  const base =
    code === "APPROVAL_DENIED"
      ? "approval denied"
      : code === "APPROVAL_TIMEOUT"
        ? "approval timed out"
        : code === "APPROVAL_CANCELLED"
          ? "approval cancelled"
          : code === "APPROVAL_CLOSED"
            ? "approval closed"
            : "approval failed"
  const name = boundedApprovalText(toolName, 128)
  const suffix = reason === undefined || reason === "approval denied" ? "" : `: ${reason}`
  return boundedApprovalText(`${base} for ${name}${suffix}`, 512)
}

function failedStream(error: unknown): AgentEventStream {
  const stream = createAgentEventStream()
  stream.fail(error)
  return stream
}

function removeActiveTurn(
  snapshot: Omit<AgentSessionSnapshot, "activeTurnId"> & { readonly activeTurnId?: string },
): Omit<AgentSessionSnapshot, "activeTurnId"> {
  const { activeTurnId: _activeTurnId, ...withoutActiveTurn } = snapshot
  return withoutActiveTurn
}

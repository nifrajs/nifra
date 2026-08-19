import {
  type AgentBackend,
  type AgentBackendInfo,
  type AgentEvent,
  type AgentEventStream,
  type AgentSessionSnapshot,
  agentError,
  type CreateSessionInput,
  createAgentEventStream,
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

export interface NativeApprovalPort {
  request(input: {
    readonly sessionId: string
    readonly tool: NativeTool
    readonly input: unknown
    readonly signal: AbortSignal
  }): boolean | PromiseLike<boolean>
}

export interface NifraBackendOptions {
  readonly model: NativeModelPort
  readonly tools?: readonly NativeTool[]
  readonly approval?: NativeApprovalPort
  readonly maxSteps?: number
  readonly maxMessageChars?: number
  readonly now?: () => number
}

interface NativeSession {
  readonly id: string
  readonly cwd: string
  readonly messages: NativeMessage[]
  controller: AbortController
  snapshot: AgentSessionSnapshot
  active: AgentEventStream | undefined
  seq: number
  extensionRevision: number
  closed: boolean
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
  }

  async createSession(input: CreateSessionInput): Promise<AgentSessionSnapshot> {
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
      seq: 0,
      extensionRevision: 0,
      closed: false,
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
    session.controller = new AbortController()
    const signal = session.controller.signal
    if (input.signal !== undefined) {
      const externalSignal = input.signal
      if (externalSignal.aborted) session.controller.abort(externalSignal.reason)
      else
        externalSignal.addEventListener(
          "abort",
          () => session.controller.abort(externalSignal.reason),
          { once: true },
        )
    }
    void this.run(session, input.message, stream, signal)
    return stream
  }

  async cancel(sessionId: string, reason = "cancelled"): Promise<void> {
    const session = this.requireSession(sessionId)
    if (session.closed) return
    const stream = session.active
    session.controller.abort(reason)
    this.update(session, "stopped")
    this.emit(session, { type: "session.stopped", reason })
    stream?.complete()
    session.active = undefined
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

  async close(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId)
    if (session.closed) return
    session.closed = true
    session.controller.abort("closed")
    session.active?.complete()
    session.active = undefined
    this.sessions.delete(sessionId)
  }

  private async run(
    session: NativeSession,
    message: string,
    stream: AgentEventStream,
    signal: AbortSignal,
  ): Promise<void> {
    const turnId = crypto.randomUUID()
    this.update(session, "running", turnId)
    this.emit(session, { type: "turn.started", turnId, prompt: message })
    session.messages.push({ role: "user", text: message })
    try {
      for (let step = 0; step < this.options.maxSteps; step++) {
        if (signal.aborted) throw new Error("native turn cancelled")
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
        const response = await this.consumeModel(raw, session, turnId, signal)
        if (response.type === "text") {
          session.messages.push({ role: "assistant", text: response.text })
          this.emit(session, { type: "assistant.message", turnId, text: response.text })
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
        if (needsApproval) {
          if (
            this.options.approval === undefined ||
            !(await this.options.approval.request({
              sessionId: session.id,
              tool,
              input: response.input,
              signal,
            }))
          ) {
            this.emit(session, {
              type: "tool.completed",
              turnId,
              callId,
              name: tool.name,
              ok: false,
              error: agentError("APPROVAL_DENIED", `approval denied for ${tool.name}`),
            })
            session.messages.push({ role: "tool", name: tool.name, text: "approval denied" })
            continue
          }
        }
        try {
          const output = await tool.execute(response.input, { cwd: session.cwd, signal })
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
          const message = error instanceof Error ? error.message : String(error)
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
      if (session.closed) return
      this.update(session, signal.aborted ? "stopped" : "failed")
      this.emit(session, {
        type: "session.failed",
        error: agentError(
          signal.aborted ? "TURN_CANCELLED" : "NATIVE_TURN_FAILED",
          error instanceof Error ? error.message : String(error),
        ),
        recoverable: true,
      })
      stream.complete()
      session.active = undefined
    }
  }

  private async consumeModel(
    raw: ReturnType<NativeModelPort["complete"]>,
    session: NativeSession,
    turnId: string,
    signal: AbortSignal,
  ): Promise<NativeModelResponse> {
    if (isAsyncIterable<NativeModelChunk>(raw)) {
      let response: NativeModelResponse | undefined
      for await (const chunk of raw) {
        if (signal.aborted) throw new Error("native turn cancelled")
        if (chunk.type === "text_delta")
          this.emit(session, { type: "assistant.delta", turnId, text: chunk.text })
        else response = chunk.response
      }
      if (response === undefined) throw new Error("native model stream ended without a response")
      return response
    }
    return await raw
  }

  private finish(session: NativeSession, stream: AgentEventStream): void {
    this.update(session, "idle")
    this.emit(session, { type: "session.completed", snapshot: session.snapshot })
    stream.complete()
    session.active = undefined
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
      status === "running" && turnId !== undefined ? { ...next, activeTurnId: turnId } : next,
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

function boundedText(value: unknown): string {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value)
    return text.length > 64 * 1024 ? `${text.slice(0, 64 * 1024)}…[truncated]` : text
  } catch {
    return "[unserializable tool output]"
  }
}

function failedStream(error: unknown): AgentEventStream {
  const stream = createAgentEventStream()
  stream.fail(error)
  return stream
}

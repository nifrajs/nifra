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

export interface ReplayBackendOptions {
  readonly events: readonly AgentEvent[]
  readonly delayMs?: number
}

interface ReplaySession {
  readonly id: string
  snapshot: AgentSessionSnapshot
  active: AgentEventStream | undefined
  controller: AbortController
  turnId: string | undefined
  turnAbortCleanup: (() => void) | undefined
  closed: boolean
  seq: number
}

/** Deterministic protocol backend for demos, CI, and UI regression tests. */
export class ReplayBackend implements AgentBackend {
  readonly info: AgentBackendInfo = Object.freeze({
    name: "replay",
    capabilities: Object.freeze(["sessions", "streaming", "replay"]),
  })
  /** Serialized immutable source records; parsing per replay prevents caller/consumer mutation leaks. */
  private readonly events: readonly string[]
  private readonly delayMs: number
  private readonly sessions = new Map<string, ReplaySession>()

  constructor(options: ReplayBackendOptions) {
    if (
      !Array.isArray(options.events) ||
      options.events.length > MAX_REPLAY_EVENTS ||
      !options.events.every((event) => isAgentEvent(event))
    )
      throw new TypeError("replay backend: events must be valid agent events")
    const encoded: string[] = []
    let totalBytes = 0
    for (const event of options.events) {
      let line: string
      try {
        // Clone before serializing so a hostile `toJSON`/nested reference cannot mutate the caller's
        // record or make the replay depend on later mutations. The serialized form is the immutable
        // source used for every turn below.
        const clone = structuredClone(event) as AgentEvent
        if (!isAgentEvent(clone)) throw new TypeError("replay event clone is invalid")
        line = JSON.stringify(clone)
      } catch {
        throw new TypeError("replay backend: events must be JSON-serializable")
      }
      const bytes = new TextEncoder().encode(line).byteLength + 1
      if (totalBytes > MAX_REPLAY_BYTES - bytes)
        throw new RangeError("replay backend: events exceed the total size limit")
      totalBytes += bytes
      encoded.push(line)
    }
    this.events = Object.freeze(encoded)
    this.delayMs = options.delayMs ?? 0
    if (!Number.isSafeInteger(this.delayMs) || this.delayMs < 0 || this.delayMs > 60_000)
      throw new RangeError("replay backend: delayMs must be between 0 and 60000")
  }

  async createSession(input: CreateSessionInput): Promise<AgentSessionSnapshot> {
    if (
      typeof input.cwd !== "string" ||
      input.cwd.length === 0 ||
      input.cwd.length > 4_096 ||
      input.cwd.includes("\0")
    )
      throw new TypeError("replay backend: cwd must be a bounded non-empty path")
    if (
      input.capabilities !== undefined &&
      (!Array.isArray(input.capabilities) ||
        input.capabilities.length > 256 ||
        !input.capabilities.every((value) => boundedReplayToken(value)))
    )
      throw new TypeError("replay backend: capabilities must be bounded tokens")
    const id = input.sessionId ?? crypto.randomUUID()
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(id))
      throw new TypeError("replay backend: invalid sessionId")
    if (this.sessions.has(id)) throw new Error(`replay backend: session already exists: ${id}`)
    const now = Date.now()
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
    this.sessions.set(id, {
      id,
      snapshot,
      active: undefined,
      controller: new AbortController(),
      turnId: undefined,
      turnAbortCleanup: undefined,
      closed: false,
      seq: 0,
    })
    return snapshot
  }

  send(input: SendMessageInput): AsyncIterable<AgentEvent> {
    const session = this.requireSession(input.sessionId)
    if (session.closed)
      return failedStream(agentError("SESSION_CLOSED", "replay session is closed"))
    if (session.active !== undefined)
      return failedStream(agentError("SESSION_BUSY", "replay session is busy"))
    const stream = createAgentEventStream()
    session.active = stream
    session.controller = new AbortController()
    session.turnId = crypto.randomUUID()
    const turnId = session.turnId
    const signal = session.controller.signal
    if (input.signal !== undefined) {
      const externalSignal = input.signal
      const onAbort = (): void => {
        if (session.active !== stream || session.turnId !== turnId) return
        void this.cancelTurn(session, stream, turnId, "cancelled")
      }
      if (externalSignal.aborted) onAbort()
      else {
        externalSignal.addEventListener("abort", onAbort, { once: true })
        session.turnAbortCleanup = () => externalSignal.removeEventListener("abort", onAbort)
        if (externalSignal.aborted) onAbort()
      }
    }
    if (session.active === stream && session.turnId === turnId)
      void this.replay(session, stream, turnId, signal)
    return stream
  }

  async cancel(sessionId: string, reason = "cancelled"): Promise<void> {
    const session = this.requireSession(sessionId)
    if (session.active === undefined) return
    await this.cancelTurn(session, session.active, session.turnId, reason)
  }

  async snapshot(sessionId: string): Promise<AgentSessionSnapshot> {
    return this.requireSession(sessionId).snapshot
  }

  async reload(sessionId: string): Promise<ReloadResult> {
    const session = this.requireSession(sessionId)
    const revision = `replay:${this.events.length}`
    session.snapshot = Object.freeze({
      ...session.snapshot,
      extensionRevision: revision,
      updatedAt: Date.now(),
    })
    return { revision, loaded: [], disabled: [], rolledBack: false }
  }

  async close(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId)
    session.closed = true
    session.turnAbortCleanup?.()
    session.turnAbortCleanup = undefined
    session.controller.abort("closed")
    session.active?.complete()
    session.active = undefined
    session.turnId = undefined
    this.sessions.delete(sessionId)
  }

  private async replay(
    session: ReplaySession,
    stream: AgentEventStream,
    turnId: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.isCurrentTurn(session, stream, turnId, signal)) return
    session.snapshot = Object.freeze({
      ...session.snapshot,
      status: "running",
      updatedAt: Date.now(),
    })
    try {
      for (const encoded of this.events) {
        if (this.delayMs > 0) await delay(this.delayMs, signal)
        if (!this.isCurrentTurn(session, stream, turnId, signal)) return
        const source = JSON.parse(encoded) as AgentEvent
        this.push(session, remap(source, session.id, session.seq))
      }
      if (!this.isCurrentTurn(session, stream, turnId, signal)) return
      session.snapshot = Object.freeze({
        ...session.snapshot,
        status: "idle",
        updatedAt: Date.now(),
      })
      this.push(session, { type: "session.completed", snapshot: session.snapshot })
    } catch (error) {
      if (!this.isCurrentTurn(session, stream, turnId, signal)) return
      this.push(session, {
        type: "session.failed",
        error: agentError("REPLAY_FAILED", error instanceof Error ? error.message : String(error)),
        recoverable: true,
      })
    } finally {
      if (this.isCurrentTurn(session, stream, turnId, signal)) {
        stream.complete()
        this.clearTurn(session, stream, turnId)
      }
    }
  }

  private async cancelTurn(
    session: ReplaySession,
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
    const stopReason = boundedReplayReason(reason)
    session.turnAbortCleanup?.()
    session.turnAbortCleanup = undefined
    session.controller.abort(stopReason)
    if (stream !== undefined && turnId !== undefined) {
      session.snapshot = Object.freeze({
        ...session.snapshot,
        status: "stopped",
        updatedAt: Date.now(),
      })
      this.push(session, { type: "session.stopped", reason: stopReason })
      stream.complete()
    } else {
      session.snapshot = Object.freeze({
        ...session.snapshot,
        status: "stopped",
        updatedAt: Date.now(),
      })
    }
    this.clearTurn(session, stream, turnId)
  }

  private isCurrentTurn(
    session: ReplaySession,
    stream: AgentEventStream,
    turnId: string,
    signal: AbortSignal,
  ): boolean {
    return (
      !session.closed &&
      !signal.aborted &&
      session.active === stream &&
      session.turnId === turnId &&
      session.controller.signal === signal
    )
  }

  private clearTurn(
    session: ReplaySession,
    stream: AgentEventStream | undefined,
    turnId: string | undefined,
  ): void {
    if (stream !== undefined && session.active !== stream) return
    if (turnId !== undefined && session.turnId !== turnId) return
    session.turnAbortCleanup?.()
    session.turnAbortCleanup = undefined
    if (stream === undefined || session.active === stream) session.active = undefined
    if (turnId === undefined || session.turnId === turnId) session.turnId = undefined
  }

  private push(
    session: ReplaySession,
    event: AgentEvent | import("@nifrajs/agent-protocol").AgentEventPayload,
  ): void {
    const next =
      "version" in event && "sessionId" in event
        ? event
        : { version: 1 as const, sessionId: session.id, seq: session.seq, at: Date.now(), ...event }
    if (!isAgentEvent(next)) throw new Error("replay backend produced an invalid event")
    session.seq = next.seq + 1
    session.snapshot = Object.freeze({ ...session.snapshot, lastSeq: next.seq, updatedAt: next.at })
    session.active?.push(next as AgentEvent)
  }

  private requireSession(id: string): ReplaySession {
    const session = this.sessions.get(id)
    if (session === undefined) throw new Error(`replay backend: unknown session: ${id}`)
    return session
  }
}

export async function readReplayEvents(path: string): Promise<readonly AgentEvent[]> {
  const file = Bun.file(path)
  if (file.size > MAX_REPLAY_BYTES) throw new RangeError("replay: event file is too large")
  const text = await file.text()
  const events: AgentEvent[] = []
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue
    if (events.length >= MAX_REPLAY_EVENTS) throw new RangeError("replay: too many events")
    const value: unknown = JSON.parse(line)
    if (!isAgentEvent(value)) throw new Error(`replay: invalid event in ${path}`)
    events.push(value)
  }
  return Object.freeze(events)
}

function remap(event: AgentEvent, sessionId: string, seq: number): AgentEvent {
  const base = { ...event, sessionId, seq, at: Date.now() }
  if (
    event.type === "session.started" ||
    event.type === "session.updated" ||
    event.type === "session.completed"
  )
    return Object.freeze({
      ...base,
      snapshot: Object.freeze({ ...event.snapshot, id: sessionId }),
    })
  return Object.freeze(base)
}

const MAX_REPLAY_BYTES = 64 * 1024 * 1024
const MAX_REPLAY_EVENTS = 100_000

function boundedReplayReason(reason: string): string {
  if (reason.length <= 512) return reason
  return `${reason.slice(0, 511)}…`
}

function boundedReplayToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:/-]{1,128}$/.test(value)
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => settle(), ms)
    const onAbort = (): void => settle(new Error("replay cancelled"))
    const cleanup = (): void => signal.removeEventListener("abort", onAbort)
    const settle = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      if (error === undefined) resolve()
      else reject(error)
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  })
}

function failedStream(error: unknown): AgentEventStream {
  const stream = createAgentEventStream()
  stream.fail(error)
  return stream
}

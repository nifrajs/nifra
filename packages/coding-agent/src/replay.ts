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

export interface ReplayBackendOptions {
  readonly events: readonly AgentEvent[]
  readonly delayMs?: number
}

interface ReplaySession {
  readonly id: string
  snapshot: AgentSessionSnapshot
  active: AgentEventStream | undefined
  closed: boolean
  seq: number
}

/** Deterministic protocol backend for demos, CI, and UI regression tests. */
export class ReplayBackend implements AgentBackend {
  readonly info: AgentBackendInfo = Object.freeze({
    name: "replay",
    capabilities: Object.freeze(["sessions", "streaming", "replay"]),
  })
  private readonly events: readonly AgentEvent[]
  private readonly delayMs: number
  private readonly sessions = new Map<string, ReplaySession>()

  constructor(options: ReplayBackendOptions) {
    this.events = Object.freeze(options.events.map((event) => Object.freeze({ ...event })))
    this.delayMs = options.delayMs ?? 0
    if (!Number.isSafeInteger(this.delayMs) || this.delayMs < 0 || this.delayMs > 60_000)
      throw new RangeError("replay backend: delayMs must be between 0 and 60000")
  }

  async createSession(input: CreateSessionInput): Promise<AgentSessionSnapshot> {
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
    this.sessions.set(id, { id, snapshot, active: undefined, closed: false, seq: 0 })
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
    void this.replay(session, stream)
    return stream
  }

  async cancel(sessionId: string, reason = "cancelled"): Promise<void> {
    const session = this.requireSession(sessionId)
    session.active?.complete()
    session.active = undefined
    session.snapshot = Object.freeze({
      ...session.snapshot,
      status: "stopped",
      updatedAt: Date.now(),
    })
    if (session.seq === 0) this.push(session, { type: "session.stopped", reason })
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
    session.active?.complete()
    session.active = undefined
    this.sessions.delete(sessionId)
  }

  private async replay(session: ReplaySession, stream: AgentEventStream): Promise<void> {
    session.snapshot = Object.freeze({
      ...session.snapshot,
      status: "running",
      updatedAt: Date.now(),
    })
    try {
      for (const source of this.events) {
        if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs))
        this.push(session, remap(source, session.id, session.seq))
      }
      session.snapshot = Object.freeze({
        ...session.snapshot,
        status: "idle",
        updatedAt: Date.now(),
      })
      this.push(session, { type: "session.completed", snapshot: session.snapshot })
    } catch (error) {
      this.push(session, {
        type: "session.failed",
        error: agentError("REPLAY_FAILED", error instanceof Error ? error.message : String(error)),
        recoverable: true,
      })
    } finally {
      stream.complete()
      session.active = undefined
    }
  }

  private push(
    session: ReplaySession,
    event: AgentEvent | import("@nifrajs/agent-protocol").AgentEventPayload,
  ): void {
    const next =
      "version" in event && "sessionId" in event
        ? event
        : { version: 1 as const, sessionId: session.id, seq: session.seq, at: Date.now(), ...event }
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
  const text = await Bun.file(path).text()
  const events: AgentEvent[] = []
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue
    const value: unknown = JSON.parse(line)
    if (!isAgentEvent(value)) throw new Error(`replay: invalid event in ${path}`)
    events.push(value)
  }
  return Object.freeze(events)
}

function remap(event: AgentEvent, sessionId: string, seq: number): AgentEvent {
  return Object.freeze({ ...event, sessionId, seq, at: Date.now() })
}

function isAgentEvent(value: unknown): value is AgentEvent {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { version?: unknown }).version === 1 &&
    typeof (value as { type?: unknown }).type === "string"
  )
}

function failedStream(error: unknown): AgentEventStream {
  const stream = createAgentEventStream()
  stream.fail(error)
  return stream
}

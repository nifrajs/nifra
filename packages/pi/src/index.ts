import { fileURLToPath } from "node:url"
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

export interface PiBackendOptions {
  /** Defaults to `pi`, resolved through PATH. */
  readonly command?: string
  /** Extra arguments appended after `--mode rpc`. */
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly sessionDir?: string
  readonly noSession?: boolean
  /** Override the generated Pi flags for a test double or a compatible RPC executable. */
  readonly rpcArgs?: readonly string[]
  /**
   * Reload transport. Pi's documented RPC protocol uses a slash command bridged by a tiny
   * extension; compatible RPC implementations may opt into their legacy top-level command.
   */
  readonly reloadCommand?: "restart" | "prompt" | "rpc"
  /** Load the tiny public-API reload bridge. Defaults to true for generated Pi processes. */
  readonly enableReloadBridge?: boolean
  readonly maxEventQueueSize?: number
  /** Optional project instructions passed through Pi's documented append-system-prompt flag. */
  readonly appendSystemPrompt?: string
  /** Opt-in loading of the separately packaged Nifra verification tools extension. */
  readonly enableNifraTools?: boolean
}

interface PiSession {
  readonly id: string
  readonly cwd: string
  process: Bun.Subprocess
  snapshot: AgentSessionSnapshot
  active: AgentEventStream | undefined
  seq: number
  turnId: string | undefined
  reloadRequested: boolean
  reloadRevision: number
  restarting: boolean
  buffer: string
  closed: boolean
  readonly approvals: Map<string, { readonly method: string }>
}

interface PiRpcRecord {
  readonly type?: string
  readonly id?: string | number
  readonly command?: string
  readonly success?: boolean
  readonly error?: unknown
  readonly data?: unknown
  readonly [key: string]: unknown
}

const INFO: AgentBackendInfo = Object.freeze({
  name: "pi",
  capabilities: Object.freeze([
    "sessions",
    "compaction",
    "extensions",
    "reload",
    "approvals",
    "streaming",
    "jsonl",
  ]),
})

/**
 * Spawn Pi in its documented JSONL RPC mode and translate its events into the Nifra protocol.
 *
 * This adapter intentionally talks to the public Pi process protocol instead of importing Pi into
 * any Nifra framework package. A future SDK adapter can implement the same AgentBackend contract.
 */
export class PiBackend implements AgentBackend {
  readonly info = INFO
  private readonly options: PiBackendOptions
  private readonly sessions = new Map<string, PiSession>()

  constructor(options: PiBackendOptions = {}) {
    this.options = Object.freeze({ ...options })
  }

  async createSession(input: CreateSessionInput): Promise<AgentSessionSnapshot> {
    const id = input.sessionId ?? crypto.randomUUID()
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(id))
      throw new TypeError("pi backend: sessionId must be a bounded token")
    if (this.sessions.has(id)) throw new Error(`pi backend: session already exists: ${id}`)

    const proc = this.spawnProcess(input.cwd, id)
    const now = Date.now()
    const snapshot: AgentSessionSnapshot = {
      version: 1,
      id,
      backend: INFO.name,
      cwd: input.cwd,
      status: "idle",
      createdAt: now,
      updatedAt: now,
      lastSeq: 0,
      capabilities: Object.freeze([...(input.capabilities ?? INFO.capabilities)]),
    }
    const session: PiSession = {
      id,
      cwd: input.cwd,
      process: proc,
      snapshot,
      active: undefined,
      seq: 0,
      turnId: undefined,
      reloadRequested: false,
      reloadRevision: 0,
      restarting: false,
      buffer: "",
      closed: false,
      approvals: new Map(),
    }
    this.sessions.set(id, session)
    this.attachProcess(session, proc)
    return snapshot
  }

  send(input: SendMessageInput): AsyncIterable<AgentEvent> {
    const session = this.requireSession(input.sessionId)
    if (session.closed) return failedStream(agentError("SESSION_CLOSED", "Pi session is closed"))
    if (session.active !== undefined)
      return failedStream(agentError("SESSION_BUSY", "Pi session already has an active turn"))

    const stream = createAgentEventStream(this.options.maxEventQueueSize ?? 256)
    session.active = stream
    session.turnId = crypto.randomUUID()
    session.reloadRequested = false
    this.updateSnapshot(session, "running")
    this.emit(session, {
      type: "turn.started",
      turnId: session.turnId,
      prompt: input.message,
    })
    try {
      writeRpc(session, { type: "prompt", message: input.message })
    } catch (error) {
      stream.fail(error)
      session.active = undefined
      this.updateSnapshot(session, "failed")
    }
    if (input.signal !== undefined) {
      if (input.signal.aborted) void this.cancel(session.id, "cancelled")
      else
        input.signal.addEventListener("abort", () => void this.cancel(session.id, "cancelled"), {
          once: true,
        })
    }
    return stream
  }

  async cancel(sessionId: string, reason = "cancelled"): Promise<void> {
    const session = this.requireSession(sessionId)
    if (session.closed) return
    writeRpc(session, { type: "abort" })
    this.updateSnapshot(session, "stopped")
    this.emit(session, { type: "session.stopped", reason })
    session.active?.complete()
    session.active = undefined
  }

  async snapshot(sessionId: string): Promise<AgentSessionSnapshot> {
    return this.requireSession(sessionId).snapshot
  }

  async reload(sessionId: string): Promise<ReloadResult> {
    const session = this.requireSession(sessionId)
    if (session.closed) {
      return {
        revision: "closed",
        loaded: [],
        disabled: [],
        rolledBack: false,
        error: agentError("SESSION_CLOSED", "Pi session is closed"),
      }
    }
    if (session.active !== undefined) {
      return {
        revision: session.snapshot.extensionRevision ?? "unchanged",
        loaded: [],
        disabled: [],
        rolledBack: false,
        error: agentError("SESSION_BUSY", "Pi session already has an active turn"),
      }
    }
    if ((this.options.reloadCommand ?? "restart") === "restart") {
      const previous = session.process
      session.restarting = true
      previous.kill()
      await previous.exited
      if (session.closed && !session.restarting) {
        return {
          revision: session.snapshot.extensionRevision ?? "closed",
          loaded: [],
          disabled: [],
          rolledBack: false,
          error: agentError("SESSION_CLOSED", "Pi session closed during reload"),
        }
      }
      session.buffer = ""
      session.reloadRevision += 1
      const revision = `pi:${session.reloadRevision}`
      session.snapshot = Object.freeze({
        ...session.snapshot,
        extensionRevision: revision,
        updatedAt: Date.now(),
      })
      session.closed = false
      session.restarting = false
      this.attachProcess(session, this.spawnProcess(session.cwd, session.id))
      return { revision, loaded: [], disabled: [], rolledBack: false }
    }
    const stream = createAgentEventStream(this.options.maxEventQueueSize ?? 256)
    session.active = stream
    session.turnId = crypto.randomUUID()
    session.reloadRequested = true
    this.updateSnapshot(session, "running")
    this.emit(session, { type: "turn.started", turnId: session.turnId, prompt: "/reload" })
    try {
      if (this.options.reloadCommand === "rpc") writeRpc(session, { type: "reload" })
      else writeRpc(session, { type: "prompt", message: "/reload" })
    } catch (error) {
      stream.fail(error)
      session.active = undefined
      this.updateSnapshot(session, "failed")
    }
    try {
      for await (const event of stream) {
        if (event.type === "extension.reloaded") {
          return {
            revision: event.revision,
            loaded: event.loaded,
            disabled: event.disabled,
            rolledBack: event.rolledBack,
          }
        }
        if (event.type === "session.failed") {
          return {
            revision: session.snapshot.extensionRevision ?? "unchanged",
            loaded: [],
            disabled: [],
            rolledBack: false,
            error: event.error,
          }
        }
      }
    } catch (error) {
      return {
        revision: session.snapshot.extensionRevision ?? "unchanged",
        loaded: [],
        disabled: [],
        rolledBack: false,
        error: agentError("RELOAD_FAILED", error instanceof Error ? error.message : String(error)),
      }
    }
    return {
      revision: session.snapshot.extensionRevision ?? "unknown",
      loaded: [],
      disabled: [],
      rolledBack: false,
    }
  }

  async resolveApproval(
    sessionId: string,
    approvalId: string,
    approved: boolean,
  ): Promise<boolean | undefined> {
    const session = this.requireSession(sessionId)
    const pending = session.approvals.get(approvalId)
    if (pending === undefined) return undefined
    session.approvals.delete(approvalId)
    writeRpc(session, {
      type: "extension_ui_response",
      id: approvalId,
      ...(pending.method === "confirm"
        ? { confirmed: approved === true }
        : { cancelled: approved !== true }),
    })
    return true
  }

  async close(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId)
    if (session.closed) {
      this.sessions.delete(sessionId)
      return
    }
    session.active?.complete()
    session.active = undefined
    session.approvals.clear()
    session.closed = true
    session.process.kill()
    await session.process.exited
    this.sessions.delete(sessionId)
  }

  private requireSession(id: string): PiSession {
    const session = this.sessions.get(id)
    if (session === undefined) throw new Error(`pi backend: unknown session: ${id}`)
    return session
  }

  private spawnProcess(cwd: string, id: string): Bun.Subprocess {
    const args =
      this.options.rpcArgs === undefined
        ? ["--mode", "rpc", ...(this.options.noSession === false ? [] : ["--no-session"])]
        : [...this.options.rpcArgs]
    if (this.options.rpcArgs === undefined) {
      if (this.options.sessionDir !== undefined) args.push("--session-dir", this.options.sessionDir)
      if (this.options.noSession === false) args.push("--session-id", id)
      if (this.options.appendSystemPrompt !== undefined)
        args.push("--append-system-prompt", this.options.appendSystemPrompt)
      if (this.options.enableReloadBridge !== false)
        args.push("--extension", fileURLToPath(new URL("../extensions/reload.ts", import.meta.url)))
      if (this.options.enableNifraTools === true)
        args.push("--extension", fileURLToPath(new URL("../extensions/nifra.ts", import.meta.url)))
    }
    args.push(...(this.options.args ?? []))
    return Bun.spawn([this.options.command ?? "pi", ...args], {
      cwd,
      env: filteredEnv(this.options.env),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
  }

  private attachProcess(session: PiSession, process: Bun.Subprocess): void {
    session.process = process
    void this.readStdout(session)
    void this.readStderr(session)
    void process.exited.then((exitCode) => {
      if (session.process !== process || session.restarting) return
      session.closed = true
      if (session.active !== undefined) {
        session.active.fail(
          agentError("PI_EXITED", `Pi exited with code ${exitCode}`, { exitCode }),
        )
        session.active = undefined
      }
    })
  }

  private async readStdout(session: PiSession): Promise<void> {
    const stdout = session.process.stdout
    if (stdout === undefined || stdout === null || typeof stdout === "number") return
    const reader = stdout.getReader()
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value !== undefined) this.consumeText(session, decoder.decode(value, { stream: true }))
      }
      const tail = decoder.decode()
      if (tail.length > 0) this.consumeText(session, tail)
    } finally {
      reader.releaseLock()
    }
  }

  private async readStderr(session: PiSession): Promise<void> {
    const stderr = session.process.stderr
    if (stderr === undefined || stderr === null || typeof stderr === "number") return
    const reader = stderr.getReader()
    try {
      while (!(await reader.read()).done) {
        // Pi diagnostics stay out of the protocol stream. The process exit path reports the code.
      }
    } finally {
      reader.releaseLock()
    }
  }

  private consumeText(session: PiSession, text: string): void {
    session.buffer += text
    for (;;) {
      const newline = session.buffer.indexOf("\n")
      if (newline === -1) return
      let line = session.buffer.slice(0, newline)
      session.buffer = session.buffer.slice(newline + 1)
      if (line.endsWith("\r")) line = line.slice(0, -1)
      if (line.length === 0) continue
      let record: PiRpcRecord
      try {
        record = JSON.parse(line) as PiRpcRecord
      } catch {
        this.failActive(session, agentError("PI_PROTOCOL", "Pi emitted invalid JSONL"))
        continue
      }
      this.consumeRecord(session, record)
    }
  }

  private consumeRecord(session: PiSession, record: PiRpcRecord): void {
    if (record.type === "response") {
      if (record.success === false) {
        this.failActive(
          session,
          agentError(
            "PI_COMMAND_FAILED",
            `Pi command failed: ${String(record.command ?? "unknown")}`,
            record.error,
          ),
        )
      } else if (record.command === "reload") {
        const active = session.active
        if (active !== undefined) {
          const result = reloadInfo(record.data)
          if (result.revision !== undefined) {
            session.snapshot = Object.freeze({
              ...session.snapshot,
              extensionRevision: result.revision,
              updatedAt: Date.now(),
            })
          }
          this.emit(session, {
            type: "extension.reloaded",
            revision: result.revision ?? session.snapshot.extensionRevision ?? "unknown",
            loaded: result.loaded,
            disabled: result.disabled,
            rolledBack: result.rolledBack,
          })
          this.finishTurn(session)
        }
      } else if (record.command === "prompt" && session.reloadRequested) {
        const active = session.active
        if (active !== undefined) {
          session.reloadRevision += 1
          const revision = `pi:${session.reloadRevision}`
          session.snapshot = Object.freeze({
            ...session.snapshot,
            extensionRevision: revision,
            updatedAt: Date.now(),
          })
          this.emit(session, {
            type: "extension.reloaded",
            revision,
            loaded: [],
            disabled: [],
            rolledBack: false,
          })
          this.finishTurn(session)
        }
      }
      return
    }
    const active = session.active
    if (active === undefined) return
    const turnId = session.turnId ?? "unknown"
    switch (record.type) {
      case "extension_ui_request": {
        if (record.method !== "confirm" || typeof record.id !== "string") return
        session.approvals.set(record.id, { method: record.method })
        this.emit(session, {
          type: "approval.required",
          turnId,
          approvalId: record.id,
          action: typeof record.title === "string" ? record.title : "confirm extension action",
          capability: "ui.confirm",
          ...(typeof record.message === "string" ? { reason: record.message } : {}),
        })
        return
      }
      case "message_update": {
        const delta = record.assistantMessageEvent
        if (isRecord(delta) && delta.type === "text_delta" && typeof delta.delta === "string") {
          this.emit(session, { type: "assistant.delta", turnId, text: delta.delta })
        }
        return
      }
      case "message_end": {
        const message = record.message
        const text = assistantText(message)
        if (text.length > 0) this.emit(session, { type: "assistant.message", turnId, text })
        return
      }
      case "tool_execution_start":
        if (typeof record.toolCallId === "string" && typeof record.toolName === "string")
          this.emit(session, {
            type: "tool.started",
            turnId,
            callId: record.toolCallId,
            name: record.toolName,
            input: record.args,
          })
        return
      case "tool_execution_update": {
        const text = resultText(record.partialResult)
        if (typeof record.toolCallId === "string" && text.length > 0)
          this.emit(session, { type: "tool.delta", turnId, callId: record.toolCallId, text })
        return
      }
      case "tool_execution_end": {
        const result = isRecord(record.result) ? record.result : undefined
        if (typeof record.toolCallId === "string" && typeof record.toolName === "string")
          this.emit(session, {
            type: "tool.completed",
            turnId,
            callId: record.toolCallId,
            name: record.toolName,
            ok: record.isError !== true,
            ...(result === undefined ? {} : { output: resultText(result) }),
            ...(record.isError === true
              ? { error: agentError("PI_TOOL_FAILED", resultText(result) || "Pi tool failed") }
              : {}),
          })
        return
      }
      case "compaction_end": {
        const result = isRecord(record.result) ? record.result : undefined
        const before = numberOrZero(result?.tokensBefore)
        const after = numberOrZero(result?.estimatedTokensAfter)
        this.emit(session, {
          type: "memory.compacted",
          before,
          after,
          reason:
            record.reason === "manual" ||
            record.reason === "threshold" ||
            record.reason === "overflow"
              ? record.reason
              : "workflow",
        })
        return
      }
      case "extension_error":
        this.emit(session, {
          type: "session.failed",
          error: agentError("PI_EXTENSION", String(record.error ?? "Pi extension failed"), {
            extensionPath: record.extensionPath,
            event: record.event,
          }),
          recoverable: true,
        })
        return
      case "agent_settled":
        this.finishTurn(session)
        return
      case "agent_end":
        this.finishTurn(session)
        return
      case "extension_reloaded": {
        const result = reloadInfo(record.data ?? record)
        this.emit(session, {
          type: "extension.reloaded",
          revision: result.revision ?? session.snapshot.extensionRevision ?? "unknown",
          loaded: result.loaded,
          disabled: result.disabled,
          rolledBack: result.rolledBack,
        })
        return
      }
      case "session_compact":
        return
      default:
        return
    }
  }

  private emit(
    session: PiSession,
    payload: import("@nifrajs/agent-protocol").AgentEventPayload,
  ): void {
    const event = Object.freeze({
      version: 1 as const,
      sessionId: session.id,
      seq: session.seq++,
      at: Date.now(),
      ...payload,
    }) as AgentEvent
    session.snapshot = Object.freeze({
      ...session.snapshot,
      lastSeq: event.seq,
      updatedAt: event.at,
    })
    session.active?.push(event)
  }

  private updateSnapshot(session: PiSession, status: AgentSessionSnapshot["status"]): void {
    const at = Date.now()
    const next = {
      ...session.snapshot,
      status,
      updatedAt: at,
      lastSeq: session.seq,
    }
    session.snapshot = Object.freeze(
      status === "running" && session.turnId !== undefined
        ? { ...next, activeTurnId: session.turnId }
        : removeActiveTurn(next),
    )
    if (session.active !== undefined)
      this.emit(session, { type: "session.updated", snapshot: session.snapshot })
  }

  private failActive(session: PiSession, error: ReturnType<typeof agentError>): void {
    const active = session.active
    if (active === undefined) return
    this.updateSnapshot(session, "failed")
    this.emit(session, { type: "session.failed", error, recoverable: true })
    active.fail(error)
    session.active = undefined
    session.reloadRequested = false
  }

  private finishTurn(session: PiSession): void {
    const active = session.active
    if (active === undefined) return
    this.updateSnapshot(session, "idle")
    this.emit(session, { type: "session.completed", snapshot: session.snapshot })
    active.complete()
    session.active = undefined
    session.reloadRequested = false
  }
}

function removeActiveTurn(
  snapshot: Omit<AgentSessionSnapshot, "activeTurnId"> & { readonly activeTurnId?: string },
): Omit<AgentSessionSnapshot, "activeTurnId"> {
  const { activeTurnId: _activeTurnId, ...withoutActiveTurn } = snapshot
  return withoutActiveTurn
}

function writeRpc(session: PiSession, value: Record<string, unknown>): void {
  const stdin = session.process.stdin
  if (stdin === undefined || stdin === null || typeof stdin === "number")
    throw new Error("pi backend: Pi stdin is unavailable")
  stdin.write(`${JSON.stringify(value)}\n`)
  stdin.flush()
}

function filteredEnv(
  values: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {}
  const names = new Set(["PATH", "HOME", "LANG", "LC_ALL", "TERM", ...Object.keys(values ?? {})])
  for (const name of names) {
    const value = values?.[name] ?? process.env[name]
    if (value !== undefined) result[name] = value
  }
  return result
}

function failedStream(error: unknown): AgentEventStream {
  const stream = createAgentEventStream()
  stream.fail(error)
  return stream
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function assistantText(value: unknown): string {
  if (!isRecord(value) || value.role !== "assistant") return ""
  const content = value.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter(isRecord)
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("")
}

function resultText(value: unknown): string {
  if (!isRecord(value)) return ""
  const content = value.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter(isRecord)
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("")
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
}

interface PiReloadInfo {
  readonly revision?: string
  readonly loaded: readonly string[]
  readonly disabled: readonly string[]
  readonly rolledBack: boolean
}

function reloadInfo(value: unknown): PiReloadInfo {
  const record = isRecord(value) ? value : {}
  const list = (candidate: unknown): readonly string[] =>
    Array.isArray(candidate)
      ? candidate.filter((item): item is string => typeof item === "string")
      : []
  return {
    ...(typeof record.revision === "string" ? { revision: record.revision } : {}),
    loaded: list(record.loaded ?? record.extensions),
    disabled: list(record.disabled),
    rolledBack: record.rolledBack === true,
  }
}

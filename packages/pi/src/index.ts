import { fileURLToPath } from "node:url"
import {
  AGENT_MAX_PAYLOAD_STRING,
  type AgentBackend,
  type AgentBackendInfo,
  type AgentEvent,
  type AgentEventStream,
  type AgentSessionSnapshot,
  agentError,
  boundAgentText,
  boundAgentValue,
  type CreateSessionInput,
  childProcessBaseEnv,
  childProcessEnv,
  createAgentEventStream,
  isAgentEvent,
  type ReloadResult,
  type SendMessageInput,
  splitAgentText,
} from "@nifrajs/agent-protocol"
import { escapeRegExp } from "@nifrajs/utils/escape-regexp"
import { isRecord } from "@nifrajs/utils/record"
import { writeRpc } from "./rpc-write.ts"

export interface PiBackendOptions {
  /** Defaults to `pi`, resolved through PATH. */
  readonly command?: string
  /** Extra arguments appended after `--mode rpc`. */
  readonly args?: readonly string[]
  /**
   * Variables Pi runs with, on top of the base set (`PATH`, `HOME`, locale, terminal, and the
   * model-provider credentials Pi reads, such as `ANTHROPIC_API_KEY`). Nothing else from the parent
   * environment passes; a key mapped to `undefined` is withheld even when the parent has it.
   */
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
  /** Maximum UTF-8 bytes accepted for one Pi JSONL record. Defaults to 1 MiB. */
  readonly maxRecordBytes?: number
  /** Maximum prompt characters accepted by the adapter. Defaults to 64 KiB. */
  readonly maxMessageChars?: number
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
  /** Pi ends a turn whose model call failed with an ordinary `agent_end`; the error is on its last message. */
  modelError: ReturnType<typeof agentError> | undefined
  /** Masks the credentials this session's Pi process was given, wherever a diagnostic echoes one. */
  redact: (text: string) => string
  turnAbortCleanup: (() => void) | undefined
  reloadRequested: boolean
  reloadRevision: number
  restarting: boolean
  buffer: string
  closed: boolean
  readonly approvals: Map<string, { readonly method: string }>
  /** The turn whose prompt reached Pi, so a cancel knows Pi has a run to abort. */
  promptedTurnId: string | undefined
  /** Aborted runs whose closing `agent_end` has not arrived: until it does, every record is theirs. */
  staleRuns: number
  drain: PromiseWithResolvers<void> | undefined
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

const DEFAULT_MAX_RECORD_BYTES = 1 * 1024 * 1024
const MAX_RECORD_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_MESSAGE_CHARS = 64 * 1024
const MAX_MESSAGE_CHARS = 4 * 1024 * 1024
const MAX_EVENT_QUEUE_SIZE = 65_536
const MAX_PENDING_APPROVALS = 128
// Pi's extension UI methods that block the extension until an `extension_ui_response` arrives.
const PI_DIALOG_METHODS: ReadonlySet<unknown> = new Set(["select", "confirm", "input", "editor"])

/**
 * Spawn Pi in its documented JSONL RPC mode and translate its events into the Nifra protocol.
 *
 * This adapter intentionally talks to the public Pi process protocol instead of importing Pi into
 * any Nifra framework package. A future SDK adapter can implement the same AgentBackend contract.
 */
export class PiBackend implements AgentBackend {
  readonly info = INFO
  private readonly options: PiBackendOptions
  private readonly maxRecordBytes: number
  private readonly maxMessageChars: number
  private readonly sessions = new Map<string, PiSession>()

  constructor(options: PiBackendOptions = {}) {
    this.maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES
    if (
      !Number.isSafeInteger(this.maxRecordBytes) ||
      this.maxRecordBytes < 1_024 ||
      this.maxRecordBytes > MAX_RECORD_BYTES
    )
      throw new RangeError(
        `pi backend: maxRecordBytes must be between 1024 and ${MAX_RECORD_BYTES}`,
      )
    this.maxMessageChars = options.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS
    if (
      !Number.isSafeInteger(this.maxMessageChars) ||
      this.maxMessageChars < 256 ||
      this.maxMessageChars > MAX_MESSAGE_CHARS
    )
      throw new RangeError(
        `pi backend: maxMessageChars must be between 256 and ${MAX_MESSAGE_CHARS}`,
      )
    if (
      options.maxEventQueueSize !== undefined &&
      (!Number.isSafeInteger(options.maxEventQueueSize) ||
        options.maxEventQueueSize < 1 ||
        options.maxEventQueueSize > MAX_EVENT_QUEUE_SIZE)
    )
      throw new RangeError(
        `pi backend: maxEventQueueSize must be between 1 and ${MAX_EVENT_QUEUE_SIZE}`,
      )
    this.options = Object.freeze({ ...options })
  }

  async createSession(input: CreateSessionInput): Promise<AgentSessionSnapshot> {
    if (
      typeof input.cwd !== "string" ||
      input.cwd.length === 0 ||
      input.cwd.length > 4_096 ||
      input.cwd.includes("\0")
    )
      throw new TypeError("pi backend: cwd must be a bounded non-empty path")
    if (
      input.capabilities !== undefined &&
      (!Array.isArray(input.capabilities) ||
        input.capabilities.length > 256 ||
        !input.capabilities.every((value) => boundedPiToken(value)))
    )
      throw new TypeError("pi backend: capabilities must be bounded tokens")
    const id = input.sessionId ?? crypto.randomUUID()
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(id))
      throw new TypeError("pi backend: sessionId must be a bounded token")
    if (this.sessions.has(id)) throw new Error(`pi backend: session already exists: ${id}`)

    const env = filteredEnv(this.options.env)
    const proc = this.spawnProcess(input.cwd, id, env)
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
      modelError: undefined,
      redact: credentialRedactor(env),
      turnAbortCleanup: undefined,
      reloadRequested: false,
      reloadRevision: 0,
      restarting: false,
      buffer: "",
      closed: false,
      approvals: new Map(),
      promptedTurnId: undefined,
      staleRuns: 0,
      drain: undefined,
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
    if (input.message.length === 0 || input.message.length > this.maxMessageChars)
      return failedStream(
        agentError("MESSAGE_BOUNDED", "message is empty or exceeds the configured limit"),
      )

    const stream = createAgentEventStream(this.options.maxEventQueueSize ?? 256)
    session.active = stream
    const turnId = crypto.randomUUID()
    session.turnId = turnId
    session.modelError = undefined
    session.reloadRequested = false
    this.updateSnapshot(session, "running")
    this.emit(session, {
      type: "turn.started",
      turnId: session.turnId,
      prompt: boundAgentText(input.message),
    })
    if (input.signal !== undefined) {
      const externalSignal = input.signal
      const onAbort = (): void => {
        // The listener is tied to this stream/turn. A stale request timeout must not stop a
        // subsequent prompt that reused the same Pi session.
        if (session.active !== stream || session.turnId !== turnId) return
        void this.cancelTurn(session, stream, turnId, "cancelled")
      }
      if (externalSignal.aborted) onAbort()
      else {
        externalSignal.addEventListener("abort", onAbort, { once: true })
        session.turnAbortCleanup = () => externalSignal.removeEventListener("abort", onAbort)
        // Abort can race listener registration; the identity check in onAbort keeps this turn
        // from leaking into a later one.
        if (externalSignal.aborted) onAbort()
      }
    }
    // An already-aborted signal is settled above. Do not write a prompt after that cancellation.
    if (session.active !== stream || session.turnId !== turnId) return stream
    const prompt = (): Promise<void> => {
      if (session.active !== stream || session.turnId !== turnId) return Promise.resolve()
      session.promptedTurnId = turnId
      return writeRpc(session.process.stdin, { type: "prompt", message: input.message })
    }
    // A cancelled run still emitting would answer into this turn, so its prompt waits for the drain.
    const prompting = session.drain === undefined ? prompt() : session.drain.promise.then(prompt)
    void prompting.catch((error) => {
      if (session.active !== stream || session.turnId !== turnId) return
      stream.fail(error)
      this.clearTurn(session, stream, turnId)
      this.updateSnapshot(session, "failed")
    })
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
      // close() may have raced the awaited process exit. Never clear the closed bit or attach a
      // replacement process after that race, otherwise a caller can resurrect a session it closed.
      if (session.closed) {
        session.restarting = false
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
      const env = filteredEnv(this.options.env)
      session.redact = credentialRedactor(env)
      this.attachProcess(session, this.spawnProcess(session.cwd, session.id, env))
      return { revision, loaded: [], disabled: [], rolledBack: false }
    }
    const stream = createAgentEventStream(this.options.maxEventQueueSize ?? 256)
    session.active = stream
    session.turnId = crypto.randomUUID()
    session.modelError = undefined
    session.reloadRequested = true
    this.updateSnapshot(session, "running")
    this.emit(session, { type: "turn.started", turnId: session.turnId, prompt: "/reload" })
    try {
      if (this.options.reloadCommand === "rpc")
        await writeRpc(session.process.stdin, { type: "reload" })
      else await writeRpc(session.process.stdin, { type: "prompt", message: "/reload" })
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
    await writeRpc(session.process.stdin, {
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
    this.clearTurnSignal(session)
    session.active?.complete()
    session.active = undefined
    session.turnId = undefined
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

  private spawnProcess(cwd: string, id: string, env: Record<string, string>): Bun.Subprocess {
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
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
  }

  private attachProcess(session: PiSession, process: Bun.Subprocess): void {
    session.process = process
    this.endDrain(session) // the runs a previous process was aborting died with it
    void this.readStdout(session)
    void this.readStderr(session)
    void process.exited.then((exitCode) => {
      if (session.process !== process || session.restarting) return
      session.closed = true
      this.endDrain(session)
      this.clearTurnSignal(session)
      if (session.active !== undefined) {
        this.failActive(session, agentError("PI_EXITED", `Pi exited with code ${exitCode}`))
      } else {
        session.snapshot = Object.freeze({
          ...removeActiveTurn(session.snapshot),
          status: "failed",
          updatedAt: Date.now(),
        })
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
      if (session.buffer.length > 0) {
        session.buffer = ""
        this.failActive(
          session,
          agentError("PI_PROTOCOL", "Pi emitted an unterminated JSONL record"),
        )
      }
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
    const buffered = session.buffer + text
    let start = 0
    for (;;) {
      const newline = buffered.indexOf("\n", start)
      if (newline === -1) break
      let line = buffered.slice(start, newline)
      start = newline + 1
      if (line.endsWith("\r")) line = line.slice(0, -1)
      if (line.length === 0) continue
      if (Buffer.byteLength(line, "utf8") > this.maxRecordBytes) {
        this.failActive(session, agentError("PI_PROTOCOL", "Pi emitted an oversized JSONL record"))
        continue
      }
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        this.failActive(session, agentError("PI_PROTOCOL", "Pi emitted invalid JSONL"))
        continue
      }
      if (!isRecord(value) || typeof value.type !== "string" || value.type.length === 0) {
        this.failActive(session, agentError("PI_PROTOCOL", "Pi emitted an invalid JSONL record"))
        continue
      }
      this.consumeRecord(session, value as PiRpcRecord)
    }
    // The cap is per record: complete lines were each measured above, and what remains is the one
    // record still arriving.
    session.buffer = buffered.slice(start)
    if (Buffer.byteLength(session.buffer, "utf8") > this.maxRecordBytes) {
      session.buffer = ""
      this.failActive(session, agentError("PI_PROTOCOL", "Pi emitted an oversized JSONL record"))
    }
  }

  private consumeRecord(session: PiSession, record: PiRpcRecord): void {
    if (record.type === "response") {
      // Pi answers an abort once it has handled it, so that answer also ends the drain: a Pi that ends
      // an aborted run without an `agent_end` must not hold every later prompt back. An abort that
      // failed had no run to stop, and says nothing about the turn running now.
      if (record.command === "abort") {
        if (session.staleRuns > 0) this.endDrain(session)
        return
      }
      if (record.success === false) {
        this.failActive(
          session,
          agentError(
            "PI_COMMAND_FAILED",
            `Pi command failed: ${boundedPiText(record.command, 128) || "unknown"}`,
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
    // Only a `confirm` inside a turn becomes an approval. Any other dialog is cancelled at once, or
    // the extension waits on an answer nobody can give; notify, setStatus and the like expect none.
    const stale = session.staleRuns > 0
    if (
      record.type === "extension_ui_request" &&
      PI_DIALOG_METHODS.has(record.method) &&
      (record.method !== "confirm" || session.active === undefined || stale) &&
      boundedPiToken(record.id)
    ) {
      const active = session.active
      const turnId = session.turnId
      void writeRpc(session.process.stdin, {
        type: "extension_ui_response",
        id: record.id,
        cancelled: true,
      }).catch(() => {
        if (session.active === active && session.turnId === turnId)
          this.failActive(session, agentError("PI_IO", "Pi could not receive the dialog response"))
      })
      return
    }
    if (stale) {
      if (
        (record.type === "agent_end" && record.willRetry !== true) ||
        record.type === "agent_settled"
      )
        if (--session.staleRuns === 0) this.endDrain(session)
      return
    }
    const active = session.active
    if (active === undefined) return
    const turnId = session.turnId ?? "unknown"
    switch (record.type) {
      case "extension_ui_request": {
        if (record.method !== "confirm" || !boundedPiToken(record.id)) return
        if (session.approvals.size >= MAX_PENDING_APPROVALS) {
          this.failActive(session, agentError("PI_PROTOCOL", "Pi approval queue is full"))
          return
        }
        session.approvals.set(record.id, { method: record.method })
        this.emit(session, {
          type: "approval.required",
          turnId,
          approvalId: record.id,
          action: boundedPiText(record.title, 512) || "confirm extension action",
          capability: "ui.confirm",
          ...(boundedPiText(record.message, 4_096)
            ? { reason: boundedPiText(record.message, 4_096) }
            : {}),
        })
        return
      }
      case "message_update": {
        const delta = record.assistantMessageEvent
        if (isRecord(delta) && delta.type === "text_delta" && typeof delta.delta === "string") {
          for (const text of splitAgentText(delta.delta))
            this.emit(session, { type: "assistant.delta", turnId, text })
        }
        return
      }
      case "message_end": {
        const message = record.message
        const text = assistantText(message)
        if (text.length > 0)
          for (const piece of splitAgentText(text))
            this.emit(session, { type: "assistant.message", turnId, text: piece })
        if (isRecord(message) && message.role === "assistant")
          session.modelError =
            message.stopReason === "error"
              ? modelError(message.errorMessage, session.redact)
              : undefined
        return
      }
      case "tool_execution_start":
        if (typeof record.toolCallId === "string" && typeof record.toolName === "string") {
          const started: ToolStartedPayload = {
            type: "tool.started",
            turnId,
            callId: record.toolCallId,
            name: record.toolName,
          }
          const input = boundAgentValue(record.args)
          if (input !== undefined) started.input = input
          this.emit(session, started)
        }
        return
      case "tool_execution_update": {
        const text = contentText(record.partialResult)
        if (typeof record.toolCallId === "string" && text.length > 0)
          for (const piece of splitAgentText(text))
            this.emit(session, {
              type: "tool.delta",
              turnId,
              callId: record.toolCallId,
              text: piece,
            })
        return
      }
      case "tool_execution_end": {
        const result = isRecord(record.result) ? record.result : undefined
        const text = contentText(result)
        if (typeof record.toolCallId === "string" && typeof record.toolName === "string")
          this.emit(session, {
            type: "tool.completed",
            turnId,
            callId: record.toolCallId,
            name: record.toolName,
            ok: record.isError !== true,
            ...(result === undefined
              ? {}
              : { output: boundAgentText(text, AGENT_MAX_PAYLOAD_STRING) }),
            ...(record.isError === true
              ? { error: agentError("PI_TOOL_FAILED", boundAgentText(text || "Pi tool failed")) }
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
          error: agentError(
            "PI_EXTENSION",
            boundedPiText(redactedText(record.error, session.redact), 4_096) ||
              "Pi extension failed",
          ),
          recoverable: true,
        })
        return
      case "agent_settled":
        this.endTurn(session)
        return
      case "agent_end":
        // Pi runs the turn again after a retryable error and ends that run with its own agent_end.
        if (record.willRetry === true) return
        this.endTurn(session)
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
    const seq = session.seq++
    const at = Date.now()
    const event = Object.freeze({
      version: 1 as const,
      sessionId: session.id,
      seq,
      at,
      ...payload,
    }) as AgentEvent
    if (!isAgentEvent(event)) {
      if (payload.type === "session.failed") {
        const fallback = Object.freeze({
          version: 1 as const,
          sessionId: session.id,
          seq,
          at,
          type: "session.failed" as const,
          error: agentError("PI_PROTOCOL", "Pi emitted an event outside protocol bounds"),
          recoverable: false,
        })
        session.snapshot = Object.freeze({
          ...session.snapshot,
          lastSeq: fallback.seq,
          updatedAt: fallback.at,
        })
        session.active?.push(fallback)
        return
      }
      this.failActive(
        session,
        agentError("PI_PROTOCOL", "Pi emitted an event outside protocol bounds"),
      )
      return
    }
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
    const turnId = session.turnId
    this.clearTurnSignal(session)
    this.updateSnapshot(session, "failed")
    this.emit(session, { type: "session.failed", error, recoverable: true })
    active.fail(error)
    this.clearTurn(session, active, turnId)
    session.reloadRequested = false
  }

  private endTurn(session: PiSession): void {
    if (session.modelError === undefined) this.finishTurn(session)
    else this.failActive(session, session.modelError)
  }

  private finishTurn(session: PiSession): void {
    const active = session.active
    if (active === undefined) return
    const turnId = session.turnId
    this.clearTurnSignal(session)
    this.updateSnapshot(session, "idle")
    this.emit(session, { type: "session.completed", snapshot: session.snapshot })
    active.complete()
    this.clearTurn(session, active, turnId)
    session.reloadRequested = false
  }

  private async cancelTurn(
    session: PiSession,
    expectedStream: AgentEventStream | undefined,
    expectedTurnId: string | undefined,
    reason: string,
  ): Promise<void> {
    if (
      expectedStream !== undefined &&
      (session.active !== expectedStream || session.turnId !== expectedTurnId)
    )
      return
    const active = session.active
    const turnId = session.turnId
    const stopReason = boundedPiText(reason, 512) || "cancelled"
    this.clearTurnSignal(session)
    // Pi has a run to abort only once the turn's prompt reached it. That run's records keep coming
    // until its `agent_end`, and are drained there rather than taken by the next turn.
    const prompted = turnId !== undefined && session.promptedTurnId === turnId && !session.closed
    if (prompted) {
      session.promptedTurnId = undefined
      session.staleRuns += 1
      session.drain ??= Promise.withResolvers<void>()
    }
    const writing = prompted
      ? writeRpc(session.process.stdin, { type: "abort" })
      : Promise.resolve()
    this.updateSnapshot(session, "stopped")
    this.emit(session, { type: "session.stopped", reason: stopReason })
    active?.complete()
    this.clearTurn(session, active, turnId)
    // Settle the caller synchronously before waiting for a buffered abort: an already-aborted
    // request must never send a prompt. An exited process may refuse the abort without undoing it.
    await writing.catch(() => undefined)
  }

  private endDrain(session: PiSession): void {
    session.staleRuns = 0
    session.drain?.resolve()
    session.drain = undefined
  }

  private clearTurnSignal(session: PiSession): void {
    session.turnAbortCleanup?.()
    session.turnAbortCleanup = undefined
  }

  private clearTurn(
    session: PiSession,
    stream: AgentEventStream | undefined,
    turnId: string | undefined,
  ): void {
    if (stream !== undefined && session.active !== stream) return
    if (turnId !== undefined && session.turnId !== turnId) return
    this.clearTurnSignal(session)
    // An approval belongs to its turn; an answer after the turn ended must not reach Pi.
    session.approvals.clear()
    if (stream === undefined || session.active === stream) session.active = undefined
    if (turnId === undefined || session.turnId === turnId) session.turnId = undefined
  }
}

function removeActiveTurn(
  snapshot: Omit<AgentSessionSnapshot, "activeTurnId"> & { readonly activeTurnId?: string },
): Omit<AgentSessionSnapshot, "activeTurnId"> {
  const { activeTurnId: _activeTurnId, ...withoutActiveTurn } = snapshot
  return withoutActiveTurn
}

// The model-provider credentials Pi's providers read from the environment. Pi cannot reach a model
// without one, and running `pi` directly would see them; every other parent variable stays out.
const PI_PROVIDER_ENV = [
  "AI_GATEWAY_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANT_LING_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AZURE_OPENAI_API_KEY",
  "BASETEN_API_KEY",
  "CEREBRAS_API_KEY",
  "CLOUDFLARE_API_KEY",
  "COPILOT_GITHUB_TOKEN",
  "DEEPSEEK_API_KEY",
  "FIREWORKS_API_KEY",
  "GCLOUD_PROJECT",
  "GEMINI_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_API_KEY",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_PROJECT",
  "GROQ_API_KEY",
  "HF_TOKEN",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "MISTRAL_API_KEY",
  "MOONSHOT_API_KEY",
  "NVIDIA_API_KEY",
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "OPENROUTER_API_KEY",
  "QWEN_TOKEN_PLAN_API_KEY",
  "QWEN_TOKEN_PLAN_CN_API_KEY",
  "RADIUS_API_KEY",
  "TOGETHER_API_KEY",
  "XAI_API_KEY",
  "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODING_CN_API_KEY",
]

// What Pi needs to run at all. None of it is a credential, so a diagnostic keeps these values.
const PI_BASE_ENV = childProcessBaseEnv(process.platform)

function filteredEnv(
  values: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string> {
  return childProcessEnv({
    env: process.env,
    platform: process.platform,
    names: PI_PROVIDER_ENV,
    values,
  })
}

function failedStream(error: unknown): AgentEventStream {
  const stream = createAgentEventStream()
  stream.fail(error)
  return stream
}

interface ToolStartedPayload {
  type: "tool.started"
  turnId: string
  callId: string
  name: string
  input?: unknown
}

function assistantText(value: unknown): string {
  return isRecord(value) && value.role === "assistant" ? contentText(value) : ""
}

/** The text of a message's `content`: the string itself, or its text parts joined. */
function contentText(value: unknown): string {
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

function boundedPiToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:/-]{1,128}$/.test(value)
}

// A provider's error can echo a credential back; the turn's error keeps the reason, not the key.
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

/** Mask every value Pi was given except its base environment - the credentials it may echo, in any
 * shape - then the key shapes a provider or proxy could hand back on its own. A value under six
 * characters is masked only where it stands alone, and a number or yes/no word is left: masking
 * every `1` or `true` would leave nothing of the diagnostic. */
function credentialRedactor(env: Readonly<Record<string, string>>): (text: string) => string {
  const base = new Set(PI_BASE_ENV)
  const values = Object.entries(env)
    .filter(([name, value]) => !base.has(name) && value.length > 0)
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length)
  const secrets = values.filter((value) => value.length >= 6)
  const short = values.filter(
    (value) => value.length < 6 && !/^(?:\d+|true|false|yes|no|on|off)$/i.test(value),
  )
  const standalone =
    short.length === 0
      ? undefined
      : new RegExp(`(?<![A-Za-z0-9])(?:${short.map(escapeRegExp).join("|")})(?![A-Za-z0-9])`, "g")
  return (text) => {
    let masked = text
    for (const secret of secrets) masked = masked.replaceAll(secret, "[REDACTED]")
    if (standalone !== undefined) masked = masked.replace(standalone, "[REDACTED]")
    for (const pattern of CREDENTIAL_PATTERNS) masked = masked.replace(pattern, "[REDACTED]")
    return masked
  }
}

function redactedText(value: unknown, redact: (text: string) => string): unknown {
  return typeof value === "string" ? redact(value) : value
}

// A rejected provider login or API key. Matched over Pi's whole error text, since a provider's auth
// code (`invalid_refresh_token`, `authentication_error`) sits in the response body it quotes.
const PI_AUTH_FAILURE =
  /oauth refresh failed|invalid_refresh_token|refresh token|no api key|invalid[_ ]?(?:api[_ ]?key|x-api-key)|incorrect api key|authentication_error|unauthori[sz]ed|re-?authenticate|(?:sign(?:ing)?|log(?:ging)?)\s+in\s+again/i

/** `PI_AUTH_REQUIRED` when the provider refused Pi's credentials, so a client can ask for a new
 * sign-in or key; `PI_MODEL_FAILED` for any other model failure. */
function modelError(
  value: unknown,
  redact: (text: string) => string,
): ReturnType<typeof agentError> {
  const auth = typeof value === "string" && PI_AUTH_FAILURE.test(value.slice(0, 4_096))
  return agentError(auth ? "PI_AUTH_REQUIRED" : "PI_MODEL_FAILED", modelErrorText(value, redact))
}

function modelErrorText(value: unknown, redact: (text: string) => string): string {
  if (typeof value !== "string") return "Pi's model call failed"
  return boundedPiText(redact(value), 1_024) || "Pi's model call failed"
}

function boundedPiText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return ""
  const text = value.replaceAll("\0", "\uFFFD")
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`
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
    Array.isArray(candidate) ? candidate.filter((item): item is string => boundedPiToken(item)) : []
  return {
    ...(boundedPiToken(record.revision) ? { revision: record.revision } : {}),
    loaded: list(record.loaded ?? record.extensions),
    disabled: list(record.disabled),
    rolledBack: record.rolledBack === true,
  }
}

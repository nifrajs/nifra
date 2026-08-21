/**
 * `@nifrajs/ag-ui` - mount a nifra agent as an AG-UI (Agent-User Interaction protocol) endpoint.
 *
 * The package is a protocol bridge over the `@nifrajs/agent` runner, mirroring the `mountAgent`
 * seam: one HTTP POST accepting the AG-UI `RunAgentInput` body, the bounded runner in the middle,
 * a stream of AG-UI events out. The request body is read through core's single bounded,
 * proto-guarded framing lane (`@nifrajs/core/edge-kit`); the model, durable state store, and
 * approval transport arrive through a per-request `ports` factory and never live in this package.
 *
 * Wire contract (default path `/agui`):
 * - `POST {path}` body `RunAgentInput` (`threadId` and `runId` required) -> SSE where each `data:`
 *   field is one AG-UI event:
 *   - `RUN_STARTED`, then `CUSTOM { name: "nifra.turn", value: { turnId } }` announcing the
 *     runner's turn id.
 *   - Step evidence maps to `TOOL_CALL_START`/`TOOL_CALL_END` for tool effects, followed by a
 *     `TOOL_CALL_RESULT` whose `content` is the token-only outcome (`{ outcome, code? }` - the
 *     runtime never carries tool payloads), and `STEP_STARTED`/`STEP_FINISHED` for everything
 *     else. Evidence-derived events carry the evidence `timestamp`.
 *   - A model port that streams (`request.onDelta`) turns into live token frames:
 *     `TEXT_MESSAGE_START`/`_CONTENT` for text deltas, `REASONING_*` for reasoning deltas, and
 *     `TOOL_CALL_START` + `TOOL_CALL_ARGS` for the tool call being formed - the following tool
 *     evidence closes that same call (`TOOL_CALL_END` + `TOOL_CALL_RESULT`) instead of opening a
 *     second one. When any text was streamed, the terminal `TEXT_MESSAGE_*` block is suppressed -
 *     the streamed text IS the assistant message, so a streaming port must stream all
 *     user-visible text. A non-streaming port keeps the single terminal
 *     `TEXT_MESSAGE_START`/`_CONTENT`/`_END` block. `usage` deltas are summed per
 *     `(provider, model)` across the run's model decisions and stamped as the spec's
 *     `usage: TokenUsage[]` array on the terminal `RUN_FINISHED` event (success and interrupt
 *     alike) - they never produce a frame of their own. Deltas are transient: a `Last-Event-ID`
 *     replay carries evidence frames and the stored (unsuppressed) terminal events only - the
 *     stored `RUN_FINISHED` keeps its `usage`.
 *   - The `ports` factory receives `(c, run)` where `run.sharedState` is the run's
 *     `AgentSharedState` channel: `body.state` seeds the document (announced as an upfront
 *     `STATE_SNAPSHOT` when present), every `patch` streams as `STATE_DELTA` (RFC 6902 ops), and
 *     a first patch without a seeded document announces itself as a `STATE_SNAPSHOT`.
 *   - A completed run ends `RUN_FINISHED` with `result` and `outcome: { type: "success" }`, after
 *     an optional `MESSAGES_SNAPSHOT` (see `emitMessagesSnapshot`); a failed one ends `RUN_ERROR`.
 *   - A suspended run (approval, budget, model retry, max turns) emits
 *     `CUSTOM { name: "nifra.pending", value: { turnId, reason, continuation } }` and then
 *     `RUN_FINISHED` with `outcome: { type: "interrupt", interrupts: [{ id: turnId, reason,
 *     toolCallId?, responseSchema, metadata: { turnId, continuation } }] }`. Resume with the
 *     spec `resume` array - `[{ interruptId: turnId, status, payload: { continuation,
 *     approval? } }]` where `payload.continuation` echoes `metadata.continuation` (the runtime is
 *     stateless, so the client must send it back) - or with the legacy
 *     `forwardedProps.resume` (`{ continuation, approval? }`) plus `forwardedProps.turnId`. A
 *     `status: "cancelled"` entry without an explicit approval resumes as a denial. The runtime
 *     keeps state token-only, so a suspended tool's input must be replayed in
 *     `continuation.input`. A resume that fails validation is ignored and the POST starts a
 *     fresh run.
 * - Agent input is `forwardedProps.input` when present, otherwise the content of the last
 *   `role: "user"` message.
 * - With an `evidenceLog` configured, evidence-derived frames carry SSE `id: <seq>` and a dropped
 *   connection is resumable: re-POST the same body with a `Last-Event-ID` header to replay the
 *   missed events and rejoin the still-running turn - the run is never re-executed. Without the
 *   log the header is ignored and every POST starts a run.
 * - The seam performs no authentication or authorization. Wrap it with the app's own route guards,
 *   and scope the store/model returned by `ports` to the caller.
 */

import {
  type AgentDefinition,
  type AgentDeltaSink,
  type AgentModelDelta,
  type AgentPendingKind,
  type AgentPorts,
  type AgentRunResult,
  type AgentSharedState,
  type AgentStepEvidence,
  type AgentTurnInput,
  combineAgentDeltaSinks,
  combineAgentTelemetry,
  createAgentSharedState,
  createAgentState,
  resumeAgent,
  runAgent,
} from "@nifrajs/agent"
import {
  type AgentEvidenceLog,
  type AgentEvidenceReplay,
  createAgentEvidenceStream,
} from "@nifrajs/agent/events"
import {
  EMPTY_RESPONSE_CONTROLS,
  type ProtoPoisoning,
  plainError,
  type ResponseResult,
  readBodyFramed,
  toResponse,
} from "@nifrajs/core/edge-kit"
import type { StandardSchemaV1 } from "@nifrajs/core/schema"

const DEFAULT_PATH = "/agui"
const DEFAULT_MAX_BODY_BYTES = 1_000_000
const PENDING_KINDS: readonly AgentPendingKind[] = ["approval", "budget", "model", "cancelled"]
const TURN_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/
const LAST_EVENT_ID_PATTERN = /^\d{1,15}$/

/** The structural slice of a route context the seam needs. */
export interface AgUIRouteContext {
  readonly req: Request
}

/** The structural slice of a nifra server `mountAgUI` needs. */
export interface AgUIMountableApp {
  post(path: string, handler: (c: AgUIRouteContext) => Response | Promise<Response>): unknown
}

/** Per-run context handed to the `ports` factory alongside the route context. */
export interface AgUIRunContext {
  /** The runner turn id this request resolves to (fresh run or resume target). */
  readonly turnId: string
  /**
   * The run's shared UI state channel. `body.state` seeds the document; patches applied by any
   * port stream to the client as `STATE_SNAPSHOT`/`STATE_DELTA`. Transient - never persisted.
   */
  readonly sharedState: AgentSharedState
}

export interface MountAgUIOptions<
  InputSchema extends StandardSchemaV1,
  OutputSchema extends StandardSchemaV1,
> {
  readonly agent: AgentDefinition<InputSchema, OutputSchema>
  /** Endpoint path. Default `/agui`. */
  readonly path?: string
  /** Bounded run length passed to the runner. */
  readonly maxTurns?: number
  /** Maximum request body size in bytes. Default 1_000_000. */
  readonly maxBodyBytes?: number
  /** Prototype-poisoning policy for the framing lane. Default `"reject"`. */
  readonly protoPoisoning?: ProtoPoisoning
  /**
   * Build the ports for one request - the model, durable state store, approval transport,
   * capabilities, and budgets. Receives the route context so the caller can scope every port to
   * the request subject, and the run context carrying the turn id and the shared UI state channel.
   */
  readonly ports: (c: AgUIRouteContext, run: AgUIRunContext) => AgentPorts | Promise<AgentPorts>
  /**
   * Evidence log making the SSE stream resumable via `Last-Event-ID`. The in-memory reference
   * (`createMemoryAgentEvidenceLog`) is single-process; a durable log is an adapter concern.
   */
  readonly evidenceLog?: AgentEvidenceLog
  /**
   * Emit a `MESSAGES_SNAPSHOT` (the request's `messages` plus the assistant output message)
   * before `RUN_FINISHED` on a successful completion. Default `false`: the snapshot echoes
   * client-sent message payloads, and terminal events are persisted to the evidence log when one
   * is configured - leave it off unless the client relies on an authoritative snapshot.
   */
  readonly emitMessagesSnapshot?: boolean
}

/** Mount a single agent as an AG-UI `POST {path}` SSE endpoint. */
export function mountAgUI<
  InputSchema extends StandardSchemaV1,
  OutputSchema extends StandardSchemaV1,
>(app: AgUIMountableApp, options: MountAgUIOptions<InputSchema, OutputSchema>): void {
  const path = options.path ?? DEFAULT_PATH
  const maxBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const proto = options.protoPoisoning ?? "reject"
  const runOptions = options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }

  app.post(path, (c) =>
    readBodyFramed<Response>(
      c.req,
      maxBytes,
      proto,
      (parsed) => execute(c, parsed, options, runOptions),
      (rejection) => render(rejection),
      () => render(plainError(400, "bad_request")),
    ).catch(() => render(plainError(400, "bad_request"))),
  )
}

async function execute<InputSchema extends StandardSchemaV1, OutputSchema extends StandardSchemaV1>(
  c: AgUIRouteContext,
  parsed: unknown,
  options: MountAgUIOptions<InputSchema, OutputSchema>,
  runOptions: { readonly maxTurns?: number },
): Promise<Response> {
  const body = asRecord(parsed)
  const threadId = body === undefined ? undefined : body.threadId
  const runId = body === undefined ? undefined : body.runId
  if (body === undefined || typeof threadId !== "string" || typeof runId !== "string")
    return jsonResponse(400, { error: "invalid_run_agent_input" })

  const forwarded = asRecord(body.forwardedProps) ?? {}
  const forwardedTurnId = typeof forwarded.turnId === "string" ? forwarded.turnId : undefined
  if (forwardedTurnId !== undefined && !TURN_ID_PATTERN.test(forwardedTurnId))
    return jsonResponse(400, { error: "invalid_turn_id" })
  // Legacy resume names the turn in forwardedProps; spec resume names it via the interrupt id.
  const entry = parseResumeEntry(body.resume)
  const turnId =
    forwardedTurnId ?? entry?.turnId ?? (TURN_ID_PATTERN.test(runId) ? runId : crypto.randomUUID())

  const input = Object.hasOwn(forwarded, "input") ? forwarded.input : lastUserMessage(body.messages)
  const resume = parseResume(forwarded.resume) ?? entry?.resume
  const log = options.evidenceLog
  const identity: RunIdentity = { threadId, runId, turnId }

  // A reconnect replays recorded evidence and rejoins the turn; it never starts a second run.
  const lastEventId = c.req.headers.get("last-event-id")
  if (log !== undefined && lastEventId !== null) {
    if (!LAST_EVENT_ID_PATTERN.test(lastEventId))
      return jsonResponse(400, { error: "invalid_last_event_id" })
    const replay = await log.replay(turnId, Number(lastEventId))
    if (replay === undefined) return jsonResponse(409, { error: "replay_unavailable" })
    return sseReplayResponse(identity, replay)
  }

  // `body.state` seeds the run's shared UI state document; patches stream as STATE_DELTA.
  const sharedState = createAgentSharedState<unknown>(body.state === undefined ? {} : body.state)
  const basePorts = await options.ports(c, { turnId, sharedState })

  const start = (
    telemetry: AgentPorts["telemetry"],
    deltas: AgentDeltaSink,
  ): Promise<AgentRunResult<unknown>> => {
    // Compose rather than replace: the SSE evidence stream must not displace a telemetry port or
    // delta sink the caller injected through `ports`.
    const combined = combineAgentTelemetry(basePorts.telemetry, log?.open(turnId), telemetry)
    const sinks = combineAgentDeltaSinks(basePorts.deltas, deltas)
    const ports = {
      ...basePorts,
      ...(combined === undefined ? {} : { telemetry: combined }),
      ...(sinks === undefined ? {} : { deltas: sinks }),
    }
    if (resume !== undefined) {
      return resumeAgent(options.agent, turnId, { value: input, resume }, ports, runOptions)
    }
    return runAgent(options.agent, { value: input }, ports, {
      ...runOptions,
      state: createAgentState(turnId),
    })
  }
  const snapshotMessages = options.emitMessagesSnapshot === true ? body.messages : undefined
  return sseResponse(identity, start, log, snapshotMessages, {
    channel: sharedState,
    announced: body.state !== undefined,
  })
}

interface RunIdentity {
  readonly threadId: string
  readonly runId: string
  readonly turnId: string
}

function sseResponse(
  identity: RunIdentity,
  start: (
    telemetry: AgentPorts["telemetry"],
    deltas: AgentDeltaSink,
  ) => Promise<AgentRunResult<unknown>>,
  log: AgentEvidenceLog | undefined,
  snapshotMessages: unknown,
  state: { readonly channel: AgentSharedState; readonly announced: boolean },
): Response {
  const stream = createAgentEvidenceStream()
  // `id:` frames are only meaningful when a log can serve the reconnect they invite.
  const withIds = log !== undefined
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = sseSender(controller)
      const projector = createDeltaProjector(send, identity.turnId)
      const run = start(stream, projector.sink)
      // The evidence stream must terminate whether the run resolves or throws, or the `for await`
      // below would hang; the run result (or the error) is still reported in-band after it drains.
      run
        .then(
          () => {},
          () => {},
        )
        .finally(() => stream.complete())
      send({ type: "RUN_STARTED", threadId: identity.threadId, runId: identity.runId })
      send({ type: "CUSTOM", name: "nifra.turn", value: { turnId: identity.turnId } })
      let announced = state.announced
      if (announced)
        send({ type: "STATE_SNAPSHOT", snapshot: state.channel.snapshot(), timestamp: Date.now() })
      // A first patch on an unseeded document announces the whole document instead of a delta
      // against a base the client never saw.
      const unsubscribe = state.channel.subscribe((ops) => {
        if (!announced) {
          announced = true
          send({
            type: "STATE_SNAPSHOT",
            snapshot: state.channel.snapshot(),
            timestamp: Date.now(),
          })
          return
        }
        send({ type: "STATE_DELTA", delta: ops, timestamp: Date.now() })
      })
      try {
        for await (const evidence of stream) {
          const openToolCallId = projector.adopt(evidence)
          sendEvidence(send, evidence, identity.turnId, withIds, openToolCallId)
        }
        const { streamedText, usage } = projector.finish()
        const events = terminalEvents(identity, await run, snapshotMessages, usage)
        // Store the terminal events before delivering them, so a client that misses them can
        // replay. The stored form is always the unsuppressed one - a replayed stream saw no
        // deltas, so it needs the full terminal text block.
        await finishQuietly(log, identity.turnId, { events })
        for (const event of events) {
          // Streamed text IS the assistant message; re-sending it as a terminal block would
          // duplicate it on the live client.
          if (streamedText && String(event.type).startsWith("TEXT_MESSAGE_")) continue
          send(event)
        }
      } catch {
        projector.finish()
        const events = [{ type: "RUN_ERROR", message: "run_failed", timestamp: Date.now() }]
        await finishQuietly(log, identity.turnId, { events })
        for (const event of events) send(event)
      } finally {
        unsubscribe()
        controller.close()
      }
    },
  })
  return sseHeaders(body)
}

function sseReplayResponse(identity: RunIdentity, replay: AgentEvidenceReplay): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = sseSender(controller)
      send({ type: "RUN_STARTED", threadId: identity.threadId, runId: identity.runId })
      send({ type: "CUSTOM", name: "nifra.turn", value: { turnId: identity.turnId } })
      try {
        for (const evidence of replay.evidence) sendEvidence(send, evidence, identity.turnId, true)
        if (replay.live !== undefined)
          for await (const evidence of replay.live)
            sendEvidence(send, evidence, identity.turnId, true)
        const events = asTerminalEvents(await replay.result)
        if (events === undefined) send({ type: "RUN_ERROR", message: "run_failed" })
        else for (const event of events) send(event)
      } catch {
        send({ type: "RUN_ERROR", message: "run_failed" })
      } finally {
        controller.close()
      }
    },
  })
  return sseHeaders(body)
}

type SseSend = (event: Record<string, unknown>, id?: number) => void

function sseSender(controller: ReadableStreamDefaultController<Uint8Array>): SseSend {
  const encoder = new TextEncoder()
  return (event, id) => {
    const head = id === undefined ? "" : `id: ${id}\n`
    controller.enqueue(encoder.encode(`${head}data: ${JSON.stringify(event)}\n\n`))
  }
}

/**
 * Emit one evidence item's events, stamping the `seq` only on the item's LAST frame: SSE
 * `Last-Event-ID` points at the last frame received, so a partially delivered multi-event item
 * (a TOOL_CALL_START without its END) is replayed whole on reconnect instead of losing its tail.
 */
function sendEvidence(
  send: SseSend,
  evidence: AgentStepEvidence,
  turnId: string,
  withIds: boolean,
  openToolCallId?: string,
): void {
  const events = evidenceEvents(evidence, turnId, openToolCallId)
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index] as Record<string, unknown>
    if (withIds && index === events.length - 1) send(event, evidence.seq)
    else send(event)
  }
}

function sseHeaders(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  })
}

/**
 * One aggregated token-usage entry in the spec's `RUN_FINISHED.usage` array: the model port's
 * `usage` deltas summed per `(provider, model)` pair, matching AG-UI's `TokenUsage` shape.
 */
export interface AgUIRunUsage {
  readonly provider?: string
  readonly model?: string
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly reasoningTokens?: number
  readonly cachedInputTokens?: number
}

const USAGE_TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "reasoningTokens",
  "cachedInputTokens",
] as const

interface DeltaProjector {
  readonly sink: AgentDeltaSink
  /**
   * Called per evidence item before its events go out. Terminal tool evidence adopts the open
   * provisional tool call (its START/ARGS already streamed) - the returned id replaces the
   * effect id so the evidence closes the same call the client is watching.
   */
  adopt(evidence: AgentStepEvidence): string | undefined
  /**
   * Close every open stream. Returns whether any text was streamed during the run, and the
   * per-(provider, model) token usage sums when any `usage` delta was reported.
   */
  finish(): { readonly streamedText: boolean; readonly usage?: readonly AgUIRunUsage[] }
}

/**
 * Project model deltas onto live AG-UI frames. Text deltas open a `TEXT_MESSAGE`, reasoning
 * deltas a `REASONING` message, tool-args deltas a provisional `TOOL_CALL` - each stream closes
 * when a different delta kind starts, when tool evidence lands, or at the end of the run. Deltas
 * are transient observer data: none of this is persisted or replayed.
 */
function createDeltaProjector(send: SseSend, turnId: string): DeltaProjector {
  let counter = 0
  let textId: string | undefined
  let reasoningId: string | undefined
  let callId: string | undefined
  let streamedText = false
  let usage: Map<string, UsageEntry> | undefined
  const closeText = (): void => {
    if (textId === undefined) return
    send({ type: "TEXT_MESSAGE_END", messageId: textId, timestamp: Date.now() })
    textId = undefined
  }
  const closeReasoning = (): void => {
    if (reasoningId === undefined) return
    const timestamp = Date.now()
    send({ type: "REASONING_MESSAGE_END", messageId: reasoningId, timestamp })
    send({ type: "REASONING_END", messageId: reasoningId, timestamp })
    reasoningId = undefined
  }
  const closeCall = (): void => {
    if (callId === undefined) return
    send({ type: "TOOL_CALL_END", toolCallId: callId, timestamp: Date.now() })
    callId = undefined
  }
  const sink: AgentDeltaSink = {
    delta(delta: AgentModelDelta) {
      // Usage is terminal metadata for the whole run, not a frame: sum per (provider, model)
      // across model decisions without disturbing whichever stream is open.
      if (delta.kind === "usage") {
        usage = usage ?? new Map()
        const key = `${delta.provider ?? ""} ${delta.model ?? ""}`
        let entry = usage.get(key)
        if (entry === undefined) {
          entry = {
            ...(delta.provider === undefined ? {} : { provider: delta.provider }),
            ...(delta.model === undefined ? {} : { model: delta.model }),
          }
          usage.set(key, entry)
        }
        for (const field of USAGE_TOKEN_FIELDS) {
          const value = delta[field]
          // A non-finite figure must not poison the sum; a never-reported field stays absent.
          if (typeof value === "number" && Number.isFinite(value))
            entry[field] = (entry[field] ?? 0) + value
        }
        return
      }
      const timestamp = Date.now()
      if (delta.kind === "text") {
        closeReasoning()
        closeCall()
        if (textId === undefined) {
          textId = `${turnId}:stream:${counter}`
          counter += 1
          send({ type: "TEXT_MESSAGE_START", messageId: textId, role: "assistant", timestamp })
        }
        send({ type: "TEXT_MESSAGE_CONTENT", messageId: textId, delta: delta.text, timestamp })
        streamedText = true
        return
      }
      if (delta.kind === "reasoning") {
        closeText()
        closeCall()
        if (reasoningId === undefined) {
          reasoningId = `${turnId}:reasoning:${counter}`
          counter += 1
          send({ type: "REASONING_START", messageId: reasoningId, timestamp })
          send({
            type: "REASONING_MESSAGE_START",
            messageId: reasoningId,
            role: "reasoning",
            timestamp,
          })
        }
        send({
          type: "REASONING_MESSAGE_CONTENT",
          messageId: reasoningId,
          delta: delta.text,
          timestamp,
        })
        return
      }
      closeText()
      closeReasoning()
      if (callId === undefined) {
        callId = `${turnId}:call:${counter}`
        counter += 1
        send({
          type: "TOOL_CALL_START",
          toolCallId: callId,
          toolCallName: delta.name ?? "tool",
          timestamp,
        })
      }
      send({ type: "TOOL_CALL_ARGS", toolCallId: callId, delta: delta.argsText, timestamp })
    },
  }
  return {
    sink,
    adopt(evidence) {
      if (evidence.kind !== "tool" || evidence.outcome === "started") return undefined
      closeText()
      closeReasoning()
      if (callId === undefined) return undefined
      const adopted = callId
      callId = undefined
      return adopted
    },
    finish() {
      closeCall()
      closeReasoning()
      closeText()
      return { streamedText, ...(usage === undefined ? {} : { usage: [...usage.values()] }) }
    },
  }
}

/** Mutable accumulator behind one `AgUIRunUsage` entry. */
interface UsageEntry {
  provider?: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  reasoningTokens?: number
  cachedInputTokens?: number
}

/** JSON Schema for the payload a spec `resume` entry must carry back. */
const RESUME_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["continuation"],
  properties: {
    continuation: {
      type: "object",
      description: "Echo of the interrupt's metadata.continuation, with the tool input replayed.",
    },
    approval: {
      type: "object",
      properties: { granted: { type: "boolean" }, reason: { type: "string" } },
    },
  },
}

/** The events that close a run, derived once so live delivery and replay stay identical. */
function terminalEvents(
  identity: RunIdentity,
  result: AgentRunResult<unknown>,
  snapshotMessages: unknown,
  usage?: readonly AgUIRunUsage[],
): readonly Record<string, unknown>[] {
  const timestamp = Date.now()
  // Usage rides the spec's RUN_FINISHED `usage` array, so the stored terminal events keep it
  // and a replayed stream reports the same totals as the live one.
  const withUsage = usage === undefined ? {} : { usage }
  if (result.status === "completed") {
    if (result.error !== undefined)
      return [{ type: "RUN_ERROR", message: result.error.code, timestamp }]
    const messageId = `${identity.turnId}:output`
    const delta = typeof result.output === "string" ? result.output : JSON.stringify(result.output)
    return [
      { type: "TEXT_MESSAGE_START", messageId, role: "assistant", timestamp },
      { type: "TEXT_MESSAGE_CONTENT", messageId, delta, timestamp },
      { type: "TEXT_MESSAGE_END", messageId, timestamp },
      ...messagesSnapshot(snapshotMessages, messageId, delta, timestamp),
      {
        type: "RUN_FINISHED",
        threadId: identity.threadId,
        runId: identity.runId,
        result: result.output,
        outcome: { type: "success" },
        ...withUsage,
        timestamp,
      },
    ]
  }
  if (result.status === "suspended") {
    return [
      {
        type: "CUSTOM",
        name: "nifra.pending",
        value: { turnId: identity.turnId, reason: result.reason, continuation: result.pending },
        timestamp,
      },
      {
        type: "RUN_FINISHED",
        threadId: identity.threadId,
        runId: identity.runId,
        outcome: {
          type: "interrupt",
          interrupts: [
            {
              id: identity.turnId,
              reason: result.reason,
              ...(result.pending.tool === undefined ? {} : { toolCallId: result.pending.effectId }),
              responseSchema: RESUME_RESPONSE_SCHEMA,
              metadata: { turnId: identity.turnId, continuation: result.pending },
            },
          ],
        },
        ...withUsage,
        timestamp,
      },
    ]
  }
  return [
    {
      type: "RUN_FINISHED",
      threadId: identity.threadId,
      runId: identity.runId,
      ...withUsage,
      timestamp,
    },
  ]
}

/**
 * The optional authoritative message list: the client-sent messages echoed back with the
 * assistant output appended. Emitted only when `emitMessagesSnapshot` is on.
 */
function messagesSnapshot(
  messages: unknown,
  messageId: string,
  content: string,
  timestamp: number,
): readonly Record<string, unknown>[] {
  if (messages === undefined) return []
  const echoed = Array.isArray(messages) ? messages : []
  return [
    {
      type: "MESSAGES_SNAPSHOT",
      messages: [...echoed, { id: messageId, role: "assistant", content }],
      timestamp,
    },
  ]
}

/** Parse the stored terminal value - a durable log adapter may hand back anything. */
function asTerminalEvents(value: unknown): readonly Record<string, unknown>[] | undefined {
  const record = asRecord(value)
  if (record === undefined || !Array.isArray(record.events)) return undefined
  const events: Record<string, unknown>[] = []
  for (const event of record.events) {
    const parsed = asRecord(event)
    if (parsed === undefined) return undefined
    events.push(parsed)
  }
  return events
}

/** Telemetry-grade storage: a failing log must not fail the turn or mask its result. */
async function finishQuietly(
  log: AgentEvidenceLog | undefined,
  turnId: string,
  result: unknown,
): Promise<void> {
  if (log === undefined) return
  try {
    await log.finish(turnId, result)
  } catch {
    // Replay degrades to unavailable; the in-band response is unaffected.
  }
}

/** Map one step-evidence item onto AG-UI events. Evidence is token-only by design. */
function evidenceEvents(
  evidence: AgentStepEvidence,
  turnId: string,
  openToolCallId?: string,
): readonly Record<string, unknown>[] {
  const timestamp = evidence.at
  if (evidence.kind === "tool") {
    // When the model streamed this call's arguments, its TOOL_CALL_START (with TOOL_CALL_ARGS)
    // already went out under the projector's provisional id - close that call instead of
    // opening a second one under the effect id.
    const toolCallId = openToolCallId ?? evidence.effectId ?? `${evidence.kind}:${evidence.seq}`
    const start = {
      type: "TOOL_CALL_START",
      toolCallId,
      toolCallName: evidence.name ?? "tool",
      timestamp,
    }
    // The runner records one terminal evidence item per tool effect (committed/failed/denied),
    // so a single item expands to the START/END/RESULT triple AG-UI clients expect. The RESULT
    // content is the token-only outcome - the runtime never carries tool payloads.
    if (evidence.outcome === "started") return openToolCallId === undefined ? [start] : []
    return [
      ...(openToolCallId === undefined ? [start] : []),
      { type: "TOOL_CALL_END", toolCallId, timestamp },
      {
        type: "TOOL_CALL_RESULT",
        messageId: `${turnId}:tool:${evidence.seq}`,
        toolCallId,
        role: "tool",
        content: JSON.stringify({
          outcome: evidence.outcome,
          ...(evidence.code === undefined ? {} : { code: evidence.code }),
        }),
        timestamp,
      },
    ]
  }
  const stepName = evidence.name === undefined ? evidence.kind : `${evidence.kind}:${evidence.name}`
  if (evidence.outcome === "started") return [{ type: "STEP_STARTED", stepName, timestamp }]
  return [{ type: "STEP_FINISHED", stepName, timestamp }]
}

function lastUserMessage(messages: unknown): unknown {
  if (!Array.isArray(messages)) return undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index])
    if (message !== undefined && message.role === "user") return message.content
  }
  return undefined
}

function parseResume(raw: unknown): AgentTurnInput["resume"] | undefined {
  const record = asRecord(raw)
  if (record === undefined) return undefined
  const continuation = asRecord(record.continuation)
  if (continuation === undefined) return undefined
  const kind = continuation.kind
  if (typeof kind !== "string" || !PENDING_KINDS.includes(kind as AgentPendingKind))
    return undefined
  if (typeof continuation.effectId !== "string") return undefined
  if (continuation.tool !== undefined && typeof continuation.tool !== "string") return undefined
  const approval = asRecord(record.approval)
  return {
    continuation: {
      kind: kind as AgentPendingKind,
      ...(continuation.tool === undefined ? {} : { tool: continuation.tool as string }),
      ...(Object.hasOwn(continuation, "input") ? { input: continuation.input } : {}),
      effectId: continuation.effectId,
    },
    ...(approval !== undefined && typeof approval.granted === "boolean"
      ? {
          approval: {
            granted: approval.granted,
            ...(typeof approval.reason === "string" ? { reason: approval.reason } : {}),
          },
        }
      : {}),
  }
}

/**
 * Parse the spec `RunAgentInput.resume` array. The runtime holds no interrupt registry - the
 * interrupt id IS the turn id, and the entry's `payload` must echo the interrupt's
 * `metadata.continuation`. A single pending suspension means a single entry; extras are ignored.
 */
function parseResumeEntry(
  raw: unknown,
): { readonly turnId: string; readonly resume: AgentTurnInput["resume"] } | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const entry = asRecord(raw[0])
  if (entry === undefined) return undefined
  const interruptId = entry.interruptId
  if (typeof interruptId !== "string" || !TURN_ID_PATTERN.test(interruptId)) return undefined
  const status = entry.status
  if (status !== "resolved" && status !== "cancelled") return undefined
  const payload = asRecord(entry.payload) ?? {}
  const approval = asRecord(payload.approval)
  const resume = parseResume({
    continuation: payload.continuation,
    // A cancelled entry without an explicit approval decision resumes as a denial.
    approval: approval ?? (status === "cancelled" ? { granted: false } : undefined),
  })
  if (resume === undefined) return undefined
  return { turnId: interruptId, resume }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}

function render(response: Response | ResponseResult): Response {
  return response instanceof Response ? response : toResponse(response, EMPTY_RESPONSE_CONTROLS)
}

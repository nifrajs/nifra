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
 *   - Step evidence maps to `TOOL_CALL_START`/`TOOL_CALL_END` for tool effects and
 *     `STEP_STARTED`/`STEP_FINISHED` for everything else. The runner's model port returns complete
 *     responses, so text arrives as a single `TEXT_MESSAGE_START`/`_CONTENT`/`_END` sequence, not
 *     token deltas.
 *   - A completed run ends `RUN_FINISHED` with `result`; a failed one ends `RUN_ERROR`.
 *   - A suspended run (approval, budget, model retry, max turns) emits
 *     `CUSTOM { name: "nifra.pending", value: { turnId, reason, continuation } }` and then
 *     `RUN_FINISHED`. Resume by sending the continuation back in
 *     `forwardedProps.resume` (`{ continuation, approval? }`) with `forwardedProps.turnId`; the
 *     runtime keeps state token-only, so a suspended tool's input must be replayed in
 *     `continuation.input`.
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
  type AgentPendingKind,
  type AgentPorts,
  type AgentRunResult,
  type AgentStepEvidence,
  type AgentTurnInput,
  combineAgentTelemetry,
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
   * capabilities, and budgets. Receives the route context so the caller can scope every port to the
   * request subject.
   */
  readonly ports: (c: AgUIRouteContext) => AgentPorts | Promise<AgentPorts>
  /**
   * Evidence log making the SSE stream resumable via `Last-Event-ID`. The in-memory reference
   * (`createMemoryAgentEvidenceLog`) is single-process; a durable log is an adapter concern.
   */
  readonly evidenceLog?: AgentEvidenceLog
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
  const turnId = forwardedTurnId ?? (TURN_ID_PATTERN.test(runId) ? runId : crypto.randomUUID())

  const input = Object.hasOwn(forwarded, "input") ? forwarded.input : lastUserMessage(body.messages)
  const resume = parseResume(forwarded.resume)
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

  const basePorts = await options.ports(c)

  const start = (telemetry?: AgentPorts["telemetry"]): Promise<AgentRunResult<unknown>> => {
    // Compose rather than replace: the SSE evidence stream must not displace a telemetry port the
    // caller injected through `ports`.
    const combined = combineAgentTelemetry(basePorts.telemetry, log?.open(turnId), telemetry)
    const ports = combined === undefined ? basePorts : { ...basePorts, telemetry: combined }
    if (resume !== undefined) {
      return resumeAgent(options.agent, turnId, { value: input, resume }, ports, runOptions)
    }
    return runAgent(options.agent, { value: input }, ports, {
      ...runOptions,
      state: createAgentState(turnId),
    })
  }
  return sseResponse(identity, start, log)
}

interface RunIdentity {
  readonly threadId: string
  readonly runId: string
  readonly turnId: string
}

function sseResponse(
  identity: RunIdentity,
  start: (telemetry: AgentPorts["telemetry"]) => Promise<AgentRunResult<unknown>>,
  log: AgentEvidenceLog | undefined,
): Response {
  const stream = createAgentEvidenceStream()
  // `id:` frames are only meaningful when a log can serve the reconnect they invite.
  const withIds = log !== undefined
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = sseSender(controller)
      const run = start(stream)
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
      try {
        for await (const evidence of stream) sendEvidence(send, evidence, withIds)
        const events = terminalEvents(identity, await run)
        // Store the terminal events before delivering them, so a client that misses them can replay.
        await finishQuietly(log, identity.turnId, { events })
        for (const event of events) send(event)
      } catch {
        const events = [{ type: "RUN_ERROR", message: "run_failed" }]
        await finishQuietly(log, identity.turnId, { events })
        for (const event of events) send(event)
      } finally {
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
        for (const evidence of replay.evidence) sendEvidence(send, evidence, true)
        if (replay.live !== undefined)
          for await (const evidence of replay.live) sendEvidence(send, evidence, true)
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
function sendEvidence(send: SseSend, evidence: AgentStepEvidence, withIds: boolean): void {
  const events = evidenceEvents(evidence)
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

/** The events that close a run, derived once so live delivery and replay stay identical. */
function terminalEvents(
  identity: RunIdentity,
  result: AgentRunResult<unknown>,
): readonly Record<string, unknown>[] {
  if (result.status === "completed") {
    if (result.error !== undefined) return [{ type: "RUN_ERROR", message: result.error.code }]
    const messageId = `${identity.turnId}:output`
    const delta = typeof result.output === "string" ? result.output : JSON.stringify(result.output)
    return [
      { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId, delta },
      { type: "TEXT_MESSAGE_END", messageId },
      {
        type: "RUN_FINISHED",
        threadId: identity.threadId,
        runId: identity.runId,
        result: result.output,
      },
    ]
  }
  const finished = { type: "RUN_FINISHED", threadId: identity.threadId, runId: identity.runId }
  if (result.status === "suspended") {
    return [
      {
        type: "CUSTOM",
        name: "nifra.pending",
        value: { turnId: identity.turnId, reason: result.reason, continuation: result.pending },
      },
      finished,
    ]
  }
  return [finished]
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
function evidenceEvents(evidence: AgentStepEvidence): readonly Record<string, unknown>[] {
  if (evidence.kind === "tool") {
    const toolCallId = evidence.effectId ?? `${evidence.kind}:${evidence.seq}`
    const start = { type: "TOOL_CALL_START", toolCallId, toolCallName: evidence.name ?? "tool" }
    // The runner records one terminal evidence item per tool effect (committed/failed/denied),
    // so a single item expands to the START/END pair AG-UI clients expect.
    if (evidence.outcome === "started") return [start]
    return [start, { type: "TOOL_CALL_END", toolCallId }]
  }
  const stepName = evidence.name === undefined ? evidence.kind : `${evidence.kind}:${evidence.name}`
  if (evidence.outcome === "started") return [{ type: "STEP_STARTED", stepName }]
  return [{ type: "STEP_FINISHED", stepName }]
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

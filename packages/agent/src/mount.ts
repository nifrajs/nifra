/**
 * `mountAgent` - the one-call HTTP + SSE seam for a {@link AgentDefinition}.
 *
 * It translates HTTP to the bounded runner and back, nothing more. The request body is read through
 * core's single bounded, proto-guarded framing lane (`@nifrajs/core/edge-kit`); the run itself is
 * driven by {@link runAgent}/{@link resumeAgent}. The caller supplies the ports through a per-request
 * factory, so the model, durable state store, and approval transport - the operated, credentialed, or
 * tenant-scoped pieces - are injected here and never live in this package.
 *
 * Wire contract (default path `/agent`):
 * - `POST {path}` body `{ input, turnId?, resume? }`:
 *   - `Accept: text/event-stream` -> SSE: one `event: step` per {@link AgentStepEvidence}, then a final
 *     `event: result` carrying the projected run result, then the stream closes.
 *   - otherwise -> a single JSON body: the projected run result. A run that throws answers
 *     `500 { error: "run_failed" }`, or `409 { error: "resume_unavailable" }` when the POST resumed a turn.
 * - `resume` is `{ continuation, approval? }` (see {@link AgentTurnInput}); the runtime keeps state
 *   token-only, so a suspended tool's input must be replayed by the caller in `continuation.input`.
 *   Return `resumeApproval: "port"` from `ports` when the caller must not approve its own tool calls.
 * - With an `evidenceLog` configured, `step` frames carry `id: <seq>` and a dropped SSE connection
 *   is resumable: re-POST the same `turnId` with a `Last-Event-ID` header to replay the missed
 *   evidence and rejoin the still-running turn (or receive the stored terminal frame) - the run is
 *   never re-executed. Without the log the header is ignored and every POST starts a run.
 * - One SSE response emits at most `maxOutputBytes` (default 4 MiB), so a client that stops reading
 *   cannot make the server queue a whole run; past it the response ends with `event: error`.
 * - The seam performs no authentication or authorization. Wrap it with the app's own route guards, and
 *   scope the store/model returned by `ports` to the caller (RLS born in at the data layer). With an
 *   `evidenceLog`, set `evidenceOwner` too: without it a turn id is a bearer capability, and any
 *   caller who reaches the route with it replays that turn's evidence.
 */

import {
  EMPTY_RESPONSE_CONTROLS,
  type ProtoPoisoning,
  plainError,
  type ResponseResult,
  readBodyFramed,
  toResponse,
} from "@nifrajs/core/edge-kit"
import type { StandardSchemaV1 } from "@nifrajs/core/schema"
import {
  type AgentEvidenceLog,
  type AgentEvidenceReplay,
  createAgentEvidenceStream,
  scopeAgentEvidenceLog,
} from "./events.ts"
import {
  type AgentDefinition,
  type AgentPendingKind,
  type AgentPorts,
  type AgentRunResult,
  type AgentTurnInput,
  combineAgentTelemetry,
  createAgentState,
  resumeAgent,
  runAgent,
} from "./index.ts"

const DEFAULT_PATH = "/agent"
const DEFAULT_MAX_BODY_BYTES = 1_000_000
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024
const PENDING_KINDS: readonly AgentPendingKind[] = ["approval", "budget", "model", "cancelled"]
const LAST_EVENT_ID_PATTERN = /^\d{1,15}$/
const TURN_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/

/** The structural slice of a route context the seam needs. Kept loose so core stays a peer dependency. */
export interface AgentRouteContext {
  readonly req: Request
}

/** The structural slice of a nifra server `mountAgent` needs. */
export interface AgentMountableApp {
  post(path: string, handler: (c: AgentRouteContext) => Response | Promise<Response>): unknown
}

export interface MountAgentOptions<
  InputSchema extends StandardSchemaV1,
  OutputSchema extends StandardSchemaV1,
> {
  readonly agent: AgentDefinition<InputSchema, OutputSchema>
  /** Endpoint path. Default `/agent`. */
  readonly path?: string
  /** Bounded run length passed to {@link runAgent}. */
  readonly maxTurns?: number
  /** Maximum request body size in bytes. Default 1_000_000. */
  readonly maxBodyBytes?: number
  /** Prototype-poisoning policy for the framing lane. Default `"reject"`. */
  readonly protoPoisoning?: ProtoPoisoning
  /**
   * Maximum total UTF-8 bytes one SSE response emits. Default 4 MiB. Past it the response ends with an
   * `error` frame (`output_limit`); with an `evidenceLog` the run keeps recording and a reconnect with
   * `Last-Event-ID` reads on from where this response stopped, otherwise the run is cancelled.
   */
  readonly maxOutputBytes?: number
  /**
   * Build the ports for one request - the model, durable state store, approval transport, capabilities,
   * and budgets. Receives the route context so the caller can scope every port to the request subject.
   * Throw a `Response` (a 401 with its challenge, a 403) to answer the request with it; any other throw
   * is a fault and reaches the app's error handling.
   */
  readonly ports: (c: AgentRouteContext) => AgentPorts | Promise<AgentPorts>
  /**
   * Evidence log making the SSE stream resumable via `Last-Event-ID`. The in-memory reference
   * (`createMemoryAgentEvidenceLog`) is single-process; a durable log is an adapter concern.
   */
  readonly evidenceLog?: AgentEvidenceLog
  /**
   * Who a turn's recorded evidence belongs to - the caller's user or tenant id. Turns are recorded and
   * replayed under it, so a reconnect or a reused `turnId` from another caller finds nothing of this
   * caller's turns. It runs before a replay is served; throw to refuse the request with
   * `403 { error: "forbidden" }`, or throw a `Response` to answer with it instead.
   */
  readonly evidenceOwner?: (c: AgentRouteContext) => string | Promise<string>
}

/** Mount a single agent as `POST {path}`, negotiating an SSE evidence stream on `Accept`. */
export function mountAgent<
  InputSchema extends StandardSchemaV1,
  OutputSchema extends StandardSchemaV1,
>(app: AgentMountableApp, options: MountAgentOptions<InputSchema, OutputSchema>): void {
  const path = options.path ?? DEFAULT_PATH
  const maxBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const proto = options.protoPoisoning ?? "reject"
  const runOptions = options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  if (
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1024 ||
    maxOutputBytes > MAX_OUTPUT_BYTES
  )
    throw new RangeError(`mountAgent maxOutputBytes must be between 1024 and ${MAX_OUTPUT_BYTES}`)

  app.post(path, (c) =>
    readBodyFramed<Response>(
      c.req,
      maxBytes,
      proto,
      (parsed) => execute(c, parsed, options, runOptions, maxOutputBytes),
      (rejection) => render(rejection),
      () => render(plainError(400, "bad_request")),
    ).catch(passThrownResponse),
  )
}

async function execute<InputSchema extends StandardSchemaV1, OutputSchema extends StandardSchemaV1>(
  c: AgentRouteContext,
  parsed: unknown,
  options: MountAgentOptions<InputSchema, OutputSchema>,
  runOptions: { readonly maxTurns?: number },
  maxOutputBytes: number,
): Promise<Response> {
  const body = asRecord(parsed)
  if (body === undefined) return jsonResponse(400, { error: "body_must_be_object" })

  const turnIdRaw = typeof body.turnId === "string" ? body.turnId : undefined
  if (turnIdRaw !== undefined && !TURN_ID_PATTERN.test(turnIdRaw))
    return jsonResponse(400, { error: "invalid_turn_id" })
  const turnId = turnIdRaw ?? crypto.randomUUID()

  const resume = parseResume(body.resume)
  let log = options.evidenceLog
  if (log !== undefined && options.evidenceOwner !== undefined) {
    let owner: string
    try {
      owner = await options.evidenceOwner(c)
    } catch (err) {
      if (err instanceof Response) return err
      return jsonResponse(403, { error: "forbidden" })
    }
    log = scopeAgentEvidenceLog(log, owner)
  }
  const wantsSse = (c.req.headers.get("accept") ?? "").includes("text/event-stream")

  // A reconnect replays recorded evidence and rejoins the turn; it never starts a second run.
  const lastEventId = c.req.headers.get("last-event-id")
  if (wantsSse && log !== undefined && lastEventId !== null) {
    if (!LAST_EVENT_ID_PATTERN.test(lastEventId))
      return jsonResponse(400, { error: "invalid_last_event_id" })
    const replay = await log.replay(turnId, Number(lastEventId))
    if (replay === undefined) return jsonResponse(409, { error: "replay_unavailable" })
    return sseReplayResponse(turnId, replay, maxOutputBytes)
  }

  const basePorts = await options.ports(c)

  const start = (
    telemetry?: AgentPorts["telemetry"],
    disconnect?: AbortSignal,
  ): Promise<AgentRunResult<NonNullable<OutputSchema["~standard"]["types"]>["output"]>> => {
    // Compose rather than replace: an SSE evidence stream must not displace a telemetry port the
    // caller injected through `ports` (an exporter, a durable evidence log).
    const combined = combineAgentTelemetry(basePorts.telemetry, log?.open(turnId), telemetry)
    const signal = withDisconnect(basePorts.signal, disconnect)
    const ports = {
      ...basePorts,
      ...(combined === undefined ? {} : { telemetry: combined }),
      ...(signal === undefined ? {} : { signal }),
    }
    if (resume !== undefined) {
      return resumeAgent(options.agent, turnId, { value: body.input, resume }, ports, runOptions)
    }
    let state: ReturnType<typeof createAgentState>
    try {
      state = createAgentState(turnId)
    } catch {
      return Promise.reject(new BadTurnId())
    }
    return runAgent(options.agent, { value: body.input }, ports, { ...runOptions, state })
  }

  if (!wantsSse) {
    try {
      const result = await start()
      const projected = projectResult(turnId, result)
      await finishQuietly(log, turnId, { event: "result", data: projected })
      return jsonResponse(200, projected)
    } catch (err) {
      await finishQuietly(log, turnId, { event: "error", data: { turnId, error: "run_failed" } })
      if (err instanceof BadTurnId) return jsonResponse(400, { error: "invalid_turn_id" })
      if (resume !== undefined) return jsonResponse(409, { error: "resume_unavailable" })
      return jsonResponse(500, { error: "run_failed" })
    }
  }
  return sseResponse(turnId, start, log, maxOutputBytes)
}

function sseResponse<Output>(
  turnId: string,
  start: (
    telemetry: AgentPorts["telemetry"],
    disconnect: AbortSignal | undefined,
  ) => Promise<AgentRunResult<Output>>,
  log: AgentEvidenceLog | undefined,
  maxOutputBytes: number,
): Response {
  const stream = createAgentEvidenceStream()
  // `id:` frames are only meaningful when a log can serve the reconnect they invite.
  const withIds = log !== undefined
  // A disconnect detaches the client. With a log the run keeps recording for a reconnect to replay;
  // without one nothing can rejoin it, so the run is cancelled.
  const disconnect = log === undefined ? new AbortController() : undefined
  let detached = false
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const deliver = sseSender(controller, maxOutputBytes)
      const send: typeof deliver = (event, data, id) => {
        if (detached) return
        try {
          deliver(event, data, id)
        } catch (error) {
          if (!(error instanceof SseOutputLimitError)) throw error
          // The budget belongs to this response, not to the logged run's authoritative result.
          detached = true
          disconnect?.abort()
          endOverBudget(deliver, controller, turnId)
        }
      }
      const run = start(stream, disconnect?.signal)
      // The evidence stream must terminate whether the run resolves or throws, or the `for await`
      // below would hang; the run result (or the error) is still reported in-band after it drains.
      run
        .then(
          () => {},
          () => {},
        )
        .finally(() => stream.complete())
      try {
        for await (const evidence of stream)
          send("step", evidence, withIds ? evidence.seq : undefined)
        const frame = { event: "result", data: projectResult(turnId, await run) }
        // Store the terminal frame before delivering it, so a client that misses it can replay.
        await finishQuietly(log, turnId, frame)
        send(frame.event, frame.data)
      } catch {
        const frame = { event: "error", data: { turnId, error: "run_failed" } }
        await finishQuietly(log, turnId, frame)
        send(frame.event, frame.data)
      } finally {
        if (!detached) controller.close()
      }
    },
    cancel() {
      detached = true
      disconnect?.abort()
    },
  })
  return sseHeaders(body)
}

function withDisconnect(
  signal: AbortSignal | undefined,
  disconnect: AbortSignal | undefined,
): AbortSignal | undefined {
  if (signal === undefined || disconnect === undefined) return signal ?? disconnect
  return AbortSignal.any([signal, disconnect])
}

function sseReplayResponse(
  turnId: string,
  replay: AgentEvidenceReplay,
  maxOutputBytes: number,
): Response {
  let detached = false
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const deliver = sseSender(controller, maxOutputBytes)
      const send: typeof deliver = (event, data, id) => {
        if (detached) return
        try {
          deliver(event, data, id)
        } catch (error) {
          if (!(error instanceof SseOutputLimitError)) throw error
          detached = true
          void replay.live?.return?.()
          endOverBudget(deliver, controller, turnId)
        }
      }
      try {
        for (const evidence of replay.evidence) send("step", evidence, evidence.seq)
        if (replay.live !== undefined)
          for await (const evidence of replay.live) send("step", evidence, evidence.seq)
        const frame = asTerminalFrame(await replay.result)
        if (frame === undefined) send("error", { turnId, error: "run_failed" })
        else send(frame.event, frame.data)
      } catch {
        send("error", { turnId, error: "run_failed" })
      } finally {
        if (!detached) controller.close()
      }
    },
    cancel() {
      detached = true
      // Only this view detaches; the logged run keeps recording for the next reconnect.
      void replay.live?.return?.()
    },
  })
  return sseHeaders(body)
}

type SseSend = (event: string, data: unknown, id?: number) => void

class SseOutputLimitError extends Error {}

function sseSender(
  controller: ReadableStreamDefaultController<Uint8Array>,
  maxOutputBytes: number,
): SseSend {
  const encoder = new TextEncoder()
  let emittedBytes = 0
  return (event, data, id) => {
    const head = id === undefined ? "" : `id: ${id}\n`
    const frame = encoder.encode(`${head}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    if (frame.byteLength > maxOutputBytes || emittedBytes > maxOutputBytes - frame.byteLength)
      throw new SseOutputLimitError("mountAgent SSE output limit exceeded")
    emittedBytes += frame.byteLength
    controller.enqueue(frame)
  }
}

function endOverBudget(
  deliver: SseSend,
  controller: ReadableStreamDefaultController<Uint8Array>,
  turnId: string,
): void {
  try {
    deliver("error", { turnId, error: "output_limit" })
  } catch {
    // A fully spent budget cannot carry the error frame; closing still ends this response.
  }
  controller.close()
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

interface TerminalFrame {
  readonly event: string
  readonly data: unknown
}

/** Parse the stored terminal value - a durable log adapter may hand back anything. */
function asTerminalFrame(value: unknown): TerminalFrame | undefined {
  const record = asRecord(value)
  if (record === undefined || typeof record.event !== "string") return undefined
  return { event: record.event, data: record.data }
}

/** Telemetry-grade storage: a failing log must not fail the turn or mask its result. */
async function finishQuietly(
  log: AgentEvidenceLog | undefined,
  turnId: string,
  frame: TerminalFrame,
): Promise<void> {
  if (log === undefined) return
  try {
    await log.finish(turnId, frame)
  } catch {
    // Replay degrades to unavailable; the in-band response is unaffected.
  }
}

/** Project a run result onto the wire. State evidence is token-only by design, so it passes through. */
function projectResult<Output>(
  turnId: string,
  result: AgentRunResult<Output>,
): Record<string, unknown> {
  const base = { turnId, status: result.status, evidence: result.evidence }
  if (result.status === "completed") {
    return result.error !== undefined
      ? { ...base, ok: false, error: result.error }
      : { ...base, ok: true, output: result.output }
  }
  if (result.status === "suspended") {
    return { ...base, reason: result.reason, pending: result.pending }
  }
  return base
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

/** A thrown `Response` is the app answering for itself; anything else is a fault for its error lane. */
function passThrownResponse(err: unknown): Response {
  if (err instanceof Response) return err
  throw err
}

function render(response: Response | ResponseResult): Response {
  return response instanceof Response ? response : toResponse(response, EMPTY_RESPONSE_CONTROLS)
}

class BadTurnId extends Error {}

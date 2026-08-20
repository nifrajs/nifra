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
 *   - otherwise -> a single JSON body: the projected run result.
 * - `resume` is `{ continuation, approval? }` (see {@link AgentTurnInput}); the runtime keeps state
 *   token-only, so a suspended tool's input must be replayed by the caller in `continuation.input`.
 * - The seam performs no authentication or authorization. Wrap it with the app's own route guards, and
 *   scope the store/model returned by `ports` to the caller (RLS born in at the data layer).
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
import { createAgentEvidenceStream } from "./events.ts"
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
const PENDING_KINDS: readonly AgentPendingKind[] = ["approval", "budget", "model", "cancelled"]

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
   * Build the ports for one request - the model, durable state store, approval transport, capabilities,
   * and budgets. Receives the route context so the caller can scope every port to the request subject.
   */
  readonly ports: (c: AgentRouteContext) => AgentPorts | Promise<AgentPorts>
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
  c: AgentRouteContext,
  parsed: unknown,
  options: MountAgentOptions<InputSchema, OutputSchema>,
  runOptions: { readonly maxTurns?: number },
): Promise<Response> {
  const body = asRecord(parsed)
  if (body === undefined) return jsonResponse(400, { error: "body_must_be_object" })

  const turnIdRaw = typeof body.turnId === "string" ? body.turnId : undefined
  const turnId = turnIdRaw ?? crypto.randomUUID()

  const resume = parseResume(body.resume)
  const basePorts = await options.ports(c)

  const start = (
    telemetry?: AgentPorts["telemetry"],
  ): Promise<AgentRunResult<NonNullable<OutputSchema["~standard"]["types"]>["output"]>> => {
    // Compose rather than replace: an SSE evidence stream must not displace a telemetry port the
    // caller injected through `ports` (an exporter, a durable evidence log).
    const combined = combineAgentTelemetry(basePorts.telemetry, telemetry)
    const ports = combined === undefined ? basePorts : { ...basePorts, telemetry: combined }
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

  const wantsSse = (c.req.headers.get("accept") ?? "").includes("text/event-stream")
  if (!wantsSse) {
    try {
      const result = await start()
      return jsonResponse(200, projectResult(turnId, result))
    } catch (err) {
      if (err instanceof BadTurnId) return jsonResponse(400, { error: "invalid_turn_id" })
      return jsonResponse(409, { error: "resume_unavailable" })
    }
  }
  return sseResponse(turnId, start)
}

function sseResponse<Output>(
  turnId: string,
  start: (telemetry: AgentPorts["telemetry"]) => Promise<AgentRunResult<Output>>,
): Response {
  const stream = createAgentEvidenceStream()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder()
      const send = (event: string, data: unknown): void => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      }
      const run = start(stream)
      // The evidence stream must terminate whether the run resolves or throws, or the `for await`
      // below would hang; the run result (or the error) is still reported in-band after it drains.
      run
        .then(
          () => {},
          () => {},
        )
        .finally(() => stream.complete())
      try {
        for await (const evidence of stream) send("step", evidence)
        send("result", projectResult(turnId, await run))
      } catch {
        send("error", { turnId, error: "run_failed" })
      } finally {
        controller.close()
      }
    },
  })
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  })
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

function render(response: Response | ResponseResult): Response {
  return response instanceof Response ? response : toResponse(response, EMPTY_RESPONSE_CONTROLS)
}

class BadTurnId extends Error {}

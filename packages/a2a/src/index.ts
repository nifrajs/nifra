/**
 * `@nifrajs/a2a` - mount a nifra agent as an Agent2Agent (A2A) protocol server.
 *
 * The package is a protocol bridge over the `@nifrajs/agent` runner, mirroring the `mountAgent`
 * seam: HTTP in, the bounded runner in the middle, A2A JSON-RPC out. The request body is read
 * through core's single bounded, proto-guarded framing lane (`@nifrajs/core/edge-kit`); the model,
 * durable state store, and approval transport arrive through a per-request `ports` factory and never
 * live in this package.
 *
 * Wire contract (A2A protocol version 1.0, JSON-RPC binding):
 * - `GET {cardPath}` (default `/.well-known/agent-card.json`) -> the agent card.
 * - `POST {path}` (default `/a2a`) -> a JSON-RPC 2.0 request:
 *   - `SendMessage` runs one turn and returns `{ task }` with a terminal or interrupted status.
 *   - `SendStreamingMessage` responds `text/event-stream`; each SSE `data:` field is a complete
 *     JSON-RPC response whose result is `{ statusUpdate }` per step-evidence item, then
 *     `{ artifactUpdate }` for a produced output, then a final `{ statusUpdate }` with
 *     `final: true`.
 *   - `GetTask` projects the stored turn state for a task id (requires `ports.state`).
 *   - Every other spec method returns `UnsupportedOperationError` (-32004): the seam is stateless
 *     per request, so cross-request cancellation and subscription registries belong to the caller.
 * - A task is one agent turn: `taskId` == the runner's `turnId`. A suspended run surfaces as
 *   `TASK_STATE_INPUT_REQUIRED` whose status message carries the pending continuation in
 *   `metadata`. To resume, send the continuation back via `message.taskId` +
 *   `message.metadata.resume` (`{ continuation, approval? }`); the runtime keeps state token-only,
 *   so a suspended tool's input must be replayed in `continuation.input`.
 * - Agent input is `message.metadata.input` when present, otherwise the first `text` part.
 *   Structured output is returned as a `text` part carrying JSON.
 * - The seam performs no authentication or authorization. Wrap it with the app's own route guards,
 *   and scope the store/model returned by `ports` to the caller.
 */

import {
  type AgentDefinition,
  type AgentPendingKind,
  type AgentPorts,
  type AgentRunResult,
  type AgentTurnInput,
  type AgentTurnState,
  createAgentState,
  resumeAgent,
  runAgent,
} from "@nifrajs/agent"
import { createAgentEvidenceStream } from "@nifrajs/agent/events"
import {
  EMPTY_RESPONSE_CONTROLS,
  type ProtoPoisoning,
  type ResponseResult,
  readBodyFramed,
  toResponse,
} from "@nifrajs/core/edge-kit"
import type { StandardSchemaV1 } from "@nifrajs/core/schema"

export const A2A_PROTOCOL_VERSION = "1.0"
export const AGENT_CARD_WELL_KNOWN_PATH = "/.well-known/agent-card.json"

const DEFAULT_PATH = "/a2a"
const DEFAULT_MAX_BODY_BYTES = 1_000_000
const PENDING_KINDS: readonly AgentPendingKind[] = ["approval", "budget", "model", "cancelled"]
const TURN_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/

// JSON-RPC 2.0 standard codes plus the A2A-specific range.
export const A2A_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  taskNotFound: -32001,
  unsupportedOperation: -32004,
} as const

export type A2ATaskState =
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_INPUT_REQUIRED"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED"

export interface A2AAgentSkill {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly tags: readonly string[]
}

export interface A2AAgentCard {
  readonly protocolVersion: string
  readonly name: string
  readonly description: string
  readonly url: string
  readonly version: string
  readonly capabilities: { readonly streaming: boolean }
  readonly defaultInputModes: readonly string[]
  readonly defaultOutputModes: readonly string[]
  readonly skills: readonly A2AAgentSkill[]
}

/** Caller-supplied card identity; everything else derives from the agent definition. */
export interface A2ACardInfo {
  /** Public URL of the JSON-RPC endpoint, as advertised to A2A clients. */
  readonly url: string
  /** Version of the exposed agent (the deployment's, not the protocol's). */
  readonly version: string
  readonly name?: string
  readonly description?: string
}

/** The structural slice of a route context the seam needs. */
export interface A2ARouteContext {
  readonly req: Request
}

/** The structural slice of a nifra server `mountA2A` needs. */
export interface A2AMountableApp {
  get(path: string, handler: (c: A2ARouteContext) => Response | Promise<Response>): unknown
  post(path: string, handler: (c: A2ARouteContext) => Response | Promise<Response>): unknown
}

export interface MountA2AOptions<
  InputSchema extends StandardSchemaV1,
  OutputSchema extends StandardSchemaV1,
> {
  readonly agent: AgentDefinition<InputSchema, OutputSchema>
  readonly card: A2ACardInfo
  /** JSON-RPC endpoint path. Default `/a2a`. */
  readonly path?: string
  /** Agent card path. Default `/.well-known/agent-card.json`. */
  readonly cardPath?: string
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
  readonly ports: (c: A2ARouteContext) => AgentPorts | Promise<AgentPorts>
}

/** Derive a spec-shaped agent card from the agent definition plus the caller's identity fields. */
export function agentCard<
  InputSchema extends StandardSchemaV1,
  OutputSchema extends StandardSchemaV1,
>(agent: AgentDefinition<InputSchema, OutputSchema>, info: A2ACardInfo): A2AAgentCard {
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: info.name ?? agent.name,
    description: info.description ?? agent.instruction,
    url: info.url,
    version: info.version,
    capabilities: { streaming: true },
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json", "text/plain"],
    skills: agent.tools.map((tool) => ({
      id: tool.name,
      name: tool.name,
      description: tool.description,
      tags: [tool.capability],
    })),
  }
}

/** Mount an agent as an A2A server: the agent card on GET, the JSON-RPC binding on POST. */
export function mountA2A<
  InputSchema extends StandardSchemaV1,
  OutputSchema extends StandardSchemaV1,
>(app: A2AMountableApp, options: MountA2AOptions<InputSchema, OutputSchema>): void {
  const path = options.path ?? DEFAULT_PATH
  const cardPath = options.cardPath ?? AGENT_CARD_WELL_KNOWN_PATH
  const maxBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const proto = options.protoPoisoning ?? "reject"
  const runOptions = options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }
  const card = agentCard(options.agent, options.card)

  app.get(cardPath, () => jsonResponse(200, card))
  app.post(path, (c) =>
    readBodyFramed<Response>(
      c.req,
      maxBytes,
      proto,
      (parsed) => dispatch(c, parsed, options, runOptions),
      (rejection) => render(rejection),
      () => rpcErrorResponse(null, A2A_ERROR_CODES.parseError, "parse_error"),
    ).catch(() => rpcErrorResponse(null, A2A_ERROR_CODES.internalError, "internal_error")),
  )
}

type RpcId = string | number
type RunStart = (telemetry?: AgentPorts["telemetry"]) => Promise<AgentRunResult<unknown>>

async function dispatch<
  InputSchema extends StandardSchemaV1,
  OutputSchema extends StandardSchemaV1,
>(
  c: A2ARouteContext,
  parsed: unknown,
  options: MountA2AOptions<InputSchema, OutputSchema>,
  runOptions: { readonly maxTurns?: number },
): Promise<Response> {
  const request = asRecord(parsed)
  const id = request === undefined ? undefined : asRpcId(request.id)
  if (request === undefined || request.jsonrpc !== "2.0" || id === undefined)
    return rpcErrorResponse(null, A2A_ERROR_CODES.invalidRequest, "invalid_request")
  const method = request.method
  if (typeof method !== "string")
    return rpcErrorResponse(id, A2A_ERROR_CODES.invalidRequest, "invalid_request")
  const params = asRecord(request.params) ?? {}

  switch (method) {
    case "SendMessage":
    case "SendStreamingMessage": {
      const turn = prepareTurn(params)
      if ("error" in turn) return rpcErrorResponse(id, turn.error.code, turn.error.message)
      const basePorts = await options.ports(c)
      const start: RunStart = (telemetry) => {
        const ports = telemetry === undefined ? basePorts : { ...basePorts, telemetry }
        if (turn.resume !== undefined) {
          return resumeAgent(
            options.agent,
            turn.turnId,
            { value: turn.input, resume: turn.resume },
            ports,
            runOptions,
          )
        }
        return runAgent(options.agent, { value: turn.input }, ports, {
          ...runOptions,
          state: createAgentState(turn.turnId),
        })
      }
      if (method === "SendMessage") {
        try {
          return rpcResultResponse(id, { task: projectTask(turn.turnId, await start()) })
        } catch {
          return rpcErrorResponse(id, A2A_ERROR_CODES.taskNotFound, "task_not_resumable")
        }
      }
      return streamingResponse(id, turn.turnId, start)
    }
    case "GetTask": {
      const taskId = typeof params.id === "string" ? params.id : undefined
      if (taskId === undefined)
        return rpcErrorResponse(id, A2A_ERROR_CODES.invalidParams, "invalid_params")
      const basePorts = await options.ports(c)
      const state = await basePorts.state?.load(taskId)
      if (state === undefined)
        return rpcErrorResponse(id, A2A_ERROR_CODES.taskNotFound, "task_not_found")
      return rpcResultResponse(id, { task: projectStoredTask(state) })
    }
    case "ListTasks":
    case "CancelTask":
    case "SubscribeToTask":
    case "CreateTaskPushNotificationConfig":
    case "GetTaskPushNotificationConfig":
    case "ListTaskPushNotificationConfigs":
    case "DeleteTaskPushNotificationConfig":
    case "GetExtendedAgentCard":
      return rpcErrorResponse(id, A2A_ERROR_CODES.unsupportedOperation, "unsupported_operation")
    default:
      return rpcErrorResponse(id, A2A_ERROR_CODES.methodNotFound, "method_not_found")
  }
}

interface PreparedTurn {
  readonly turnId: string
  readonly input: unknown
  readonly resume: AgentTurnInput["resume"]
}

function prepareTurn(
  params: Record<string, unknown>,
): PreparedTurn | { readonly error: { readonly code: number; readonly message: string } } {
  const message = asRecord(params.message)
  if (message === undefined)
    return { error: { code: A2A_ERROR_CODES.invalidParams, message: "invalid_params" } }
  const metadata = asRecord(message.metadata) ?? {}
  const taskId = typeof message.taskId === "string" ? message.taskId : undefined
  const resume = parseResume(metadata.resume)
  if (taskId !== undefined && !TURN_ID_PATTERN.test(taskId))
    return { error: { code: A2A_ERROR_CODES.invalidParams, message: "invalid_task_id" } }
  // A message that names a task must carry the continuation: the runtime keeps state token-only,
  // so there is nothing to continue from without it.
  if (taskId !== undefined && resume === undefined)
    return { error: { code: A2A_ERROR_CODES.invalidParams, message: "resume_metadata_required" } }
  if (resume !== undefined && taskId === undefined)
    return { error: { code: A2A_ERROR_CODES.invalidParams, message: "task_id_required" } }
  return {
    turnId: taskId ?? crypto.randomUUID(),
    input: Object.hasOwn(metadata, "input") ? metadata.input : firstTextPart(message.parts),
    resume,
  }
}

function firstTextPart(parts: unknown): unknown {
  if (!Array.isArray(parts)) return undefined
  for (const part of parts) {
    const record = asRecord(part)
    if (record !== undefined && typeof record.text === "string") return record.text
  }
  return undefined
}

function streamingResponse(id: RpcId, turnId: string, start: RunStart): Response {
  const stream = createAgentEvidenceStream()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder()
      const send = (payload: unknown): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
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
        for await (const evidence of stream) {
          send(
            rpcResult(id, {
              statusUpdate: {
                taskId: turnId,
                contextId: turnId,
                status: { state: "TASK_STATE_WORKING" satisfies A2ATaskState },
                final: false,
                metadata: { evidence },
              },
            }),
          )
        }
        const result = await run
        if (result.status === "completed" && result.error === undefined) {
          send(
            rpcResult(id, {
              artifactUpdate: {
                taskId: turnId,
                contextId: turnId,
                artifact: outputArtifact(turnId, result.output),
                lastChunk: true,
              },
            }),
          )
        }
        const task = projectTask(turnId, result)
        send(
          rpcResult(id, {
            statusUpdate: {
              taskId: turnId,
              contextId: turnId,
              status: task.status,
              final: true,
              ...(task.metadata === undefined ? {} : { metadata: task.metadata }),
            },
          }),
        )
      } catch {
        send(rpcError(id, A2A_ERROR_CODES.internalError, "run_failed"))
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

interface ProjectedTask {
  readonly id: string
  readonly contextId: string
  readonly status: { readonly state: A2ATaskState; readonly message?: unknown }
  readonly artifacts?: readonly unknown[]
  readonly metadata?: Record<string, unknown>
}

/** Project a run result onto the A2A task shape. Evidence is token-only by design, so it passes through. */
function projectTask(turnId: string, result: AgentRunResult<unknown>): ProjectedTask {
  const base = { id: turnId, contextId: turnId }
  if (result.status === "completed") {
    if (result.error !== undefined) {
      return {
        ...base,
        status: { state: "TASK_STATE_FAILED" },
        metadata: { evidence: result.evidence, error: result.error },
      }
    }
    return {
      ...base,
      status: { state: "TASK_STATE_COMPLETED" },
      artifacts: [outputArtifact(turnId, result.output)],
      metadata: { evidence: result.evidence },
    }
  }
  if (result.status === "suspended") {
    const state: A2ATaskState =
      result.reason === "cancelled" ? "TASK_STATE_CANCELED" : "TASK_STATE_INPUT_REQUIRED"
    return {
      ...base,
      status: {
        state,
        message: {
          messageId: `${turnId}:pending`,
          taskId: turnId,
          role: "ROLE_AGENT",
          parts: [],
          metadata: { reason: result.reason, continuation: result.pending },
        },
      },
      metadata: { evidence: result.evidence },
    }
  }
  // `continue` never escapes the run loop; project it defensively as still-working.
  return {
    ...base,
    status: { state: "TASK_STATE_WORKING" },
    metadata: { evidence: result.evidence },
  }
}

/** Project stored turn state (GetTask). Stored state cannot distinguish a failed completion. */
function projectStoredTask(state: AgentTurnState): ProjectedTask {
  const taskState: A2ATaskState =
    state.status === "completed"
      ? "TASK_STATE_COMPLETED"
      : state.status === "suspended"
        ? "TASK_STATE_INPUT_REQUIRED"
        : "TASK_STATE_WORKING"
  return {
    id: state.turnId,
    contextId: state.turnId,
    status: { state: taskState },
    metadata: {
      evidence: state.evidence,
      ...(state.pending === undefined ? {} : { continuation: state.pending }),
    },
  }
}

function outputArtifact(turnId: string, output: unknown): Record<string, unknown> {
  return {
    artifactId: `${turnId}:output`,
    name: "output",
    parts: [typeof output === "string" ? { text: output } : { text: JSON.stringify(output) }],
  }
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

function rpcResult(id: RpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result }
}

function rpcError(id: RpcId | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } }
}

function rpcResultResponse(id: RpcId, result: unknown): Response {
  return jsonResponse(200, rpcResult(id, result))
}

function rpcErrorResponse(id: RpcId | null, code: number, message: string): Response {
  return jsonResponse(200, rpcError(id, code, message))
}

function asRpcId(value: unknown): RpcId | undefined {
  if (typeof value === "string") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  return undefined
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

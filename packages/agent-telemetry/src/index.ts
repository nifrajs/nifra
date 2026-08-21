/**
 * `@nifrajs/agent-telemetry` - child-span instrumentation for AI agent tool calls.
 *
 * Extends `@nifrajs/otel`'s span model: when an AI agent invokes a tool via
 * `/_nifra/tool/*` or the MCP endpoint, this middleware creates a child span
 * tracking tool name, input size, output size, and execution time.
 *
 * **Zero production overhead when not registered** - Nifra's `bare` flag keeps
 * routes on the sync fast path unless hooks are present at registration time.
 */

import {
  type ActiveObservation,
  createObservationLifecycle,
  type ObservationAdapter,
} from "@nifrajs/otel"

export {
  type AgentRunEvidence,
  type AgentRunOutcome,
  type AgentRunTrace,
  type TraceAgentRunOptions,
  traceAgentRun,
} from "./run.ts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentTelemetryOptions {
  /** Exporter that receives completed tool-call spans. */
  readonly exporter: ObservationAdapter
  /** Path prefix for nifra tool routes (default `"/_nifra/tool/"`). */
  readonly toolPathPrefix?: string | undefined
  /** Path for the MCP endpoint (default `"/mcp"`). */
  readonly mcpPath?: string | undefined
}

/** Minimal context shape the middleware receives from hooks. */
interface HookContext {
  readonly request: Request
  readonly trace?: {
    readonly traceId: string
    readonly spanId: string
    readonly sampled: boolean
  }
  /** Present when `@nifrajs/otel` owns the enclosing request observation. */
  readonly observation?: ActiveObservation
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Agent telemetry middleware. Register via `app.use(agentTelemetry({ exporter }))`.
 *
 * Creates child spans for requests targeting tool endpoints (`/_nifra/tool/*`)
 * or the MCP endpoint (`/mcp`). Non-matching requests pass through with zero overhead
 * (a single `startsWith` check - O(1), no regex).
 */
export function agentTelemetry(options: AgentTelemetryOptions) {
  const toolPrefix = options.toolPathPrefix ?? "/_nifra/tool/"
  const mcpPath = options.mcpPath ?? "/mcp"
  const exporter = options.exporter
  const standaloneLifecycle = createObservationLifecycle({ adapters: [exporter] })
  const inflight = new WeakMap<Request, ActiveObservation>()

  return {
    name: "agent-telemetry",

    beforeHandle(context: HookContext) {
      const url = new URL(context.request.url)
      const pathname = url.pathname
      const isToolCall = pathname.startsWith(toolPrefix)
      const isMcpCall = pathname === mcpPath

      if (!isToolCall && !isMcpCall) return undefined

      // Extract tool name
      const toolName = isToolCall ? pathname.slice(toolPrefix.length) || "unknown" : "mcp"

      // Measure input size from Content-Length header
      const inputBytes = Number(context.request.headers.get("content-length") ?? "0") || 0

      const input = {
        name: `tool:${toolName}`,
        attributes: {
          "tool.name": toolName,
          "tool.input_bytes": inputBytes,
        },
      }
      const observation =
        context.observation?.startChild(input, [exporter]) ??
        standaloneLifecycle.start({
          ...input,
          ...(context.trace === undefined ? {} : { parent: context.trace }),
          traceparent: context.request.headers.get("traceparent"),
        })
      inflight.set(context.request, observation)

      return undefined // don't short-circuit
    },

    onError(error: unknown, context: HookContext) {
      inflight.get(context.request)?.recordError(error)

      return undefined // don't swallow the error
    },

    onResponse(response: Response, request: Request) {
      const observation = inflight.get(request)
      if (!observation) return response
      inflight.delete(request)
      const end = (outputBytes: number): void => {
        observation.end({
          statusCode: response.status,
          attributes: {
            "http.response.status_code": response.status,
            "tool.output_bytes": outputBytes,
          },
        })
      }

      const declared = response.headers.get("content-length")
      if (declared !== null) {
        end(Number(declared) || 0)
        return response
      }
      if (response.body === null) {
        end(0)
        return response
      }

      // Streamed response without content-length: count bytes as the body is consumed and
      // end the span when the stream settles. `end()` is exactly-once, so close/cancel/error
      // racing is safe; an abandoned stream still ends the span on cancel.
      let outputBytes = 0
      const reader = response.body.getReader()
      const counted = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read()
            if (done) {
              end(outputBytes)
              controller.close()
              return
            }
            outputBytes += value.byteLength
            controller.enqueue(value)
          } catch (error) {
            end(outputBytes)
            controller.error(error)
          }
        },
        cancel(reason) {
          end(outputBytes)
          return reader.cancel(reason)
        },
      })
      return new Response(counted, response)
    },
  }
}

// ---------------------------------------------------------------------------
// Console exporter
// ---------------------------------------------------------------------------

/**
 * Pretty-prints agent tool call traces to the terminal.
 *
 * Output format:
 * ```
 * [agent] tool:get_weather 12ms ok (input: 45B, output: 128B)
 * ```
 */
export function consoleAgentExporter(
  log: (line: string) => void = (line) => {
    console.log(line)
  },
): ObservationAdapter {
  return {
    onEnd(span) {
      const input = span.attributes["tool.input_bytes"] ?? 0
      const output = span.attributes["tool.output_bytes"] ?? 0
      const duration = span.durationMs ?? 0
      log(
        `[agent] ${span.name} ${duration}ms ${span.status} (input: ${input}B, output: ${output}B)`,
      )
    },
  }
}

// ---------------------------------------------------------------------------
// Orchestration correlation
// ---------------------------------------------------------------------------

/** Content-free lifecycle kinds emitted by run dispatch and recovery. */
export type OrchestrationTelemetryKind =
  | "started"
  | "checkpointed"
  | "retrying"
  | "recovered"
  | "cancelled"
  | "completed"
  | "failed"
  | "dead-lettered"

/** Allowlisted correlation fields. No index signature is intentional: arbitrary attributes are rejected. */
export interface OrchestrationTelemetryEvent {
  readonly kind: OrchestrationTelemetryKind
  readonly runId: string
  readonly planDigest: string
  readonly nodeId: string
  readonly attempt: number
  readonly evidenceSeq: number
  readonly at: number
  readonly evidenceId?: string
  readonly replayId?: string
  readonly traceRef?: string
  readonly scheduleToken?: string
  readonly statusCode?: string
}

export interface OrchestrationTelemetryOptions {
  /** No exporter means disabled telemetry and zero spans. */
  readonly exporter?: ObservationAdapter
  readonly adapters?: readonly ObservationAdapter[]
  readonly maxDistinctValues?: number
}

export interface OrchestrationTelemetry {
  readonly enabled: boolean
  readonly dropped: number
  record(event: OrchestrationTelemetryEvent | unknown): boolean
  close(): void
}

const ORCHESTRATION_TOKEN = /^[A-Za-z0-9._:-]{1,128}$/
const ORCHESTRATION_DIGEST = /^[0-9a-f]{64}$/
const ORCHESTRATION_KINDS: ReadonlySet<string> = new Set([
  "started",
  "checkpointed",
  "retrying",
  "recovered",
  "cancelled",
  "completed",
  "failed",
  "dead-lettered",
])
const ORCHESTRATION_FIELDS = new Set([
  "kind",
  "runId",
  "planDigest",
  "nodeId",
  "attempt",
  "evidenceSeq",
  "at",
  "evidenceId",
  "replayId",
  "traceRef",
  "scheduleToken",
  "statusCode",
])
const ORCHESTRATION_FORBIDDEN = new Set([
  "prompt",
  "message",
  "text",
  "input",
  "output",
  "arguments",
  "body",
  "response",
  "secret",
  "credential",
  "diagnostic",
  "stack",
  "content",
  "transcript",
  "artifact",
  "path",
])

function orchestrationRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function boundedTelemetryToken(value: unknown): value is string {
  return typeof value === "string" && ORCHESTRATION_TOKEN.test(value)
}

function parseOrchestrationEvent(value: unknown): OrchestrationTelemetryEvent | undefined {
  if (!orchestrationRecord(value)) return undefined
  for (const key of Object.keys(value)) {
    if (ORCHESTRATION_FORBIDDEN.has(key.toLowerCase()) || !ORCHESTRATION_FIELDS.has(key))
      return undefined
  }
  if (
    typeof value.kind !== "string" ||
    !ORCHESTRATION_KINDS.has(value.kind) ||
    !boundedTelemetryToken(value.runId) ||
    !boundedTelemetryToken(value.nodeId) ||
    typeof value.planDigest !== "string" ||
    !ORCHESTRATION_DIGEST.test(value.planDigest) ||
    typeof value.at !== "number" ||
    !Number.isSafeInteger(value.at) ||
    value.at < 0 ||
    typeof value.attempt !== "number" ||
    !Number.isSafeInteger(value.attempt) ||
    value.attempt < 1 ||
    typeof value.evidenceSeq !== "number" ||
    !Number.isSafeInteger(value.evidenceSeq) ||
    value.evidenceSeq < 0
  )
    return undefined
  for (const key of [
    "evidenceId",
    "replayId",
    "traceRef",
    "scheduleToken",
    "statusCode",
  ] as const) {
    const candidate = value[key]
    if (candidate !== undefined && !boundedTelemetryToken(candidate)) return undefined
  }
  return Object.freeze({
    kind: value.kind as OrchestrationTelemetryKind,
    runId: value.runId,
    planDigest: value.planDigest,
    nodeId: value.nodeId,
    attempt: value.attempt,
    evidenceSeq: value.evidenceSeq,
    at: value.at,
    ...(value.evidenceId === undefined ? {} : { evidenceId: value.evidenceId as string }),
    ...(value.replayId === undefined ? {} : { replayId: value.replayId as string }),
    ...(value.traceRef === undefined ? {} : { traceRef: value.traceRef as string }),
    ...(value.scheduleToken === undefined ? {} : { scheduleToken: value.scheduleToken as string }),
    ...(value.statusCode === undefined ? {} : { statusCode: value.statusCode as string }),
  })
}

function orchestrationAttributes(
  event: OrchestrationTelemetryEvent,
): Record<string, string | number> {
  return {
    "nifra.orchestration.run_id": event.runId,
    "nifra.orchestration.plan_digest": event.planDigest,
    "nifra.orchestration.node_id": event.nodeId,
    "nifra.orchestration.attempt": event.attempt,
    "nifra.orchestration.evidence_seq": event.evidenceSeq,
    "nifra.orchestration.at": event.at,
    ...(event.evidenceId === undefined
      ? {}
      : { "nifra.orchestration.evidence_id": event.evidenceId }),
    ...(event.replayId === undefined ? {} : { "nifra.orchestration.replay_id": event.replayId }),
    ...(event.traceRef === undefined ? {} : { "nifra.orchestration.trace_ref": event.traceRef }),
    ...(event.scheduleToken === undefined
      ? {}
      : { "nifra.orchestration.schedule": event.scheduleToken }),
    ...(event.statusCode === undefined
      ? {}
      : { "nifra.orchestration.status_code": event.statusCode }),
  }
}

/** Create an opt-in, bounded telemetry bridge for run/retry/recovery correlation. */
export function orchestrationTelemetry(
  options: OrchestrationTelemetryOptions = {},
): OrchestrationTelemetry {
  const adapters = [
    ...(options.exporter === undefined ? [] : [options.exporter]),
    ...(options.adapters ?? []),
  ]
  const enabled = adapters.length > 0
  const maxDistinct = options.maxDistinctValues ?? 512
  if (!Number.isSafeInteger(maxDistinct) || maxDistinct < 1 || maxDistinct > 10_000)
    throw new RangeError("orchestration telemetry maxDistinctValues is invalid")
  if (!enabled)
    return {
      enabled: false,
      get dropped() {
        return 0
      },
      record: () => false,
      close: () => undefined,
    }

  const lifecycle = createObservationLifecycle({ adapters })
  const run = lifecycle.start({ name: "nifra.orchestration.run", attributes: {} })
  const distinct = new Map<string, Set<string>>()
  let droppedCount = 0
  let closed = false
  const record = (raw: OrchestrationTelemetryEvent | unknown): boolean => {
    if (closed) return false
    const event = parseOrchestrationEvent(raw)
    if (event === undefined) {
      droppedCount = Math.min(1_000_000, droppedCount + 1)
      return false
    }
    const attrs = orchestrationAttributes(event)
    for (const [key, value] of Object.entries(attrs)) {
      if (typeof value !== "string") continue
      const values = distinct.get(key) ?? new Set<string>()
      if (!values.has(value) && values.size >= maxDistinct) {
        droppedCount = Math.min(1_000_000, droppedCount + 1)
        return false
      }
      values.add(value)
      distinct.set(key, values)
    }
    const status = event.kind === "failed" || event.kind === "dead-lettered" ? "error" : "ok"
    run.startChild({ name: `nifra.orchestration.${event.kind}`, attributes: attrs }).end({ status })
    return true
  }
  return {
    enabled: true,
    get dropped() {
      return droppedCount
    },
    record,
    close() {
      if (closed) return
      closed = true
      run.end({ status: "ok" })
    },
  }
}

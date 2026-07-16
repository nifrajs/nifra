/**
 * `@nifrajs/agent-telemetry` — child-span instrumentation for AI agent tool calls.
 *
 * Extends `@nifrajs/otel`'s span model: when an AI agent invokes a tool via
 * `/_nifra/tool/*` or the MCP endpoint, this middleware creates a child span
 * tracking tool name, input size, output size, and execution time.
 *
 * **Zero production overhead when not registered** — Nifra's `bare` flag keeps
 * routes on the sync fast path unless hooks are present at registration time.
 */

import {
  type ActiveObservation,
  createObservationLifecycle,
  type ObservationAdapter,
} from "@nifrajs/otel"

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
 * (a single `startsWith` check — O(1), no regex).
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

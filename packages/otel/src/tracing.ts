/**
 * The `tracing()` plugin — establishes a span per request, propagates W3C trace context, and exposes
 * `c.trace` for forwarding the trace to downstream services. OpenTelemetry-compatible by wire format
 * (traceparent) and attribute names (HTTP semantic conventions); the span itself is exported through
 * your {@link SpanExporter} (bridge to the OTel SDK, or log via `consoleSpanExporter`).
 */

import { definePlugin } from "@nifrajs/core"
import {
  type AttributeValue,
  consoleSpanExporter,
  type NifraSpan,
  type SpanExporter,
} from "./span.ts"
import {
  formatTraceparent,
  generateSpanId,
  generateTraceId,
  parseTraceparent,
} from "./traceparent.ts"

/** The trace context exposed on the handler `c.trace` (typed, threaded via `derive`). */
export interface TraceContext {
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId?: string
  readonly sampled: boolean
  /** This request's outbound `traceparent` — forward it on downstream calls to continue the trace. */
  readonly traceparent: string
}

export interface TracingOptions {
  /** Where spans are sent. Default: {@link consoleSpanExporter}. */
  readonly exporter?: SpanExporter
  /** Sets the `service.name` attribute on every span. */
  readonly serviceName?: string
  /**
   * Set the outbound `traceparent` on the RESPONSE too (handy for browser/client correlation).
   * Default false — most setups only propagate downstream, not back to the caller.
   */
  readonly responseHeader?: boolean
}

/** Spread into an outgoing `fetch`/`ctx.api` call's headers to continue the trace downstream:
 * `fetch(url, { headers: traceHeaders(c.trace) })`. */
export function traceHeaders(trace: TraceContext): { traceparent: string } {
  return { traceparent: trace.traceparent }
}

const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

/**
 * Distributed-tracing plugin. Each request continues the inbound trace (or starts one), opens a
 * server span, and ends it on response with the status + HTTP attributes. Idempotent.
 *
 * ```ts
 * app.use(tracing({ exporter: myOtelExporter, serviceName: "orders-api" }))
 * // in a handler: fetch(url, { headers: traceHeaders(c.trace) })  // continue the trace downstream
 * ```
 */
export function tracing(options: TracingOptions = {}) {
  const exporter = options.exporter ?? consoleSpanExporter()
  const serviceName = options.serviceName
  // Span per in-flight request, keyed by the Request — ended in onResponse (mirrors @nifrajs/middleware
  // timing). A WeakMap so an abandoned request can't leak a span.
  const inFlight = new WeakMap<Request, NifraSpan>()

  return definePlugin("tracing", (app) =>
    app
      .derive((c) => {
        const parent = parseTraceparent(c.req.headers.get("traceparent"))
        const traceId = parent?.traceId ?? generateTraceId()
        const spanId = generateSpanId()
        const sampled = parent?.sampled ?? true
        const path = pathOf(c.req.url)
        const attributes: Record<string, AttributeValue> = {
          "http.request.method": c.req.method,
          "url.path": path,
        }
        if (serviceName !== undefined) attributes["service.name"] = serviceName
        const span: NifraSpan = {
          traceId,
          spanId,
          ...(parent !== null ? { parentSpanId: parent.spanId } : {}),
          sampled,
          name: `${c.req.method} ${path}`,
          startTime: Date.now(),
          status: "unset",
          attributes,
        }
        inFlight.set(c.req, span)
        exporter.onStart?.(span)
        const traceparent = formatTraceparent(traceId, spanId, sampled)
        if (options.responseHeader) c.set.headers.traceparent = traceparent
        const trace: TraceContext = {
          traceId,
          spanId,
          ...(parent !== null ? { parentSpanId: parent.spanId } : {}),
          sampled,
          traceparent,
        }
        return { trace }
      })
      .use({
        name: "tracing-end",
        onResponse: (res, req) => {
          const span = inFlight.get(req)
          if (span === undefined) return res
          inFlight.delete(req)
          span.endTime = Date.now()
          span.durationMs = span.endTime - span.startTime
          span.attributes["http.response.status_code"] = res.status
          // 5xx is a server error; everything else (incl. handled 4xx) is a normal outcome.
          span.status = res.status >= 500 ? "error" : "ok"
          exporter.onEnd(span)
          return res
        },
      }),
  )
}

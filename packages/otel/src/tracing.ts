/**
 * The `tracing()` plugin — establishes a span per request, propagates W3C trace context, and exposes
 * `c.trace` for forwarding the trace to downstream services. OpenTelemetry-compatible by wire format
 * (traceparent) and attribute names (HTTP semantic conventions); the span itself is exported through
 * your {@link SpanExporter} (bridge to the OTel SDK, or log via `consoleSpanExporter`).
 */

import { definePlugin } from "@nifrajs/core"
import {
  type ActiveObservation,
  createObservationLifecycle,
  type ObservationContext,
} from "./lifecycle.ts"
import { consoleSpanExporter, type ObservationAdapter, type SpanExporter } from "./span.ts"

/** The trace context exposed on the handler `c.trace` (typed, threaded via `derive`). */
export type TraceContext = ObservationContext

export interface TracingOptions {
  /** Where spans are sent. Default: {@link consoleSpanExporter}. */
  readonly exporter?: SpanExporter
  /** Additional observation adapters (DevTools, a private redacting backend, metrics, …). */
  readonly adapters?: readonly ObservationAdapter[]
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
  const adapters: ObservationAdapter[] = [
    ...(options.exporter === undefined && options.adapters === undefined
      ? [consoleSpanExporter()]
      : options.exporter === undefined
        ? []
        : [options.exporter]),
    ...(options.adapters ?? []),
  ]
  const lifecycle = createObservationLifecycle({ adapters })
  const serviceName = options.serviceName
  // A WeakMap so an abandoned request cannot leak its active observation.
  const inFlight = new WeakMap<Request, ActiveObservation>()

  return definePlugin("tracing", (app) =>
    app
      .derive((c) => {
        const path = pathOf(c.req.url)
        const observation = lifecycle.start({
          name: `${c.req.method} ${path}`,
          traceparent: c.req.headers.get("traceparent"),
          attributes: {
            "http.request.method": c.req.method,
            "url.path": path,
            ...(serviceName === undefined ? {} : { "service.name": serviceName }),
          },
        })
        inFlight.set(c.req, observation)
        if (options.responseHeader) c.set.headers.traceparent = observation.context.traceparent
        return { trace: observation.context, observation }
      })
      .use({
        name: "tracing-end",
        onError: (error, context) => {
          inFlight.get(context.request)?.recordError(error)
          return undefined
        },
        onResponseFinalized: (outcome, req) => {
          const observation = inFlight.get(req)
          if (observation === undefined) return
          inFlight.delete(req)
          if (outcome.error !== undefined) observation.recordError(outcome.error)
          const res = outcome.response
          const bodySize = Number(res.headers.get("content-length") ?? "0") || 0
          const isrStatus = res.headers.get("x-nifra-isr")
          observation.end({
            statusCode: res.status,
            ...(outcome.error === undefined ? {} : { status: "error" as const }),
            attributes: {
              "http.response.status_code": res.status,
              "http.response.body.size": bodySize,
              ...(isrStatus === null ? {} : { "nifra.isr.status": isrStatus }),
            },
          })
        },
      }),
  )
}

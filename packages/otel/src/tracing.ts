/**
 * The `tracing()` plugin — establishes a span per request, propagates W3C trace context, and exposes
 * `c.trace` for forwarding the trace to downstream services. OpenTelemetry-compatible by wire format
 * (traceparent) and attribute names (HTTP semantic conventions); the span itself is exported through
 * your {@link ObservationAdapter} (bridge to the OTel SDK, or log via `consoleSpanExporter`).
 */

import {
  type CausalityContext,
  type CausalityRecorder,
  causalityHeaders,
  continueCausality,
  readCausalityHeaders,
  startCausality,
} from "@nifrajs/core/causality"
import { definePlugin } from "@nifrajs/core/server"
import {
  type ActiveObservation,
  createObservationLifecycle,
  type ObservationContext,
} from "./lifecycle.ts"
import { consoleSpanExporter, type ObservationAdapter } from "./span.ts"

/** The trace context exposed on the handler `c.trace` (typed, threaded via `derive`). */
export type TraceContext = ObservationContext

export interface TracingOptions {
  /** Where spans are sent. Default: {@link consoleSpanExporter}. */
  readonly exporter?: ObservationAdapter
  /** Additional observation adapters (DevTools, a private redacting backend, metrics, …). */
  readonly adapters?: readonly ObservationAdapter[]
  /** Sets the `service.name` attribute on every span. */
  readonly serviceName?: string
  /**
   * Set the outbound `traceparent` on the RESPONSE too (handy for browser/client correlation).
   * Default false — most setups only propagate downstream, not back to the caller.
   */
  readonly responseHeader?: boolean
  /**
   * Optional durable graph recorder. When configured, the request root is appended before the
   * handler runs and recorder failure fails closed. Without one, `c.causality` is still propagated.
   */
  readonly causality?: {
    readonly recorder?: CausalityRecorder
    /** Injectable epoch clock for deterministic tests. */
    readonly now?: () => number
    /**
     * Explicit trust gate for service-to-service causality headers. Internet clients are untrusted
     * by default; a false result or thrown/rejected check starts a fresh execution graph.
     */
    readonly acceptInbound?: (
      request: Request,
      context: CausalityContext,
    ) => boolean | Promise<boolean>
  }
}

/** Spread into an outgoing `fetch`/`ctx.api` call's headers to continue the trace downstream:
 * `fetch(url, { headers: traceHeaders(c.trace) })`. */
export function traceHeaders(
  trace: TraceContext,
  causality?: CausalityContext,
): { readonly traceparent: string } & Readonly<Record<string, string>> {
  return {
    traceparent: trace.traceparent,
    ...(causality === undefined ? {} : causalityHeaders(causality)),
  }
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
        const causalAt = options.causality?.now?.()
        const derive = (parent?: CausalityContext) => {
          const causal =
            parent === undefined
              ? startCausality("request", `req_${observation.context.spanId}`, {
                  // `traceparent` is untrusted. The server-generated span id keeps graph identity fresh.
                  executionId: `exec_${observation.context.traceId}_${observation.context.spanId}`,
                  ...(causalAt === undefined ? {} : { at: causalAt }),
                  trace: {
                    traceId: observation.context.traceId,
                    spanId: observation.context.spanId,
                  },
                })
              : continueCausality(parent, "request", `req_${observation.context.spanId}`, {
                  relation: "called",
                  ...(causalAt === undefined ? {} : { at: causalAt }),
                  trace: {
                    traceId: observation.context.traceId,
                    spanId: observation.context.spanId,
                  },
                })
          const derived = { trace: observation.context, observation, causality: causal.context }
          if (options.responseHeader) c.set.headers.traceparent = observation.context.traceparent
          const recorder = options.causality?.recorder
          return recorder === undefined
            ? derived
            : recorder.record(causal.record).then(() => derived)
        }

        const inbound = readCausalityHeaders(c.req.headers)
        const acceptInbound = options.causality?.acceptInbound
        if (!inbound.success || acceptInbound === undefined) return derive()
        let accepted: boolean | Promise<boolean>
        try {
          accepted = acceptInbound(c.req, inbound.context)
        } catch {
          return derive()
        }
        // Keep recorder execution outside the trust-gate catch. A synchronous recorder failure is a
        // durability failure, not a rejected inbound parent, and must fail closed without retrying.
        return typeof accepted === "boolean"
          ? derive(accepted ? inbound.context : undefined)
          : Promise.resolve(accepted).then(
              (allowed) => derive(allowed === true ? inbound.context : undefined),
              () => derive(),
            )
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

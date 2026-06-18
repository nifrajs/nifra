/**
 * The span model + exporter seam. Attribute names follow OpenTelemetry HTTP semantic conventions
 * (`http.request.method`, `url.path`, `http.response.status_code`, …) so a span maps cleanly onto an
 * OTel `Span` when bridged — but nothing here depends on the OTel SDK. You supply a {@link SpanExporter}
 * (a ~10-line adapter to `@opentelemetry/api`, or the bundled {@link consoleSpanExporter}).
 */

export type SpanStatus = "unset" | "ok" | "error"
export type AttributeValue = string | number | boolean

/** A completed (or in-flight) server span for one request. */
export interface NifraSpan {
  /** 32-hex W3C trace id — shared across every span/service in the trace. */
  readonly traceId: string
  /** 16-hex id of this span. */
  readonly spanId: string
  /** The inbound span's id, if this request continued an upstream trace. */
  readonly parentSpanId?: string
  /** Whether the trace is sampled (the W3C flag). */
  readonly sampled: boolean
  /** Span name — `"<METHOD> <path>"`. */
  readonly name: string
  /** Wall-clock start (epoch ms). */
  readonly startTime: number
  /** Wall-clock end (epoch ms) — set on completion. */
  endTime?: number
  /** Duration in ms (monotonic). */
  durationMs?: number
  status: SpanStatus
  /** OTel-semantic-convention attributes. */
  readonly attributes: Record<string, AttributeValue>
}

/**
 * Where ended spans go. Implement this to bridge to the OpenTelemetry SDK (map each field onto a
 * real `Span` from a `Tracer`), ship to a collector, or just log. `onStart` is optional (most
 * backends only need the completed span).
 */
export interface SpanExporter {
  onStart?(span: NifraSpan): void
  onEnd(span: NifraSpan): void
}

/** A no-frills exporter that logs each completed span as one structured line. Useful in dev or as a
 * starting point before wiring a real backend. */
export function consoleSpanExporter(
  log: (line: string) => void = (l) => {
    console.log(l)
  },
): SpanExporter {
  return {
    onEnd(span) {
      log(
        JSON.stringify({
          name: span.name,
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId,
          durationMs: span.durationMs,
          status: span.status,
          ...span.attributes,
        }),
      )
    },
  }
}

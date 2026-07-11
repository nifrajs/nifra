/**
 * @nifrajs/otel — distributed tracing for nifra. The `tracing()` plugin continues (or starts) a W3C
 * trace per request, opens an OpenTelemetry-semantic-convention span, and exposes `c.trace` so you
 * can forward the trace to downstream services with `traceHeaders(c.trace)`. Spans go to a pluggable
 * `SpanExporter` — bridge to the OpenTelemetry SDK, or log with `consoleSpanExporter`. No SDK
 * bundled; edge-safe.
 *
 *   import { tracing, traceHeaders, consoleSpanExporter } from "@nifrajs/otel"
 *   app.use(tracing({ exporter: consoleSpanExporter(), serviceName: "orders-api" }))
 */

export {
  type ActiveObservation,
  createObservationLifecycle,
  type EndObservation,
  type ObservationClock,
  type ObservationContext,
  type ObservationLifecycle,
  type ObservationLifecycleOptions,
  type ObservationParent,
  type StartObservation,
} from "./lifecycle.ts"
export {
  type AttributeValue,
  combineObservationAdapters,
  consoleSpanExporter,
  type NifraSpan,
  type ObservationAdapter,
  type SpanExporter,
  type SpanStatus,
} from "./span.ts"
export {
  formatTraceparent,
  generateSpanId,
  generateTraceId,
  type ParsedTraceparent,
  parseTraceparent,
} from "./traceparent.ts"
export { type TraceContext, type TracingOptions, traceHeaders, tracing } from "./tracing.ts"

import { type ParsedTraceparent, parseTraceparent } from "./traceparent.ts"

/**
 * The trace a bound context carries (`c.trace` from `tracing()`, `JobContext.trace` from `jobTracing()`),
 * read structurally and validated through its W3C `traceparent`, so a context of any other shape is
 * simply untraced.
 */
export function traceOfContext(context: unknown): ParsedTraceparent | null {
  if (typeof context !== "object" || context === null || !("trace" in context)) return null
  const trace = context.trace
  if (typeof trace !== "object" || trace === null || !("traceparent" in trace)) return null
  const traceparent = trace.traceparent
  return typeof traceparent === "string" ? parseTraceparent(traceparent) : null
}

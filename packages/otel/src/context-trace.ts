import { type ParsedTraceparent, parseTraceparent } from "./traceparent.ts"

/**
 * The trace a bound context carries (`c.trace` from `tracing()`, `JobContext.trace` from `jobTracing()`),
 * read structurally and validated through its W3C `traceparent`, so a context of any other shape is
 * simply untraced.
 */
export function traceOfContext(context: unknown): ParsedTraceparent | null {
  if (typeof context !== "object" || context === null) return null
  const trace = (context as { readonly trace?: unknown }).trace
  if (typeof trace !== "object" || trace === null) return null
  const traceparent = (trace as { readonly traceparent?: unknown }).traceparent
  return typeof traceparent === "string" ? parseTraceparent(traceparent) : null
}

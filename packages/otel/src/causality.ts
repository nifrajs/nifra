/** OpenTelemetry adapter for the framework-neutral durable causality context. */

import { type CausalityContext, parseCausalityContext } from "@nifrajs/core/causality"
import type { ObservationLink } from "./span.ts"

/**
 * Convert the nearest observed causal ancestor into an OTel span link. Returns `undefined` instead
 * of inventing a trace identity when the durable context has no observation anchor.
 */
export function causalitySpanLink(context: CausalityContext): ObservationLink | undefined {
  const parsed = parseCausalityContext(context)
  if (!parsed.success || parsed.context.trace === undefined) return undefined
  return Object.freeze({
    traceId: parsed.context.trace.traceId,
    spanId: parsed.context.trace.spanId,
    attributes: Object.freeze({
      "nifra.execution.id": parsed.context.executionId,
      "nifra.causality.kind": parsed.context.current.kind,
      "nifra.causality.id": parsed.context.current.id,
    }),
  })
}

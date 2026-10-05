/**
 * Consumer spans for `@nifrajs/events` envelopes. nifra does not deliver events, so it cannot trace them
 * on its own: wrap the consumer once and every envelope it receives gets a `process <type>` span, linked
 * to the producer through the envelope's durable causality.
 *
 *   import { traceEventConsumer } from "@nifrajs/otel/events"
 *   const consume = traceEventConsumer(orderPaid, async (event, ctx) => fulfil(event.payload), { exporter })
 *   await consume(message.body)            // from a queue, an SSE frame, a webhook body
 */

import type { CausalityContext } from "@nifrajs/core/causality"
import { causalitySpanLink } from "./causality.ts"
import {
  createObservationLifecycle,
  type ObservationContext,
  type ObservationScope,
  type StartObservation,
} from "./lifecycle.ts"
import type { AttributeValue, ObservationAdapter } from "./span.ts"
import { parseTraceparent } from "./traceparent.ts"

/** The envelope fields a consumer span reads. `EventEnvelope` from `@nifrajs/events` has them. */
export interface TracedEventEnvelope {
  readonly id: string
  readonly type: string
  readonly version: number
  readonly causality?: CausalityContext
}

/**
 * An event contract or a registry from `@nifrajs/events`, declared structurally: anything whose
 * `parse(input)` never throws and reports success with an envelope, or failure with `issues` (a contract)
 * or a `reason` (a registry).
 */
export interface TracedEventSource<Envelope extends TracedEventEnvelope> {
  /** A contract's own type, used to name the span of an envelope that failed to parse. */
  readonly type?: string
  parse(input: unknown):
    | { readonly success: true; readonly envelope: Envelope }
    | {
        readonly success: false
        readonly issues?: readonly unknown[]
        readonly reason?: string
      }
}

/** What the wrapped handler receives next to the envelope: the consumer span's trace context. */
export interface EventConsumerContext {
  readonly trace: ObservationContext
}

export type TracedEventResult<Value> =
  | { readonly success: true; readonly value: Value }
  | { readonly success: false; readonly issueCount: number }

/** The traced consumer. `parent` is an ambient trace (`c.trace` in a webhook route), if there is one. */
export type TracedEventConsumer<Value> = (
  input: unknown,
  parent?: ObservationContext,
) => Promise<TracedEventResult<Value>>

export interface EventTracingOptions {
  readonly exporter?: ObservationAdapter
  readonly adapters?: readonly ObservationAdapter[]
  /** `messaging.system`: the transport the envelopes arrive on. Default `"nifra.events"`. */
  readonly system?: string
  /** Runs the handler with the consumer span active in an ambient context (see `ObservationScope`). */
  readonly scope?: ObservationScope
}

const REGISTRY_REASONS: ReadonlySet<string> = new Set([
  "not-an-object",
  "unknown-contract",
  "invalid-payload",
])
const TYPE_NAME = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/

/**
 * Wrap an event consumer so each envelope is one `process <type>` span (kind consumer), linked to the
 * producer's span through `causalitySpanLink(envelope.causality)`. With a `parent`, the span is that
 * span's child; otherwise it starts its own trace. Attributes: `nifra.event.type`, `nifra.event.version`,
 * `messaging.message.id` (the envelope id), and the messaging operation.
 *
 * Input that fails to parse never reaches the handler: it becomes an error span carrying only an issue
 * count (and a registry's bounded reason), resolves `{ success: false }`, and exports no payload. A
 * throwing handler ends its span as an error and rejects.
 */
export function traceEventConsumer<Envelope extends TracedEventEnvelope, Result>(
  source: TracedEventSource<Envelope>,
  handler: (envelope: Envelope, context: EventConsumerContext) => Result,
  options: EventTracingOptions = {},
): TracedEventConsumer<Awaited<Result>> {
  const adapters = [
    ...(options.exporter === undefined ? [] : [options.exporter]),
    ...(options.adapters ?? []),
  ]
  const lifecycle = createObservationLifecycle({ adapters })
  const system = options.system ?? "nifra.events"
  const scope = options.scope
  const sourceType =
    typeof source.type === "string" && TYPE_NAME.test(source.type) ? source.type : undefined
  const operation = {
    "messaging.system": system,
    "messaging.operation.type": "process",
    "messaging.operation.name": "process",
  }

  return async (input, parent) => {
    const ambient = parent === undefined ? null : parseTraceparent(parent.traceparent)
    const name = sourceType === undefined ? "process" : `process ${sourceType}`
    let parsed: ReturnType<TracedEventSource<Envelope>["parse"]>
    try {
      parsed = source.parse(input)
    } catch (error) {
      // A contract with an async payload schema throws here; that is a bug, not bad input.
      lifecycle
        .start({ name, kind: "consumer", parent: ambient, attributes: operation })
        .end({ status: "error", attributes: { "error.type": "_OTHER" } })
      throw error
    }
    if (!parsed.success) {
      const attributes: Record<string, AttributeValue> = {
        ...operation,
        "nifra.event.issue_count": parsed.issues?.length ?? 1,
        "error.type": "invalid_event",
      }
      if (parsed.reason !== undefined && REGISTRY_REASONS.has(parsed.reason))
        attributes["nifra.event.parse_failure"] = parsed.reason
      lifecycle
        .start({
          name,
          kind: "consumer",
          parent: ambient,
          attributes,
        })
        .end({ status: "error" })
      return { success: false, issueCount: parsed.issues?.length ?? 1 }
    }

    const envelope = parsed.envelope
    const start: { -readonly [K in keyof StartObservation]: StartObservation[K] } = {
      name: `process ${envelope.type}`,
      kind: "consumer",
      parent: ambient,
      attributes: {
        ...operation,
        "messaging.message.id": envelope.id,
        "nifra.event.type": envelope.type,
        "nifra.event.version": envelope.version,
      },
    }
    const link =
      envelope.causality === undefined ? undefined : causalitySpanLink(envelope.causality)
    if (link !== undefined) start.links = [link]
    const span = lifecycle.start(start)
    const context: EventConsumerContext = { trace: span.context }
    try {
      const value =
        scope === undefined
          ? await handler(envelope, context)
          : await scope(span.context, () => handler(envelope, context))
      span.end({ status: "ok" })
      return { success: true, value }
    } catch (error) {
      span.recordError(error)
      span.end({ status: "error", attributes: { "error.type": "_OTHER" } })
      throw error
    }
  }
}

/**
 * The deep request-observation lifecycle. This module alone owns trace parent selection, identity,
 * timing, error recording, final status classification, and exactly-once completion. Integrations
 * should adapt completed spans; they should not reimplement this state machine.
 */

import type {
  AttributeValue,
  NifraSpan,
  ObservationAdapter,
  ObservationLink,
  SpanStatus,
} from "./span.ts"
import {
  formatTraceparent,
  generateSpanId,
  generateTraceId,
  parseTraceparent,
} from "./traceparent.ts"

export interface ObservationContext {
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId?: string
  readonly sampled: boolean
  /** This span's outbound W3C trace context. */
  readonly traceparent: string
}

export interface ObservationParent {
  readonly traceId: string
  readonly spanId: string
  readonly sampled: boolean
}

export interface StartObservation {
  readonly name: string
  /** Explicit parent. `null` forces a root span; `undefined` falls back to `traceparent`. */
  readonly parent?: ObservationParent | null
  /** Inbound W3C header used when `parent` is undefined. */
  readonly traceparent?: string | null
  readonly attributes?: Readonly<Record<string, AttributeValue>>
  /** Non-parent causal relationships, for example an outbox event that resumed this workflow. */
  readonly links?: readonly ObservationLink[]
}

export interface EndObservation {
  readonly statusCode?: number
  /** Explicit status wins over status-code and recorded-error classification. */
  readonly status?: Exclude<SpanStatus, "unset">
  readonly attributes?: Readonly<Record<string, AttributeValue>>
}

export interface ActiveObservation {
  readonly span: NifraSpan
  readonly context: ObservationContext
  /** Adds a sink to this in-flight span. Re-adding the same adapter is idempotent. */
  addAdapter(adapter: ObservationAdapter): void
  /** Starts a child that inherits this span's trace identity and sampling decision. */
  startChild(
    input: Omit<StartObservation, "parent" | "traceparent">,
    additionalAdapters?: readonly ObservationAdapter[],
  ): ActiveObservation
  /**
   * Merge attributes onto the in-flight span — the seam for plugins that learn something mid-request
   * (an authenticated principal, a feature-flag bucket, a cache verdict) after the span opened.
   * Silently ignored once the observation has ended (the exported span is immutable).
   */
  setAttributes(attributes: Readonly<Record<string, AttributeValue>>): void
  /** Records failure evidence without deciding the final status until the response is known. */
  recordError(error: unknown): void
  /** Ends and exports once. Repeated calls return the same completed span without notifying again. */
  end(input?: EndObservation): NifraSpan
}

export interface ObservationLifecycle {
  start(
    input: StartObservation,
    additionalAdapters?: readonly ObservationAdapter[],
  ): ActiveObservation
}

export interface ObservationClock {
  /** Epoch milliseconds for interoperable start/end timestamps. */
  wallTime(): number
  /** Monotonic milliseconds for durations. */
  monotonicTime(): number
}

export interface ObservationLifecycleOptions {
  readonly adapters?: readonly ObservationAdapter[]
  /** Injectable seams are primarily useful for deterministic tests and constrained runtimes. */
  readonly clock?: ObservationClock
  readonly generateTraceId?: () => string
  readonly generateSpanId?: () => string
}

const defaultClock: ObservationClock = {
  wallTime: () => Date.now(),
  monotonicTime: () => (typeof performance === "undefined" ? Date.now() : performance.now()),
}

/** Creates an independent lifecycle factory. Adapters are always called fail-open. */
export function createObservationLifecycle(
  options: ObservationLifecycleOptions = {},
): ObservationLifecycle {
  const adapters = options.adapters ?? []
  const clock = options.clock ?? defaultClock
  const newTraceId = options.generateTraceId ?? generateTraceId
  const newSpanId = options.generateSpanId ?? generateSpanId

  const notifyStart = (span: NifraSpan, spanAdapters: readonly ObservationAdapter[]): void => {
    for (const adapter of spanAdapters) {
      try {
        adapter.onStart?.(span)
      } catch {
        // Observation must never change request behavior.
      }
    }
  }

  const notifyEnd = (span: NifraSpan, spanAdapters: readonly ObservationAdapter[]): void => {
    for (const adapter of spanAdapters) {
      try {
        adapter.onEnd(span)
      } catch {
        // Observation must never change request behavior.
      }
    }
  }

  const start = (
    input: StartObservation,
    additionalAdapters: readonly ObservationAdapter[] = [],
  ): ActiveObservation => {
    const spanAdapters = new Set([...adapters, ...additionalAdapters])
    const parent =
      input.parent === undefined ? parseTraceparent(input.traceparent ?? null) : input.parent
    const traceId = parent?.traceId ?? newTraceId()
    const spanId = newSpanId()
    const sampled = parent?.sampled ?? true
    const startTime = clock.wallTime()
    const monotonicStart = clock.monotonicTime()
    const span: NifraSpan = {
      traceId,
      spanId,
      ...(parent === null ? {} : { parentSpanId: parent.spanId }),
      sampled,
      name: input.name,
      startTime,
      status: "unset",
      attributes: { ...input.attributes },
      ...(input.links === undefined
        ? {}
        : {
            links: Object.freeze(
              input.links.map((link) =>
                Object.freeze({
                  traceId: link.traceId,
                  spanId: link.spanId,
                  ...(link.attributes === undefined
                    ? {}
                    : { attributes: Object.freeze({ ...link.attributes }) }),
                }),
              ),
            ),
          }),
    }
    const context: ObservationContext = {
      traceId,
      spanId,
      ...(parent === null ? {} : { parentSpanId: parent.spanId }),
      sampled,
      traceparent: formatTraceparent(traceId, spanId, sampled),
    }
    let recordedError = false
    let ended = false

    const active: ActiveObservation = {
      span,
      context,
      addAdapter(adapter) {
        if (ended || spanAdapters.has(adapter)) return
        spanAdapters.add(adapter)
        try {
          adapter.onStart?.(span)
        } catch {
          // Dynamic adapters have the same fail-open guarantee as initial adapters.
        }
      },
      startChild(child, childAdapters) {
        return start(
          {
            ...child,
            parent: context,
          },
          childAdapters,
        )
      },
      setAttributes(attributes) {
        if (ended) return
        Object.assign(span.attributes, attributes)
      },
      recordError(_error) {
        if (ended) return
        recordedError = true
        // Error text is deliberately excluded: exception messages routinely contain credentials,
        // URLs, customer data, and query values. Integrations that own an explicit redaction policy
        // may add sanitized detail through their own adapter.
        span.attributes["error.recorded"] = true
      },
      end(endInput = {}) {
        if (ended) return span
        ended = true
        Object.assign(span.attributes, endInput.attributes)
        span.endTime = clock.wallTime()
        span.durationMs = Math.max(0, clock.monotonicTime() - monotonicStart)
        span.status =
          endInput.status ??
          (endInput.statusCode === undefined
            ? recordedError
              ? "error"
              : "ok"
            : endInput.statusCode >= 500
              ? "error"
              : "ok")
        // Publish an immutable completed span: a misbehaving adapter can no longer mutate the shared
        // attributes bag and corrupt what other adapters (or the caller) observe. Adapters are fail-open,
        // so a stray write throws into their own try/catch rather than changing request behavior.
        Object.freeze(span.attributes)
        Object.freeze(span)
        notifyEnd(span, [...spanAdapters])
        return span
      },
    }

    notifyStart(span, [...spanAdapters])
    return active
  }

  return { start }
}

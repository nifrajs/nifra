/**
 * Spans for `@nifrajs/jobs`, following the OpenTelemetry messaging conventions. `jobTracing()` is the
 * queue's `instrument`: each enqueue is a `send <job>` producer span and each attempt a `process <job>`
 * consumer span. The send span's context is stored with the job, and the process span is its CHILD
 * (plus a link to it), so one trace runs from the request that enqueued the job through every attempt.
 *
 *   import { jobTracing } from "@nifrajs/otel/jobs"
 *   const queue = createQueue({ store, instrument: jobTracing({ exporter }) })
 *   await sendEmail.for(c).enqueue({ to })   // "send send-email", child of the request span
 */

import {
  createObservationLifecycle,
  type ObservationContext,
  type ObservationScope,
  type StartObservation,
} from "./lifecycle.ts"
import type { AttributeValue, ObservationAdapter } from "./span.ts"
import { parseTraceparent } from "./traceparent.ts"

/** `JobEnqueueInfo` from `@nifrajs/jobs`, declared structurally so this package does not depend on it. */
export interface JobTracingEnqueueInfo {
  readonly name: string
  readonly traceparent: string | undefined
}

/** `JobRunInfo` from `@nifrajs/jobs`, declared structurally. */
export interface JobTracingRunInfo {
  readonly id: string
  readonly name: string
  readonly attempt: number
  readonly maxAttempts: number
  readonly traceparent: string | undefined
}

/** Structurally a `QueueInstrument` from `@nifrajs/jobs`: pass it as `createQueue({ instrument })`. */
export interface JobTracingInstrument {
  enqueue(
    info: JobTracingEnqueueInfo,
    next: (scope?: { readonly traceparent?: string }) => Promise<string>,
  ): Promise<string>
  run(
    info: JobTracingRunInfo,
    next: (scope?: { readonly trace?: ObservationContext }) => Promise<string>,
  ): Promise<string>
}

export interface JobTracingOptions {
  readonly exporter?: ObservationAdapter
  readonly adapters?: readonly ObservationAdapter[]
  /**
   * Runs each attempt with its process span active in an ambient context. Pass `otelBridge().scope`
   * from `@nifrajs/otel/sdk-bridge` so OpenTelemetry instrumentations (pg, undici) inside the handler
   * nest under the process span.
   */
  readonly scope?: ObservationScope
}

const SYSTEM = "nifra.jobs"

/**
 * The queue instrument. Span names are `send <job name>` (kind producer) and `process <job name>` (kind
 * consumer), with `messaging.system = "nifra.jobs"`, `messaging.operation.type`/`.name`,
 * `messaging.destination.name` (the job name) and `messaging.message.id`. A process span also carries
 * `nifra.job.attempt` and `nifra.job.outcome`; an attempt that failed is an error span, and one that
 * dead-lettered the job adds `nifra.job.dead_lettered = true`. Error text is never exported.
 *
 * The stored traceparent is untrusted: a malformed one starts the process span as a new trace. The
 * sampled flag travels with it.
 */
export function jobTracing(options: JobTracingOptions = {}): JobTracingInstrument {
  const adapters = [
    ...(options.exporter === undefined ? [] : [options.exporter]),
    ...(options.adapters ?? []),
  ]
  const lifecycle = createObservationLifecycle({ adapters })
  const scope = options.scope

  return {
    async enqueue(info, next) {
      const span = lifecycle.start({
        name: `send ${info.name}`,
        kind: "producer",
        parent: parseTraceparent(info.traceparent),
        attributes: {
          "messaging.system": SYSTEM,
          "messaging.operation.type": "send",
          "messaging.operation.name": "send",
          "messaging.destination.name": info.name,
        },
      })
      try {
        const id = await next({ traceparent: span.context.traceparent })
        span.end({ status: "ok", attributes: { "messaging.message.id": id } })
        return id
      } catch (error) {
        span.recordError(error)
        span.end({ status: "error", attributes: { "error.type": "_OTHER" } })
        throw error
      }
    },
    async run(info, next) {
      const creation = parseTraceparent(info.traceparent)
      const start: { -readonly [K in keyof StartObservation]: StartObservation[K] } = {
        name: `process ${info.name}`,
        kind: "consumer",
        parent: creation,
        attributes: {
          "messaging.system": SYSTEM,
          "messaging.operation.type": "process",
          "messaging.operation.name": "process",
          "messaging.destination.name": info.name,
          "messaging.message.id": info.id,
          "nifra.job.attempt": info.attempt,
        },
      }
      if (creation !== null) start.links = [{ traceId: creation.traceId, spanId: creation.spanId }]
      const span = lifecycle.start(start)
      const trace = span.context
      try {
        const outcome =
          scope === undefined ? await next({ trace }) : await scope(trace, () => next({ trace }))
        if (outcome === "completed") {
          span.end({ status: "ok", attributes: { "nifra.job.outcome": outcome } })
        } else {
          const attributes: Record<string, AttributeValue> = {
            "nifra.job.outcome": outcome,
            "error.type": "_OTHER",
          }
          if (outcome === "dead-lettered") attributes["nifra.job.dead_lettered"] = true
          span.end({ status: "error", attributes })
        }
        return outcome
      } catch (error) {
        span.recordError(error)
        span.end({ status: "error", attributes: { "error.type": "_OTHER" } })
        throw error
      }
    },
  }
}

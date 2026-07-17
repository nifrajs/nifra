/**
 * A dependency-free OTLP/HTTP (JSON) span exporter. Ships completed spans to any OpenTelemetry
 * collector (`.../v1/traces`) with in-process batching, matching the package's no-SDK stance: it
 * speaks the wire protocol directly over `fetch`, so it runs on Bun, Node, Deno, and workerd alike.
 *
 * Wire mapping follows the OTLP/JSON encoding: ids stay hex, times become Unix-nanosecond strings,
 * attributes become typed `KeyValue`s. Export is fail-open (a collector outage never throws into a
 * request); delivery failures reach `onError`.
 */

import type { AttributeValue, NifraSpan, ObservationAdapter, SpanStatus } from "./span.ts"

export interface OtlpExporterOptions {
  /** The collector's traces endpoint, e.g. `http://localhost:4318/v1/traces`. */
  readonly url: string
  /** Extra headers on every export (auth tokens, tenant ids). */
  readonly headers?: Record<string, string>
  /** `service.name` resource attribute. Default `"nifra"`. */
  readonly serviceName?: string
  /** Batching knobs. */
  readonly batch?: {
    /** Flush once this many spans are queued. Must be a positive safe integer. Default 512. */
    readonly maxBatch?: number
    /** Hard cap on the queue; oldest spans are dropped past it. Positive safe integer; default 2048. */
    readonly maxQueue?: number
    /** Periodic flush interval (ms). Must be a positive safe integer. Default 5000. */
    readonly flushIntervalMs?: number
  }
  /** Called when an export POST fails or spans are dropped. Fail-open: never throws into a request. */
  readonly onError?: (error: unknown) => void
  /** Override `fetch` (tests, a proxy agent). Defaults to the global. */
  readonly fetch?: (input: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>
}

export interface OtlpExporter extends ObservationAdapter {
  /** Send everything queued now. Await it in a graceful shutdown so no span is lost. */
  flush(): Promise<void>
  /** Stop the periodic timer and flush a final time. Call on server stop. */
  shutdown(): Promise<void>
}

const STATUS_CODE: Readonly<Record<SpanStatus, number>> = { unset: 0, ok: 1, error: 2 }

function assertPositiveSafeInteger(value: number, option: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(
      `otlpExporter: ${option} must be a positive safe integer; received ${String(value)}`,
    )
  }
}

function anyValue(value: AttributeValue): Record<string, unknown> {
  if (typeof value === "boolean") return { boolValue: value }
  if (typeof value === "string") return { stringValue: value }
  // OTLP/JSON carries 64-bit ints as strings; non-integers use doubleValue.
  return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
}

function keyValues(attributes: Readonly<Record<string, AttributeValue>>): unknown[] {
  return Object.entries(attributes).map(([key, value]) => ({ key, value: anyValue(value) }))
}

const MS_TO_NANOS = 1_000_000

function toOtlpSpan(span: NifraSpan): Record<string, unknown> {
  const end = span.endTime ?? span.startTime
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId !== undefined ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    kind: 2, // SPAN_KIND_SERVER
    startTimeUnixNano: String(span.startTime * MS_TO_NANOS),
    endTimeUnixNano: String(end * MS_TO_NANOS),
    attributes: keyValues(span.attributes),
    status: { code: STATUS_CODE[span.status] },
    ...(span.links !== undefined && span.links.length > 0
      ? {
          links: span.links.map((link) => ({
            traceId: link.traceId,
            spanId: link.spanId,
            ...(link.attributes !== undefined ? { attributes: keyValues(link.attributes) } : {}),
          })),
        }
      : {}),
  }
}

export function otlpExporter(options: OtlpExporterOptions): OtlpExporter {
  const maxBatch = options.batch?.maxBatch ?? 512
  const maxQueue = options.batch?.maxQueue ?? 2048
  const flushIntervalMs = options.batch?.flushIntervalMs ?? 5000
  assertPositiveSafeInteger(maxBatch, "batch.maxBatch")
  assertPositiveSafeInteger(maxQueue, "batch.maxQueue")
  assertPositiveSafeInteger(flushIntervalMs, "batch.flushIntervalMs")
  const doFetch = options.fetch ?? (globalThis.fetch as OtlpExporterOptions["fetch"])
  const resourceAttributes = keyValues({ "service.name": options.serviceName ?? "nifra" })

  const queue: NifraSpan[] = []
  let timer: ReturnType<typeof setInterval> | undefined

  const report = (error: unknown): void => {
    try {
      options.onError?.(error)
    } catch {
      // an onError that itself throws must not break export
    }
  }

  const send = async (spans: NifraSpan[]): Promise<void> => {
    if (spans.length === 0 || doFetch === undefined) return
    const body = JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: resourceAttributes },
          scopeSpans: [{ scope: { name: "nifra" }, spans: spans.map(toOtlpSpan) }],
        },
      ],
    })
    try {
      const res = await doFetch(options.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...options.headers },
        body,
      })
      if (!res.ok) report(new Error(`otlp_export_failed_${res.status}`))
    } catch (error) {
      report(error)
    }
  }

  const flush = (): Promise<void> => {
    if (queue.length === 0) return Promise.resolve()
    return send(queue.splice(0, queue.length))
  }

  const ensureTimer = (): void => {
    if (timer !== undefined) return
    timer = setInterval(() => {
      void flush()
    }, flushIntervalMs)
    ;(timer as { unref?: () => void }).unref?.() // never keep the process alive for the exporter
  }

  return {
    onEnd(span) {
      queue.push(span)
      if (queue.length > maxQueue) {
        queue.shift() // drop the oldest under sustained backpressure rather than grow unbounded
        report(new Error("otlp_queue_overflow_span_dropped"))
      }
      if (queue.length >= maxBatch) void flush()
      else ensureTimer()
    },
    flush,
    async shutdown() {
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
      await flush()
    },
  }
}

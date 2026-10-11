/**
 * A dependency-free OTLP/HTTP (JSON) span exporter. Ships completed spans to any OpenTelemetry
 * collector (`.../v1/traces`) with in-process batching, matching the package's no-SDK stance: it
 * speaks the wire protocol directly over `fetch`, so it runs on Bun, Node, Deno, and workerd alike.
 *
 * Wire mapping follows the OTLP/JSON encoding: ids stay hex, times become Unix-nanosecond strings,
 * attributes become typed `KeyValue`s. Export is fail-open (a collector outage never throws into a
 * request); delivery failures reach `onError`.
 */

import type { AttributeValue, NifraSpan, ObservationAdapter, SpanKind, SpanStatus } from "./span.ts"

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
  /**
   * Deadline for one export POST (ms); a send past it is aborted and reported. Exports go one at a
   * time, so this also bounds how long `flush()` and `shutdown()` wait per batch. Positive safe
   * integer; default 30000.
   */
  readonly timeoutMs?: number
  /** Called when an export POST fails or spans are dropped. Fail-open: never throws into a request. */
  readonly onError?: (error: unknown) => void
  /** Override `fetch` (tests, a proxy agent). Defaults to the global. */
  readonly fetch?: (input: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>
}

export interface OtlpExporter extends ObservationAdapter {
  /**
   * Send everything queued now. Resolves once each span queued before the call was sent, failed or
   * dropped; await it in a graceful shutdown so no span is lost.
   */
  flush(): Promise<void>
  /** Stop the periodic timer and flush a final time, awaiting the export in flight. Call on server stop. */
  shutdown(): Promise<void>
}

const STATUS_CODE: Readonly<Record<SpanStatus, number>> = { unset: 0, ok: 1, error: 2 }
// OTLP `Span.SpanKind`; 0 (UNSPECIFIED) is never sent. A kind is caller data, so anything unknown
// exports as server, the kind of the spans that predate the field.
function kindCode(kind: SpanKind | undefined): number {
  switch (kind) {
    case "internal":
      return 1
    case "client":
      return 3
    case "producer":
      return 4
    case "consumer":
      return 5
    default:
      return 2
  }
}

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
    kind: kindCode(span.kind),
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
  const timeoutMs = options.timeoutMs ?? 30_000
  assertPositiveSafeInteger(maxBatch, "batch.maxBatch")
  assertPositiveSafeInteger(maxQueue, "batch.maxQueue")
  assertPositiveSafeInteger(flushIntervalMs, "batch.flushIntervalMs")
  assertPositiveSafeInteger(timeoutMs, "timeoutMs")
  const doFetch = options.fetch ?? (globalThis.fetch as OtlpExporterOptions["fetch"])
  const resourceAttributes = keyValues({ "service.name": options.serviceName ?? "nifra" })

  const queue: NifraSpan[] = []
  let timer: ReturnType<typeof setInterval> | undefined
  // Spans ever queued, and spans since sent, failed or dropped. The queue is FIFO and drops its
  // oldest, so every span queued before a flush is settled once `settled` reaches that flush's mark.
  let queued = 0
  let settled = 0
  const waiters: Array<{ readonly mark: number; readonly resolve: () => void }> = []
  let pumping = false

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
    const controller = new AbortController()
    let deadline: ReturnType<typeof setTimeout> | undefined
    // Raced as well as signalled: a custom fetch that ignores the signal must not hold the loop.
    const expired = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => {
        const error = new Error(`otlp_export_timeout_${timeoutMs}ms`)
        controller.abort(error)
        reject(error)
      }, timeoutMs)
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Node and Bun timers carry unref; elsewhere the optional call is a no-op
      ;(deadline as { unref?: () => void }).unref?.()
    })
    try {
      const res = await Promise.race([
        doFetch(options.url, {
          method: "POST",
          headers: { "content-type": "application/json", ...options.headers },
          body,
          signal: controller.signal,
        }),
        expired,
      ])
      if (!res.ok) report(new Error(`otlp_export_failed_${res.status}`))
    } catch (error) {
      report(error)
    } finally {
      clearTimeout(deadline)
    }
  }

  const settle = (count: number): void => {
    settled += count
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i]
      if (waiter === undefined || waiter.mark > settled) continue
      waiters.splice(i, 1)
      waiter.resolve()
    }
  }

  // One export in flight at a time; spans arriving meanwhile wait in the bounded queue.
  const pump = async (): Promise<void> => {
    while (queue.length > 0) {
      const batch = queue.splice(0, maxBatch)
      await send(batch)
      settle(batch.length)
    }
  }

  const kick = (): void => {
    if (pumping) return
    pumping = true
    void pump().finally(() => {
      pumping = false
      if (queue.length > 0) kick()
    })
  }

  const flush = (): Promise<void> => {
    if (settled === queued) return Promise.resolve()
    const done = new Promise<void>((resolve) => waiters.push({ mark: queued, resolve }))
    kick()
    return done
  }

  const ensureTimer = (): void => {
    if (timer !== undefined) return
    timer = setInterval(kick, flushIntervalMs)
    ;(timer as { unref?: () => void }).unref?.() // never keep the process alive for the exporter
  }

  return {
    onEnd(span) {
      queue.push(span)
      queued++
      if (queue.length > maxQueue) {
        queue.shift() // drop the oldest under sustained backpressure rather than grow unbounded
        settle(1)
        report(new Error("otlp_queue_overflow_span_dropped"))
      }
      if (queue.length >= maxBatch) kick()
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

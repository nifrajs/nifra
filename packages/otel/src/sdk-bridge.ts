/**
 * A bridge between nifra spans and the OpenTelemetry SDK. The app passes its own `@opentelemetry/api`;
 * nifra takes no dependency on it.
 *
 *   import * as api from "@opentelemetry/api"
 *   import { otelBridge } from "@nifrajs/otel/sdk-bridge"
 *
 *   const bridge = otelBridge({ api })
 *   app.use(tracing({ adapters: [bridge.adapter] })).use(bridge.plugin)
 *   // a pg / undici span started inside a handler is now a child of the request span
 *
 * Context propagation needs an async context manager registered with the SDK (on Node, Bun and Deno the
 * AsyncLocalStorage one from `@opentelemetry/context-async-hooks`; on Workers, `nodejs_compat`).
 */

import type { AnyServer, IdentityPlugin } from "@nifrajs/core/server"
import { traceOfContext } from "./context-trace.ts"
import type { ObservationContext, ObservationScope } from "./lifecycle.ts"
import type { AttributeValue, NifraSpan, ObservationAdapter, SpanKind } from "./span.ts"
import { generateSpanId, generateTraceId } from "./traceparent.ts"

/** The OTel `SpanContext` shape. */
export interface OtelSpanContext {
  readonly traceId: string
  readonly spanId: string
  readonly traceFlags: number
  readonly isRemote?: boolean
}

/** The part of an OTel `Span` the bridge uses. Every `Span` from `@opentelemetry/api` has it. */
export interface OtelSpan {
  spanContext(): OtelSpanContext
  setAttributes(attributes: Record<string, AttributeValue>): unknown
  setStatus(status: { code: number }): unknown
  end(endTime?: number): void
  isRecording(): boolean
}

/** The part of an OTel `Tracer` the bridge uses. */
export interface OtelTracer {
  startSpan(
    name: string,
    options?: {
      kind?: number
      startTime?: number
      attributes?: Record<string, AttributeValue>
      links?: Array<{
        context: OtelSpanContext
        attributes?: Record<string, AttributeValue>
      }>
    },
    context?: unknown,
  ): OtelSpan
}

/** The part of `@opentelemetry/api` the bridge uses: pass `import * as api from "@opentelemetry/api"`. */
export interface OtelApi {
  readonly ROOT_CONTEXT: unknown
  readonly context: {
    active(): unknown
    with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
      context: unknown,
      fn: F,
      thisArg?: ThisParameterType<F>,
      ...args: A
    ): ReturnType<F>
  }
  readonly trace: {
    setSpan(context: unknown, span: unknown): unknown
    getSpan(context: unknown): { spanContext(): OtelSpanContext } | undefined
    getTracer(name: string, version?: string): OtelTracer
  }
}

/** The SDK's `IdGenerator`. */
export interface OtelIdGenerator {
  generateTraceId(): string
  generateSpanId(): string
}

export interface OtelBridgeOptions {
  /** The app's own `@opentelemetry/api` module. */
  readonly api: OtelApi
  /** Tracer that mirrored spans start on. Default `api.trace.getTracer("@nifrajs/otel")`, at first use. */
  readonly tracer?: OtelTracer
  /** Maximum mirrored spans in flight at once; the oldest is ended past it. Default 10,000. */
  readonly maxActive?: number
  /** Opportunistically end mirrored spans in flight longer than this many ms. Default 5 min. */
  readonly maxActiveAgeMs?: number
  /** Injectable wall clock for deterministic retention tests. */
  readonly now?: () => number
  /**
   * Called once when the SDK gave a mirrored span different ids from the nifra span, which means
   * `idGenerator` is not wired. Default: one `console.warn`.
   */
  readonly onIdMismatch?: () => void
}

export interface OtelBridge {
  /**
   * Mirrors nifra spans into SDK spans: name, kind, parent, links, attributes, status and timing. Add it
   * to `tracing({ adapters })` and to `cacheTracing` / `jobTracing` / `traceEventConsumer`.
   */
  readonly adapter: ObservationAdapter
  /**
   * `app.use(bridge.plugin)`: each subsequent route runs with its request span active in the OTel
   * context, so the SDK's own instrumentations (pg, mysql2, ioredis, undici, prisma) nest under it.
   * Costs one `around()` frame per request, and only when installed.
   */
  readonly plugin: IdentityPlugin
  /** Runs code with a nifra span active in the OTel context: `jobTracing({ scope: bridge.scope })`. */
  readonly scope: ObservationScope
  /**
   * Pass as the SDK provider's `idGenerator` so mirrored spans keep nifra's exact trace and span ids:
   * the `traceparent` nifra forwards downstream and the trace context a job stores then name real
   * spans. Outside a mirrored start it generates random ids.
   */
  readonly idGenerator: OtelIdGenerator
}

// `SpanKind` and `SpanStatusCode` of @opentelemetry/api, stable since 1.0.
const KIND: Readonly<Record<string, number>> = Object.freeze(
  Object.assign(Object.create(null) as Record<SpanKind, number>, {
    internal: 0,
    server: 1,
    client: 2,
    producer: 3,
    consumer: 4,
  }),
)
const SERVER_KIND = 1
const STATUS_OK = 1
const STATUS_ERROR = 2
const SAMPLED = 1
const INVALID: OtelSpanContext = Object.freeze({
  traceId: "00000000000000000000000000000000",
  spanId: "0000000000000000",
  traceFlags: 0,
})

/**
 * A span that only carries a context. Instrumentations read the active span's `spanContext()` to pick
 * their parent; nifra owns the span's lifecycle, so every other call is a no-op.
 */
class ContextSpan {
  private readonly resolve: () => OtelSpanContext
  constructor(resolve: () => OtelSpanContext) {
    this.resolve = resolve
  }
  spanContext(): OtelSpanContext {
    return this.resolve()
  }
  setAttribute(): this {
    return this
  }
  setAttributes(): this {
    return this
  }
  addEvent(): this {
    return this
  }
  addLink(): this {
    return this
  }
  addLinks(): this {
    return this
  }
  setStatus(): this {
    return this
  }
  updateName(): this {
    return this
  }
  end(): void {}
  isRecording(): boolean {
    return false
  }
  recordException(): void {}
}

/** Build the bridge. See {@link OtelBridge} for what each part does. */
export function otelBridge(options: OtelBridgeOptions): OtelBridge {
  const api = options.api
  const maxActive = options.maxActive ?? 10_000
  const maxActiveAgeMs = options.maxActiveAgeMs ?? 5 * 60_000
  if (!Number.isSafeInteger(maxActive) || maxActive < 1) {
    throw new RangeError("otelBridge maxActive must be a positive safe integer")
  }
  if (!Number.isSafeInteger(maxActiveAgeMs) || maxActiveAgeMs < 1) {
    throw new RangeError("otelBridge maxActiveAgeMs must be a positive safe integer")
  }
  const now = options.now ?? Date.now
  let tracer = options.tracer
  const tracerOf = (): OtelTracer => {
    tracer ??= api.trace.getTracer("@nifrajs/otel")
    return tracer
  }
  let warned = false
  const onIdMismatch =
    options.onIdMismatch ??
    (() =>
      console.warn(
        "[nifra/otel] mirrored spans got new ids from the SDK; pass `idGenerator: bridge.idGenerator` to the tracer provider so forwarded traceparents name real spans",
      ))

  // The ids the next SDK span must take. Set and cleared around one synchronous `startSpan` call.
  let pending: { traceId: string | undefined; spanId: string | undefined } | undefined
  const idGenerator: OtelIdGenerator = {
    generateTraceId() {
      const id = pending?.traceId
      if (pending !== undefined) pending.traceId = undefined
      return id ?? generateTraceId()
    },
    generateSpanId() {
      const id = pending?.spanId
      if (pending !== undefined) pending.spanId = undefined
      return id ?? generateSpanId()
    },
  }

  const active = new Map<string, { readonly span: OtelSpan; readonly at: number }>()
  let nextSweepAt = Number.POSITIVE_INFINITY

  const evict = (spanId: string): void => {
    const entry = active.get(spanId)
    if (entry === undefined) return
    active.delete(spanId)
    try {
      entry.span.setAttributes({ "nifra.bridge.evicted": true })
      entry.span.end()
    } catch {
      // A failing SDK cannot break the request that triggered the eviction.
    }
  }

  // Same retention shape as effectTracing: insertion order is age order, so a sweep stops at the
  // first live entry and costs O(evicted).
  const sweep = (): number => {
    const at = now()
    if (!Number.isFinite(at) || at < nextSweepAt) return at
    nextSweepAt = Number.POSITIVE_INFINITY
    for (const [spanId, entry] of active) {
      const expiresAt = entry.at + maxActiveAgeMs
      if (at >= expiresAt) {
        evict(spanId)
      } else {
        nextSweepAt = expiresAt
        break
      }
    }
    return at
  }

  const contextOf = (trace: {
    readonly traceId: string
    readonly spanId: string
    readonly sampled: boolean
  }): OtelSpanContext =>
    active.get(trace.spanId)?.span.spanContext() ?? {
      traceId: trace.traceId,
      spanId: trace.spanId,
      traceFlags: trace.sampled ? SAMPLED : 0,
      isRemote: false,
    }

  const contextWith = (spanContext: () => OtelSpanContext): unknown =>
    api.trace.setSpan(api.context.active(), new ContextSpan(spanContext))

  const adapter: ObservationAdapter = {
    onStart(span: NifraSpan) {
      const at = sweep()
      while (active.size >= maxActive) {
        const oldest = active.keys().next().value as string | undefined
        if (oldest === undefined) break
        evict(oldest)
      }
      const parentSpanId = span.parentSpanId
      let parent = api.ROOT_CONTEXT
      if (parentSpanId !== undefined) {
        const mirroredParent = active.get(parentSpanId)?.span
        const parentSpan =
          mirroredParent ??
          new ContextSpan(() => ({
            traceId: span.traceId,
            spanId: parentSpanId,
            traceFlags: span.sampled ? SAMPLED : 0,
            isRemote: true,
          }))
        parent = api.trace.setSpan(parent, parentSpan)
      }
      pending = { traceId: span.traceId, spanId: span.spanId }
      let mirrored: OtelSpan
      try {
        mirrored = tracerOf().startSpan(
          span.name,
          {
            kind: KIND[span.kind ?? "server"] ?? SERVER_KIND,
            startTime: span.startTime,
            attributes: { ...span.attributes },
            ...(span.links === undefined
              ? {}
              : {
                  links: span.links.map((link) => ({
                    context: {
                      traceId: link.traceId,
                      spanId: link.spanId,
                      traceFlags: 0,
                      isRemote: true,
                    },
                    ...(link.attributes === undefined
                      ? {}
                      : { attributes: { ...link.attributes } }),
                  })),
                }),
          },
          parent,
        )
      } finally {
        pending = undefined
      }
      if (!warned && mirrored.isRecording() && mirrored.spanContext().spanId !== span.spanId) {
        warned = true
        onIdMismatch()
      }
      active.set(span.spanId, Object.freeze({ span: mirrored, at: Number.isFinite(at) ? at : 0 }))
      nextSweepAt = Math.min(nextSweepAt, (Number.isFinite(at) ? at : 0) + maxActiveAgeMs)
    },
    onEnd(span: NifraSpan) {
      const entry = active.get(span.spanId)
      if (entry === undefined) return
      active.delete(span.spanId)
      entry.span.setAttributes(span.attributes)
      if (span.status !== "unset")
        entry.span.setStatus({ code: span.status === "error" ? STATUS_ERROR : STATUS_OK })
      entry.span.end(span.endTime)
    },
  }

  const scope: ObservationScope = (trace: ObservationContext, run) =>
    api.context.with(
      contextWith(() => contextOf(trace)),
      run,
    )

  const apply = <S extends AnyServer>(app: S): S => {
    app.around((c, next) => {
      const outer = api.trace.getSpan(api.context.active())
      // The request span opens in `tracing()`'s derive, which runs inside this wrapper, so the
      // context is resolved lazily when an instrumentation starts a child.
      return api.context.with(
        contextWith(() => {
          const trace = traceOfContext(c)
          return trace === null ? (outer?.spanContext() ?? INVALID) : contextOf(trace)
        }),
        next,
      )
    })
    return app
  }

  return {
    adapter,
    plugin: Object.assign(apply, { pluginName: "nifra:otel-sdk-bridge" }) as IdentityPlugin,
    scope,
    idGenerator,
  }
}

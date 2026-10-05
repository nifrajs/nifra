import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core/server"
import { createQueue } from "@nifrajs/jobs"
import * as api from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import {
  AlwaysOnSampler,
  BasicTracerProvider,
  InMemorySpanExporter,
  ParentBasedSampler,
  type ReadableSpan,
  SimpleSpanProcessor,
  type TracerConfig,
} from "@opentelemetry/sdk-trace-base"
import { jobTracing } from "../src/jobs.ts"
import { createObservationLifecycle } from "../src/lifecycle.ts"
import { type OtelBridge, otelBridge } from "../src/sdk-bridge.ts"
import type { NifraSpan } from "../src/span.ts"
import { tracing } from "../src/tracing.ts"

const contextManager = new AsyncLocalStorageContextManager()
beforeAll(() => {
  api.context.setGlobalContextManager(contextManager.enable())
})
afterAll(() => {
  api.context.disable()
  api.trace.disable()
})
afterEach(() => {
  api.trace.disable()
})

/** An SDK provider; with `bridge`, registered globally with the bridge's idGenerator. */
function sdk(bridge?: OtelBridge) {
  const exporter = new InMemorySpanExporter()
  const config: TracerConfig = {
    sampler: new ParentBasedSampler({ root: new AlwaysOnSampler() }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  }
  if (bridge !== undefined) config.idGenerator = bridge.idGenerator
  const provider = new BasicTracerProvider(config)
  if (bridge !== undefined) api.trace.setGlobalTracerProvider(provider)
  return { exporter, tracer: provider.getTracer("test") }
}

function collect(): { spans: NifraSpan[]; exporter: { onEnd(span: NifraSpan): void } } {
  const spans: NifraSpan[] = []
  return { spans, exporter: { onEnd: (span) => spans.push(span) } }
}

function present<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`missing ${what}`)
  return value
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 1))
const finished = (exporter: InMemorySpanExporter, name: string): ReadableSpan => {
  const span = exporter.getFinishedSpans().find((s) => s.name === name)
  if (span === undefined) throw new Error(`no span ${name}`)
  return span
}

describe("otelBridge plugin", () => {
  test("an SDK span started in a handler, after an await, nests under the nifra request span", async () => {
    const { exporter, tracer } = sdk()
    const nifra = collect()
    const bridge = otelBridge({ api, tracer })
    const app = server()
      .use(tracing({ exporter: nifra.exporter }))
      .use(bridge.plugin)
      .get("/orders", async () => {
        await tick()
        const span = tracer.startSpan("pg.query")
        await tick()
        span.end()
        return { ok: true }
      })

    await app.fetch(new Request("http://nifra.test/orders"))

    const request = present(nifra.spans[0], "the request span")
    const child = finished(exporter, "pg.query")
    expect(child.spanContext().traceId).toBe(request.traceId)
    expect(child.parentSpanContext?.spanId).toBe(request.spanId)
    expect(child.parentSpanContext?.isRemote).toBe(false)
  })

  test("the active span only carries the context: every other call is a no-op", async () => {
    const { exporter, tracer } = sdk()
    const app = server()
      .use(tracing({ adapters: [] }))
      .use(otelBridge({ api, tracer }).plugin)
      .get("/x", () => {
        const active = present(api.trace.getActiveSpan(), "the active span")
        expect(active.isRecording()).toBe(false)
        expect(active.setAttribute("k", 1)).toBe(active)
        expect(active.setAttributes({ k: 1 })).toBe(active)
        expect(active.addEvent("e")).toBe(active)
        expect(active.addLink({ context: active.spanContext() })).toBe(active)
        expect(active.addLinks([])).toBe(active)
        expect(active.setStatus({ code: api.SpanStatusCode.ERROR })).toBe(active)
        expect(active.updateName("renamed")).toBe(active)
        active.recordException(new Error("x"))
        active.end()
        return { ok: true }
      })
    expect((await app.fetch(new Request("http://nifra.test/x"))).status).toBe(200)
    expect(exporter.getFinishedSpans()).toHaveLength(0)
  })

  test("concurrent requests keep their own parents", async () => {
    const { exporter, tracer } = sdk()
    const nifra = collect()
    const app = server()
      .use(tracing({ exporter: nifra.exporter }))
      .use(otelBridge({ api, tracer }).plugin)
      .get("/q/:n", async (c) => {
        await new Promise((resolve) => setTimeout(resolve, 5 - Number(c.params.n)))
        tracer.startSpan(`child ${c.params.n}`).end()
        return { ok: true }
      })
    await Promise.all([0, 1, 2, 3].map((n) => app.fetch(new Request(`http://nifra.test/q/${n}`))))
    const parentOf = new Map(
      nifra.spans.map((span) => [
        String(span.attributes["url.path"]).split("/").at(-1),
        span.spanId,
      ]),
    )
    expect(exporter.getFinishedSpans()).toHaveLength(4)
    for (const child of exporter.getFinishedSpans()) {
      expect(parentOf.get(child.name.split(" ")[1])).toBe(child.parentSpanContext?.spanId)
    }
  })

  test("an unsampled request makes the SDK drop its children", async () => {
    const { exporter, tracer } = sdk()
    const app = server()
      .use(tracing({ adapters: [] }))
      .use(otelBridge({ api, tracer }).plugin)
      .get("/x", () => {
        tracer.startSpan("pg.query").end()
        return { ok: true }
      })
    await app.fetch(
      new Request("http://nifra.test/x", {
        headers: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00" },
      }),
    )
    expect(exporter.getFinishedSpans()).toHaveLength(0)
  })

  test("without tracing() the plugin is transparent: the ambient OTel span stays the parent", async () => {
    const { exporter, tracer } = sdk()
    const app = server()
      .use(otelBridge({ api, tracer }).plugin)
      .get("/x", () => {
        tracer.startSpan("inner").end()
        return { ok: true }
      })
    await app.fetch(new Request("http://nifra.test/x"))
    const outer = tracer.startSpan("outer")
    await api.context.with(api.trace.setSpan(api.context.active(), outer), () =>
      app.fetch(new Request("http://nifra.test/x")),
    )
    outer.end()
    const inners = exporter.getFinishedSpans().filter((span) => span.name === "inner")
    expect(inners[0]?.parentSpanContext).toBeUndefined()
    expect(inners[1]?.parentSpanContext?.spanId).toBe(outer.spanContext().spanId)
  })
})

describe("otelBridge adapter", () => {
  test("mirrors nifra spans with their exact ids, kind, status, links and timing", async () => {
    const bridge = otelBridge({ api })
    const { exporter } = sdk(bridge)
    const tracer = api.trace.getTracer("app")
    const nifra = collect()
    const app = server()
      .use(tracing({ exporter: nifra.exporter, adapters: [bridge.adapter] }))
      .use(bridge.plugin)
      .get("/orders", async () => {
        await tick()
        tracer.startSpan("pg.query").end()
        return { ok: true }
      })
    await app.fetch(new Request("http://nifra.test/orders"))

    const request = present(nifra.spans[0], "the request span")
    const mirrored = finished(exporter, "GET /orders")
    expect(mirrored.spanContext()).toMatchObject({
      traceId: request.traceId,
      spanId: request.spanId,
    })
    expect(mirrored.kind).toBe(api.SpanKind.SERVER)
    expect(mirrored.status.code).toBe(api.SpanStatusCode.OK)
    expect(mirrored.attributes["http.response.status_code"]).toBe(200)
    expect(mirrored.startTime[0] * 1000 + mirrored.startTime[1] / 1e6).toBeCloseTo(
      request.startTime,
      0,
    )
    expect(finished(exporter, "pg.query").parentSpanContext?.spanId).toBe(request.spanId)

    const lifecycle = createObservationLifecycle({ adapters: [bridge.adapter] })
    const link = { traceId: "1".repeat(32), spanId: "2".repeat(16), attributes: { why: "x" } }
    lifecycle
      .start({ name: "process job", kind: "consumer", parent: null, links: [link] })
      .end({ status: "error" })
    const consumer = finished(exporter, "process job")
    expect(consumer.kind).toBe(api.SpanKind.CONSUMER)
    expect(consumer.status.code).toBe(api.SpanStatusCode.ERROR)
    expect(consumer.links[0]?.context).toMatchObject({ traceId: link.traceId, spanId: link.spanId })
    expect(consumer.links[0]?.attributes).toEqual({ why: "x" })
    expect(consumer.parentSpanContext).toBeUndefined()
  })

  test("a remote parent is kept, and an unset status stays unset", () => {
    const bridge = otelBridge({ api })
    const { exporter } = sdk(bridge)
    const lifecycle = createObservationLifecycle({ adapters: [bridge.adapter] })
    const span = lifecycle.start({
      name: "continued",
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    })
    bridge.adapter.onEnd({ ...span.span, status: "unset" })
    const mirrored = finished(exporter, "continued")
    expect(mirrored.parentSpanContext).toMatchObject({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      isRemote: true,
    })
    expect(mirrored.kind).toBe(api.SpanKind.SERVER)
    expect(mirrored.status.code).toBe(api.SpanStatusCode.UNSET)
    // Ending a span the adapter no longer holds is a no-op.
    expect(() => bridge.adapter.onEnd(span.span)).not.toThrow()
  })

  test("without idGenerator the ids differ: it warns once, and SDK children still nest under the mirror", async () => {
    const { exporter, tracer } = sdk()
    let warnings = 0
    const bridge = otelBridge({ api, tracer, onIdMismatch: () => warnings++ })
    const app = server()
      .use(tracing({ adapters: [bridge.adapter] }))
      .use(bridge.plugin)
      .get("/x", async () => {
        await tick()
        tracer.startSpan("pg.query").end()
        return { ok: true }
      })
    await app.fetch(new Request("http://nifra.test/x"))
    await app.fetch(new Request("http://nifra.test/x"))
    expect(warnings).toBe(1)
    const mirrors = exporter.getFinishedSpans().filter((span) => span.name === "GET /x")
    const children = exporter.getFinishedSpans().filter((span) => span.name === "pg.query")
    expect(children.map((span) => span.parentSpanContext?.spanId)).toEqual(
      mirrors.map((span) => span.spanContext().spanId),
    )
  })

  test("the default mismatch notice is one console.warn", () => {
    const { tracer } = sdk()
    const bridge = otelBridge({ api, tracer })
    const lifecycle = createObservationLifecycle({ adapters: [bridge.adapter] })
    const original = console.warn
    const lines: unknown[] = []
    console.warn = (line: unknown) => lines.push(line)
    try {
      lifecycle.start({ name: "a" }).end()
      lifecycle.start({ name: "b" }).end()
    } finally {
      console.warn = original
    }
    expect(lines).toHaveLength(1)
    expect(String(lines[0])).toContain("idGenerator")
  })

  test("the in-flight map is bounded by size and by age", () => {
    let now = 1_000
    const { exporter, tracer } = sdk()
    const bridge = otelBridge({
      api,
      tracer,
      maxActive: 2,
      maxActiveAgeMs: 100,
      now: () => now,
      onIdMismatch: () => undefined,
    })
    const lifecycle = createObservationLifecycle({ adapters: [bridge.adapter] })
    lifecycle.start({ name: "first" })
    lifecycle.start({ name: "second" })
    lifecycle.start({ name: "third" })
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(["first"])
    expect(exporter.getFinishedSpans()[0]?.attributes["nifra.bridge.evicted"]).toBe(true)
    now += 500
    lifecycle.start({ name: "fourth" })
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual([
      "first",
      "second",
      "third",
    ])
  })

  test("rejects invalid retention limits", () => {
    expect(() => otelBridge({ api, maxActive: 0 })).toThrow(RangeError)
    expect(() => otelBridge({ api, maxActiveAgeMs: Number.NaN })).toThrow(RangeError)
  })
})

describe("otelBridge scope", () => {
  test("jobTracing({ scope }) nests SDK spans in a handler under the process span", async () => {
    const bridge = otelBridge({ api })
    const { exporter } = sdk(bridge)
    const tracer = api.trace.getTracer("app")
    const nifra = collect()
    const queue = createQueue({
      instrument: jobTracing({ exporter: nifra.exporter, scope: bridge.scope }),
    })
    queue.define("email-job", {
      async handler() {
        await tick()
        tracer.startSpan("pg.query").end()
      },
    })
    await queue.enqueue("email-job", undefined)
    await queue.drain()
    const process = present(
      nifra.spans.find((span) => span.name === "process email-job"),
      "the process span",
    )
    expect(finished(exporter, "pg.query").parentSpanContext?.spanId).toBe(process.spanId)
    expect(finished(exporter, "pg.query").spanContext().traceId).toBe(process.traceId)
  })
})

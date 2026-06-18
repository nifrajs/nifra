import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import {
  type NifraSpan,
  type SpanExporter,
  type TraceContext,
  traceHeaders,
  tracing,
} from "../src/index.ts"

function collector(): { spans: NifraSpan[]; started: NifraSpan[]; exporter: SpanExporter } {
  const spans: NifraSpan[] = []
  const started: NifraSpan[] = []
  return {
    spans,
    started,
    exporter: {
      onStart: (s) => started.push(s),
      onEnd: (s) => spans.push(s),
    },
  }
}

describe("tracing plugin", () => {
  test("starts a fresh trace, ends a span with HTTP attributes + ok status", async () => {
    const c = collector()
    const app = server()
      .use(tracing({ exporter: c.exporter, serviceName: "test-api" }))
      .get("/ping", () => ({ ok: true }))
    const res = await app.fetch(new Request("http://t/ping"))
    expect(res.status).toBe(200)
    expect(c.started).toHaveLength(1)
    expect(c.spans).toHaveLength(1)
    const span = c.spans[0]!
    expect(span.name).toBe("GET /ping")
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(span.parentSpanId).toBeUndefined() // fresh trace, no inbound parent
    expect(span.status).toBe("ok")
    expect(span.attributes["http.request.method"]).toBe("GET")
    expect(span.attributes["url.path"]).toBe("/ping")
    expect(span.attributes["http.response.status_code"]).toBe(200)
    expect(span.attributes["service.name"]).toBe("test-api")
    expect(typeof span.durationMs).toBe("number")
  })

  test("continues an inbound trace (parent span id + same trace id)", async () => {
    const c = collector()
    const app = server()
      .use(tracing({ exporter: c.exporter }))
      .get("/x", () => ({ ok: true }))
    await app.fetch(
      new Request("http://t/x", {
        headers: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" },
      }),
    )
    const span = c.spans[0]!
    expect(span.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736") // continued
    expect(span.parentSpanId).toBe("00f067aa0ba902b7")
    expect(span.spanId).not.toBe("00f067aa0ba902b7") // its own new span id
    expect(span.sampled).toBe(true)
  })

  test("c.trace is exposed and forwards a valid traceparent downstream", async () => {
    const c = collector()
    let forwarded = ""
    const app = server()
      .use(tracing({ exporter: c.exporter }))
      .get("/h", (ctx) => {
        const t = (ctx as unknown as { trace: TraceContext }).trace
        forwarded = traceHeaders(t).traceparent
        return { trace: t.traceId }
      })
    await app.fetch(new Request("http://t/h"))
    const span = c.spans[0]!
    expect(forwarded).toBe(`00-${span.traceId}-${span.spanId}-01`) // this request's own span continues the trace
  })

  test("5xx marks the span status error", async () => {
    const c = collector()
    const app = server({ logger: { debug() {}, info() {}, warn() {}, error() {} } })
      .use(tracing({ exporter: c.exporter }))
      .get("/boom", () => {
        throw new Error("kaboom")
      })
    const res = await app.fetch(new Request("http://t/boom"))
    expect(res.status).toBe(500)
    expect(c.spans[0]!.status).toBe("error")
    expect(c.spans[0]!.attributes["http.response.status_code"]).toBe(500)
  })

  test("a handled 4xx is NOT an error span", async () => {
    const c = collector()
    const app = server()
      .use(tracing({ exporter: c.exporter }))
      .get("/nf", () => new Response("nope", { status: 404 }))
    await app.fetch(new Request("http://t/nf"))
    expect(c.spans[0]!.status).toBe("ok")
    expect(c.spans[0]!.attributes["http.response.status_code"]).toBe(404)
  })

  test("responseHeader option sets traceparent on the response", async () => {
    const c = collector()
    const app = server()
      .use(tracing({ exporter: c.exporter, responseHeader: true }))
      .get("/r", () => ({ ok: true }))
    const res = await app.fetch(new Request("http://t/r"))
    expect(res.headers.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
  })
})

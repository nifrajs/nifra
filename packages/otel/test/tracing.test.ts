import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import {
  type CausalityContext,
  type CausalityRecord,
  causalityHeaders,
  startCausality,
} from "@nifrajs/core/causality"
import {
  type NifraSpan,
  type ObservationAdapter,
  type TraceContext,
  traceHeaders,
  tracing,
} from "../src/index.ts"

function collector(): { spans: NifraSpan[]; started: NifraSpan[]; exporter: ObservationAdapter } {
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

  test("creates and durably records the HTTP root before the handler runs", async () => {
    const c = collector()
    const records: CausalityRecord[] = []
    let context: CausalityContext | undefined
    const app = server()
      .use(
        tracing({
          exporter: c.exporter,
          causality: {
            now: () => 42,
            recorder: {
              async record(record) {
                records.push(record)
                return "inserted"
              },
            },
          },
        }),
      )
      .get("/causal", (ctx) => {
        context = ctx.causality
        return { ok: true }
      })

    await app.fetch(new Request("http://t/causal"))

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      executionId: `exec_${c.spans[0]?.traceId}_${c.spans[0]?.spanId}`,
      node: {
        kind: "request",
        at: 42,
        trace: { traceId: c.spans[0]?.traceId, spanId: c.spans[0]?.spanId },
      },
      parents: [],
    })
    expect(context?.current).toEqual({ kind: "request", id: `req_${c.spans[0]?.spanId}` })
  })

  test("continues inbound durable causality and forwards both conventions downstream", async () => {
    const c = collector()
    const parent = startCausality("event", "evt_inbound", {
      executionId: "exec_inbound",
      at: 1,
    })
    const records: CausalityRecord[] = []
    let forwarded: Readonly<Record<string, string>> = {}
    const app = server()
      .use(
        tracing({
          exporter: c.exporter,
          causality: {
            now: () => 2,
            acceptInbound: () => true,
            recorder: {
              async record(record) {
                records.push(record)
                return "inserted"
              },
            },
          },
        }),
      )
      .get("/resume", (ctx) => {
        forwarded = traceHeaders(ctx.trace, ctx.causality)
        return { ok: true }
      })

    await app.fetch(new Request("http://t/resume", { headers: causalityHeaders(parent.context) }))

    expect(records[0]).toMatchObject({
      executionId: "exec_inbound",
      parents: [{ kind: "event", id: "evt_inbound", relation: "called" }],
    })
    expect(forwarded.traceparent).toBe(`00-${c.spans[0]?.traceId}-${c.spans[0]?.spanId}-01`)
    expect(forwarded["x-nifra-execution-id"]).toBe("exec_inbound")
    expect(forwarded["x-nifra-causality-kind"]).toBe("request")
  })

  test("does not trust client-supplied durable lineage without an explicit gate", async () => {
    const c = collector()
    const forged = startCausality("command", "cmd_forged", {
      executionId: "exec_victim",
      at: 1,
    })
    let context: CausalityContext | undefined
    const app = server()
      .use(tracing({ exporter: c.exporter }))
      .get("/public", (ctx) => {
        context = ctx.causality
        return { ok: true }
      })

    await app.fetch(new Request("http://t/public", { headers: causalityHeaders(forged.context) }))

    expect(context?.executionId).not.toBe("exec_victim")
    expect(context?.current.kind).toBe("request")
  })

  test("fails closed before the handler if an explicitly configured graph recorder fails", async () => {
    const c = collector()
    let handled = false
    const app = server({ logger: { debug() {}, info() {}, warn() {}, error() {} } })
      .use(
        tracing({
          exporter: c.exporter,
          causality: {
            recorder: {
              async record() {
                throw new Error("causality store unavailable")
              },
            },
          },
        }),
      )
      .get("/closed", () => {
        handled = true
        return { ok: true }
      })

    const response = await app.fetch(new Request("http://t/closed"))
    expect(response.status).toBe(500)
    expect(handled).toBe(false)
  })

  test("does not swallow recorder failure behind an asynchronous inbound trust gate", async () => {
    const c = collector()
    const parent = startCausality("event", "evt_async", {
      executionId: "exec_async",
      at: 1,
    })
    let calls = 0
    const app = server({ logger: { debug() {}, info() {}, warn() {}, error() {} } })
      .use(
        tracing({
          exporter: c.exporter,
          causality: {
            acceptInbound: async () => true,
            recorder: {
              async record() {
                calls += 1
                throw new Error("graph unavailable")
              },
            },
          },
        }),
      )
      .get("/async-gate", () => ({ ok: true }))

    const response = await app.fetch(
      new Request("http://t/async-gate", {
        headers: causalityHeaders(parent.context),
      }),
    )
    expect(response.status).toBe(500)
    expect(calls).toBe(1)
  })

  test("does not retry a synchronous recorder failure behind a synchronous inbound trust gate", async () => {
    const c = collector()
    const parent = startCausality("event", "evt_sync", {
      executionId: "exec_sync",
      at: 1,
    })
    let calls = 0
    const app = server({ logger: { debug() {}, info() {}, warn() {}, error() {} } })
      .use(
        tracing({
          exporter: c.exporter,
          causality: {
            acceptInbound: () => true,
            recorder: {
              record() {
                calls += 1
                throw new Error("graph unavailable")
              },
            },
          },
        }),
      )
      .get("/sync-gate", () => ({ ok: true }))

    const response = await app.fetch(
      new Request("http://t/sync-gate", {
        headers: causalityHeaders(parent.context),
      }),
    )
    expect(response.status).toBe(500)
    expect(calls).toBe(1)
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

  test("classifies the response after every later response transformation", async () => {
    const c = collector()
    const app = server()
      .use(tracing({ exporter: c.exporter }))
      .onResponse(
        (response) =>
          new Response(response.body, {
            status: 503,
            statusText: "Unavailable",
            headers: response.headers,
          }),
      )
      .get("/late-status", () => ({ ok: true }))

    const response = await app.fetch(new Request("http://t/late-status"))
    expect(response.status).toBe(503)
    expect(c.spans[0]?.attributes["http.response.status_code"]).toBe(503)
    expect(c.spans[0]?.status).toBe("error")
  })

  test("ends the observation when a later response transformation throws", async () => {
    const c = collector()
    const app = server()
      .use(tracing({ exporter: c.exporter }))
      .onResponse(() => {
        throw new Error("response-hook-secret")
      })
      .get("/hook-failure", () => ({ ok: true }))

    await expect(app.fetch(new Request("http://t/hook-failure"))).rejects.toThrow(
      "response-hook-secret",
    )
    expect(c.spans).toHaveLength(1)
    expect(c.spans[0]?.status).toBe("error")
    expect(c.spans[0]?.attributes["error.recorded"]).toBe(true)
    expect(JSON.stringify(c.spans[0]?.attributes)).not.toContain("response-hook-secret")
  })
})

describe("setAttributes — the mid-request annotation seam", () => {
  test("a handler (or later plugin) annotates the in-flight span via c.observation", async () => {
    const c = collector()
    const app = server()
      .use(tracing({ exporter: c.exporter }))
      .get("/annotated", (ctx) => {
        ctx.observation.setAttributes({ "tenant.key": "t_abc123", "flag.bucket": "treatment" })
        return { ok: true }
      })
    await app.fetch(new Request("http://t/annotated"))
    expect(c.spans[0]?.attributes["tenant.key"]).toBe("t_abc123")
    expect(c.spans[0]?.attributes["flag.bucket"]).toBe("treatment")
    // End-time attributes still win their own keys and the span still classifies normally.
    expect(c.spans[0]?.attributes["http.response.status_code"]).toBe(200)
  })

  test("setAttributes after end is a silent no-op — the exported span is immutable", async () => {
    const c = collector()
    let leaked: { setAttributes(a: Record<string, string>): void } | undefined
    const app = server()
      .use(tracing({ exporter: c.exporter }))
      .get("/leak", (ctx) => {
        leaked = ctx.observation
        return { ok: true }
      })
    await app.fetch(new Request("http://t/leak"))
    expect(c.spans).toHaveLength(1)
    expect(() => leaked?.setAttributes({ late: "write" })).not.toThrow()
    expect(c.spans[0]?.attributes.late).toBeUndefined()
  })
})

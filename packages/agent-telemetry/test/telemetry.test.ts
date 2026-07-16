import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { type NifraSpan, type ObservationAdapter, tracing } from "@nifrajs/otel"
import { agentTelemetry, consoleAgentExporter } from "../src/index.ts"

/** Captures spans into an array for assertion. */
function collectingExporter(): { exporter: ObservationAdapter; spans: NifraSpan[] } {
  const spans: NifraSpan[] = []
  return {
    spans,
    exporter: {
      onStart(span) {
        spans.push(span)
      },
      onEnd() {
        // The span is mutated in-place so it already has endTime etc.
      },
    },
  }
}

describe("agentTelemetry", () => {
  test("creates a span for /_nifra/tool/* requests", async () => {
    const { exporter, spans } = collectingExporter()
    const app = server()
      .use(agentTelemetry({ exporter }))
      .post("/_nifra/tool/get_weather", () => ({ temp: 22 }))

    const res = await app.fetch(
      new Request("http://localhost/_nifra/tool/get_weather", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ location: "Paris" }),
      }),
    )

    expect(res.status).toBe(200)
    // Spans end when the response body finishes streaming — consume it first.
    await res.json()
    expect(spans.length).toBe(1)

    const span = spans[0]!
    expect(span.name).toBe("tool:get_weather")
    expect(span.status).toBe("ok")
    expect(span.durationMs).toBeDefined()
    expect(span.attributes["tool.name"]).toBe("get_weather")
    expect(span.attributes["tool.output_bytes"]).toBeDefined()
  })

  test("does NOT create a span for regular routes", async () => {
    const { exporter, spans } = collectingExporter()
    const app = server()
      .use(agentTelemetry({ exporter }))
      .get("/api/users", () => [{ name: "Ada" }])

    await app.fetch(new Request("http://localhost/api/users"))
    expect(spans.length).toBe(0)
  })

  test("marks span as error when handler throws", async () => {
    const { exporter, spans } = collectingExporter()
    const app = server()
      .use(agentTelemetry({ exporter }))
      .post("/_nifra/tool/broken", () => {
        throw new Error("boom")
      })

    const res = await app.fetch(
      new Request("http://localhost/_nifra/tool/broken", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    )

    expect(res.status).toBe(500)
    await res.text()
    expect(spans.length).toBe(1)

    const span = spans[0]!
    expect(span.status).toBe("error")
    expect(span.attributes["error.recorded"]).toBe(true)
    expect(span.attributes["error.message"]).toBeUndefined()
  })

  test("creates a child of the active Nifra trace", async () => {
    const { exporter, spans } = collectingExporter()
    const app = server()
      .use(tracing({ exporter: { onEnd() {} } }))
      .use(agentTelemetry({ exporter }))
      .get("/_nifra/tool/child", (context) => ({ trace: context.trace }))

    const response = await app.fetch(new Request("http://localhost/_nifra/tool/child"))
    const body = (await response.json()) as { trace: { traceId: string; spanId: string } }

    expect(spans[0]?.traceId).toBe(body.trace.traceId)
    expect(spans[0]?.parentSpanId).toBe(body.trace.spanId)
  })

  test("uses final response status for returned, set, and thrown responses", async () => {
    const { exporter, spans } = collectingExporter()
    const app = server()
      .use(agentTelemetry({ exporter }))
      .get("/_nifra/tool/returned", () => new Response("bad", { status: 503 }))
      .get("/_nifra/tool/set", (context) => {
        context.set.status = 502
        return { bad: true }
      })
      .get("/_nifra/tool/thrown", () => {
        throw new Response("missing", { status: 404 })
      })

    for (const path of ["returned", "set", "thrown"]) {
      const response = await app.fetch(new Request(`http://localhost/_nifra/tool/${path}`))
      await response.text()
    }

    expect(spans.map((span) => span.attributes["http.response.status_code"])).toEqual([
      503, 502, 404,
    ])
    expect(spans.map((span) => span.status)).toEqual(["error", "error", "ok"])
    expect(spans.every((span) => span.endTime !== undefined)).toBe(true)
  })

  test("exporter failures never change the response", async () => {
    const app = server()
      .use(
        agentTelemetry({
          exporter: {
            onStart() {
              throw new Error("start")
            },
            onEnd() {
              throw new Error("end")
            },
          },
        }),
      )
      .get("/_nifra/tool/safe", () => "ok")

    const response = await app.fetch(new Request("http://localhost/_nifra/tool/safe"))
    expect(response.status).toBe(200)
    expect(await response.json()).toBe("ok")
  })

  test("traces the MCP endpoint and records input bytes", async () => {
    const { exporter, spans } = collectingExporter()
    const app = server()
      .use(agentTelemetry({ exporter }))
      .post("/mcp", () => ({ ok: true }))

    const body = JSON.stringify({ method: "tools/call" })
    await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(body.length) },
        body,
      }),
    )

    expect(spans.length).toBe(1)
    expect(spans[0]!.name).toBe("tool:mcp")
    expect(spans[0]!.attributes["tool.name"]).toBe("mcp")
    expect(spans[0]!.attributes["tool.input_bytes"]).toBe(body.length)
  })

  test("adopts an inbound traceparent when no request observation exists", async () => {
    const { exporter, spans } = collectingExporter()
    const app = server()
      .use(agentTelemetry({ exporter }))
      .get("/_nifra/tool/linked", () => "ok")

    await app.fetch(
      new Request("http://localhost/_nifra/tool/linked", {
        headers: { traceparent: "00-0123456789abcdef0123456789abcdef-0011223344556677-01" },
      }),
    )

    expect(spans.length).toBe(1)
    expect(spans[0]!.traceId).toBe("0123456789abcdef0123456789abcdef")
    expect(spans[0]!.parentSpanId).toBe("0011223344556677")
  })

  test("counts streamed response bytes when content-length is absent", async () => {
    const { exporter, spans } = collectingExporter()
    const chunks = [new TextEncoder().encode("hello "), new TextEncoder().encode("world")]
    const app = server()
      .use(agentTelemetry({ exporter }))
      .get(
        "/_nifra/tool/stream",
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                for (const chunk of chunks) controller.enqueue(chunk)
                controller.close()
              },
            }),
          ),
      )

    const response = await app.fetch(new Request("http://localhost/_nifra/tool/stream"))
    expect(response.headers.get("content-length")).toBeNull()
    expect(await response.text()).toBe("hello world")

    expect(spans.length).toBe(1)
    expect(spans[0]!.attributes["tool.output_bytes"]).toBe(11)
    expect(spans[0]!.endTime).toBeDefined()
  })

  test("ends the span with a partial byte count when a streamed body is cancelled", async () => {
    const { exporter, spans } = collectingExporter()
    const app = server()
      .use(agentTelemetry({ exporter }))
      .get(
        "/_nifra/tool/abandoned",
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.enqueue(new TextEncoder().encode("chunk"))
              },
            }),
          ),
      )

    const response = await app.fetch(new Request("http://localhost/_nifra/tool/abandoned"))
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel()

    expect(spans.length).toBe(1)
    expect(spans[0]!.endTime).toBeDefined()
    expect(spans[0]!.attributes["tool.output_bytes"]).toBe(5)
  })

  test("supports custom toolPathPrefix", async () => {
    const { exporter, spans } = collectingExporter()
    const app = server()
      .use(agentTelemetry({ exporter, toolPathPrefix: "/tools/" }))
      .get("/tools/ping", () => "pong")

    await app.fetch(new Request("http://localhost/tools/ping"))
    expect(spans.length).toBe(1)
    expect(spans[0]!.name).toBe("tool:ping")
  })
})

describe("consoleAgentExporter", () => {
  test("formats output correctly", () => {
    const lines: string[] = []
    const exporter = consoleAgentExporter((l) => lines.push(l))

    exporter.onEnd({
      traceId: "abc",
      spanId: "def",
      sampled: true,
      name: "tool:test",
      startTime: 1000,
      endTime: 1042,
      durationMs: 42,
      status: "ok",
      attributes: { "tool.name": "test", "tool.input_bytes": 100, "tool.output_bytes": 250 },
    })

    expect(lines.length).toBe(1)
    expect(lines[0]).toContain("[agent]")
    expect(lines[0]).toContain("tool:test")
    expect(lines[0]).toContain("42ms")
    expect(lines[0]).toContain("ok")
    expect(lines[0]).toContain("input: 100B")
    expect(lines[0]).toContain("output: 250B")
  })

  test("uses console.log by default", () => {
    const original = console.log
    const lines: string[] = []
    console.log = (line) => lines.push(String(line))
    try {
      consoleAgentExporter().onEnd({
        traceId: "abc",
        spanId: "def",
        sampled: true,
        name: "tool:default",
        startTime: 1,
        status: "ok",
        attributes: {},
      })
    } finally {
      console.log = original
    }
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("tool:default")
  })
})

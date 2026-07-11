import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { type NifraSpan, tracing } from "@nifrajs/otel"
import { devtools, devtoolsClientScript } from "../src/index.ts"

describe("devtools server middleware", () => {
  test("captures events and streams via SSE", async () => {
    const app = server()
      .use(devtools({ enabled: true, maxEvents: 10 }))
      .get("/api/ping", () => "pong")

    // 1. Make a regular request (should be captured)
    const req1 = new Request("http://localhost/api/ping")
    const res1 = await app.fetch(req1)
    expect(res1.status).toBe(200)

    // 2. Make an SSE request to devtools endpoint
    const sseReq = new Request("http://localhost/_nifra/devtools")
    const sseRes = await app.fetch(sseReq)
    expect(sseRes.status).toBe(200)
    expect(sseRes.headers.get("content-type")).toBe("text/event-stream")
    expect(sseRes.headers.get("x-nifra-devtools")).toBe("true")

    // 3. Read the stream to verify the buffered event is sent
    const reader = sseRes.body!.getReader()
    const { value } = await reader.read()

    const text = new TextDecoder().decode(value)
    expect(text).toContain("data: {")
    expect(text).toContain('"method":"GET"')
    expect(text).toContain('"path":"/api/ping"')
    expect(text).toContain('"status":200')

    // Clean up
    await reader.cancel()
  })

  test("adapts the same request span when tracing is already installed", async () => {
    const spans: NifraSpan[] = []
    const app = server()
      .use(tracing({ exporter: { onEnd: (span) => spans.push(span) } }))
      .use(devtools({ enabled: true }))
      .get("/shared", () => "ok")

    await app.fetch(new Request("http://localhost/shared"))
    const stream = await app.fetch(new Request("http://localhost/_nifra/devtools"))
    const reader = stream.body!.getReader()
    const { value } = await reader.read()
    await reader.cancel()
    const payload = new TextDecoder()
      .decode(value)
      .replace(/^data: /, "")
      .trim()
    const event = JSON.parse(payload) as { traceId: string; spanId: string }

    expect(spans).toHaveLength(1)
    expect(event.traceId).toBe(spans[0]!.traceId)
    expect(event.spanId).toBe(spans[0]!.spanId)
  })

  test("does not trace the devtools endpoint itself", async () => {
    const app = server().use(devtools({ enabled: true }))

    // The devtools endpoint itself shouldn't trigger an onResponse trace.
    const sseReq1 = new Request("http://localhost/_nifra/devtools")
    const sseRes1 = await app.fetch(sseReq1)
    const reader1 = sseRes1.body!.getReader()

    // We expect no events to be yielded.
    const timeout = new Promise((resolve) => setTimeout(() => resolve("TIMEOUT"), 100))
    const result = await Promise.race([reader1.read(), timeout])

    expect(result).toBe("TIMEOUT")
    await reader1.cancel()
  })

  test("trims the ring buffer to maxEvents", async () => {
    const app = server()
      .use(devtools({ enabled: true, maxEvents: 2 }))
      .get("/api/:n", () => "ok")

    for (const n of [1, 2, 3]) {
      await app.fetch(new Request(`http://localhost/api/${n}`))
    }

    const sse = await app.fetch(new Request("http://localhost/_nifra/devtools"))
    const reader = sse.body!.getReader()
    const decoder = new TextDecoder()
    let text = ""
    // The buffer is replayed as one chunk per event; drain both buffered events.
    while (!text.includes('"path":"/api/3"')) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    await reader.cancel()

    expect(text).not.toContain('"path":"/api/1"')
    expect(text).toContain('"path":"/api/2"')
    expect(text).toContain('"path":"/api/3"')
  })

  test("sends keep-alive ping frames while a stream is open", async () => {
    const app = server().use(devtools({ enabled: true, pingIntervalMs: 5 }))
    const sse = await app.fetch(new Request("http://localhost/_nifra/devtools"))
    const reader = sse.body!.getReader()

    const { value } = await reader.read()
    await reader.cancel()

    expect(new TextDecoder().decode(value)).toContain(": ping")
  })

  test("removes cancelled clients and enforces the connection cap", async () => {
    const app = server().use(devtools({ enabled: true, maxConnections: 1 }))
    const first = await app.fetch(new Request("http://localhost/_nifra/devtools"))
    expect(first.status).toBe(200)

    const blocked = await app.fetch(new Request("http://localhost/_nifra/devtools"))
    expect(blocked.status).toBe(503)

    await first.body?.cancel()
    const reconnected = await app.fetch(new Request("http://localhost/_nifra/devtools"))
    expect(reconnected.status).toBe(200)
    await reconnected.body?.cancel()
  })

  test("is disabled explicitly and rejects remote, cross-origin, and unauthorized streams", async () => {
    const disabled = server().use(devtools({ enabled: false }))
    expect((await disabled.fetch(new Request("http://localhost/_nifra/devtools"))).status).toBe(404)

    const protectedApp = server().use(
      devtools({
        enabled: true,
        authorize: (request) => request.headers.get("authorization") === "Bearer dev",
      }),
    )
    expect(
      (await protectedApp.fetch(new Request("http://example.com/_nifra/devtools"))).status,
    ).toBe(403)
    expect(
      (
        await protectedApp.fetch(
          new Request("http://localhost/_nifra/devtools", {
            headers: { origin: "https://evil.example" },
          }),
        )
      ).status,
    ).toBe(403)
    expect((await protectedApp.fetch(new Request("http://localhost/_nifra/devtools"))).status).toBe(
      401,
    )
  })
})

describe("devtoolsClientScript", () => {
  test("returns non-empty client script", () => {
    const script = devtoolsClientScript()
    expect(typeof script).toBe("string")
    expect(script.length).toBeGreaterThan(100)
    expect(script).toContain('EventSource("/_nifra/devtools")')
    expect(script).toContain("nifra-devtools")
  })

  test("uses a configured endpoint", () => {
    expect(devtoolsClientScript({ path: "/internal/events" })).toContain(
      'EventSource("/internal/events")',
    )
  })
})

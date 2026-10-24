import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { type NifraSpan, tracing } from "@nifrajs/otel"
import { Window } from "happy-dom"
import {
  type DevToolsEvent,
  devtools,
  devtoolsClientScript,
  filterDevToolsEvents,
} from "../src/index.ts"

describe("devtools server middleware", () => {
  test("never touches a bare `process` global (Workers without nodejs_compat)", async () => {
    const source = await Bun.file(new URL("../src/index.ts", import.meta.url)).text()
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join("\n")
    expect(code).not.toMatch(/(?<![.\w])process\./)
  })

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

  test("bounds unread connection bytes and releases its slot when live events overflow", async () => {
    const app = server()
      .use(devtools({ enabled: true, maxEvents: 3, maxConnections: 1, maxPendingBytes: 1024 }))
      .get("/ping", () => "ok")
    const response = await app.fetch(new Request("http://localhost/_nifra/devtools"))
    for (let index = 0; index < 20; index++) await app.fetch(new Request("http://localhost/ping"))

    const reader = response.body!.getReader()
    let bytes = 0
    let queuedEvents = 0
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      queuedEvents++
    }
    expect(bytes).toBeLessThanOrEqual(1024)
    expect(queuedEvents).toBeGreaterThan(0)
    expect(queuedEvents).toBeLessThan(20)

    const snapshot = await app.fetch(new Request("http://localhost/_nifra/devtools/state"))
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: This response comes from the local DevTools fixture's /state endpoint, which emits the known { events } envelope.
    expect(((await snapshot.json()) as { events: unknown[] }).events).toHaveLength(3)
    const reconnected = await app.fetch(new Request("http://localhost/_nifra/devtools"))
    expect(reconnected.status).toBe(200)
    await reconnected.body?.cancel()
  })

  test("initial history sends the newest suffix that fits without closing the connection", async () => {
    const app = server()
      .use(devtools({ enabled: true, maxEvents: 20, maxConnections: 1, maxPendingBytes: 1024 }))
      .get("/ping/:id", () => "ok")
    for (let index = 0; index < 20; index++)
      await app.fetch(new Request(`http://localhost/ping/${index}`))
    const response = await app.fetch(new Request("http://localhost/_nifra/devtools"))
    const reader = response.body!.getReader()
    let text = ""
    while (!text.includes('"path":"/ping/19"')) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += new TextDecoder().decode(chunk.value)
    }
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(1024)
    expect(text).not.toContain('"path":"/ping/0"')
    expect(text).toContain('"path":"/ping/19"')
    expect((await app.fetch(new Request("http://localhost/_nifra/devtools"))).status).toBe(503)
    await reader.cancel()
  })

  test("an oversized event closes a viewer without queuing the frame", async () => {
    const app = server()
      .use(devtools({ enabled: true, maxConnections: 1, maxPendingBytes: 1024 }))
      .get("/ping/:id", () => "ok")
    const response = await app.fetch(new Request("http://localhost/_nifra/devtools"))
    await app.fetch(new Request(`http://localhost/ping/${"x".repeat(2_000)}`))
    expect((await response.body!.getReader().read()).done).toBe(true)
    const reconnected = await app.fetch(new Request("http://localhost/_nifra/devtools"))
    expect(reconnected.status).toBe(200)
    await reconnected.body?.cancel()
  })

  test("keep-alive frames obey the pending budget too", async () => {
    const app = server().use(devtools({ enabled: true, maxPendingBytes: 8, pingIntervalMs: 2 }))
    const response = await app.fetch(new Request("http://localhost/_nifra/devtools"))
    await Bun.sleep(30)
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(": ping\n\n")
    expect((await reader.read()).done).toBe(true)
  })

  test("rejects non-finite and fractional pending byte budgets", () => {
    for (const maxPendingBytes of [0, -1, 0.5, Number.NaN, Infinity])
      expect(() => devtools({ maxPendingBytes })).toThrow(/positive safe integer/)
  })

  test("uses the socket peer for loopback access when the platform supplies one", async () => {
    const app = server().use(devtools({ enabled: true }))
    const remoteWithForgedHost = await app.fetch(new Request("http://localhost/_nifra/devtools"), {
      clientIp: "203.0.113.5",
    })
    expect(remoteWithForgedHost.status).toBe(403)

    const loopback = await app.fetch(new Request("http://localhost/_nifra/devtools"), {
      clientIp: "127.0.0.1",
    })
    expect(loopback.status).toBe(200)
    await loopback.body?.cancel()

    const mappedLoopback = await app.fetch(new Request("http://127.0.0.1/_nifra/devtools"), {
      clientIp: "[::ffff:127.0.0.1%lo0]",
    })
    expect(mappedLoopback.status).toBe(200)
    await mappedLoopback.body?.cancel()

    // A DNS-rebound page: the peer is this machine, but Host and Origin name the attacker's domain.
    for (const path of ["/_nifra/devtools", "/_nifra/devtools/state"]) {
      const rebound = await app.fetch(
        new Request(`http://attacker.example:3000${path}`, {
          headers: { origin: "http://attacker.example:3000" },
        }),
        { clientIp: "127.0.0.1" },
      )
      expect(rebound.status).toBe(403)
    }

    const remoteAllowed = server().use(devtools({ enabled: true, allowRemote: true }))
    const proxied = await remoteAllowed.fetch(new Request("http://example.com/_nifra/devtools"), {
      clientIp: "127.0.0.1",
    })
    expect(proxied.status).toBe(200)
    await proxied.body?.cancel()

    const edgeFallback = await app.fetch(new Request("http://localhost/_nifra/devtools"))
    expect(edgeFallback.status).toBe(200)
    await edgeFallback.body?.cancel()
  })
})

describe("devtoolsClientScript", () => {
  test("lists a keepAlive app's kept pages while open, and shows nothing without one", async () => {
    const window = new Window()
    let tick = (): void => {}
    const pages: unknown[] = []
    // The overlay as a page runs it, with the clock and the stream handed in.
    new Function("window", "document", "EventSource", "setInterval", devtoolsClientScript())(
      window,
      window.document,
      class {
        onmessage = null
      },
      (run: () => void) => {
        tick = run
        return 0
      },
    )
    const panel = window.document.getElementById("nifra-devtools")
    const kept = (): string[] =>
      [...(panel?.querySelectorAll("div > div > div") ?? [])]
        .filter((row) => row.children.length === 4)
        .map((row) => [...row.children].map((cell) => cell.textContent).join(" | "))
    panel?.lastElementChild?.dispatchEvent(new window.Event("click"))
    expect(kept()).toEqual([])
    Reflect.set(window, "__nifraKeepAlive", { pages: () => pages })
    pages.push({ instance: "k1", path: "/list/1", routeId: "list", hiddenFor: 12_400, nodes: 31 })
    pages.push({
      instance: "k2",
      path: "/list/2",
      routeId: "list",
      hiddenFor: 900,
      nodes: undefined,
    })
    tick()
    expect(kept()).toEqual([
      "/list/1 | k1 | hidden 12 s | 31 nodes",
      "/list/2 | k2 | hidden 1 s | -",
    ])
    expect(panel?.textContent).toContain("Kept pages (2)")
    await window.happyDOM.close()
  })

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

const fixture = (path: string, id: string): DevToolsEvent => ({
  id,
  traceId: id,
  spanId: id,
  timestamp: 0,
  method: "GET",
  path,
  status: 200,
  durationMs: 1,
  bodyBytes: 0,
})

describe("filterDevToolsEvents", () => {
  const events = [fixture("/api/a", "1"), fixture("/api/b", "2"), fixture("/api/a/x", "3")]

  test("no query returns a copy of every event", () => {
    const out = filterDevToolsEvents(events)
    expect(out.map((e) => e.id)).toEqual(["1", "2", "3"])
    expect(out).not.toBe(events) // a copy, never the live buffer
  })

  test("filters by path prefix", () => {
    expect(filterDevToolsEvents(events, { path: "/api/a" }).map((e) => e.id)).toEqual(["1", "3"])
    expect(filterDevToolsEvents(events, { path: "/nope" })).toEqual([])
  })

  test("limits to the most recent N, clamping 0 and over-large limits", () => {
    expect(filterDevToolsEvents(events, { limit: 2 }).map((e) => e.id)).toEqual(["2", "3"])
    expect(filterDevToolsEvents(events, { limit: 0 })).toEqual([]) // NOT the whole array
    expect(filterDevToolsEvents(events, { limit: 99 }).map((e) => e.id)).toEqual(["1", "2", "3"])
  })

  test("applies the path filter before the limit", () => {
    expect(filterDevToolsEvents(events, { path: "/api/a", limit: 1 }).map((e) => e.id)).toEqual([
      "3",
    ])
  })
})

describe("devtools /state snapshot", () => {
  test("serves recent traces as filtered JSON, guarded like the stream", async () => {
    const app = server()
      .use(devtools({ enabled: true }))
      .get("/api/ping", () => "pong")
      .get("/api/pong", () => "ping")
    await app.fetch(new Request("http://localhost/api/ping"))
    await app.fetch(new Request("http://localhost/api/pong"))
    await app.fetch(new Request("http://localhost/api/ping"))

    const snapshot = async (query = ""): Promise<{ events: DevToolsEvent[] }> => {
      const res = await app.fetch(new Request(`http://localhost/_nifra/devtools/state${query}`))
      return (await res.json()) as { events: DevToolsEvent[] }
    }

    const all = await snapshot()
    expect(all.events.map((e) => e.path)).toEqual(["/api/ping", "/api/pong", "/api/ping"])
    expect(
      all.events.every((e) => typeof e.status === "number" && typeof e.durationMs === "number"),
    ).toBe(true)

    expect((await snapshot("?path=/api/ping")).events.map((e) => e.path)).toEqual([
      "/api/ping",
      "/api/ping",
    ])
    expect((await snapshot("?limit=1")).events).toHaveLength(1)

    // Correct JSON content type + no-store, and NOT an event stream.
    const res = await app.fetch(new Request("http://localhost/_nifra/devtools/state"))
    expect(res.headers.get("content-type")).toContain("application/json")
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(res.headers.get("x-nifra-devtools")).toBe("true")

    // The snapshot exposes the same data as the stream, so it shares the guard: a cross-origin read is refused.
    const crossOrigin = await app.fetch(
      new Request("http://localhost/_nifra/devtools/state", {
        headers: { origin: "https://evil.example" },
      }),
    )
    expect(crossOrigin.status).toBe(403)
  })
})

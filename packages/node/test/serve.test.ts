import { afterEach, expect, test } from "bun:test"
import { ServerResponse as NodeServerResponse } from "node:http"
import { connect } from "node:net"
import type { StandardResult, StandardSchemaV1, StandardTypes } from "@nifrajs/core"
import { server } from "@nifrajs/core"
import { type NodeServer, serve } from "../src/index.ts"

let running: NodeServer | undefined
afterEach(async () => {
  await running?.stop({ drainMs: 0 })
  running = undefined
})

/** A minimal Standard Schema for the body-cap tests (hand-rolled — no lib dependency). */
const nameBody: StandardSchemaV1<unknown, { name: string }> = {
  "~standard": {
    version: 1,
    vendor: "nifra-test",
    validate: (v): StandardResult<{ name: string }> =>
      typeof v === "object" && v !== null && "name" in v && typeof v.name === "string"
        ? { value: { name: v.name } }
        : { issues: [{ message: "name must be a string" }] },
    types: undefined as unknown as StandardTypes<unknown, { name: string }>,
  },
}

function demoApp() {
  return server()
    .get("/users/:id", (c) => ({ id: c.params.id }))
    .post("/echo", (c) => c.req.json())
    .get("/empty", (c) => {
      c.set.status = 204
      return undefined
    })
    .get("/cookies", (c) => {
      c.set.cookie("sid", "a")
      c.set.cookie("csrf", "b")
      return { ok: true }
    })
    .get("/redirect", () => new Response(null, { status: 302, headers: { location: "/dest" } }))
    .get(
      "/stream",
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const enc = new TextEncoder()
              controller.enqueue(enc.encode("chunk-"))
              controller.enqueue(enc.encode("data"))
              controller.close()
            },
          }),
          { headers: { "content-type": "text/plain" } },
        ),
    )
}

test("serves GET (JSON) + POST (body), resolves the bound port", async () => {
  running = await serve(demoApp(), { port: 0 })
  expect(running.port).toBeGreaterThan(0)
  const base = `http://localhost:${running.port}`

  expect(await (await fetch(`${base}/users/42`)).json()).toEqual({ id: "42" })

  const echoed = await fetch(`${base}/echo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hi: "there" }),
  })
  expect(await echoed.json()).toEqual({ hi: "there" })
})

test("emits multiple Set-Cookie headers as separate lines (not comma-joined)", async () => {
  // `Headers.forEach` joins repeated headers with ", "; for Set-Cookie that's wrong (a cookie's
  // `Expires` contains a comma). The adapter must split them via `getSetCookie()` — so a response
  // that sets a session + a CSRF cookie arrives as two distinct header lines.
  running = await serve(demoApp(), { port: 0 })
  const res = await fetch(`http://localhost:${running.port}/cookies`)
  await res.text()
  const cookies = res.headers.getSetCookie()
  expect(cookies).toHaveLength(2)
  expect(cookies.some((c) => c.startsWith("sid=a"))).toBe(true)
  expect(cookies.some((c) => c.startsWith("csrf=b"))).toBe(true)
})

test("JSON responses carry the application/json content-type (node-direct fast path)", async () => {
  // A nifra app exposes `resolveNode`, so a plain-data result is serialized straight to the socket
  // (no undici Response). The wire bytes must still match: a JSON Content-Type + the JSON body.
  running = await serve(demoApp(), { port: 0 })
  const res = await fetch(`http://localhost:${running.port}/users/7`)
  expect(res.headers.get("content-type")).toContain("application/json")
  expect(await res.json()).toEqual({ id: "7" })
})

test("a handler-returned Response (redirect) round-trips via the response fallback", async () => {
  // Not the JSON fast path — `resolveNode` returns `{ kind: "response" }`, which the adapter writes
  // the usual Web way (status + headers preserved).
  running = await serve(demoApp(), { port: 0 })
  const res = await fetch(`http://localhost:${running.port}/redirect`, { redirect: "manual" })
  expect(res.status).toBe(302)
  expect(res.headers.get("location")).toBe("/dest")
})

test("a streaming Response body is written through chunk-by-chunk", async () => {
  running = await serve(demoApp(), { port: 0 })
  const res = await fetch(`http://localhost:${running.port}/stream`)
  expect(res.headers.get("content-type")).toBe("text/plain")
  expect(await res.text()).toBe("chunk-data")
})

test("writes marked buffered response bodies directly without draining the Web stream", async () => {
  const nodeBody = Symbol.for("nifra.response.body")
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("stream should not be read"))
      },
    }),
    { headers: { "content-type": "text/html; charset=utf-8" } },
  )
  Object.defineProperty(response, nodeBody, { value: "<h1>fast html</h1>" })
  running = await serve({ fetch: () => response }, { port: 0 })

  const res = await fetch(`http://localhost:${running.port}/`)
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8")
  expect(await res.text()).toBe("<h1>fast html</h1>")
})

test("writes node-direct buffered body outcomes with headers and cookies", async () => {
  const app = {
    fetch: () => {
      throw new Error("fetch fallback should not run")
    },
    resolveNodeSource: () => ({
      kind: "body" as const,
      status: 203,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": ["sid=a; Path=/", "csrf=b; Path=/"],
        "x-fast": "body",
      },
      body: "<h1>node-direct</h1>",
    }),
  }
  running = await serve(app, { port: 0 })

  const res = await fetch(`http://localhost:${running.port}/`)
  expect(res.status).toBe(203)
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8")
  expect(res.headers.get("x-fast")).toBe("body")
  expect(res.headers.getSetCookie()).toEqual(["sid=a; Path=/", "csrf=b; Path=/"])
  expect(await res.text()).toBe("<h1>node-direct</h1>")
})

test("waits for Node drain when the socket applies response backpressure", async () => {
  const originalWrite = NodeServerResponse.prototype.write
  let forcedBackpressure = false
  NodeServerResponse.prototype.write = function (
    this: NodeServerResponse,
    ...args: Parameters<typeof originalWrite>
  ): boolean {
    const wrote = originalWrite.apply(this, args)
    if (!forcedBackpressure) {
      forcedBackpressure = true
      queueMicrotask(() => this.emit("drain"))
      return false
    }
    return wrote
  } as typeof originalWrite
  try {
    const app = server().get(
      "/backpressure",
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const enc = new TextEncoder()
              controller.enqueue(enc.encode("first-"))
              controller.enqueue(enc.encode("second"))
              controller.close()
            },
          }),
        ),
    )
    running = await serve(app, { port: 0 })
    const res = await fetch(`http://localhost:${running.port}/backpressure`)
    expect(await res.text()).toBe("first-second")
    expect(forcedBackpressure).toBe(true)
  } finally {
    NodeServerResponse.prototype.write = originalWrite
  }
})

test("cancels the Web response body when the Node socket closes under backpressure", async () => {
  const originalWrite = NodeServerResponse.prototype.write
  let forcedClose = false
  let cancelled = false
  NodeServerResponse.prototype.write = function (
    this: NodeServerResponse,
    ...args: Parameters<typeof originalWrite>
  ): boolean {
    const wrote = originalWrite.apply(this, args)
    if (!forcedClose) {
      forcedClose = true
      queueMicrotask(() => {
        this.emit("error", new Error("forced write failure"))
        this.destroy()
      })
      return false
    }
    return wrote
  } as typeof originalWrite
  try {
    const app = server().get(
      "/disconnect",
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("partial"))
            },
            cancel() {
              cancelled = true
            },
          }),
        ),
    )
    running = await serve(app, { port: 0 })
    await fetch(`http://localhost:${running.port}/disconnect`)
      .then((res) => res.text())
      .catch(() => undefined)
    for (let i = 0; i < 20 && !cancelled; i++) await Bun.sleep(5)
    expect(forcedClose).toBe(true)
    expect(cancelled).toBe(true)
  } finally {
    NodeServerResponse.prototype.write = originalWrite
  }
})

test("cancels the Web response body on a clean close while waiting for drain", async () => {
  const originalWrite = NodeServerResponse.prototype.write
  let forcedClose = false
  let cancelled = false
  NodeServerResponse.prototype.write = function (
    this: NodeServerResponse,
    ...args: Parameters<typeof originalWrite>
  ): boolean {
    const wrote = originalWrite.apply(this, args)
    if (!forcedClose) {
      forcedClose = true
      queueMicrotask(() => {
        this.emit("close")
        this.destroy()
      })
      return false
    }
    return wrote
  } as typeof originalWrite
  try {
    const app = server().get(
      "/close",
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("partial"))
            },
            cancel() {
              cancelled = true
            },
          }),
        ),
    )
    running = await serve(app, { port: 0 })
    await fetch(`http://localhost:${running.port}/close`)
      .then((res) => res.text())
      .catch(() => undefined)
    for (let i = 0; i < 20 && !cancelled; i++) await Bun.sleep(5)
    expect(forcedClose).toBe(true)
    expect(cancelled).toBe(true)
  } finally {
    NodeServerResponse.prototype.write = originalWrite
  }
})

test("cancels the Web response body if the socket closes before waiting for drain", async () => {
  const originalWrite = NodeServerResponse.prototype.write
  let forcedClose = false
  let cancelled = false
  NodeServerResponse.prototype.write = function (
    this: NodeServerResponse,
    ...args: Parameters<typeof originalWrite>
  ): boolean {
    const wrote = originalWrite.apply(this, args)
    if (!forcedClose) {
      forcedClose = true
      this.destroy()
      return false
    }
    return wrote
  } as typeof originalWrite
  try {
    const app = server().get(
      "/already-closed",
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("partial"))
            },
            cancel() {
              cancelled = true
            },
          }),
        ),
    )
    running = await serve(app, { port: 0 })
    await Promise.race([
      fetch(`http://localhost:${running.port}/already-closed`)
        .then((res) => res.text())
        .catch(() => undefined),
      Bun.sleep(500).then(() => {
        throw new Error("fetch hung after socket close")
      }),
    ])
    for (let i = 0; i < 20 && !cancelled; i++) await Bun.sleep(5)
    expect(forcedClose).toBe(true)
    expect(cancelled).toBe(true)
  } finally {
    NodeServerResponse.prototype.write = originalWrite
  }
})

test("a plain { fetch } handler (no resolveNode) still works via the Web path", async () => {
  // Backward-compat: the adapter bridges *any* Web-fetch handler, not only nifra apps. Without a
  // `resolveNode` seam it falls back to `app.fetch` + the Response writer.
  running = await serve({ fetch: async () => Response.json({ plain: true }) }, { port: 0 })
  const res = await fetch(`http://localhost:${running.port}/`)
  expect(await res.json()).toEqual({ plain: true })
})

test("constructs Request.url with an explicitly configured public protocol", async () => {
  const app = server().get("/url", (c) => ({
    url: c.req.url,
    protocol: new URL(c.req.url).protocol,
  }))
  running = await serve(app, { port: 0, protocol: "https" })

  const res = await fetch(`http://localhost:${running.port}/url?x=1`)
  const body = (await res.json()) as { url: string; protocol: string }
  expect(body.protocol).toBe("https:")
  expect(body.url).toBe(`https://localhost:${running.port}/url?x=1`)
})

test("does not trust forwarded protocol headers unless configured by the host", async () => {
  const app = server().get("/url", (c) => ({ url: c.req.url }))
  running = await serve(app, { port: 0 })

  const res = await fetch(`http://localhost:${running.port}/url`, {
    headers: { "x-forwarded-proto": "https" },
  })
  expect(await res.json()).toEqual({ url: `http://localhost:${running.port}/url` })
})

test("plain fetch handlers also receive the configured protocol", async () => {
  running = await serve(
    { fetch: (req) => Response.json({ url: req.url }) },
    { port: 0, protocol: () => "https" },
  )

  const res = await fetch(`http://localhost:${running.port}/plain`)
  expect(await res.json()).toEqual({ url: `https://localhost:${running.port}/plain` })
})

test("rejects invalid node adapter protocol configuration", () => {
  expect(() => serve(demoApp(), { port: 0, protocol: "ftp" as unknown as "http" })).toThrow(
    /protocol/,
  )
})

test("a throwing resolveNode yields a flat 500 (no leak)", async () => {
  // `resolveNode` is the trusted seam, but the adapter still guards it: a throw never leaks a stack.
  const fastThrow = {
    resolveNode: (): Promise<never> => {
      throw new Error("boom")
    },
    fetch: (): Promise<Response> => Promise.resolve(new Response()),
  }
  running = await serve(fastThrow, { port: 0 })
  const res = await fetch(`http://localhost:${running.port}/`)
  expect(res.status).toBe(500)
  expect(await res.json()).toEqual({ ok: false, error: "internal_error" })
})

test("a resolveNodeSource whose promise REJECTS (async) yields a flat 500 (no stack leak)", async () => {
  // The node-direct seam should never reject — nifra catches internally and renders a 500 outcome — but
  // the adapter still guards it: an async rejection maps to the flat 500, never a leaked stack/detail.
  const asyncReject = {
    resolveNodeSource: (): Promise<never> => Promise.reject(new Error("boom secret detail")),
    fetch: (): Promise<Response> => Promise.resolve(new Response()),
  }
  running = await serve(asyncReject, { port: 0 })
  const res = await fetch(`http://localhost:${running.port}/`)
  expect(res.status).toBe(500)
  const body = await res.text()
  expect(JSON.parse(body)).toEqual({ ok: false, error: "internal_error" })
  expect(body).not.toContain("secret detail") // the rejection reason must never reach the wire
})

test("a resolveNodeSource that THROWS (sync) yields a flat 500 (no stack leak)", async () => {
  // Same guard, synchronous throw: caught by the fast-path try/catch, mapped to a flat 500.
  const syncThrow = {
    resolveNodeSource: (): Promise<never> => {
      throw new Error("boom secret detail")
    },
    fetch: (): Promise<Response> => Promise.resolve(new Response()),
  }
  running = await serve(syncThrow, { port: 0 })
  const res = await fetch(`http://localhost:${running.port}/`)
  expect(res.status).toBe(500)
  expect(await res.text()).not.toContain("secret detail")
})

test("a resolveNode (Web seam) whose promise REJECTS (async) yields a flat 500 (no stack leak)", async () => {
  // Same guard on the non-fast Web seam: an async rejection from resolveNode is a flat 500.
  const asyncReject = {
    resolveNode: (): Promise<never> => Promise.reject(new Error("boom secret detail")),
    fetch: (): Promise<Response> => Promise.resolve(new Response()),
  }
  running = await serve(asyncReject, { port: 0 })
  const res = await fetch(`http://localhost:${running.port}/`)
  expect(res.status).toBe(500)
  expect(await res.text()).not.toContain("secret detail")
})

test("a plain { fetch } whose promise REJECTS (async) yields a flat 500 (no stack leak)", async () => {
  // Backward-compat Web path: even a non-nifra handler whose fetch rejects must not leak a stack.
  running = await serve(
    { fetch: (): Promise<Response> => Promise.reject(new Error("boom secret detail")) },
    { port: 0 },
  )
  const res = await fetch(`http://localhost:${running.port}/`)
  expect(res.status).toBe(500)
  const body = await res.text()
  expect(JSON.parse(body)).toEqual({ ok: false, error: "internal_error" })
  expect(body).not.toContain("secret detail")
})

test("passes a 204 (no body) through to Node correctly", async () => {
  running = await serve(demoApp(), { port: 0 })
  const res = await fetch(`http://localhost:${running.port}/empty`)
  expect(res.status).toBe(204)
  expect(await res.text()).toBe("")
})

test("a throwing app yields a flat 500 (no leak)", async () => {
  running = await serve(
    {
      fetch: () => {
        throw new Error("boom")
      },
    },
    { port: 0 },
  )
  const res = await fetch(`http://localhost:${running.port}/`)
  expect(res.status).toBe(500)
  expect(await res.json()).toEqual({ ok: false, error: "internal_error" })
})

test("stop() drains an in-flight request, then is idempotent", async () => {
  const app = server().get("/slow", async () => {
    await Bun.sleep(80)
    return { done: true }
  })
  running = await serve(app, { port: 0 })
  const inflight = fetch(`http://localhost:${running.port}/slow`)
    .then((r) => r.json())
    .catch(() => "ERR")
  await Bun.sleep(20) // ensure the request is in-flight
  await running.stop({ drainMs: 1000 })
  expect(await inflight).toEqual({ done: true })
  await running.stop() // second call is a no-op (idempotent)
})

test("inherits the app-level requestTimeoutMs (503) through app.fetch", async () => {
  // The timeout lives inside app.fetch (not Bun's listen()), so it applies through any
  // adapter that calls app.fetch — no Node-specific timeout wiring needed.
  const app = server({ requestTimeoutMs: 40 }).get("/slow", async () => {
    await Bun.sleep(200)
    return { done: true }
  })
  running = await serve(app, { port: 0 })
  const res = await fetch(`http://localhost:${running.port}/slow`)
  expect(res.status).toBe(503)
  expect(await res.json()).toEqual({ ok: false, error: "request_timeout" })
})

test("signals:true installs SIGTERM/SIGINT handlers that stop the server, then cleans up", async () => {
  const sigtermBefore = process.listenerCount("SIGTERM")
  const sigintBefore = process.listenerCount("SIGINT")
  running = await serve(demoApp(), { port: 0, signals: true })
  expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore + 1)
  expect(process.listenerCount("SIGINT")).toBe(sigintBefore + 1)

  const { port } = running
  // Invoke the registered handler directly — emitting a real signal would kill the test runner.
  const handler = process.listeners("SIGTERM").at(-1) as () => void
  handler()
  await Bun.sleep(20) // let stop() close the listening socket

  await expect(fetch(`http://localhost:${port}/users/1`)).rejects.toThrow()
  // handlers removed — no leak across serve()/stop() cycles
  expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore)
  expect(process.listenerCount("SIGINT")).toBe(sigintBefore)
  running = undefined // already stopped
})

// ── Lazy RequestSource (node-direct fast path) ───────────────────────────────────────────────────
// The adapter hands nifra a lazy `RequestSource` so the undici `Request` is only built when user code
// reads `c.req`. These tests pin the behaviors that change introduced — c.req materialization and,
// critically, that the body-size cap still holds when the body flows through the lazy source.

test("c.req materializes lazily and exposes method/url/headers", async () => {
  const app = server().get("/whoami", (c) => ({
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    ua: c.req.headers.get("x-probe"),
  }))
  running = await serve(app, { port: 0 })
  const res = await fetch(`http://localhost:${running.port}/whoami`, {
    headers: { "x-probe": "hi" },
  })
  expect(await res.json()).toEqual({ method: "GET", path: "/whoami", ua: "hi" })
})

test("c.boundedBody on a GET resolves to an empty body through the lean source", async () => {
  const app = server().get("/empty-body", async (c) => ({
    len: (await c.boundedBody()).byteLength,
  }))
  running = await serve(app, { port: 0 })
  const res = await fetch(`http://localhost:${running.port}/empty-body`)
  expect(await res.json()).toEqual({ len: 0 })
})

test("c.cookies on a GET with no Cookie header stays empty through the lean source", async () => {
  const app = server().get("/no-cookie", (c) => ({
    count: Object.keys(c.cookies).length,
  }))
  running = await serve(app, { port: 0 })
  const res = await fetch(`http://localhost:${running.port}/no-cookie`)
  expect(await res.json()).toEqual({ count: 0 })
})

test("c.boundedBody on a GET honors Content-Length: 0 through the lean source", async () => {
  const app = server().get("/empty-body-length", async (c) => ({
    len: (await c.boundedBody()).byteLength,
  }))
  running = await serve(app, { port: 0 })
  const res = await fetch(`http://localhost:${running.port}/empty-body-length`, {
    headers: { "content-length": "0" },
  })
  expect(await res.json()).toEqual({ len: 0 })
})

test("c.boundedJson on a bodyless GET returns invalid_json through the lean source", async () => {
  const app = server().get("/empty-json", async (c) => {
    await c.boundedJson()
    return { ok: true }
  })
  running = await serve(app, { port: 0 })
  const res = await fetch(`http://localhost:${running.port}/empty-json`, {
    headers: { "content-length": "0" },
  })
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ ok: false, error: "invalid_json" })
})

test("c.req.json() works through the lazy source on a POST", async () => {
  const app = server().post("/echo", (c) => c.req.json())
  running = await serve(app, { port: 0 })
  const res = await fetch(`http://localhost:${running.port}/echo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ a: 1, b: [2, 3] }),
  })
  expect(await res.json()).toEqual({ a: 1, b: [2, 3] })
})

test("a schema-validated body still reaches the handler AND c.req is readable after (one-shot)", async () => {
  // nifra reads + validates the body, then the handler also touches c.req — the lazy source must
  // build a Request whose body is already consumed (no double-read crash), while c.body is intact.
  const app = server().post("/u", { body: nameBody }, (c) => ({
    name: c.body.name,
    method: c.req.method,
  }))
  running = await serve(app, { port: 0 })
  const res = await fetch(`http://localhost:${running.port}/u`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Ada" }),
  })
  expect(await res.json()).toEqual({ name: "Ada", method: "POST" })
})

test("SECURITY: an oversized Content-Length is rejected (413) through the lazy source", async () => {
  // nifra's default cap is 1 MB. A schema route reads the body, so the cap applies — and the lazy
  // source must reject an over-cap Content-Length BEFORE buffering it.
  const app = server().post("/u", { body: nameBody }, (c) => c.body)
  running = await serve(app, { port: 0 })
  const res = await fetch(`http://localhost:${running.port}/u`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "a".repeat(1_100_000) }), // ~1.1 MB > 1 MB cap
  })
  expect(res.status).toBe(413)
})

test("SECURITY: an oversized STREAMED (chunked) body is capped before the handler runs", async () => {
  // No Content-Length → the lazy source exposes the live stream, and nifra's streaming byte-cap must
  // cancel it once over the cap. We assert the SERVER-SIDE property (the handler never sees the
  // oversized body), not the client status: when a server caps + responds mid-upload, the streaming
  // client may observe a reset/odd status — so the reliable signal is that the cap short-circuited
  // *before* validation + the handler. (curl confirms the server stops reading at ~1 MB, not 2 MB.)
  let handlerRan = false
  const app = server().post("/u", { body: nameBody }, (c) => {
    handlerRan = true
    return c.body
  })
  running = await serve(app, { port: 0 })
  const chunk = new Uint8Array(256 * 1024).fill(97) // 256 KB of 'a'
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 8; i++) controller.enqueue(chunk) // 2 MB total > 1 MB cap
      controller.close()
    },
  })
  try {
    await fetch(`http://localhost:${running.port}/u`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half", // required for a streamed request body
    } as RequestInit & { duplex: "half" })
  } catch {
    // A streaming client can see a connection reset when the server caps mid-upload — expected.
  }
  await Bun.sleep(50) // let the cap short-circuit settle
  expect(handlerRan).toBe(false) // the body cap rejected the payload before it reached the handler
})

test("a bare GET that never reads c.req still serves (the fast path never builds a Request)", async () => {
  const app = server().get("/fast", () => ({ ok: true }))
  running = await serve(app, { port: 0 })
  const res = await fetch(`http://localhost:${running.port}/fast`)
  expect(res.headers.get("content-type")).toContain("application/json")
  expect(await res.json()).toEqual({ ok: true })
})

test("c.boundedBody reads the raw body on Node via the lazy source's arrayBuffer()", async () => {
  // A schema-less POST: nifra does not auto-read the body, so the handler drives the read through
  // c.boundedBody() → readBoundedBytes → the lazy source's arrayBuffer() (Content-Length within the
  // cap → buffered straight off Node's stream, no Request materialized).
  const app = server().post("/raw", async (c) => {
    const bytes = await c.boundedBody()
    return { len: bytes.byteLength, text: new TextDecoder().decode(bytes) }
  })
  running = await serve(app, { port: 0 })
  const res = await fetch(`http://localhost:${running.port}/raw`, {
    method: "POST",
    body: "hello-bounded-body",
  })
  expect(await res.json()).toEqual({ len: 18, text: "hello-bounded-body" })
})

test("a client that drops the connection mid-body rejects the read (no hang) and the server stays up", async () => {
  // The body read must not hang if the client disconnects before sending the declared Content-Length.
  // Drive it through c.boundedBody → the lazy source's readNodeBody, drop the socket mid-upload, and
  // assert (a) the read rejected server-side (the close/abort guard fired) and (b) the server survives.
  let readRejected = false
  const app = server().post("/raw", async (c) => {
    try {
      await c.boundedBody()
    } catch {
      readRejected = true
      throw new Error("body read aborted")
    }
    return { ok: true }
  })
  running = await serve(app, { port: 0 })

  const socket = connect(running.port, "127.0.0.1")
  socket.on("error", () => {}) // swallow the client-side reset that destroy() triggers
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()))
  // Announce a 1 KB body but send only 2 bytes, then drop the connection mid-upload.
  socket.write("POST /raw HTTP/1.1\r\nHost: x\r\nContent-Length: 1024\r\n\r\nhi")
  await Bun.sleep(50) // let the handler run → readNodeBody attach its data/close listeners
  socket.destroy()
  await Bun.sleep(50) // let the close propagate → readNodeBody rejects → handler catches

  expect(readRejected).toBe(true) // the dropped connection rejected the read instead of hanging
  // The server survived the abort and still serves a fresh request on a new connection.
  const ok = await fetch(`http://localhost:${running.port}/raw`, { method: "POST", body: "ok" })
  expect(await ok.json()).toEqual({ ok: true })
})

test("a half-close (FIN) mid-body rejects via the close signal (not just abort/error)", async () => {
  // Sibling of the drop test that exercises the forward-compatible `close`-without-`end` guard
  // (`aborted` is deprecated on newer Node): a graceful FIN mid-upload, not a reset.
  let readRejected = false
  const app = server().post("/half", async (c) => {
    try {
      await c.boundedBody()
    } catch {
      readRejected = true
      throw new Error("body read aborted")
    }
    return { ok: true }
  })
  running = await serve(app, { port: 0 })

  const socket = connect(running.port, "127.0.0.1")
  socket.on("error", () => {})
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()))
  // Announce 1 KB but send 2 bytes, then half-close the write side (FIN) instead of resetting.
  socket.write("POST /half HTTP/1.1\r\nHost: x\r\nContent-Length: 1024\r\n\r\nhi")
  await Bun.sleep(50)
  socket.end()
  await Bun.sleep(80)

  expect(readRejected).toBe(true)
})

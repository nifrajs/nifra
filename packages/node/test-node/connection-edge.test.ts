/**
 * Connection-level edges of the Node adapter on Node itself: a peer that resets mid-handshake, an
 * `Upgrade` header that is not a WebSocket handshake, and a client that leaves a streamed response.
 * Each differs from Bun's node:http compat at the socket level.
 */

import assert from "node:assert/strict"
import { connect, type Socket } from "node:net"
import { test } from "node:test"
import { server } from "@nifrajs/core"
import { sse, streaming } from "@nifrajs/core/sse"
import { websocket } from "@nifrajs/core/ws"
import { serve } from "@nifrajs/node"

const HANDSHAKE =
  "Host: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
  "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"

function rawRequest(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(text))
    let got = ""
    socket.on("data", (chunk) => {
      got += chunk
    })
    socket.on("end", () => resolve(got))
    socket.on("close", () => resolve(got))
    socket.on("error", reject)
  })
}

test("a peer that resets while an async upgrade guard runs leaves the server up", async () => {
  let entered!: () => void
  const inGuard = new Promise<void>((resolve) => {
    entered = resolve
  })
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const app = server()
    .use(websocket())
    .get("/health", () => "ok")
    .ws("/sock", {
      upgrade: async () => {
        entered()
        await held
        return { user: null }
      },
      open: (ws) => ws.send("hi"),
    })
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  try {
    const socket = connect(running.port, "127.0.0.1", () =>
      socket.write(`GET /sock HTTP/1.1\r\n${HANDSHAKE}`),
    )
    socket.on("error", () => {})
    await inGuard
    socket.resetAndDestroy()
    await new Promise((resolve) => setTimeout(resolve, 50))
    release()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const res = await fetch(`http://127.0.0.1:${running.port}/health`)
    assert.equal(res.status, 200)
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("an Upgrade header that is not a WebSocket handshake is served as an ordinary request", async () => {
  const app = server()
    .use(websocket())
    .get("/api/users", () => ({ users: [] }))
    .ws("/sock", { open: (ws) => ws.send("hi") })
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  try {
    const reply = await rawRequest(
      running.port,
      "GET /api/users HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade, HTTP2-Settings, close\r\n" +
        "Upgrade: h2c\r\nHTTP2-Settings: AAMAAABkAARAAAAAAAIAAAAA\r\n\r\n",
    )
    assert.match(reply, /^HTTP\/1\.1 200 /)
    assert.match(reply, /\{"users":\[\]\}/)
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("a websocket upgrade to a path with no WS route is answered by its HTTP route, as on Bun", async () => {
  const app = server()
    .use(websocket())
    .ws("/ws", { message: (ws, data) => ws.send(data) })
    .get("/plain", () => ({ plain: true }))
    .post("/plain", () => ({ posted: true }))
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  const handshake =
    "Host: 127.0.0.1\r\nConnection: Upgrade, close\r\nUpgrade: websocket\r\n" +
    "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
  try {
    const got = await rawRequest(running.port, `GET /plain HTTP/1.1\r\n${handshake}\r\n`)
    assert.match(got, /^HTTP\/1\.1 200 /)
    assert.match(got, /\{"plain":true\}/)
    const posted = await rawRequest(
      running.port,
      `POST /plain HTTP/1.1\r\n${handshake}Content-Length: 2\r\n\r\n{}`,
    )
    assert.match(posted, /^HTTP\/1\.1 200 /)
    assert.match(posted, /\{"posted":true\}/)
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("a client that disconnects aborts the request signal and stops an SSE producer", async () => {
  let requestAborted!: () => void
  const requestSignalFired = new Promise<void>((resolve) => {
    requestAborted = resolve
  })
  let producerStopped!: () => void
  const stopped = new Promise<void>((resolve) => {
    producerStopped = resolve
  })
  const app = server()
    .use(streaming())
    .get("/events", (c) => {
      c.req.signal.addEventListener("abort", () => requestAborted())
      return sse(c, async (stream) => {
        // Bounded, so a regression fails the test instead of keeping the runner alive.
        for (let ticks = 0; !stream.signal.aborted && ticks < 300; ticks++) {
          stream.send({ data: "tick" })
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        producerStopped()
      })
    })
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  try {
    const controller = new AbortController()
    const res = await fetch(`http://127.0.0.1:${running.port}/events`, {
      signal: controller.signal,
    })
    await res.body?.getReader().read()
    controller.abort()
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("still running")), 2000),
    )
    await Promise.race([Promise.all([requestSignalFired, stopped]), timeout])
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

async function serveEndlessStream(): Promise<{
  running: Awaited<ReturnType<typeof serve>>
  stopped: Promise<void>
  finished: () => boolean
}> {
  let producerStopped!: () => void
  const stopped = new Promise<void>((resolve) => {
    producerStopped = resolve
  })
  let finished = false
  const app = server()
    .use(websocket())
    .use(streaming())
    .ws("/ws", { message: (ws, data) => ws.send(data) })
    .get("/events", (c) =>
      sse(c, async (stream) => {
        for (let ticks = 0; !stream.signal.aborted && ticks < 300; ticks++) {
          stream.send({ data: "tick" })
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        finished = true
        producerStopped()
      }),
    )
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  return { running, stopped, finished: () => finished }
}

/** Open `/events` with a WebSocket handshake; resolves with the socket once the first event is in. */
function upgradeToEvents(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const client = connect(port, "127.0.0.1", () =>
      client.write(
        "GET /events HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
          "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      ),
    )
    client.on("error", () => {})
    const timer = setTimeout(() => {
      client.destroy()
      reject(new Error("no event arrived"))
    }, 5000)
    let received = ""
    client.on("data", (chunk: Buffer) => {
      received += chunk.toString()
      if (!received.includes("data: tick")) return
      clearTimeout(timer)
      resolve(client)
    })
  })
}

function stopsWithin(stopped: Promise<void>, ms: number): Promise<unknown> {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("still running")), ms),
  )
  return Promise.race([stopped, timeout])
}

test("a streaming route reached by an unmatched upgrade streams, and stops when the client leaves", async () => {
  const stream = await serveEndlessStream()
  try {
    const client = await upgradeToEvents(stream.running.port)
    assert.equal(stream.finished(), false, "the body arrived only once the stream had ended")
    client.destroy()
    await stopsWithin(stream.stopped, 2000)
  } finally {
    await stream.running.stop({ drainMs: 50 })
  }
})

test("stop() closes a streaming route answered on an unmatched upgrade", async () => {
  const stream = await serveEndlessStream()
  let client: Socket | undefined
  try {
    client = await upgradeToEvents(stream.running.port)
    assert.equal(stream.finished(), false, "the body arrived only once the stream had ended")
    await stream.running.stop({ drainMs: 50 })
    await stopsWithin(stream.stopped, 2000)
  } finally {
    client?.destroy()
    await stream.running.stop({ drainMs: 50 })
  }
})

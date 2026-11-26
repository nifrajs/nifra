import assert from "node:assert/strict"
import { connect } from "node:net"
import { test } from "node:test"
import { server, staticResponse } from "@nifrajs/core"
import { websocket } from "@nifrajs/core/ws"
import { selfSignedCertificate } from "../../../internal/test-utils/src/tls.ts"
import { serve } from "../src/index.ts"
import { parseHead, raw, rawExchange } from "./support.ts"

const app = () =>
  server()
    .use(websocket())
    .get("/s", staticResponse({ headers: { "x-pad": "p".repeat(2000) } }))
    .get("/h", (c) => ({ h: c.req.headers.get("x-a") }))
    .get("/stream", () => {
      let sent = 0
      return new Response(
        new ReadableStream({
          async pull(controller) {
            await new Promise((resolve) => setTimeout(resolve, 5))
            if (sent++ === 3) controller.close()
            else controller.enqueue(new TextEncoder().encode("x"))
          },
        }),
      )
    })
    .post("/p", async (c) => ({ n: (await c.req.text()).length }))
    .ws("/ws", { message: () => {} })

const start = (engine: Record<string, number> = {}) =>
  serve(app(), { port: 0, hostname: "127.0.0.1", engine })

const status = (received: string): string => received.split("\r\n")[0] ?? ""

const UPGRADE =
  "GET /ws HTTP/1.1\r\nHost: a\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
  "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"

/** Whether the server closes a socket that says `send` and then nothing within `ms`. */
function closesWithin(port: number, send: Uint8Array | string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(send))
    socket.resume()
    socket.on("error", () => {})
    const timer = setTimeout(() => {
      resolve(false)
      socket.destroy()
    }, ms)
    socket.on("close", () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

test("framing and header forms read as node:http reads them", async () => {
  const running = await start()
  const get = (head: string | Buffer) => raw(running.port, head, (r) => r.includes("}"), 1000)
  try {
    assert.match(await get("GET /h HTTP/1.1\nHost: a\n\n"), /^HTTP\/1\.1 400/)
    assert.match(await get("GET /h HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 400/)
    assert.match(await get("GET @evil.test/x HTTP/1.1\r\nHost: a\r\n\r\n"), /^HTTP\/1\.1 400/)
    const latin1 = Buffer.from("GET /h HTTP/1.1\r\nHost: a\r\nx-a: é\r\n\r\n", "latin1")
    const echoed = Buffer.from(parseHead(await get(latin1)).body, "latin1").toString("utf8")
    assert.equal(JSON.parse(echoed).h, "\u00e9")
    const many = Array.from({ length: 100 }, (_, i) => `x-${i}: 1\r\n`).join("")
    assert.match(await get(`GET /h HTTP/1.1\r\nHost: a\r\n${many}\r\n`), /^HTTP\/1\.1 200/)
    const big = `x-big: ${"a".repeat(20_000)}\r\n`
    assert.match(await get(`GET /h HTTP/1.1\r\nHost: a\r\n${big}\r\n`), /^HTTP\/1\.1 431/)
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("Expect: 100-continue is answered before the body is sent", async () => {
  const running = await start()
  try {
    const head = "POST /p HTTP/1.1\r\nHost: a\r\nContent-Length: 3\r\nExpect: 100-continue\r\n\r\n"
    const received = await raw(running.port, head, (r) => r.includes("\r\n\r\n"), 1000)
    assert.equal(status(received), "HTTP/1.1 100 Continue")
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("Expect: 100-continue is answered past 64 header fields, and in request order", async () => {
  const running = await start()
  const expecting = (extra = "") =>
    `POST /p HTTP/1.1\r\nHost: a\r\n${extra}Content-Length: 3\r\nExpect: 100-continue\r\n\r\n`
  try {
    const many = Array.from({ length: 100 }, (_, i) => `x-${i}: 1\r\n`).join("")
    const alone = await raw(running.port, expecting(many), (r) => r.includes("\r\n\r\n"), 1000)
    assert.equal(status(alone), "HTTP/1.1 100 Continue")
    // Behind a response still streaming: that response first, then the interim reply.
    const behind = await raw(
      running.port,
      `GET /stream HTTP/1.1\r\nHost: a\r\n\r\n${expecting()}`,
      (r) => r.includes("100 Continue"),
      2000,
    )
    assert.equal(status(behind), "HTTP/1.1 200 OK")
    assert.ok(behind.indexOf("0\r\n\r\n") < behind.indexOf("HTTP/1.1 100 Continue"))
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("a streamed HTTP/1.0 response ends with the connection, not with chunks", async () => {
  const running = await start()
  try {
    const { received, end } = await rawExchange(
      running.port,
      "GET /stream HTTP/1.0\r\nHost: a\r\n\r\n",
    )
    assert.equal(end, "closed")
    assert.doesNotMatch(received, /transfer-encoding/i)
    assert.equal(parseHead(received).body, "xxx")
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("a client that reads nothing stops being read, and is dropped", async () => {
  const running = await start({ idleTimeoutMs: 1000 })
  try {
    const before = process.memoryUsage().rss
    const socket = connect(running.port, "127.0.0.1")
    socket.pause()
    socket.on("error", () => {})
    // Listening from the start: a reset while the requests are still being written closes it early.
    const closed = new Promise((resolve) => socket.once("close", () => resolve(true)))
    await new Promise((resolve) => socket.once("connect", resolve))
    socket.write("GET /s HTTP/1.1\r\nHost: a\r\n\r\n".repeat(500_000))
    await new Promise((resolve) => setTimeout(resolve, 600))
    // 14 MB of requests would answer with over 1 GB; the writer stops near its pause mark.
    assert.ok(process.memoryUsage().rss - before < 200 * 1024 * 1024)
    // No byte moves for a whole idle window: the connection is dropped, which a reader then sees.
    await new Promise((resolve) => setTimeout(resolve, 2200))
    socket.resume()
    const timer = new Promise((resolve) => setTimeout(() => resolve(false), 5000).unref())
    assert.equal(await Promise.race([closed, timer]), true)
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("a request head that never finishes is cut at the headers timeout", async () => {
  const running = await start({ headersTimeoutMs: 500 })
  try {
    assert.equal(await closesWithin(running.port, "GET / HTTP/1.1\r\nHost: a\r\n", 3000), true)
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("a quiet WebSocket is pinged, kept while it answers and dropped when it does not", async () => {
  const running = await start({ idleTimeoutMs: 1000 })
  try {
    let pings = 0
    const socket = connect(running.port, "127.0.0.1", () => socket.write(UPGRADE))
    socket.on("error", () => {})
    let closed = false
    socket.on("close", () => {
      closed = true
    })
    socket.on("data", (chunk) => {
      if (chunk[0] !== 0x89) return
      pings++
      // A masked, empty Pong.
      socket.write(Buffer.from([0x8a, 0x80, 0, 0, 0, 0]))
    })
    await new Promise((resolve) => setTimeout(resolve, 4500))
    assert.equal(closed, false)
    assert.ok(pings >= 2, `${pings} pings`)
    socket.destroy()
    assert.equal(await closesWithin(running.port, UPGRADE, 5000), true)
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("a trickled TLS handshake is cut at the headers timeout", async () => {
  const { cert, key } = await selfSignedCertificate()
  const running = await serve(app(), {
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert, key },
    engine: { headersTimeoutMs: 1000, idleTimeoutMs: 600 },
  })
  try {
    const socket = connect(running.port, "127.0.0.1")
    socket.on("error", () => {})
    // The start of a ClientHello record, a byte at a time and faster than the idle timeout.
    const hello = [0x16, 0x03, 0x01, 0x02, 0x00, 0x01, 0x00, 0x01, 0xfc]
    let at = 0
    const trickle = setInterval(() => socket.write(Buffer.from([hello[at++] ?? 0])), 200)
    const closed = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000)
      socket.on("close", () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    clearInterval(trickle)
    socket.destroy()
    assert.equal(closed, true)
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

/** HTTP/2 on the engine: by ALPN over TLS, by prior knowledge in the clear, with HTTP/1.1 beside it. */

import assert from "node:assert/strict"
import {
  type ClientHttp2Session,
  connect,
  constants,
  type Settings as Http2PeerSettings,
  type IncomingHttpHeaders,
} from "node:http2"
import { createConnection } from "node:net"
import { test } from "node:test"
import { server, staticResponse, status } from "@nifrajs/core"
import { selfSignedCertificate } from "../../../internal/test-utils/src/tls.ts"
import { serve, setResponseTrailers } from "../src/index.ts"

interface Reply {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

function exchange(
  session: ClientHttp2Session,
  method: string,
  path: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const stream = session.request({ ":method": method, ":path": path, ...headers })
    let head: IncomingHttpHeaders = {}
    let text = ""
    stream.setEncoding("utf8")
    stream.on("response", (received) => {
      head = received
    })
    stream.on("data", (chunk: string) => {
      text += chunk
    })
    stream.on("end", () => resolve({ status: Number(head[":status"]), headers: head, body: text }))
    stream.on("error", reject)
    stream.end(body)
  })
}

const app = () =>
  server()
    .get("/who", (c) => ({ url: c.req.url, host: c.req.headers.get("host") }))
    .post("/echo", async (c) => ({ got: await c.req.json() }))
    .get("/stream", () => {
      const encoder = new TextEncoder()
      let n = 0
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(encoder.encode(`chunk-${n}\n`))
            if (++n === 4) controller.close()
          },
        }),
        { headers: { "content-type": "text/plain" } },
      )
    })
    .get("/short-known", () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(70_000))
            controller.enqueue(new Uint8Array(70_000))
            controller.close()
          },
        }),
        { headers: { "content-length": "999999" } },
      )
    })
    .get("/errors-midway", () => {
      let n = 0
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise((resolve) => setTimeout(resolve, 5))
            if (n++ === 2) return controller.error(new Error("stream failed"))
            controller.enqueue(new TextEncoder().encode("part"))
          },
        }),
      )
    })
    .get("/fixed", staticResponse({ headers: { "x-fixed": "1" } }))
    .get("/teapot", () => status(418, { teapot: true }))

test("prior knowledge: one connection carries several streams, and POST bodies arrive", async () => {
  const running = await serve(app(), { port: 0, hostname: "127.0.0.1", http2: true })
  const session = connect(`http://127.0.0.1:${running.port}`)
  try {
    const [who, echo, teapot] = await Promise.all([
      exchange(session, "GET", "/who"),
      exchange(session, "POST", "/echo", JSON.stringify({ n: 7 }), {
        "content-type": "application/json",
      }),
      exchange(session, "GET", "/teapot"),
    ])
    assert.equal(who.status, 200)
    assert.equal(JSON.parse(who.body).url, `http://127.0.0.1:${running.port}/who`)
    assert.equal(echo.status, 200)
    assert.deepEqual(JSON.parse(echo.body), { got: { n: 7 } })
    assert.equal(teapot.status, 418)
    assert.equal(typeof session.originSet, "undefined")
  } finally {
    session.close()
    await running.stop({ drainMs: 50 })
  }
})

test("a streamed body and a fixed reply both come back over HTTP/2", async () => {
  const running = await serve(app(), { port: 0, hostname: "127.0.0.1", http2: true })
  const session = connect(`http://127.0.0.1:${running.port}`)
  try {
    const streamed = await exchange(session, "GET", "/stream")
    assert.equal(streamed.body, "chunk-0\nchunk-1\nchunk-2\nchunk-3\n")
    const fixed = await exchange(session, "GET", "/fixed")
    assert.equal(fixed.status, 200)
    assert.equal(fixed.headers["x-fixed"], "1")
    assert.equal(fixed.headers.connection, undefined)
    assert.equal(fixed.headers["transfer-encoding"], undefined)
  } finally {
    session.close()
    await running.stop({ drainMs: 50 })
  }
})

test("HTTP/1.1 is still served on the same port", async () => {
  const running = await serve(app(), { port: 0, hostname: "127.0.0.1", http2: true })
  try {
    const res = await fetch(`http://127.0.0.1:${running.port}/teapot`)
    assert.equal(res.status, 418)
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("over TLS the client negotiates h2 by ALPN, and the app sees https", async () => {
  const pair = await selfSignedCertificate()
  const running = await serve(app(), {
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert: pair.cert, key: pair.key },
    http2: { maxConcurrentStreams: 64 },
  })
  const session = connect(`https://127.0.0.1:${running.port}`, {
    ca: pair.cert,
    ALPNProtocols: ["h2", "http/1.1"],
  })
  try {
    const who = await exchange(session, "GET", "/who")
    assert.equal(session.alpnProtocol, "h2")
    assert.equal(JSON.parse(who.body).url, `https://127.0.0.1:${running.port}/who`)
  } finally {
    session.close()
    await running.stop({ drainMs: 50 })
  }
})

test("without the option, a client opening with the HTTP/2 preface is not served", async () => {
  const running = await serve(app(), { port: 0, hostname: "127.0.0.1" })
  const session = connect(`http://127.0.0.1:${running.port}`)
  session.on("error", () => {})
  try {
    const outcome = await Promise.race([
      exchange(session, "GET", "/teapot").then(
        (reply) => `reply ${reply.status}`,
        () => "refused",
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("refused"), 1500)),
    ])
    assert.equal(outcome, "refused")
  } finally {
    session.destroy()
    await running.stop({ drainMs: 50 })
  }
})

test("stop() lets an open HTTP/2 stream finish and then closes the connection", async () => {
  const encoder = new TextEncoder()
  let began!: () => void
  const started = new Promise<void>((resolve) => {
    began = resolve
  })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const held = server().get(
    "/held",
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode("first;"))
            began()
            await gate
            controller.enqueue(encoder.encode("last"))
            controller.close()
          },
        }),
        { headers: { "content-type": "text/plain" } },
      ),
  )
  const running = await serve(held, { port: 0, hostname: "127.0.0.1", http2: true })
  const session = connect(`http://127.0.0.1:${running.port}`)
  const closed = new Promise<void>((resolve) => session.once("close", () => resolve()))
  try {
    const stream = session.request({ ":path": "/held" })
    let text = ""
    stream.setEncoding("utf8")
    stream.on("data", (chunk: string) => {
      text += chunk
    })
    const ended = new Promise<void>((resolve, reject) => {
      stream.on("end", () => resolve())
      stream.on("error", reject)
    })
    stream.end()
    await started
    // The stream is open when shutdown starts: it must be allowed to finish.
    const stopping = running.stop({ drainMs: 3000 })
    release()
    await ended
    assert.equal(text, "first;last")
    await stopping
    await Promise.race([
      closed,
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("still open")), 3000)),
    ])
  } finally {
    release()
    session.destroy()
  }
})

test("a stream that fails short of its declared length resets the HTTP/2 stream", async () => {
  const running = await serve(app(), { port: 0, hostname: "127.0.0.1", http2: true })
  const session = connect(`http://127.0.0.1:${running.port}`)
  session.on("error", () => {})
  try {
    const outcome = await new Promise<string>((resolve) => {
      const stream = session.request({ ":path": "/short-known" })
      stream.on("data", () => {})
      stream.on("end", () => resolve("finished"))
      stream.on("error", () => resolve(`reset ${stream.rstCode}`))
      stream.end()
    })
    assert.match(outcome, /^reset [1-9]/)
    // The connection and its other streams are untouched.
    assert.equal((await exchange(session, "GET", "/teapot")).status, 418)
  } finally {
    session.destroy()
    await running.stop({ drainMs: 50 })
  }
})

test("a stream of no declared length that fails resets the HTTP/2 stream rather than ending it as whole", async () => {
  const running = await serve(app(), { port: 0, hostname: "127.0.0.1", http2: true })
  const session = connect(`http://127.0.0.1:${running.port}`)
  session.on("error", () => {})
  try {
    const outcome = await new Promise<string>((resolve) => {
      const stream = session.request({ ":path": "/errors-midway" })
      stream.on("data", () => {})
      stream.on("end", () => resolve("finished"))
      stream.on("error", () => resolve(`reset ${stream.rstCode}`))
      stream.end()
    })
    assert.match(outcome, /^reset [1-9]/)
    assert.equal((await exchange(session, "GET", "/teapot")).status, 418)
  } finally {
    session.destroy()
    await running.stop({ drainMs: 50 })
  }
})

test("an HTTP/2 upload deadline resets just the expired stream", { timeout: 6000 }, async () => {
  const release = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  let uploads = 0
  const app = server()
    .post("/upload", () => {
      uploads++
      return { ok: true }
    })
    .get("/sibling", async () => {
      entered.resolve()
      await release.promise
      return { ok: true }
    })
  const running = await serve(app, {
    port: 0,
    hostname: "127.0.0.1",
    http2: true,
    engine: { requestTimeoutMs: 250 },
  })
  const session = connect(`http://127.0.0.1:${running.port}`)
  const upload = session.request({ ":method": "POST", ":path": "/upload" })
  const closed = new Promise<number>((resolve) => {
    upload.on("error", () => {
      // Node can emit an error for RST_STREAM. Assert its wire code on close.
    })
    upload.once("close", () => resolve(upload.rstCode))
  })
  upload.write("part of the upload")
  try {
    const sibling = exchange(session, "GET", "/sibling")
    await Promise.race([entered.promise, sibling])
    assert.equal(await closed, constants.NGHTTP2_CANCEL)
    assert.equal(uploads, 0)
    release.resolve()
    assert.equal((await sibling).status, 200)
    assert.equal((await exchange(session, "GET", "/sibling")).status, 200)
  } finally {
    release.resolve()
    session.destroy()
    await running.stop({ drainMs: 0 })
  }
})

const trailerApp = () =>
  server()
    .get("/headers", (c) => {
      const n = c.req.headers.get("x-n") ?? ""
      return new Response(n, {
        headers: {
          "content-type": "text/plain",
          "x-same": "a value long enough to be worth indexing",
          "x-varies": `value-${n}-${"z".repeat(Number(n) % 40)}`,
          "set-cookie": `id=${n}`,
        },
      })
    })
    .get("/trailers", (c) => {
      const set = setResponseTrailers(c.req, { "x-checksum": "abc123" })
      const refused = setResponseTrailers(c.req, { "content-length": "1" })
      return { set, refused }
    })
    .get("/stream-trailers", (c) => {
      const req = c.req
      let n = 0
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise((resolve) => setImmediate(resolve))
            if (n++ < 3) return controller.enqueue(new TextEncoder().encode("part"))
            setResponseTrailers(req, { "x-count": "3" })
            controller.close()
          },
        }),
      )
    })

function trailed(session: ClientHttp2Session, path: string) {
  return new Promise<{ body: string; trailers: IncomingHttpHeaders }>((resolve, reject) => {
    const stream = session.request({ ":path": path })
    let body = ""
    let trailers: IncomingHttpHeaders = {}
    stream.setEncoding("utf8")
    stream.on("data", (chunk: string) => {
      body += chunk
    })
    stream.on("trailers", (received) => {
      trailers = received
    })
    stream.on("end", () => resolve({ body, trailers }))
    stream.on("error", reject)
    stream.end()
  })
}

for (const headerTableSize of [0, 256, 4096]) {
  test(`compressed response headers decode across many streams, table ${headerTableSize}`, async () => {
    const running = await serve(trailerApp(), {
      port: 0,
      hostname: "127.0.0.1",
      http2: { headerTableSize },
    })
    const session = connect(`http://127.0.0.1:${running.port}`)
    try {
      for (let round = 0; round < 3; round++) {
        await Promise.all(
          Array.from({ length: 100 }, async (_, i) => {
            const n = String(round * 100 + i)
            const reply = await exchange(session, "GET", "/headers", undefined, { "x-n": n })
            assert.equal(reply.body, n)
            assert.equal(reply.headers["x-same"], "a value long enough to be worth indexing")
            assert.equal(reply.headers["x-varies"], `value-${n}-${"z".repeat(Number(n) % 40)}`)
            assert.deepEqual(reply.headers["set-cookie"], [`id=${n}`])
          }),
        )
      }
    } finally {
      session.close()
      await running.stop({ drainMs: 50 })
    }
  })
}

test("response trailers follow a buffered and a streamed body", async () => {
  const running = await serve(trailerApp(), { port: 0, hostname: "127.0.0.1", http2: true })
  const session = connect(`http://127.0.0.1:${running.port}`)
  try {
    const buffered = await trailed(session, "/trailers")
    assert.deepEqual(JSON.parse(buffered.body), { set: true, refused: false })
    assert.equal(buffered.trailers["x-checksum"], "abc123")
    const streamed = await trailed(session, "/stream-trailers")
    assert.equal(streamed.body, "partpartpart")
    assert.equal(streamed.trailers["x-count"], "3")

    const h1 = await fetch(`http://127.0.0.1:${running.port}/trailers`)
    assert.deepEqual(await h1.json(), { set: false, refused: false })
  } finally {
    session.close()
    await running.stop({ drainMs: 50 })
  }
})

test("settings are advertised, and out-of-range ones are refused", async () => {
  const running = await serve(trailerApp(), {
    port: 0,
    hostname: "127.0.0.1",
    http2: {
      initialWindowSize: 70_000,
      maxFrameSize: 32_768,
      headerTableSize: 1024,
      maxConcurrentStreams: 7,
    },
  })
  const session = connect(`http://127.0.0.1:${running.port}`)
  try {
    const settings = await new Promise<Http2PeerSettings>((resolve) =>
      session.once("remoteSettings", resolve),
    )
    assert.equal(settings.initialWindowSize, 70_000)
    assert.equal(settings.maxFrameSize, 32_768)
    assert.equal(settings.headerTableSize, 1024)
    assert.equal(settings.maxConcurrentStreams, 7)
  } finally {
    session.close()
    await running.stop({ drainMs: 50 })
  }
  for (const http2 of [
    { initialWindowSize: 0 },
    { connectionWindowSize: 65_534 },
    { maxFrameSize: 16_383 },
    { headerTableSize: 65_537 },
    { maxSendBuffer: 0 },
    { pingIntervalMs: -1 },
    { pingTimeoutMs: 0 },
  ]) {
    await assert.rejects(
      async () => serve(trailerApp(), { port: 0, hostname: "127.0.0.1", http2 }),
      /`http2\./,
    )
  }
})

const FRAME = { settings: 4, ping: 6, goaway: 7 } as const

/** A client that speaks just enough frames to see what the server sends of its own accord. */
async function rawSession(port: number) {
  const socket = createConnection({ port, host: "127.0.0.1" })
  const frames: { type: number; flags: number; payload: Buffer }[] = []
  let buffered = Buffer.alloc(0)
  let arrived = Promise.withResolvers<void>()
  let ended = false
  const wake = () => {
    arrived.resolve()
    arrived = Promise.withResolvers<void>()
  }
  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk])
    while (buffered.length >= 9 && buffered.length >= 9 + buffered.readUIntBE(0, 3)) {
      const end = 9 + buffered.readUIntBE(0, 3)
      frames.push({
        type: buffered.readUInt8(3),
        flags: buffered.readUInt8(4),
        payload: buffered.subarray(9, end),
      })
      buffered = buffered.subarray(end)
    }
    wake()
  })
  socket.on("error", () => {})
  socket.on("close", () => {
    ended = true
    wake()
  })
  const send = (type: number, flags: number, payload = Buffer.alloc(0)) => {
    const head = Buffer.alloc(9)
    head.writeUIntBE(payload.length, 0, 3)
    head.writeUInt8(type, 3)
    head.writeUInt8(flags, 4)
    socket.write(Buffer.concat([head, payload]))
  }
  socket.write("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n")
  send(FRAME.settings, 0)
  return {
    send,
    async next(type: number) {
      for (;;) {
        const at = frames.findIndex((f) => f.type === type && (type !== 6 || f.flags === 0))
        if (at >= 0) return frames.splice(0, at + 1).at(-1)
        if (ended) return undefined
        await arrived.promise
      }
    },
    close: () => socket.destroy(),
  }
}

test("a quiet connection is pinged, kept while it answers and closed when it stops", async () => {
  const running = await serve(trailerApp(), {
    port: 0,
    hostname: "127.0.0.1",
    http2: { pingIntervalMs: 1000, pingTimeoutMs: 1500 },
    engine: { idleTimeoutMs: 3000 },
  })
  const raw = await rawSession(running.port)
  try {
    const started = performance.now()
    while (performance.now() - started < 4500) {
      const ping = await raw.next(FRAME.ping)
      assert.ok(ping, "closed while still answering")
      raw.send(FRAME.ping, 1, ping.payload)
    }
    // Unanswered from here on: the connection must end.
    while ((await raw.next(FRAME.ping)) !== undefined) {}
  } finally {
    raw.close()
    await running.stop({ drainMs: 50 })
  }
})

test("stop() announces the shutdown in two GOAWAY frames", async () => {
  const running = await serve(trailerApp(), { port: 0, hostname: "127.0.0.1", http2: true })
  const raw = await rawSession(running.port)
  let stopped: Promise<void> | undefined
  try {
    assert.ok(await raw.next(FRAME.settings))
    stopped = running.stop({ drainMs: 2000 })
    const first = await raw.next(FRAME.goaway)
    assert.equal(first?.payload.readUInt32BE(0), 0x7fff_ffff)
    const ping = await raw.next(FRAME.ping)
    assert.ok(ping)
    raw.send(FRAME.ping, 1, ping.payload)
    const last = await raw.next(FRAME.goaway)
    assert.equal(last?.payload.readUInt32BE(0), 0)
  } finally {
    raw.close()
    await (stopped ?? running.stop({ drainMs: 50 }))
  }
})

test("stop() delivers a response that a slow reader has not taken yet", async () => {
  const size = 12 * 1024 * 1024
  const entered = Promise.withResolvers<void>()
  const app = server().get("/big", () => {
    entered.resolve()
    return new Response(new Uint8Array(size))
  })
  // The body goes to the engine in one write, so all of it is queued at once.
  const running = await serve(app, {
    port: 0,
    hostname: "127.0.0.1",
    http2: true,
    engine: { writeHighWaterMark: 32 * 1024 * 1024, responseBackpressureLimit: 64 * 1024 * 1024 },
  })
  const socket = createConnection({ port: running.port, host: "127.0.0.1" })
  socket.on("error", () => {})
  let buffered = Buffer.alloc(0)
  let received = 0
  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk])
    while (buffered.length >= 9 && buffered.length >= 9 + buffered.readUIntBE(0, 3)) {
      const length = buffered.readUIntBE(0, 3)
      if (buffered.readUInt8(3) === 0) received += length
      buffered = buffered.subarray(9 + length)
    }
  })
  const closed = new Promise((resolve) => socket.once("close", resolve))
  const frame = (type: number, flags: number, stream: number, payload: Buffer) => {
    const head = Buffer.alloc(9)
    head.writeUIntBE(payload.length, 0, 3)
    head.writeUInt8(type, 3)
    head.writeUInt8(flags, 4)
    head.writeUInt32BE(stream, 5)
    return Buffer.concat([head, payload])
  }
  // Windows wide enough for the whole body, so what is left waits on the socket alone.
  const initialWindow = Buffer.from([0, 4, 0x7f, 0xff, 0xff, 0xff])
  const connectionWindow = Buffer.from([0x7f, 0xff, 0, 0])
  const request = Buffer.concat([
    Buffer.from([0x82, 0x86, 0x04, 4]),
    Buffer.from("/big"),
    Buffer.from([0x41, 9]),
    Buffer.from("localhost"),
  ])
  let stopped: Promise<void> | undefined
  try {
    socket.pause()
    socket.write("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n")
    socket.write(frame(4, 0, 0, initialWindow))
    socket.write(frame(8, 0, 0, connectionWindow))
    socket.write(frame(1, 0x05, 1, request))
    await entered.promise
    stopped = running.stop({ drainMs: 20_000 })
    // Past the unanswered shutdown PING and two sweeps; reading later only makes this stricter.
    await new Promise((resolve) => setTimeout(resolve, 3500))
    socket.resume()
    await closed
    assert.equal(received, size)
  } finally {
    socket.destroy()
    await (stopped ?? running.stop({ drainMs: 50 }))
  }
})

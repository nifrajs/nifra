/** HTTP/2 on the engine: by ALPN over TLS, by prior knowledge in the clear, with HTTP/1.1 beside it. */

import assert from "node:assert/strict"
import { type ClientHttp2Session, connect, type IncomingHttpHeaders } from "node:http2"
import { test } from "node:test"
import { server, staticResponse, status } from "@nifrajs/core"
import { selfSignedCertificate } from "../../../internal/test-utils/src/tls.ts"
import { serve } from "../src/index.ts"

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
  const running = await serve(app(), { port: 0, hostname: "127.0.0.1", http2: true })
  const session = connect(`http://127.0.0.1:${running.port}`)
  const closed = new Promise<void>((resolve) => session.once("close", () => resolve()))
  try {
    const first = await exchange(session, "GET", "/teapot")
    assert.equal(first.status, 418)
    await running.stop({ drainMs: 500 })
    await Promise.race([
      closed,
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("still open")), 3000)),
    ])
  } finally {
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

test("a stream of no declared length that fails ends cleanly on HTTP/2: there is no failed end to send", async () => {
  const running = await serve(app(), { port: 0, hostname: "127.0.0.1", http2: true })
  const session = connect(`http://127.0.0.1:${running.port}`)
  try {
    const reply = await exchange(session, "GET", "/errors-midway")
    assert.equal(reply.status, 200)
    assert.equal(reply.body, "partpart")
    assert.equal((await exchange(session, "GET", "/teapot")).status, 418)
  } finally {
    session.destroy()
    await running.stop({ drainMs: 50 })
  }
})

/**
 * The **ordinary** Node request/response path, exercised on Node itself over real sockets.
 *
 * The stream hand-off did not only touch the proxy and static paths: every request body now arrives
 * as a pull-driven `ReadableStream` instead of `Readable.toWeb`'s eagerly-consuming wrapper, and
 * every response passes a claim check before it is written. Those two edits sit on the common path,
 * so the common path is what this file holds down.
 *
 * The difference that matters is laziness. `Readable.toWeb` starts draining its source the moment it
 * is constructed; the replacement touches the socket only when something actually reads. That is the
 * whole point of the change, and it is also the one thing that could plausibly alter HTTP behaviour
 * rather than just its speed - an undrained request body is a keep-alive hazard, and a body read
 * late is a body read after the handler has had a chance to respond. Both are asserted below.
 *
 * Raw `net` sockets rather than `fetch` wherever the case is one `fetch` will not produce:
 * connection reuse under an unread body, `Expect: 100-continue`, pipelining, a mid-upload hangup.
 */

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { connect, type Socket } from "node:net"
import { after, before, test } from "node:test"
import { server } from "@nifrajs/core"
import { serve } from "@nifrajs/node"

let port = 0
let stop: (() => Promise<void>) | undefined
/** A second server left on the default 1 MB cap, so the cap itself can be asserted. */
let cappedPort = 0
let stopCapped: (() => Promise<void>) | undefined

const digest = (bytes: Uint8Array | Buffer): string =>
  createHash("sha256").update(bytes).digest("hex")

const BIG = Buffer.alloc(5 * 1024 * 1024)
for (let i = 0; i < BIG.length; i++) BIG[i] = i % 251
const BIG_DIGEST = digest(BIG)

/** Records whether a handler that never touches the body still saw a healthy connection. */
let ignoredBodyHits = 0

before(async () => {
  // Raised past the 1 MB default only so a multi-megabyte body can be round tripped here; the cap is
  // asserted separately against a server that keeps the default.
  const app = server({ maxBodyBytes: 8 * 1024 * 1024 })
    .get("/hello", () => new Response("hello", { headers: { "content-type": "text/plain" } }))
    .get("/stream", () => {
      // A response body that arrives in pieces with gaps, so the writer's teardown is exercised on a
      // body that is neither a string nor a Uint8Array - the shape that reaches the claim check.
      let sent = 0
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (sent === 8) return controller.close()
            sent++
            await new Promise((resolve) => setTimeout(resolve, 5))
            controller.enqueue(new Uint8Array(8192).fill(sent))
          },
        }),
        { headers: { "content-type": "application/octet-stream" } },
      )
    })
    .post("/echo", async (c) => {
      const bytes = new Uint8Array(await c.req.arrayBuffer())
      return { len: bytes.byteLength, sha: digest(bytes) }
    })
    .post("/echo-text", async (c) => ({ text: await c.req.text() }))
    .post("/echo-json", async (c) => c.req.json())
    .post("/ignore", () => {
      ignoredBodyHits++
      return "ignored"
    })
    .post("/late", async (c) => {
      // Respond only after a turn of the event loop, so the body is read strictly later than the
      // point at which the eager wrapper would already have drained it.
      await new Promise((resolve) => setTimeout(resolve, 25))
      return { text: await c.req.text() }
    })
    .get("/empty", () => new Response(null, { status: 204 }))
  const handle = await serve(app, { port: 0, hostname: "127.0.0.1" })
  port = handle.port
  stop = () => handle.stop()

  const capped = server().post("/echo", async (c) => ({
    len: (await c.req.arrayBuffer()).byteLength,
  }))
  const cappedHandle = await serve(capped, { port: 0, hostname: "127.0.0.1" })
  cappedPort = cappedHandle.port
  stopCapped = () => cappedHandle.stop()
})

after(async () => {
  await stop?.()
  await stopCapped?.()
})

/** Sends raw bytes on one socket and returns everything written back until the peer is done. */
function rawExchange(
  write: string | Buffer,
  options: { readonly waitMs?: number; readonly keepOpen?: boolean } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(port, "127.0.0.1")
    const chunks: Buffer[] = []
    const finish = (): void => {
      socket.destroy()
      resolve(Buffer.concat(chunks).toString("latin1"))
    }
    socket.on("error", reject)
    socket.on("data", (chunk: Buffer) => chunks.push(chunk))
    socket.on("end", finish)
    socket.once("connect", () => {
      socket.write(write)
      if (options.keepOpen !== true) {
        setTimeout(finish, options.waitMs ?? 300)
      }
    })
  })
}

test("a content-length request body round trips byte for byte", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/echo`, { method: "POST", body: BIG })
  assert.deepEqual(await response.json(), { len: BIG.length, sha: BIG_DIGEST })
})

test("a chunked request body round trips byte for byte", async () => {
  // No content-length: the adapter cannot pre-size the read and must drive the stream to completion.
  const response = await fetch(`http://127.0.0.1:${port}/echo`, {
    method: "POST",
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < BIG.length; offset += 64 * 1024) {
          controller.enqueue(new Uint8Array(BIG.subarray(offset, offset + 64 * 1024)))
        }
        controller.close()
      },
    }),
    duplex: "half",
  } as RequestInit)
  assert.deepEqual(await response.json(), { len: BIG.length, sha: BIG_DIGEST })
})

test("an empty request body reads as empty rather than hanging", async () => {
  const withHeader = await fetch(`http://127.0.0.1:${port}/echo-text`, {
    method: "POST",
    body: "",
  })
  assert.deepEqual(await withHeader.json(), { text: "" })

  // And with no content-length and no body at all, which is the shape a bare POST takes.
  const bare = await rawExchange("POST /echo-text HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n")
  assert.match(bare, /200 OK/)
  assert.match(bare, /\{"text":""\}/)
})

test("a body read after the handler has already yielded still arrives complete", async () => {
  // Laziness means nothing has touched the socket by the time the handler starts. If the source were
  // being consumed by something other than the reader, the delay would lose bytes.
  const payload = "x".repeat(200_000)
  const response = await fetch(`http://127.0.0.1:${port}/late`, { method: "POST", body: payload })
  const body = (await response.json()) as { text: string }
  assert.equal(body.text.length, payload.length)
  assert.equal(body.text, payload)
})

test("a handler that never reads the body still leaves the connection reusable", async () => {
  // The keep-alive case the laziness could plausibly break: with the eager wrapper the body was
  // drained whether or not anyone wanted it, so the socket was always clean for the next request.
  // Now nothing reads it, and it is Node's own discard of an unconsumed request body that has to
  // clear the socket. Three requests with bodies down one connection, all answered, proves it does.
  const before = ignoredBodyHits
  const one =
    "POST /ignore HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nConnection: keep-alive\r\n\r\nabcde"
  const last =
    "POST /ignore HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nConnection: close\r\n\r\nabcde"
  const transcript = await rawExchange(one + one + last, { keepOpen: true })
  assert.equal(transcript.match(/HTTP\/1\.1 200/g)?.length, 3, transcript)
  assert.equal(transcript.match(/ignored/g)?.length, 3, transcript)
  assert.equal(ignoredBodyHits - before, 3)
})

test("pipelined requests on one socket are each answered in order", async () => {
  const get = "GET /hello HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n"
  const post =
    "POST /echo-text HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nhi"
  const close = "GET /hello HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"
  const transcript = await rawExchange(get + post + close, { keepOpen: true })
  assert.equal(transcript.match(/HTTP\/1\.1 200/g)?.length, 3, transcript)
  assert.ok(transcript.indexOf("hello") < transcript.indexOf('{"text":"hi"}'), transcript)
})

test("Expect: 100-continue is answered and the body that follows is read", async () => {
  const transcript = await rawExchange(
    "POST /echo-text HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nExpect: 100-continue\r\nConnection: close\r\n\r\nabcde",
    { keepOpen: true },
  )
  assert.match(transcript, /HTTP\/1\.1 100 Continue/)
  assert.match(transcript, /\{"text":"abcde"\}/)
})

test("HEAD returns the headers of the GET with no body", async () => {
  const transcript = await rawExchange(
    "HEAD /hello HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
    { keepOpen: true },
  )
  const [head, ...rest] = transcript.split("\r\n\r\n")
  assert.match(head ?? "", /HTTP\/1\.1 200/)
  assert.equal(rest.join("\r\n\r\n"), "")
})

test("a 204 carries no body and does not wedge the connection", async () => {
  const transcript = await rawExchange(
    "GET /empty HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\nGET /hello HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
    { keepOpen: true },
  )
  assert.match(transcript, /HTTP\/1\.1 204/)
  assert.match(transcript, /hello/)
})

test("a streamed response body arrives whole", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/stream`)
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.equal(bytes.length, 8 * 8192)
  for (let piece = 0; piece < 8; piece++) {
    assert.equal(bytes[piece * 8192], piece + 1, `piece ${piece} has the wrong marker`)
  }
})

test("a client that hangs up mid-upload does not take the server with it", async () => {
  await new Promise<void>((resolve) => {
    const socket = connect(port, "127.0.0.1")
    socket.on("error", () => undefined)
    socket.once("connect", () => {
      // Announce 1 MB, send 8 bytes, vanish.
      socket.write("POST /echo HTTP/1.1\r\nHost: x\r\nContent-Length: 1048576\r\n\r\nabcdefgh")
      setTimeout(() => {
        socket.destroy()
        resolve()
      }, 40)
    })
  })
  await new Promise((resolve) => setTimeout(resolve, 60))
  // The next ordinary request is the assertion: the process is alive and the listener still serving.
  const response = await fetch(`http://127.0.0.1:${port}/hello`)
  assert.equal(await response.text(), "hello")
})

test("a client that abandons a streamed response mid-body does not take the server with it", async () => {
  for (let i = 0; i < 20; i++) {
    const abort = new AbortController()
    await fetch(`http://127.0.0.1:${port}/stream`, { signal: abort.signal })
      .then(async (response) => {
        await response.body?.getReader().read()
        abort.abort()
      })
      .catch(() => undefined)
  }
  await new Promise((resolve) => setTimeout(resolve, 100))
  const response = await fetch(`http://127.0.0.1:${port}/hello`)
  assert.equal(await response.text(), "hello")
})

test("json and text reads agree with the bytes that were sent", async () => {
  const payload = { name: "a-name", nested: { list: [1, 2, 3], flag: true } }
  const asJson = await fetch(`http://127.0.0.1:${port}/echo-json`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
  assert.deepEqual(await asJson.json(), payload)
})

test("SECURITY: the body cap still rejects an over-cap content-length body", async () => {
  // The cap is a security gate and it sits directly on the path this change touched: it is applied
  // while the body is read, and the body is now read through the replacement stream.
  const response = await fetch(`http://127.0.0.1:${cappedPort}/echo`, {
    method: "POST",
    body: Buffer.alloc(2 * 1024 * 1024),
  })
  assert.equal(response.ok, false)
  assert.deepEqual(await response.json(), { ok: false, error: "payload_too_large" })
})

test("an over-cap upload is answered, not reset, however far past the cap it runs", async () => {
  // The cap cancels the body read while the client is still uploading. Cancelling a request body by
  // destroying it destroys the socket with it, and the 413 the client needs never leaves - it sees a
  // connection reset instead. This asserts the answer arrives at sizes far past the cap, which is
  // where that failure showed up rather than at the boundary.
  for (const megabytes of [2, 8, 64]) {
    let sent = 0
    const response = await fetch(`http://127.0.0.1:${cappedPort}/echo`, {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= megabytes * 1024 * 1024) return controller.close()
          sent += 65536
          controller.enqueue(new Uint8Array(65536))
        },
      }),
      duplex: "half",
    } as RequestInit)
    assert.equal(response.status, 413, `${megabytes} MB body`)
    assert.deepEqual(await response.json(), { ok: false, error: "payload_too_large" })
    // And the rejection is not paid for by reading the whole thing: the response completing tears
    // the connection down, so a 64 MB body stops arriving a little past the 1 MB cap.
    assert.ok(sent < 8 * 1024 * 1024, `${megabytes} MB body: server absorbed ${sent} bytes`)
  }
})

test("SECURITY: the body cap still rejects an over-cap chunked body mid-stream", async () => {
  // No content-length, so nothing can be pre-checked: the cap has to fire on the running byte count
  // of the live stream. If laziness had turned the read into a buffer-then-check, this would pass
  // the whole 2 MB through memory before rejecting it.
  const response = await fetch(`http://127.0.0.1:${cappedPort}/echo`, {
    method: "POST",
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 32; i++) controller.enqueue(new Uint8Array(64 * 1024))
        controller.close()
      },
    }),
    duplex: "half",
  } as RequestInit)
  assert.equal(response.ok, false)
  assert.deepEqual(await response.json(), { ok: false, error: "payload_too_large" })
})

test("many sequential requests on fresh connections stay correct", async () => {
  // Real-world shape rather than an edge: the same route hit repeatedly, mixing bodied and bodiless
  // requests, so a stream left half-consumed by an earlier request would show up as a wrong answer.
  for (let i = 0; i < 100; i++) {
    const body = "y".repeat(i * 37)
    const [text, hello] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/echo-text`, { method: "POST", body }).then((r) => r.json()),
      fetch(`http://127.0.0.1:${port}/hello`).then((r) => r.text()),
    ])
    assert.deepEqual(text, { text: body }, `iteration ${i}`)
    assert.equal(hello, "hello", `iteration ${i}`)
  }
})

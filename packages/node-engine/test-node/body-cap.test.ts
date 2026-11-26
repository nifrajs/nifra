/** The request-body cap: where the engine refuses, and what the default follows. */

import assert from "node:assert/strict"
import { connect } from "node:net"
import { test } from "node:test"
import { server } from "@nifrajs/core"
import { bodyCeiling, serve } from "../src/index.ts"
import { parseHead } from "./support.ts"

const CHUNK = Buffer.alloc(100_000, 7)
const CHUNKS = 40

const echoLength = (options: { maxBodyBytes?: number } = {}) =>
  server(options).post("/echo-length", async (c) => ({
    length: (await c.req.arrayBuffer()).byteLength,
  }))

/** Send an upload as fast as the socket takes it; report what came back and how much was written. */
function upload(
  port: number,
  head: string,
  frame: (chunk: Buffer) => Buffer[],
  total = CHUNKS,
): Promise<{ text: string; sent: number }> {
  return new Promise((resolve) => {
    let sent = 0
    let text = ""
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(head)
      const timer = setInterval(() => {
        if (socket.destroyed || sent >= total) return clearInterval(timer)
        sent++
        for (const part of frame(CHUNK)) socket.write(part)
        if (sent === total && total < CHUNKS) socket.write("0\r\n\r\n")
      }, 2)
    })
    socket.on("data", (data) => {
      text += data.toString("latin1")
      // A kept-alive connection never closes: a complete JSON answer is the end.
      if (text.includes("}")) socket.destroy()
    })
    socket.on("close", () => resolve({ text, sent }))
    socket.on("error", () => {})
    setTimeout(() => socket.destroy(), 4000).unref()
  })
}

test("a chunked upload over the cap is refused with 413 as it passes the cap, not once it ends", async () => {
  const running = await serve(echoLength(), {
    port: 0,
    hostname: "127.0.0.1",
    maxBodySize: 1_000_000,
  })
  try {
    const { text, sent } = await upload(
      running.port,
      "POST /echo-length HTTP/1.1\r\nHost: x\r\ntransfer-encoding: chunked\r\n\r\n",
      (chunk) => [Buffer.from(`${chunk.length.toString(16)}\r\n`), chunk, Buffer.from("\r\n")],
    )
    assert.equal(parseHead(text).status, 413)
    assert.ok(sent < CHUNKS, `the server read all ${sent} chunks before refusing`)
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("a refusal reaches a client that is still sending when it is written", async () => {
  const running = await serve(echoLength(), {
    port: 0,
    hostname: "127.0.0.1",
    maxBodySize: 1_000_000,
  })
  try {
    // The client reads only after its writes: a close with unread input resets the connection and
    // takes the answer with it.
    const text = await new Promise<string>((resolve) => {
      let received = ""
      let rounds = 0
      const socket = connect(running.port, "127.0.0.1", () => {
        socket.pause()
        socket.write("POST /echo-length HTTP/1.1\r\nHost: x\r\ncontent-length: 8000000\r\n\r\n")
        const timer = setInterval(() => {
          if (++rounds <= 20 && !socket.destroyed) return void socket.write(CHUNK)
          clearInterval(timer)
          socket.resume()
        }, 5)
      })
      socket.on("data", (data) => {
        received += data.toString("latin1")
      })
      socket.on("error", () => {})
      socket.on("close", () => resolve(received))
      setTimeout(() => socket.destroy(), 4000).unref()
    })
    assert.equal(parseHead(text).status, 413)
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("a declared length over the cap is refused before any of the body is read", async () => {
  const running = await serve(echoLength(), {
    port: 0,
    hostname: "127.0.0.1",
    maxBodySize: 1_000_000,
  })
  try {
    const { text, sent } = await upload(
      running.port,
      `POST /echo-length HTTP/1.1\r\nHost: x\r\ncontent-length: ${CHUNK.length * CHUNKS}\r\n\r\n`,
      (chunk) => [chunk],
    )
    assert.equal(parseHead(text).status, 413)
    assert.ok(sent < 5, `${sent} chunks were sent into a refused upload`)
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("a body under the cap is read whole, chunked or not", async () => {
  const running = await serve(echoLength(), {
    port: 0,
    hostname: "127.0.0.1",
    maxBodySize: 1_000_000,
  })
  try {
    const sizes: number[] = []
    for (const body of [Buffer.alloc(900_000, 1), new Blob([Buffer.alloc(900_000, 2)]).stream()]) {
      const reply = await fetch(`http://127.0.0.1:${running.port}/echo-length`, {
        method: "POST",
        body,
        // @ts-expect-error undici needs this to send a stream
        duplex: "half",
      })
      const answer: unknown = await reply.json()
      if (typeof answer !== "object" || answer === null || !("length" in answer)) {
        throw new Error("no length in the answer")
      }
      sizes.push(Number(answer.length))
    }
    assert.deepEqual(sizes, [900_000, 900_000])
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("the default cap follows the app's maxBodyBytes when that is larger", async () => {
  const body = Buffer.alloc(2_000_000, 3)
  const send = (port: number) =>
    fetch(`http://127.0.0.1:${port}/echo-length`, { method: "POST", body })
  const followed = await serve(echoLength({ maxBodyBytes: 3_000_000 }), {
    port: 0,
    hostname: "127.0.0.1",
  })
  const pinned = await serve(echoLength({ maxBodyBytes: 3_000_000 }), {
    port: 0,
    hostname: "127.0.0.1",
    maxBodySize: 1_000_000,
  })
  try {
    assert.equal((await send(followed.port)).status, 200)
    assert.equal((await send(pinned.port)).status, 413)
  } finally {
    await followed.stop({ drainMs: 50 })
    await pinned.stop({ drainMs: 50 })
  }
})

test("bodyCeiling is the largest cap among the app and its mounts", () => {
  assert.equal(bodyCeiling({}), undefined)
  const root = server({ maxBodyBytes: 500 })
    .mount({ path: "/a", app: server({ maxBodyBytes: 9_000 }), stripPrefix: true })
    .mount({ path: "/b", app: server({ maxBodyBytes: 70 }), stripPrefix: true })
  assert.equal(bodyCeiling(root), 9_000)
})

const post = (port: number, body: BodyInit, path = "/echo-length") =>
  fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body })

test("a body a little over the cap is answered with the app's own 413 body", async () => {
  const running = await serve(echoLength(), {
    port: 0,
    hostname: "127.0.0.1",
    maxBodySize: 1_000_000,
  })
  const small = await serve(echoLength({ maxBodyBytes: 1000 }), { port: 0, hostname: "127.0.0.1" })
  try {
    const ours = await post(running.port, Buffer.alloc(1_500_000, 1))
    const apps = await post(small.port, Buffer.alloc(5000, 1))
    assert.equal(ours.status, 413)
    assert.equal(apps.status, 413)
    // The same status, content type and body, whichever side refused it.
    assert.equal(ours.headers.get("content-type"), apps.headers.get("content-type"))
    assert.equal(await ours.text(), await apps.text())
    // The connection and the server are intact afterwards.
    assert.equal((await post(running.port, "12345")).status, 200)
  } finally {
    await running.stop({ drainMs: 50 })
    await small.stop({ drainMs: 50 })
  }
})

test("a chunked body a little over the cap gets the same answer", async () => {
  const running = await serve(echoLength(), {
    port: 0,
    hostname: "127.0.0.1",
    maxBodySize: 1_000_000,
  })
  try {
    const { text } = await upload(
      running.port,
      "POST /echo-length HTTP/1.1\r\nHost: x\r\ntransfer-encoding: chunked\r\n\r\n",
      (chunk) => [Buffer.from(`${chunk.length.toString(16)}\r\n`), chunk, Buffer.from("\r\n")],
      15,
    )
    const reply = parseHead(text)
    assert.equal(reply.status, 413)
    assert.match(reply.body, /payload_too_large/)
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("a body far over the cap is still cut off, with the engine's empty 413", async () => {
  const running = await serve(echoLength(), {
    port: 0,
    hostname: "127.0.0.1",
    maxBodySize: 1_000_000,
  })
  try {
    const { text } = await upload(
      running.port,
      `POST /echo-length HTTP/1.1\r\nHost: x\r\ncontent-length: ${CHUNK.length * CHUNKS}\r\n\r\n`,
      (chunk) => [chunk],
    )
    const reply = parseHead(text)
    assert.equal(reply.status, 413)
    assert.equal(reply.body, "")
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("oversizeWindow sets how far past the cap a body still gets the app's 413 body", async () => {
  const run = (oversizeWindow: number) =>
    serve(echoLength(), { port: 0, hostname: "127.0.0.1", maxBodySize: 1_000_000, oversizeWindow })
  const narrow = await run(200_000)
  const off = await run(0)
  try {
    const within = await post(narrow.port, Buffer.alloc(1_100_000, 1))
    assert.equal(within.status, 413)
    assert.match(await within.text(), /payload_too_large/)
    const past = await upload(
      narrow.port,
      `POST /echo-length HTTP/1.1\r\nHost: x\r\ncontent-length: 1300000\r\n\r\n`,
      (chunk) => [chunk],
    )
    assert.equal(parseHead(past.text).status, 413)
    assert.equal(parseHead(past.text).body, "")

    // With no window every body over the cap is refused natively, and nothing measures a body.
    const refused = await upload(
      off.port,
      `POST /echo-length HTTP/1.1\r\nHost: x\r\ncontent-length: 1100000\r\n\r\n`,
      (chunk) => [chunk],
    )
    assert.equal(parseHead(refused.text).status, 413)
    assert.equal(parseHead(refused.text).body, "")
    assert.equal((await post(off.port, Buffer.alloc(900_000, 1))).status, 200)
  } finally {
    await narrow.stop({ drainMs: 50 })
    await off.stop({ drainMs: 50 })
  }
})

test("a cap or window that is not a whole number is refused up front", () => {
  const app = echoLength()
  for (const oversizeWindow of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => serve(app, { port: 0, oversizeWindow }), /oversizeWindow/)
  }
  for (const maxBodySize of [0, -5, 2.5]) {
    assert.throws(() => serve(app, { port: 0, maxBodySize }), /maxBodySize/)
  }
})

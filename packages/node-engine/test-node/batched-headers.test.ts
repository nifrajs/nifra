/** Responses with their own headers leave through the batched writer: the wire must not change. */

import assert from "node:assert/strict"
import { connect } from "node:http2"
import { createConnection } from "node:net"
import { after, before, test } from "node:test"
import { server } from "@nifrajs/core"
import { type EngineServer, serve } from "../src/index.ts"
import { parseHead, raw } from "./support.ts"

let running: EngineServer

const app = () =>
  server()
    .get("/headers", (c) => {
      c.set.headers["x-a"] = "1"
      c.set.headers["x-colon"] = "a: b"
      c.set.headers["x-latin"] = "café"
      return { text: "é€" }
    })
    .get("/owned", (c) => {
      c.set.headers["content-length"] = "999"
      c.set.headers.date = "never"
      return { ok: true }
    })
    .get("/type", (c) => {
      c.set.headers["Content-Type"] = "application/problem+json"
      return { ok: false }
    })
    .get("/created", (c) => {
      c.set.status = 201
      c.set.headers["x-a"] = "1"
      return { made: 1 }
    })
    .get("/cookies", (c) => {
      c.set.cookie("a", "1")
      c.set.cookie("b", "2")
      return { ok: true }
    })
    .get("/bad-value", (c) => {
      c.set.headers["x-bad"] = "a\r\nx-injected: 1"
      return { ok: true }
    })
    .get("/bad-name", (c) => {
      c.set.headers["bad name"] = "v"
      return { ok: true }
    })
    .get("/bad-async", async (c) => {
      await null
      c.set.headers["x-bad"] = "a\nb"
      return { ok: true }
    })
    .get("/sized/:size/:id", async (c) => {
      await null
      c.set.headers["x-id"] = c.params.id
      return { fill: c.params.id.repeat(Number(c.params.size)) }
    })

before(async () => {
  running = await serve(app(), { port: 0, hostname: "127.0.0.1" })
})

after(() => running.stop())

const request = (path: string, close = true): string =>
  `GET ${path} HTTP/1.1\r\nHost: h\r\n${close ? "Connection: close\r\n" : ""}\r\n`

const get = async (path: string) => parseHead(await raw(running.port, request(path), () => false))

/** `raw` decodes latin1, so a body is turned back into its bytes before it is read as UTF-8. */
const json = (body: string): unknown => JSON.parse(Buffer.from(body, "latin1").toString("utf8"))

test("custom headers are written as set, and the length counts the body's bytes", async () => {
  const { status, headers, body } = await get("/headers")
  assert.equal(status, 200)
  assert.deepEqual(headers.get("x-a"), ["1"])
  assert.deepEqual(headers.get("x-colon"), ["a: b"])
  assert.deepEqual(headers.get("x-latin"), [Buffer.from("café").toString("latin1")])
  assert.deepEqual(headers.get("content-type"), ["application/json"])
  assert.deepEqual(headers.get("content-length"), [String(body.length)])
  assert.deepEqual(json(body), { text: "é€" })
})

test("framing headers stay the engine's, and a set Content-Type replaces the default", async () => {
  const owned = await get("/owned")
  assert.deepEqual(owned.headers.get("content-length"), [String(owned.body.length)])
  assert.equal(owned.headers.get("date")?.length, 1)
  assert.notEqual(owned.headers.get("date")?.[0], "never")
  assert.deepEqual((await get("/type")).headers.get("content-type"), ["application/problem+json"])
})

test("a status and every cookie are kept", async () => {
  assert.equal((await get("/created")).status, 201)
  assert.equal((await get("/cookies")).headers.get("set-cookie")?.length, 2)
})

test("a header that cannot be written answers 500 and injects nothing", async () => {
  for (const path of ["/bad-value", "/bad-name", "/bad-async"]) {
    const { status, headers } = await get(path)
    assert.equal(status, 500, path)
    assert.equal(headers.has("x-injected"), false, path)
  }
})

test("pipelined responses keep request order", async () => {
  const received = await raw(
    running.port,
    `${request("/sized/1/a", false)}${request("/headers", false)}${request("/sized/1/b")}`,
  )
  const marks = [...received.matchAll(/x-id: (\w)|x-a: 1/g)].map((m) => m[1] ?? "headers")
  assert.deepEqual(marks, ["a", "headers", "b"])
})

// 300k stays batched and fills the shared buffer several times over; 800k and 3M take the other writers.
test("concurrent responses keep their own headers and bodies over HTTP/1.1 and HTTP/2", async () => {
  const cases = Array.from({ length: 24 }, (_, i) => ({
    id: String.fromCharCode(97 + i),
    size: i === 22 ? 800_000 : i === 23 ? 3_000_000 : 300_000,
  }))
  await Promise.all(
    cases.map(async ({ id, size }) => {
      const response = await fetch(`http://127.0.0.1:${running.port}/sized/${size}/${id}`)
      assert.equal(response.headers.get("x-id"), id)
      assert.deepEqual(await response.json(), { fill: id.repeat(size) })
    }),
  )

  const h2 = await serve(app(), { port: 0, hostname: "127.0.0.1", http2: true })
  const session = connect(`http://127.0.0.1:${h2.port}`)
  try {
    await Promise.all(
      cases.map(
        ({ id, size }) =>
          new Promise<void>((resolve, reject) => {
            const stream = session.request({ ":path": `/sized/${size}/${id}` })
            let head: unknown
            let text = ""
            stream.setEncoding("utf8")
            stream.on("response", (headers) => {
              head = headers["x-id"]
            })
            stream.on("data", (chunk: string) => {
              text += chunk
            })
            stream.on("end", () => {
              try {
                assert.equal(head, id)
                assert.equal(text, JSON.stringify({ fill: id.repeat(size) }))
                resolve()
              } catch (error) {
                reject(error)
              }
            })
            stream.on("error", reject)
          }),
      ),
    )
  } finally {
    session.close()
    await h2.stop()
  }
})

test("a response over the buffer limit waits for a stalled reader", async () => {
  const capped = await serve(app(), {
    port: 0,
    hostname: "127.0.0.1",
    engine: { writeHighWaterMark: 4096, responseBackpressureLimit: 65_536 },
  })
  const socket = createConnection(capped.port, "127.0.0.1")
  try {
    socket.pause()
    socket.write(request("/sized/600000/7"))
    // Answered after the stalled request, so the server has written all it can to that one.
    for (let i = 0; i < 2; i++) await fetch(`http://127.0.0.1:${capped.port}/created`)
    const chunks: Buffer[] = []
    await new Promise<void>((resolve, reject) => {
      socket.on("data", (chunk: Buffer) => chunks.push(chunk))
      socket.on("end", resolve)
      socket.on("error", reject)
      socket.resume()
    })
    const { headers, body } = parseHead(Buffer.concat(chunks).toString("latin1"))
    assert.deepEqual(headers.get("x-id"), ["7"])
    assert.equal(body.length, JSON.stringify({ fill: "7".repeat(600_000) }).length)
  } finally {
    socket.destroy()
    await capped.stop()
  }
})

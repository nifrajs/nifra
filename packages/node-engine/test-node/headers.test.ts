import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { server } from "@nifrajs/core"
import { type EngineServer, serve } from "../src/index.ts"
import { parseHead, raw } from "./support.ts"

let running: EngineServer

before(async () => {
  const app = server()
    .get("/h", (c) => ({
      cookie: c.header("cookie"),
      repeated: c.header("x-a"),
      type: c.header("content-type"),
      all: [...c.req.headers.keys()].sort(),
      url: c.req.url,
    }))
    .post("/t", (c) => ({
      type: c.header("content-type"),
      length: c.header("content-length"),
      encoding: c.header("transfer-encoding"),
    }))
  running = await serve(app, { port: 0, hostname: "127.0.0.1" })
})

after(() => running.stop())

const get = (extra: string): Promise<string> =>
  raw(
    running.port,
    `GET /h HTTP/1.1\r\nHost: example.test:8080\r\n${extra}Connection: close\r\n\r\n`,
    (r) => r.includes("}"),
  )

test("a header outside the single-call set is read from the whole list, repeats joined", async () => {
  const { status, body } = parseHead(await get("X-A: 1\r\nX-A: 2\r\nCookie: a=1\r\n"))
  assert.equal(status, 200)
  const seen = JSON.parse(body)
  assert.equal(seen.repeated, "1, 2")
  assert.equal(seen.cookie, "a=1")
  assert.deepEqual(seen.all, ["connection", "cookie", "host", "x-a"])
  assert.equal(seen.url, "http://example.test:8080/h")
})

test("a repeated Content-Type reads as its first value, as on Node", async () => {
  const { body } = parseHead(
    await get("Content-Type: application/json\r\nContent-Type: text/plain\r\n"),
  )
  assert.equal(JSON.parse(body).type, "application/json")
})

test("a header read after the whole list was read agrees with the list", async () => {
  const { body } = parseHead(await get("Content-Type: text/x\r\nX-A: 1\r\n"))
  const seen = JSON.parse(body)
  assert.equal(seen.type, "text/x")
  assert.equal(seen.repeated, "1")
})

test("body headers of a POST come from the request", async () => {
  const { body } = parseHead(
    await raw(
      running.port,
      "POST /t HTTP/1.1\r\nHost: h\r\nContent-Type: text/x\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi",
      (r) => r.includes("}"),
    ),
  )
  assert.deepEqual(JSON.parse(body), { type: "text/x", length: "2", encoding: null })
})

test("a chunked POST reports its transfer coding and no length", async () => {
  const { body } = parseHead(
    await raw(
      running.port,
      "POST /t HTTP/1.1\r\nHost: h\r\nContent-Type: text/x\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n2\r\nhi\r\n0\r\n\r\n",
      (r) => r.includes("}"),
    ),
  )
  assert.deepEqual(JSON.parse(body), { type: "text/x", length: null, encoding: "chunked" })
})

test("Content-Type is the header's value whether or not the request has a body", async () => {
  const send = async (head: string, body: string): Promise<unknown> => {
    const { body: text } = parseHead(
      await raw(
        running.port,
        `POST /t HTTP/1.1\r\nHost: h\r\n${head}Content-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
        (r) => r.includes("}"),
      ),
    )
    return JSON.parse(text).type
  }
  assert.equal(await send("Content-Type: text/x\r\n", "hi"), "text/x")
  assert.equal(await send("Content-Type: text/x\r\n", ""), "text/x")
  assert.equal(await send("", "hi"), null)
  assert.equal(await send("", ""), null)
})

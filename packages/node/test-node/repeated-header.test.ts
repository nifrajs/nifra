/**
 * A field sent twice reaches the app as Fetch's `Headers` hands it over on Bun, Deno and Workers: every
 * value, joined with ", ". Node keeps only the first of a field it treats as a singleton (Content-Type,
 * Authorization, User-Agent), so the same bytes were JSON here and an unsupported media type there.
 * Found by scripts/check-runtime-differential.ts.
 */

import assert from "node:assert/strict"
import { connect } from "node:net"
import { after, before, test } from "node:test"
import type { StandardSchemaV1 } from "@nifrajs/core"
import { server } from "@nifrajs/core"
import { serve } from "@nifrajs/node"

const anything: StandardSchemaV1<unknown, unknown> = {
  "~standard": { version: 1, vendor: "test", validate: (value) => ({ value }) },
}

let port = 0
let stop: (() => Promise<void>) | undefined

before(async () => {
  const app = server()
    .post("/echo", (c) => ({
      type: c.header("content-type"),
      agent: c.req.headers.get("user-agent"),
    }))
    .post("/items", { body: anything }, (c) => ({ body: c.body }))
    .get("/fields", (c) => ({
      caller: c.req.headers.get("x-caller"),
      fast: c.header("x-caller"),
      empty: c.req.headers.get("x-empty"),
      cookie: c.req.headers.get("cookie"),
    }))
  const running = await serve(app, { hostname: "127.0.0.1", port: 0 })
  port = running.port
  stop = () => running.stop()
})

after(async () => {
  await stop?.()
})

function exchange(
  path: string,
  hosts: readonly string[] = ["127.0.0.1"],
): Promise<{ status: number; body: string }> {
  const body = '{"a":1}'
  return send([
    `POST ${path} HTTP/1.1`,
    ...hosts.map((host) => `Host: ${host}`),
    "Content-Type: application/json",
    "Content-Type: application/json",
    "User-Agent: one",
    "User-Agent: two",
    `Content-Length: ${body.length}`,
    "Connection: close",
    "",
    body,
  ])
}

function send(lines: readonly string[]): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1")
    let received = ""
    socket.on("connect", () => {
      socket.write(lines.join("\r\n"))
    })
    socket.setEncoding("latin1")
    socket.on("data", (chunk: string) => {
      received += chunk
    })
    socket.on("error", reject)
    socket.on("end", () => {
      const [head = "", body = ""] = received.split("\r\n\r\n")
      resolve({ status: Number(head.split(" ")[1]), body })
    })
  })
}

test("a repeated Content-Type and User-Agent read as every value, joined", async () => {
  const echoed = await exchange("/echo")
  assert.equal(echoed.status, 200)
  assert.deepEqual(JSON.parse(echoed.body), {
    type: "application/json, application/json",
    agent: "one, two",
  })
})

test("a repeated Content-Type is not a JSON body", async () => {
  const refused = await exchange("/items")
  assert.equal(refused.status, 415)
})

// Joined, the app would read both authorities from Host while the request was routed on the first.
test("a repeated Host is a 400", async () => {
  const refused = await exchange("/echo", ["127.0.0.1", "other.example"])
  assert.equal(refused.status, 400)
})

// `Headers` strips the whitespace around each value it is given, so the joined "a\tb, " read back
// as "a\tb," on Node only.
test("a repeated field whose last value is empty keeps the join's trailing space", async () => {
  const echoed = await send([
    "GET /fields HTTP/1.1",
    "Host: 127.0.0.1",
    "X-Caller: a\tb",
    "X-Caller:",
    "X-Empty:",
    "X-Empty:",
    "Cookie: a=1",
    "Cookie:",
    "Connection: close",
    "",
    "",
  ])
  assert.equal(echoed.status, 200)
  assert.deepEqual(JSON.parse(echoed.body), {
    caller: "a\tb, ",
    fast: "a\tb, ",
    empty: ", ",
    cookie: "a=1; ",
  })
})

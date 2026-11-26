/** What reaches the wire: large TLS answers, repeated cookie fields and pipelined order. */

import assert from "node:assert/strict"
import { request as httpsRequest } from "node:https"
import { connect } from "node:net"
import { test } from "node:test"
import { server } from "@nifrajs/core"
import { selfSignedCertificate } from "../../../internal/test-utils/src/tls.ts"
import { serve } from "../src/index.ts"
import { raw } from "./support.ts"

const loopback = { port: 0, hostname: "127.0.0.1" }

test("a TLS response larger than the record buffer arrives whole", async () => {
  const { cert, key } = await selfSignedCertificate()
  const text = "x".repeat(300_000)
  const running = await serve(
    server().get("/large", () => new Response(text)),
    { ...loopback, tls: { cert, key } },
  )
  try {
    const received = await new Promise<string>((resolve, reject) => {
      const req = httpsRequest(
        {
          host: "127.0.0.1",
          port: running.port,
          path: "/large",
          ca: cert,
          servername: "localhost",
        },
        (res) => {
          let body = ""
          res.setEncoding("utf8")
          res.on("data", (chunk) => {
            body += chunk
          })
          res.on("end", () => resolve(body))
          res.on("error", reject)
        },
      )
      req.on("error", reject)
      req.end()
    })
    assert.equal(received.length, text.length)
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("repeated Cookie fields are joined as cookie pairs", async () => {
  const running = await serve(
    server().get("/cookie", (c) => ({ header: c.req.headers.get("cookie"), seen: c.cookies })),
    loopback,
  )
  try {
    const reply = await raw(
      running.port,
      "GET /cookie HTTP/1.1\r\nHost: x\r\ncookie: session=abc\r\ncookie: theme=dark\r\nconnection: close\r\n\r\n",
    )
    assert.match(reply, /"session":"abc"/)
    assert.match(reply, /"theme":"dark"/)
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

test("pipelined answers keep request order when a finished request's id is used again", async () => {
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const app = server()
    .get("/slow", async () => {
      await gate
      return "answer-a"
    })
    .get("/b", () => "answer-b")
    .get("/d", async () => {
      queueMicrotask(release)
      return "answer-d"
    })
  const running = await serve(app, loopback)
  const get = (path: string): string => `GET ${path} HTTP/1.1\r\nHost: x\r\n\r\n`
  try {
    const received = await new Promise<string>((resolve) => {
      let text = ""
      const socket = connect(running.port, "127.0.0.1", () => {
        socket.write(get("/slow") + get("/b"))
        // A later read, so `/b` has finished and given its id back.
        setTimeout(() => socket.write(get("/b") + get("/d")), 50)
      })
      socket.on("data", (data) => {
        text += data.toString("latin1")
        if (text.includes("answer-d")) socket.end()
      })
      socket.on("close", () => resolve(text))
      socket.on("error", () => {})
      setTimeout(() => socket.destroy(), 3000).unref()
    })
    assert.deepEqual(received.match(/answer-[abd]/g), [
      "answer-a",
      "answer-b",
      "answer-b",
      "answer-d",
    ])
  } finally {
    await running.stop({ drainMs: 50 })
  }
})

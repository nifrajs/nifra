import { afterEach, expect, test } from "bun:test"
import { connect } from "node:net"
import { server } from "@nifrajs/core"
import { type NodeServer, serve } from "../src/index.ts"

/**
 * A repeated field whose last value is empty joins to "a, ". `Headers` strips the whitespace around
 * each value it is given, so the adapter's joined record read back as "a," while Bun and Deno keep
 * "a, ". Found by scripts/check-runtime-differential.ts; test-node/repeated-header.test.ts runs the
 * same bytes on Node.
 */

let running: NodeServer | undefined
afterEach(async () => {
  await running?.stop({ drainMs: 0 })
  running = undefined
})

function send(port: number, lines: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(lines.join("\r\n"))
    })
    let text = ""
    socket.setEncoding("latin1")
    socket.on("data", (chunk: string) => {
      text += chunk
    })
    socket.on("end", () => resolve(text.split("\r\n\r\n")[1] ?? ""))
    socket.on("error", reject)
  })
}

test("a repeated field whose last value is empty keeps the join's trailing space", async () => {
  const app = server().get("/fields", (c) => ({
    caller: c.req.headers.get("x-caller"),
    empty: c.req.headers.get("x-empty"),
    cookie: c.req.headers.get("cookie"),
    plain: c.req.headers.get("x-plain"),
    setCookie: c.req.headers.getSetCookie(),
  }))
  running = await serve(app, { hostname: "127.0.0.1", port: 0 })
  const body = await send(running.port, [
    "GET /fields HTTP/1.1",
    "Host: 127.0.0.1",
    "X-Caller: a\tb",
    "X-Caller:",
    "X-Empty:",
    "X-Empty:",
    "Cookie: a=1",
    "Cookie:",
    "X-Plain: one",
    "Set-Cookie: s=1",
    "Set-Cookie: s=2",
    "Connection: close",
    "",
    "",
  ])
  expect(JSON.parse(body)).toEqual({
    caller: "a\tb, ",
    empty: ", ",
    cookie: "a=1; ",
    plain: "one",
    setCookie: ["s=1", "s=2"],
  })
})

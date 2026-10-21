/**
 * A body read through `c.req.body` before anything forced the Web `Request`: `signal`, `bodyUsed`
 * and the other non-body members must still answer, as `@nifrajs/mcp` reads them after its reader.
 */

import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { server } from "@nifrajs/core"
import { createMcpServer } from "@nifrajs/mcp"
import { serve } from "@nifrajs/node"

let base = ""
let stop: (() => Promise<void>) | undefined

const readAll = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
  const decoder = new TextDecoder()
  let text = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text + decoder.decode()
    text += decoder.decode(value, { stream: true })
  }
}

before(async () => {
  const mcp = createMcpServer({ name: "node-adapter", version: "1.0.0" })
  const app = server()
    .post("/read", async (c) => {
      const text = await readAll((c.req.body as ReadableStream<Uint8Array>).getReader())
      return { text, aborted: c.req.signal.aborted, bodyUsed: c.req.bodyUsed }
    })
    .post("/cancel", async (c) => {
      await c.req.body?.cancel()
      return { aborted: c.req.signal.aborted, bodyUsed: c.req.bodyUsed }
    })
    .post("/locked", async (c) => {
      const reader = (c.req.body as ReadableStream<Uint8Array>).getReader()
      const aborted = c.req.signal.aborted
      return { aborted, text: await readAll(reader), bodyUsed: c.req.bodyUsed }
    })
    .post("/mcp", (c) => mcp.fetch(c.req))
  const running = await serve(app, { hostname: "127.0.0.1", port: 0 })
  base = `http://127.0.0.1:${running.port}`
  stop = () => running.stop()
})

after(async () => {
  await stop?.()
})

const post = (path: string, body: string, headers?: Record<string, string>) =>
  fetch(`${base}${path}`, { method: "POST", body, ...(headers === undefined ? {} : { headers }) })

test("a body drained through its reader leaves signal and bodyUsed readable", async () => {
  const response = await post("/read", "hello")
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { text: "hello", aborted: false, bodyUsed: true })
})

test("a cancelled body stream reads as used", async () => {
  const response = await post("/cancel", "hello")
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { aborted: false, bodyUsed: true })
})

test("signal read between getReader and the first read still delivers the whole body", async () => {
  const response = await post("/locked", "hello")
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { aborted: false, text: "hello", bodyUsed: true })
})

test("an MCP POST mounted through mcp.fetch(c.req) answers", async () => {
  const response = await post(
    "/mcp",
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    { "content-type": "application/json" },
  )
  assert.equal(response.status, 200)
  const reply = (await response.json()) as { id: number; result: { serverInfo: { name: string } } }
  assert.equal(reply.id, 1)
  assert.equal(reply.result.serverInfo.name, "node-adapter")
})

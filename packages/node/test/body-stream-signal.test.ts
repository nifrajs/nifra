import { afterAll, beforeAll, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { type NodeServer, serve } from "../src/index.ts"

let running: NodeServer | undefined
let base = ""

const readAll = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
  const decoder = new TextDecoder()
  let text = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text + decoder.decode()
    text += decoder.decode(value, { stream: true })
  }
}

const readerOf = (
  body: ReadableStream<Uint8Array> | null,
): ReadableStreamDefaultReader<Uint8Array> => {
  if (body === null) throw new Error("the request carries no body")
  return body.getReader()
}

beforeAll(async () => {
  const app = server()
    .post("/read", async (c) => {
      const text = await readAll(readerOf(c.req.body))
      return { text, aborted: c.req.signal.aborted, bodyUsed: c.req.bodyUsed }
    })
    .post("/cancel", async (c) => {
      await c.req.body?.cancel()
      return { aborted: c.req.signal.aborted, bodyUsed: c.req.bodyUsed }
    })
  running = await serve(app, { hostname: "127.0.0.1", port: 0 })
  base = `http://127.0.0.1:${running.port}`
})

afterAll(async () => {
  await running?.stop()
})

test("a body drained through its reader leaves signal and bodyUsed readable", async () => {
  const response = await fetch(`${base}/read`, { method: "POST", body: "hello" })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ text: "hello", aborted: false, bodyUsed: true })
})

test("a cancelled body stream reads as used", async () => {
  const response = await fetch(`${base}/cancel`, { method: "POST", body: "hello" })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ aborted: false, bodyUsed: true })
})

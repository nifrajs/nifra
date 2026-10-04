/**
 * A hook that reads `c.req` before an auth-first route's body schema runs: on Node the transport
 * cap's raw readers buffer the socket, and the schema stage must parse those same bytes.
 */
import assert from "node:assert/strict"
import { request } from "node:http"
import { after, before, test } from "node:test"
import { server } from "@nifrajs/core"
import { serve } from "@nifrajs/node"

const named = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) =>
      typeof value === "object" && value !== null && "a" in value
        ? { value }
        : { issues: [{ message: "a is required" }] },
  },
} as const

let base = ""
let streamedBase = ""
const stops: Array<() => Promise<void>> = []
const peeks: unknown[] = []
const details: unknown[] = []

before(async () => {
  const app = server()
    .derive(async (c) => {
      peeks.push(await c.req.text())
      return {}
    })
    .post(
      "/hook",
      { body: named, validationOrder: "auth-before-validation", bodyLimit: 1024 },
      (c) => ({ body: c.body }),
    )
  const running = await serve(app, { port: 0, hostname: "127.0.0.1" })
  base = `http://127.0.0.1:${running.port}`
  stops.push(() => running.stop())

  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (_message: string, fields?: Record<string, unknown>) => {
      details.push(fields?.detail)
    },
  }
  const streaming = server({ logger })
    .derive(async (c) => {
      const reader = c.req.body?.getReader()
      if (reader !== undefined) for (;;) if ((await reader.read()).done) break
      return {}
    })
    .post(
      "/hook",
      { body: named, validationOrder: "auth-before-validation", bodyLimit: 1024 },
      (c) => ({ body: c.body }),
    )
  const streamedRunning = await serve(streaming, { port: 0, hostname: "127.0.0.1" })
  streamedBase = `http://127.0.0.1:${streamedRunning.port}`
  stops.push(() => streamedRunning.stop())
})

after(() => Promise.all(stops.map((stop) => stop())))

function post(chunked: boolean, to = base): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = '{"a":"node"}'
    const req = request(
      `${to}/hook`,
      {
        method: "POST",
        headers: chunked
          ? { "content-type": "application/json", "transfer-encoding": "chunked" }
          : { "content-type": "application/json", "content-length": String(payload.length) },
      },
      (res) => {
        let text = ""
        res.setEncoding("utf8")
        res.on("data", (chunk: string) => {
          text += chunk
        })
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }))
      },
    )
    req.on("error", reject)
    req.end(payload)
  })
}

test("the body schema parses a framed body a hook already read", async () => {
  const res = await post(false)
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.text), { body: { a: "node" } })
})

test("the body schema parses a chunked body a hook already read", async () => {
  const res = await post(true)
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.text), { body: { a: "node" } })
  assert.deepEqual(peeks, ['{"a":"node"}', '{"a":"node"}'])
})

test("a body a hook streamed through c.req.body fails the schema after it, naming the fix", async () => {
  assert.equal((await post(false, streamedBase)).status, 500)
  assert.equal((await post(true, streamedBase)).status, 500)
  assert.equal(details.length, 2)
  for (const detail of details) assert.match(String(detail), /c\.req\.bytes\(\)/)
})

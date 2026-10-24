import { afterEach, expect, test } from "bun:test"
import { server, silentLogger, status } from "@nifrajs/core"
import { type NodeServer, serve } from "../src/index.ts"

/**
 * The adapter writes a handler's JSON itself on its direct lanes, with its generated copy of core's
 * writer, so a `bigint` is the same decimal string here as through `app.fetch`.
 */

let running: NodeServer | undefined
afterEach(async () => {
  await running?.stop({ drainMs: 0 })
  running = undefined
})

test("a bigint in an answer is its decimal string on every lane the adapter writes", async () => {
  const id = 9007199254740993n
  const app = server()
    .get("/bare", () => ({ id }))
    .get("/status", () => status(201, { id }))
    .get("/thrown", () => {
      throw status(409, { id })
    })
    .get("/json", (c) => c.json({ id }, { status: 202 }))
    .derive(() => ({ who: "a" }))
    .beforeHandle(() => undefined)
    .get("/lifecycle", (c) => ({ id, who: c.who }))
  running = await serve(app, { hostname: "127.0.0.1", port: 0 })
  const base = `http://127.0.0.1:${running.port}`
  for (const [path, code, text] of [
    ["/bare", 200, '{"id":"9007199254740993"}'],
    ["/status", 201, '{"id":"9007199254740993"}'],
    ["/thrown", 409, '{"id":"9007199254740993"}'],
    ["/json", 202, '{"id":"9007199254740993"}'],
    ["/lifecycle", 200, '{"id":"9007199254740993","who":"a"}'],
  ] as const) {
    const response = await fetch(`${base}${path}`)
    expect({ path, status: response.status, text: await response.text() }).toEqual({
      path,
      status: code,
      text,
    })
  }
})

test("a value the writer still cannot write is the flat 500, whatever made it fail", async () => {
  const cycle: Record<string, unknown> = { id: 1n }
  cycle.self = cycle
  const hook = {
    toJSON() {
      throw new RangeError("hook")
    },
  }
  const app = server({ logger: silentLogger })
    .get("/cycle", () => cycle)
    .get("/hook", () => hook)
  running = await serve(app, { hostname: "127.0.0.1", port: 0 })
  for (const path of ["/cycle", "/hook"]) {
    const response = await fetch(`http://127.0.0.1:${running.port}${path}`)
    expect({ path, status: response.status, body: await response.json() }).toEqual({
      path,
      status: 500,
      body: { ok: false, error: "internal_error" },
    })
  }
})

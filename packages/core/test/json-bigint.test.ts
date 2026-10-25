import { describe, expect, test } from "bun:test"
import { type StandardSchemaV1, server, silentLogger, status } from "../src/index.ts"
import { jsonResponse } from "../src/server/json-response.ts"
import { jsonText } from "../src/server/json-text.ts"
import { streaming } from "../src/server/sse.ts"
import { plainJsonCodec } from "../src/transport-codec.ts"

/**
 * A `bigint` in a JSON answer is written as its decimal string. `JSON.stringify` throws on one, which
 * made every route returning a database's 64-bit id a 500; each lane below writes JSON its own way, so
 * each is asserted.
 */

const ID = 9007199254740993n

const anything: StandardSchemaV1<unknown, unknown> = {
  "~standard": { version: 1, vendor: "test", validate: (value) => ({ value }) },
}

async function body(app: { fetch(request: Request): Response | Promise<Response> }, path: string) {
  const response = await app.fetch(new Request(`http://t${path}`))
  return { status: response.status, text: await response.text() }
}

describe("a bigint in a JSON answer", () => {
  test("is its decimal string on every lane", async () => {
    const app = server({ logger: silentLogger })
      .get("/bare", () => ({ id: ID, ids: [1n, -2n], at: new Date(0) }))
      .get("/top", () => ID)
      .get("/status", () => status(201, { id: ID }))
      .get("/json", (c) => c.json({ id: ID }, { status: 202, headers: { "x-kept": "1" } }))
      .get("/thrown", () => {
        throw status(409, { id: ID })
      })
      .derive(() => ({ who: "a" }))
      .get("/derived", async (c) => ({ id: ID, who: c.who }))

    expect(await body(app, "/bare")).toEqual({
      status: 200,
      text: '{"id":"9007199254740993","ids":["1","-2"],"at":"1970-01-01T00:00:00.000Z"}',
    })
    expect(await body(app, "/top")).toEqual({ status: 200, text: '"9007199254740993"' })
    expect(await body(app, "/status")).toEqual({ status: 201, text: '{"id":"9007199254740993"}' })
    const reply = await app.fetch(new Request("http://t/json"))
    expect(reply.status).toBe(202)
    expect(reply.headers.get("x-kept")).toBe("1")
    expect(await reply.text()).toBe('{"id":"9007199254740993"}')
    expect(await body(app, "/thrown")).toEqual({ status: 409, text: '{"id":"9007199254740993"}' })
    expect(await body(app, "/derived")).toEqual({
      status: 200,
      text: '{"id":"9007199254740993","who":"a"}',
    })
  })

  test("takes the static-header lane too", async () => {
    const app = server()
      .use({ name: "tag", responseHeaders: { "x-tag": "1" } })
      .get("/", () => ({ id: ID }))
    const response = await app.fetch(new Request("http://t/"))
    expect(response.headers.get("x-tag")).toBe("1")
    expect(await response.text()).toBe('{"id":"9007199254740993"}')
  })

  test("reaches an SSE event", async () => {
    const app = server()
      .use(streaming())
      .sse("/feed", { sse: anything }, (_c, stream) => {
        stream.send({ id: ID })
        stream.close()
      })
    const text = await (await app.fetch(new Request("http://t/feed"))).text()
    expect(text).toContain('data: {"id":"9007199254740993"}')
  })

  test("a cycle is still the 500 it was", async () => {
    const app = server({ logger: silentLogger }).get("/", () => {
      const node: Record<string, unknown> = { id: 1n }
      node.self = node
      return node
    })
    expect((await body(app, "/")).status).toBe(500)
  })
})

describe("jsonText and jsonResponse", () => {
  test("leave a value without a bigint as JSON.stringify and Response.json write it", async () => {
    const value = { a: 1, b: [true, null], c: "x" }
    expect(jsonText(value)).toBe(JSON.stringify(value))
    expect(jsonText(undefined)).toBeUndefined()
    const response = jsonResponse(value, { status: 201 })
    expect(response.status).toBe(201)
    expect(response.headers.get("content-type")).toBe(Response.json(0).headers.get("content-type"))
    expect(await response.text()).toBe(JSON.stringify(value))
  })

  test("keep the runtime's content-type and errors on the retry", async () => {
    const response = jsonResponse({ id: 1n })
    expect(response.headers.get("content-type")).toBe(Response.json(0).headers.get("content-type"))
    expect(await response.text()).toBe('{"id":"1"}')
    expect(() => jsonResponse(() => 1n)).toThrow(TypeError)
  })

  test("report the first error when the retry fails as well", () => {
    const cycle: Record<string, unknown> = { id: 1n }
    cycle.self = cycle
    let first = ""
    try {
      JSON.stringify(cycle)
    } catch (error) {
      if (error instanceof Error) first = error.message
    }
    expect(first).not.toBe("")
    expect(() => jsonText(cycle)).toThrow(first)
    const broken = {
      toJSON() {
        throw new RangeError("hook")
      },
    }
    // Not a TypeError: thrown as it is, without running the hook a second time.
    let calls = 0
    const counted = {
      toJSON() {
        calls++
        throw new RangeError("counted")
      },
    }
    expect(() => jsonText(broken)).toThrow("hook")
    expect(() => jsonResponse(broken)).toThrow("hook")
    expect(() => jsonText(counted)).toThrow("counted")
    expect(calls).toBe(1)
  })

  test("the plain transport codec writes a bigint the same way", () => {
    expect(plainJsonCodec.encode({ id: 2n })).toBe('{"id":"2"}')
  })
})

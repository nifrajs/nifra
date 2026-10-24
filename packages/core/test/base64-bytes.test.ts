import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { t as form } from "@nifrajs/schema/form"
import { fromPrecompiled } from "@nifrajs/schema/precompiled"
import { RouteConfigError } from "../src/errors.ts"
import { server, silentLogger, status } from "../src/index.ts"
import { responseContract } from "../src/server/response-contract-lane.ts"
import { streaming } from "../src/server/sse.ts"

/**
 * `t.bytes()` in a response schema: every `Uint8Array` the handler answers with is written as base64.
 * Each kind of answer (a plain value, `status(...)`, `c.json(...)`, a thrown one, an async one) reaches
 * the writer by its own path, so each is asserted, and a route without the field keeps what
 * `JSON.stringify` writes.
 */

const bytes = new Uint8Array([0, 1, 2, 250, 255])
const BASE64 = "AAEC+v8="
const file = t.object({ name: t.string(), data: t.bytes() })

async function body(app: { fetch(request: Request): Response | Promise<Response> }, path: string) {
  const response = await app.fetch(new Request(`http://t${path}`))
  return { status: response.status, text: await response.text() }
}

describe("a t.bytes() response field", () => {
  test("is base64 for every kind of answer", async () => {
    const app = server({ logger: silentLogger })
      .get("/plain", { response: file }, () => ({ name: "a", data: bytes }))
      .get("/async", { response: file }, async () => ({ name: "a", data: bytes }))
      .get("/status", { response: file }, () => status(201, { name: "a", data: bytes }))
      .get("/json", { response: file }, (c) =>
        c.json({ name: "a", data: bytes }, { status: 202, headers: { "x-kept": "1" } }),
      )
      .get("/thrown", { errors: { 409: file } }, () => {
        throw status(409, { name: "a", data: bytes })
      })
      .get("/rejected", { errors: { 409: file } }, async () => {
        throw status(409, { name: "a", data: bytes })
      })

    const expected = `{"name":"a","data":"${BASE64}"}`
    expect(await body(app, "/plain")).toEqual({ status: 200, text: expected })
    expect(await body(app, "/async")).toEqual({ status: 200, text: expected })
    expect(await body(app, "/status")).toEqual({ status: 201, text: expected })
    const reply = await app.fetch(new Request("http://t/json"))
    expect(reply.status).toBe(202)
    expect(reply.headers.get("x-kept")).toBe("1")
    expect(await reply.text()).toBe(expected)
    expect(await body(app, "/thrown")).toEqual({ status: 409, text: expected })
    expect(await body(app, "/rejected")).toEqual({ status: 409, text: expected })
  })

  test("reaches nested lists, Buffers and views, and leaves the rest of the answer as it was", async () => {
    const view = new Uint8Array([9, 0, 1, 2, 250, 255, 9]).subarray(1, 6)
    const files = t.object({ files: t.array(file) })
    const app = server().get("/", { response: files }, () => ({
      files: [
        { name: "a", data: bytes },
        { name: "b", data: Buffer.from(bytes) },
        { name: "c", data: view },
      ],
      at: new Date(0),
      untouched: { n: 1 },
    }))
    expect(JSON.parse((await body(app, "/")).text)).toEqual({
      files: [
        { name: "a", data: BASE64 },
        { name: "b", data: BASE64 },
        { name: "c", data: BASE64 },
      ],
      at: "1970-01-01T00:00:00.000Z",
      untouched: { n: 1 },
    })
  })

  test("does not change the handler's own value", async () => {
    const answer = { name: "a", data: bytes, list: [bytes] }
    const app = server().get("/", { response: file }, () => answer)
    await body(app, "/")
    expect(answer.data).toBe(bytes)
    expect(answer.list[0]).toBe(bytes)
  })

  test("keeps a `__proto__` key a field", async () => {
    const answer = JSON.parse('{"name":"a","data":0,"__proto__":{"polluted":true}}')
    answer.data = bytes
    const app = server().get("/", { response: file }, () => answer)
    const sent = JSON.parse((await body(app, "/")).text)
    expect(sent.data).toBe(BASE64)
    expect(Object.getPrototypeOf(sent)).toBe(Object.prototype)
    expect(Reflect.get({}, "polluted")).toBeUndefined()
  })

  test("is found on a precompiled schema too", async () => {
    const compiled = fromPrecompiled(file.jsonSchema, () => true)
    const app = server().get("/", { response: compiled }, () => ({ name: "a", data: bytes }))
    expect((await body(app, "/")).text).toBe(`{"name":"a","data":"${BASE64}"}`)
  })

  test("passes a response contract that holds the route to its schema", async () => {
    const app = server({ logger: silentLogger })
      .use(responseContract("enforce"))
      .get("/", { response: file }, () => ({ name: "a", data: bytes }))
    expect(await body(app, "/")).toEqual({
      status: 200,
      text: `{"name":"a","data":"${BASE64}"}`,
    })
  })
})

describe("a Uint8Array without a t.bytes() field", () => {
  test("is the index object JSON.stringify writes", async () => {
    const app = server().get("/", () => ({ data: new Uint8Array([1, 2]) }))
    expect((await body(app, "/")).text).toBe('{"data":{"0":1,"1":2}}')
  })
})

describe("t.bytes() where a value arrives", () => {
  test("is refused when the route is registered", () => {
    for (const schema of [
      { body: file },
      { query: t.query({ data: t.bytes() }) },
      { headers: t.headers({ data: t.bytes() }) },
      { body: form.form({ data: t.bytes() }) },
    ]) {
      let refused: unknown
      try {
        server().post("/", schema, () => null)
      } catch (error) {
        refused = error
      }
      expect(refused).toBeInstanceOf(RouteConfigError)
      expect(refused).toMatchObject({ code: "RESPONSE_ONLY_SCHEMA" })
    }
    expect(() =>
      server()
        .use(streaming())
        .sse("/feed", { sse: file }, (_c, stream) => stream.close()),
    ).toThrow(/route GET \/feed, `sse`: t\.bytes\(\) is for a response field;/)
  })
})

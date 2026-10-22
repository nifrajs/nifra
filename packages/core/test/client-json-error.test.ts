import { describe, expect, test } from "bun:test"
import { type Logger, server } from "../src/index.ts"

const post = (path: string, body: string) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  })

const loggerInto = (sink: string[]): Logger => ({
  debug() {},
  info() {},
  warn() {},
  error(message) {
    sink.push(message)
  },
})

const answer = async (response: Response) => ({
  status: response.status,
  body: await response.json(),
})

// A handler that reads the body itself (no body schema) and gets bytes that are not JSON was answered
// 500 on every runtime: the client's input, the server's status. Found by
// scripts/check-runtime-differential.ts.
describe("a request body the app's own c.req.json() cannot parse", () => {
  test("is the client's 400 when it escapes the handler, and not logged as a fault", async () => {
    const logged: string[] = []
    const app = server({ logger: loggerInto(logged) })
      .post("/bare", async (c) => ({ got: await c.req.json() }))
      .derive(() => ({ seen: true }))
      .post("/program", async (c) => ({ got: await c.req.json(), seen: c.seen }))
    for (const path of ["/bare", "/program"]) {
      for (const body of ["{", "", "nope"]) {
        expect(await answer(await app.fetch(post(path, body)))).toEqual({
          status: 400,
          body: { ok: false, error: "invalid_json" },
        })
      }
      expect((await app.fetch(post(path, '{"a":1}'))).status).toBe(200)
      // No body at all, as Bun.serve hands over a `Content-Length: 0` request.
      const bodiless = new Request(`http://localhost${path}`, { method: "POST" })
      expect(await answer(await app.fetch(bodiless))).toEqual({
        status: 400,
        body: { ok: false, error: "invalid_json" },
      })
    }
    expect(logged).toEqual([])
  })

  test("still rejects with the SyntaxError Request.json() rejects with", async () => {
    const app = server().post("/catch", async (c) => {
      try {
        return { got: await c.req.json() }
      } catch (error) {
        return { syntax: error instanceof SyntaxError }
      }
    })
    expect(await answer(await app.fetch(post("/catch", "{")))).toEqual({
      status: 200,
      body: { syntax: true },
    })
  })

  test("reaches onError first; one no hook answers is the 400", async () => {
    const seen: unknown[] = []
    const app = server()
      .onError((error) => {
        seen.push(error)
        return undefined
      })
      .post("/hooked", async (c) => ({ got: await c.req.json() }))
    const mapped = server()
      .onError((error) => (error instanceof SyntaxError ? { mapped: true } : undefined))
      .post("/hooked", async (c) => ({ got: await c.req.json() }))
    expect((await app.fetch(post("/hooked", "{"))).status).toBe(400)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeInstanceOf(SyntaxError)
    expect(await answer(await mapped.fetch(post("/hooked", "{")))).toEqual({
      status: 200,
      body: { mapped: true },
    })
  })

  test("a SyntaxError the app raises on its own string stays a logged 500", async () => {
    const logged: string[] = []
    const app = server({ logger: loggerInto(logged) })
      .post("/own", (): unknown => JSON.parse("{"))
      .derive(() => ({ seen: true }))
      .post("/own-program", (c): unknown => [JSON.parse("{"), c.seen])
    for (const path of ["/own", "/own-program"])
      expect((await app.fetch(post(path, '{"a":1}'))).status).toBe(500)
    expect(logged).toEqual(["unhandled request error", "unhandled request error"])
  })
})

const form = (path: string, contentType: string, body: string) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  })

// A web action reading a form the client sent malformed was answered 500 on every runtime. Found by
// scripts/check-runtime-differential.ts.
describe("a request body the app's own c.req.formData() cannot parse", () => {
  const unparseable: readonly (readonly [string, string])[] = [
    ["multipart/form-data; boundary=x", "--x\r\nContent-Disposition: form-data\r\n\r\nno name"],
    ["multipart/form-data; boundary=other", "--x--\r\n"],
    ["multipart/form-data", "--x--\r\n"],
    ["application/json", '{"a":1}'],
  ]

  test("is the client's 400 when it escapes the handler, and not logged as a fault", async () => {
    const logged: string[] = []
    const entries = async (c: { req: Request }) => [...(await c.req.formData()).keys()]
    const app = server({ logger: loggerInto(logged) })
      .post("/bare", async (c) => ({ keys: await entries(c) }))
      .derive(() => ({ seen: true }))
      .post("/program", async (c) => ({ keys: await entries(c), seen: c.seen }))
    for (const path of ["/bare", "/program"]) {
      for (const [type, body] of unparseable) {
        expect({ type, ...(await answer(await app.fetch(form(path, type, body)))) }).toEqual({
          type,
          status: 400,
          body: { ok: false, error: "invalid_form" },
        })
      }
      const sent = form(
        path,
        "multipart/form-data; boundary=x",
        '--x\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--x--\r\n',
      )
      expect((await answer(await app.fetch(sent))).body.keys).toEqual(["a"])
      expect((await app.fetch(form(path, "application/x-www-form-urlencoded", "a=1"))).status).toBe(
        200,
      )
    }
    expect(logged).toEqual([])
  })

  test("still rejects with the TypeError Request.formData() rejects with", async () => {
    const app = server().post("/catch", async (c) => {
      try {
        return { got: [...(await c.req.formData()).keys()] }
      } catch (error) {
        return { type: error instanceof TypeError }
      }
    })
    expect(await answer(await app.fetch(form("/catch", "application/json", "{}")))).toEqual({
      status: 200,
      body: { type: true },
    })
  })
})

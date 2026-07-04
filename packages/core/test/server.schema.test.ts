import { describe, expect, test } from "bun:test"
import { server } from "../src/index.ts"
import type { StandardResult, StandardSchemaV1, StandardTypes } from "../src/schema/standard.ts"

/**
 * A minimal Standard Schema, hand-rolled so these tests exercise the framework
 * against the *spec* rather than any one library. zod/valibot/arktype expose the
 * exact same `~standard` interface, so they drop in unchanged.
 */
function schema<Output>(
  validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>,
): StandardSchemaV1<unknown, Output> {
  return {
    "~standard": {
      version: 1,
      vendor: "nifra-test",
      validate,
      // type-only marker; the runtime value is irrelevant
      types: undefined as unknown as StandardTypes<unknown, Output>,
    },
  }
}

const userBody = schema<{ name: string }>((value) => {
  if (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string"
  ) {
    return { value: { name: value.name } }
  }
  return { issues: [{ message: "name must be a string", path: ["name"] }] }
})

function jsonRequest(method: string, path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

/**
 * A POST whose body is a `ReadableStream` — which carries NO `Content-Length`, so it
 * exercises the streaming byte-cap path (the security guard), not the native fast path.
 */
function streamRequest(path: string, payload: string): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(payload))
      c.close()
    },
  })
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stream,
  })
}

/**
 * A POST with an explicit `Content-Length` — which triggers the native fast path.
 * Defaults to the real byte length; override `declared` to simulate an over-cap claim.
 */
function lengthedRequest(path: string, payload: string, declared?: number): Request {
  const bytes = new TextEncoder().encode(payload).length
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(declared ?? bytes) },
    body: payload,
  })
}

describe("body validation", () => {
  test("valid body is typed and passed to the handler", async () => {
    // c.body.name only type-checks because the schema's output is inferred.
    const app = server().post("/users", { body: userBody }, (c) => ({ created: c.body.name }))
    const res = await app.fetch(jsonRequest("POST", "/users", { name: "Ada" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ created: "Ada" })
  })

  test("invalid body is rejected with 422 and the issues", async () => {
    const app = server().post("/users", { body: userBody }, (c) => c.body)
    const res = await app.fetch(jsonRequest("POST", "/users", { name: 123 }))
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({
      ok: false,
      error: "validation",
      issues: [{ message: "name must be a string", path: ["name"] }],
    })
  })

  test("non-JSON content-type is rejected with 415", async () => {
    const app = server().post("/users", { body: userBody }, (c) => c.body)
    const req = new Request("http://localhost/users", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "Ada",
    })
    expect((await app.fetch(req)).status).toBe(415)
  })

  test("malformed JSON is rejected with 400 invalid_json", async () => {
    const app = server().post("/users", { body: userBody }, (c) => c.body)
    const req = new Request("http://localhost/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    })
    const res = await app.fetch(req)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, error: "invalid_json" })
  })

  test("a malformed Content-Length is rejected with 400, not silently streamed [AUDIT L1]", async () => {
    const app = server().post("/users", { body: userBody }, (c) => c.body)
    // A non-`1*DIGIT` length (negative/fractional/non-numeric/exponential/hex) is malformed. Real HTTP
    // servers never deliver these, but a hand-built Request can — reject up front rather than falling
    // through to the streaming guard (an upper-bound cap that would still read a lying-smaller body).
    for (const bad of ["-5", "1.5", "abc", "1e3", "0x10"]) {
      const req = new Request("http://localhost/users", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": bad },
        body: JSON.stringify({ name: "Ada" }),
      })
      const res = await app.fetch(req)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ ok: false, error: "invalid_content_length" })
    }
  })

  test("oversized body is rejected with 413", async () => {
    // An in-memory Request from a string carries no Content-Length, so this is caught
    // by the streaming byte-cap (see the explicit fast-path / streaming tests below).
    const app = server({ maxBodyBytes: 10 }).post("/users", { body: userBody }, (c) => c.body)
    const res = await app.fetch(
      jsonRequest("POST", "/users", { name: "a much longer name than ten bytes" }),
    )
    expect(res.status).toBe(413)
  })

  test("a body with Content-Length reads through the native fast path", async () => {
    const app = server().post("/users", { body: userBody }, (c) => c.body)
    const req = lengthedRequest("/users", JSON.stringify({ name: "Ada" }))
    // The fast path is only taken when Content-Length is present.
    expect(req.headers.get("content-length")).not.toBeNull()
    expect(await (await app.fetch(req)).json()).toEqual({ name: "Ada" })
  })

  test("a declared Content-Length over the cap is rejected with 413 before buffering", async () => {
    const app = server({ maxBodyBytes: 10 }).post("/users", { body: userBody }, (c) => c.body)
    // Declares 1000 bytes against a 10-byte cap → rejected up front, body never read.
    const req = lengthedRequest("/users", JSON.stringify({ name: "Ada" }), 1000)
    expect((await app.fetch(req)).status).toBe(413)
  })

  test("a valid streamed body (no Content-Length) reads through the streaming path", async () => {
    const app = server().post("/users", { body: userBody }, (c) => c.body)
    const req = streamRequest("/users", JSON.stringify({ name: "Ada" }))
    expect(req.headers.get("content-length")).toBeNull()
    expect(await (await app.fetch(req)).json()).toEqual({ name: "Ada" })
  })

  test("an oversized streamed body (no Content-Length) is rejected by the streaming byte-cap", async () => {
    // The security guarantee the fast path must NOT regress: a chunked / length-less
    // body still can't force unbounded buffering — the running byte count aborts it.
    const app = server({ maxBodyBytes: 10 }).post("/users", { body: userBody }, (c) => c.body)
    const req = streamRequest("/users", JSON.stringify({ name: "x".repeat(100) }))
    expect(req.headers.get("content-length")).toBeNull()
    expect((await app.fetch(req)).status).toBe(413)
  })

  test("awaits async validators", async () => {
    const asyncBody = schema<{ ok: boolean }>(async (value) => {
      await Promise.resolve()
      if (typeof value === "object" && value !== null && "ok" in value && value.ok === true) {
        return { value: { ok: true } }
      }
      return { issues: [{ message: "ok must be true" }] }
    })
    const app = server().post("/a", { body: asyncBody }, (c) => c.body)
    expect(await (await app.fetch(jsonRequest("POST", "/a", { ok: true }))).json()).toEqual({
      ok: true,
    })
    expect((await app.fetch(jsonRequest("POST", "/a", { ok: false }))).status).toBe(422)
  })
})

describe("c.boundedBody / c.boundedJson (schema-less body cap)", () => {
  test("boundedBody returns the raw bytes under the cap", async () => {
    const app = server().post("/raw", async (c) => ({ len: (await c.boundedBody()).byteLength }))
    const res = await app.fetch(
      new Request("http://localhost/raw", { method: "POST", body: "hello" }),
    )
    expect(await res.json()).toEqual({ len: 5 })
  })

  test("boundedJson parses JSON under the cap", async () => {
    const app = server().post("/raw", async (c) => {
      const data = await c.boundedJson<{ x: number }>()
      return { x: data.x }
    })
    const res = await app.fetch(jsonRequest("POST", "/raw", { x: 7 }))
    expect(await res.json()).toEqual({ x: 7 })
  })

  test("boundedBody rejects an over-cap streamed body with 413 (no Content-Length)", async () => {
    const app = server({ maxBodyBytes: 10 }).post("/raw", async (c) => ({
      len: (await c.boundedBody()).byteLength,
    }))
    expect((await app.fetch(streamRequest("/raw", "x".repeat(100)))).status).toBe(413)
  })

  test("boundedBody rejects an over-cap declared Content-Length with 413", async () => {
    const app = server({ maxBodyBytes: 10 }).post("/raw", async (c) => ({
      len: (await c.boundedBody()).byteLength,
    }))
    expect((await app.fetch(lengthedRequest("/raw", "x".repeat(100)))).status).toBe(413)
  })

  test("boundedJson rejects invalid JSON with 400", async () => {
    const app = server().post("/raw", async (c) => await c.boundedJson())
    const res = await app.fetch(
      new Request("http://localhost/raw", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    )
    expect(res.status).toBe(400)
  })

  test("a per-route maxBytes overrides the server cap upward (an upload route)", async () => {
    // Global cap 10; this route opts into 1000 → a 100-byte body the global would 413 now passes.
    const app = server({ maxBodyBytes: 10 }).post("/upload", async (c) => ({
      len: (await c.boundedBody(1000)).byteLength,
    }))
    expect(await (await app.fetch(streamRequest("/upload", "x".repeat(100)))).json()).toEqual({
      len: 100,
    })
  })

  test("a tighter per-route maxBytes rejects below the server cap", async () => {
    const app = server({ maxBodyBytes: 1_000 }).post("/small", async (c) => ({
      len: (await c.boundedBody(10)).byteLength,
    }))
    expect((await app.fetch(streamRequest("/small", "x".repeat(50)))).status).toBe(413)
  })
})

describe("query validation", () => {
  const pageQuery = schema<{ page: string }>((value) => {
    if (
      typeof value === "object" &&
      value !== null &&
      "page" in value &&
      typeof value.page === "string"
    ) {
      return { value: { page: value.page } }
    }
    return { issues: [{ message: "page is required", path: ["page"] }] }
  })

  test("valid query is typed and passed to the handler", async () => {
    const app = server().get("/search", { query: pageQuery }, (c) => ({ page: c.query.page }))
    const res = await app.fetch(new Request("http://localhost/search?page=2"))
    expect(await res.json()).toEqual({ page: "2" })
  })

  test("invalid query is rejected with 422", async () => {
    const app = server().get("/search", { query: pageQuery }, (c) => c.query)
    const res = await app.fetch(new Request("http://localhost/search"))
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({
      ok: false,
      error: "validation",
      issues: [{ message: "page is required", path: ["page"] }],
    })
  })
})

describe("drainCapped chunk shapes", () => {
  const chunkedRequest = (chunks: string[]) =>
    new Request("http://t/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        start(ctrl) {
          for (const c of chunks) ctrl.enqueue(new TextEncoder().encode(c))
          ctrl.close()
        },
      }),
    })
  const echo = () =>
    server().post("/echo", async (c) => {
      const bytes = await c.boundedBody()
      return { len: bytes.length, text: new TextDecoder().decode(bytes) }
    })

  test("multi-chunk body merges in order", async () => {
    const res = await echo().fetch(chunkedRequest(['{"a":', "1", "}"]))
    expect(await res.json()).toEqual({ len: 7, text: '{"a":1}' })
  })

  test("empty stream is zero bytes", async () => {
    const res = await echo().fetch(chunkedRequest([]))
    expect(await res.json()).toEqual({ len: 0, text: "" })
  })

  test("multi-chunk over the cap is 413", async () => {
    const app = server({ maxBodyBytes: 8 }).post("/echo", async (c) => {
      const bytes = await c.boundedBody()
      return { len: bytes.length }
    })
    const res = await app.fetch(chunkedRequest(["aaaa", "bbbb", "cccc"]))
    expect(res.status).toBe(413)
  })
})

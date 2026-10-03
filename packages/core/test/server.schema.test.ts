import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { RouteConfigError, server } from "../src/index.ts"
import type { StandardResult, StandardSchemaV1, StandardTypes } from "../src/schema/standard.ts"
import { isResponseResult, type ResponseResult } from "../src/server/runtime-core.ts"

/** A POST whose length-less body is still producing when a cap trips: its last chunk is never
 * pulled. */
function overCapPost(url: string, headers: Record<string, string> = {}): Request {
  let sent = 0
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers,
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ >= 2) return controller.close()
        controller.enqueue(new Uint8Array(65_536).fill(32))
      },
    }),
    duplex: "half",
  }
  return new Request(url, init)
}

/** Resolves with the response, or with "no response" once `ms` pass without one. */
function within(
  ms: number,
  response: Promise<Response> | Response,
): Promise<Response | "no response"> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<"no response">((resolve) => {
    timer = setTimeout(() => resolve("no response"), ms)
  })
  return Promise.race([Promise.resolve(response), deadline]).finally(() => clearTimeout(timer))
}

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

const apiHeaders = schema<{ "x-api-key": string }>((value) => {
  if (
    typeof value === "object" &&
    value !== null &&
    "x-api-key" in value &&
    typeof value["x-api-key"] === "string"
  ) {
    return { value: { "x-api-key": value["x-api-key"] } }
  }
  return { issues: [{ message: "x-api-key is required", path: ["x-api-key"] }] }
})

function jsonRequest(method: string, path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

/**
 * A POST whose body is a `ReadableStream` - which carries NO `Content-Length`, so it
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
 * A POST with an explicit `Content-Length` - which triggers the native fast path.
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
  test("rejects unsupported transport and validation-order settings at registration", () => {
    expect(() => server().post("/wire", { wire: "json" as never }, () => null)).toThrow(
      /wire must be "raw"/,
    )
    expect(() => server().post("/wire-body", { wire: "raw", body: userBody }, () => null)).toThrow(
      /cannot be combined with a body schema/,
    )
    expect(() =>
      server().post("/order", { validationOrder: "before-auth" as never }, () => null),
    ).toThrow(/validationOrder is invalid/)
    expect(() =>
      server().post(
        "/idempotent",
        { idempotency: { scope: "request", namespace: "schema-test" } },
        () => null,
      ),
    ).toThrow(/\.use\(idempotency\(\)\)/)
  })

  test("invalid route body limits fail closed at registration", () => {
    for (const bodyLimit of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      try {
        server().post("/invalid-limit", { bodyLimit }, () => null)
        throw new Error("expected route registration to fail")
      } catch (error) {
        expect(error).toBeInstanceOf(RouteConfigError)
        expect((error as RouteConfigError).code).toBe("INVALID_BODY_LIMIT")
      }
    }
    expect(() =>
      server().post("/invalid-limit-type", { bodyLimit: "not-a-limit" as never }, () => null),
    ).toThrow(RouteConfigError)
  })

  test("unlimited body routes require an explicit, exclusive reason", () => {
    expect(() => server().post("/upload", { bodyLimit: "unlimited" }, () => null)).toThrow(
      RouteConfigError,
    )
    expect(() =>
      server().post("/upload", { bodyLimit: "unlimited", bodyLimitReason: "   " }, () => null),
    ).toThrow(RouteConfigError)
    expect(() =>
      server().post("/bounded", { bodyLimit: 1024, bodyLimitReason: "not unlimited" }, () => null),
    ).toThrow(RouteConfigError)
    expect(() =>
      server().post(
        "/upload",
        { bodyLimit: "unlimited", bodyLimitReason: 123 as never },
        () => null,
      ),
    ).toThrow(RouteConfigError)
  })

  test("unlimited body routes reject buffered schema readers", () => {
    expect(() =>
      server().post(
        "/ingest",
        {
          body: userBody,
          bodyLimit: "unlimited",
          bodyLimitReason: "upload is bounded by the object-store streaming protocol",
        },
        (c) => c.body,
      ),
    ).toThrow(/cannot be used with a body schema/)
  })

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

  test("JSON is matched by media type, not by substring", async () => {
    const app = server().post("/users", { body: userBody }, (c) => c.body)
    const send = (contentType: string) =>
      app.fetch(
        new Request("http://localhost/users", {
          method: "POST",
          headers: { "content-type": contentType },
          body: JSON.stringify({ name: "Ada" }),
        }),
      )
    // A no-preflight text/plain request, even though the header contains "application/json".
    expect((await send("text/plain; x=application/json")).status).toBe(415)
    expect((await send("text/plain;application/json")).status).toBe(415)
    expect((await send("application/jsonx")).status).toBe(415)
    expect((await send("application/json+x")).status).toBe(415)
    expect((await send("application/json garbage")).status).toBe(415)
    expect((await send("application/json\tgarbage")).status).toBe(415)
    expect((await send("application/x +json")).status).toBe(415)
    expect((await send("application/vnd.api+json garbage")).status).toBe(415)
    expect((await send("application/vnd.api+jsonx")).status).toBe(415)
    expect((await send("text/x+json")).status).toBe(415)
    for (const accepted of [
      "application/json",
      "application/json; charset=utf-8",
      "application/json;charset=UTF-8",
      "application/json ; charset=utf-8",
      "Application/JSON; charset=UTF-8",
      "application/vnd.api+json",
      "application/merge-patch+json",
      "application/problem+json; charset=utf-8",
      "application/vnd.api+json ; ext=x",
      "APPLICATION/VND.API+JSON",
    ]) {
      expect((await send(accepted)).status).toBe(200)
    }
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

  test("a malformed Content-Length is rejected with 400, not silently streamed", async () => {
    const app = server().post("/users", { body: userBody }, (c) => c.body)
    // A non-`1*DIGIT` length (negative/fractional/non-numeric/exponential/hex) is malformed. Real HTTP
    // servers never deliver these, but a hand-built Request can - reject up front rather than falling
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

  test("a finite per-route body limit can intentionally exceed the app default", async () => {
    const app = server({ maxBodyBytes: 10 }).post(
      "/larger",
      { body: userBody, bodyLimit: 100 },
      (c) => c.body,
    )
    const res = await app.fetch(
      jsonRequest("POST", "/larger", { name: "a longer but bounded name" }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: "a longer but bounded name" })
  })

  test("a schema body route can read request metadata before body validation", async () => {
    const app = server({ maxBodyBytes: 10 })
      .derive((c) => ({
        authorization: c.req.headers.get("authorization"),
      }))
      .post("/metadata", { body: userBody, bodyLimit: 100 }, (c) => ({
        authorization: c.authorization,
        name: c.body.name,
      }))
    const res = await app.fetch(
      new Request("http://localhost/metadata", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer test" },
        body: JSON.stringify({ name: "Ada" }),
      }),
    )
    expect(await res.json()).toEqual({ authorization: "Bearer test", name: "Ada" })
  })

  test("a valid streamed body (no Content-Length) reads through the streaming path", async () => {
    const app = server().post("/users", { body: userBody }, (c) => c.body)
    const req = streamRequest("/users", JSON.stringify({ name: "Ada" }))
    expect(req.headers.get("content-length")).toBeNull()
    expect(await (await app.fetch(req)).json()).toEqual({ name: "Ada" })
  })

  test("an oversized streamed body (no Content-Length) is rejected by the streaming byte-cap", async () => {
    // The security guarantee the fast path must NOT regress: a chunked / length-less
    // body still can't force unbounded buffering - the running byte count aborts it.
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
  test("wire raw routes expose protocol bytes without JSON parsing", async () => {
    const app = server().post(
      "/webhook",
      { wire: "raw" },
      async (c) => new Response(await c.req.text(), { status: 202 }),
    )
    const response = await app.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "signed-payload",
      }),
    )
    expect(response.status).toBe(202)
    expect(await response.text()).toBe("signed-payload")
  })

  test("wire raw routes keep the finite transport cap", async () => {
    const app = server({ maxBodyBytes: 4 }).post(
      "/webhook",
      { wire: "raw" },
      async (c) => new Response(await c.req.arrayBuffer()),
    )
    const response = await app.fetch(
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([1, 2, 3, 4, 5]),
      }),
    )
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ ok: false, error: "payload_too_large" })
  })

  test("wire raw rejects a buffered body schema at registration", () => {
    expect(() =>
      server().post("/invalid-wire", { wire: "raw", body: userBody }, () => ({ ok: true })),
    ).toThrow(RouteConfigError)
  })

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

  test("the transport cap protects direct c.req body reads on schema-less routes", async () => {
    const app = server({ maxBodyBytes: 10 }).post("/raw-direct", async (c) => ({
      len: (await c.req.arrayBuffer()).byteLength,
    }))
    const res = await app.fetch(streamRequest("/raw-direct", "x".repeat(100)))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ ok: false, error: "payload_too_large" })
  })

  test("an auth-first schema route caps the direct c.req reads its hooks make", async () => {
    let read: number | undefined
    const app = server()
      .derive(async (c) => {
        read = (await c.req.text()).length
        return {}
      })
      .post(
        "/hook",
        {
          body: t.object({ a: t.string() }),
          validationOrder: "auth-before-validation",
          bodyLimit: 1024,
        },
        () => ({ ok: true }),
      )
    const res = await app.fetch(jsonRequest("POST", "/hook", { a: "x".repeat(100_000) }))
    expect(res.status).toBe(413)
    expect(read).toBeUndefined()
  })

  test("a capped clone read over the cap answers, though the original is never read", async () => {
    const app = server({ maxBodyBytes: 1024 }).post("/raw-clone", async (c) => ({
      len: (await c.req.clone().text()).length,
    }))
    const res = await within(2000, app.fetch(overCapPost("http://localhost/raw-clone")))
    expect(res === "no response" ? res : res.status).toBe(413)
  })

  test("a lying small Content-Length cannot bypass the transport cap", async () => {
    const app = server({ maxBodyBytes: 100 }).post("/raw-lying", async (c) => ({
      len: (await c.req.arrayBuffer()).byteLength,
    }))
    const res = await app.fetch(
      new Request("http://localhost/raw-lying", {
        method: "POST",
        headers: { "content-length": "1" },
        body: "x".repeat(101),
      }),
    )
    expect(res.status).toBe(413)
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

  test("an over-cap read throws a plain render, not a Response", async () => {
    let thrown: unknown
    const app = server({ maxBodyBytes: 10 }).post("/raw", async (c) => {
      try {
        await c.boundedBody()
      } catch (err) {
        thrown = err
        throw err
      }
      return { ok: true }
    })
    const res = await app.fetch(lengthedRequest("/raw", "x".repeat(100)))
    expect(res.status).toBe(413)
    expect(thrown).not.toBeInstanceOf(Response)
    expect(isResponseResult(thrown)).toBe(true)
    expect((thrown as ResponseResult).plain).toEqual({
      status: 413,
      body: { ok: false, error: "payload_too_large" },
    })
  })

  test("a JSON body that spells the plain-render brand as a string key stays data", async () => {
    // The lane tells its own failures from a parsed body by a symbol brand. `JSON.parse` only ever
    // produces string keys, so a body that writes the brand out longhand is still just an object.
    const app = server().post("/raw", async (c) => ({ got: await c.boundedJson() }))
    const body = { "Symbol(nifra.response.result)": true, plain: { status: 413 } }
    const res = await app.fetch(jsonRequest("POST", "/raw", body))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ got: body })
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

  test("an unlimited route with a reason skips the transport cap for direct reads", async () => {
    const app = server({ maxBodyBytes: 10 }).post(
      "/ingest",
      {
        bodyLimit: "unlimited",
        bodyLimitReason: "upload is bounded by the object-store streaming protocol",
      },
      async (c) => ({ len: (await c.req.arrayBuffer()).byteLength }),
    )
    expect(await (await app.fetch(streamRequest("/ingest", "x".repeat(100)))).json()).toEqual({
      len: 100,
    })
  })

  test("an unlimited route's boundedJson/boundedBody default to no cap", async () => {
    const app = server({ maxBodyBytes: 10 }).post(
      "/ingest",
      {
        bodyLimit: "unlimited",
        bodyLimitReason: "upload is bounded by the object-store streaming protocol",
      },
      async (c) => await c.boundedJson<{ name: string }>(),
    )
    const name = "x".repeat(100)
    expect(await (await app.fetch(jsonRequest("POST", "/ingest", { name }))).json()).toEqual({
      name,
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

describe("header validation", () => {
  test("normalizes header names and exposes the validated value as c.headers", async () => {
    const app = server().get("/header", { headers: apiHeaders }, (c) => c.headers["x-api-key"])
    const res = await app.fetch(
      new Request("http://localhost/header", { headers: { "X-API-KEY": "secret" } }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toBe("secret")
  })

  test("missing required headers are rejected before the handler", async () => {
    let ran = false
    const app = server().get("/header", { headers: apiHeaders }, () => {
      ran = true
      return "bad"
    })
    const res = await app.fetch(new Request("http://localhost/header"))
    expect(res.status).toBe(422)
    expect(ran).toBe(false)
  })
})

describe("cookie validation", () => {
  const sessionCookies = schema<{ session: string }>((value) => {
    if (
      typeof value === "object" &&
      value !== null &&
      "session" in value &&
      typeof value.session === "string"
    ) {
      return { value: { session: value.session } }
    }
    return { issues: [{ message: "session is required", path: ["session"] }] }
  })
  const withCookie = (path: string, cookie?: string, init: RequestInit = {}): Request =>
    new Request(`http://localhost${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        ...(cookie === undefined ? {} : { cookie }),
      },
    })

  test("exposes the validated value as c.cookies", async () => {
    const app = server().get("/me", { cookies: sessionCookies }, (c) => c.cookies)
    const res = await app.fetch(withCookie("/me", "_ga=GA1.2; session=a%20b"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ session: "a b" })
  })

  test("a missing cookie is rejected with 422 before the handler", async () => {
    let ran = false
    const app = server().get("/me", { cookies: sessionCookies }, () => {
      ran = true
      return "bad"
    })
    const res = await app.fetch(withCookie("/me", "theme=dark"))
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({
      ok: false,
      error: "validation",
      issues: [{ message: "session is required", path: ["session"] }],
    })
    expect(ran).toBe(false)
  })

  test("t.cookies coerces declared fields and passes the other cookies through", async () => {
    const app = server().get(
      "/prefs",
      { cookies: t.cookies({ page: t.integer(), dark: t.boolean() }) },
      (c) => ({ next: c.cookies.page + 1, dark: c.cookies.dark, all: c.cookies }),
    )
    const ok = await app.fetch(withCookie("/prefs", "page=2; dark=true; _ga=GA1.2"))
    expect(await ok.json()).toEqual({
      next: 3,
      dark: true,
      all: { page: 2, dark: true, _ga: "GA1.2" },
    })
    expect((await app.fetch(withCookie("/prefs", "page=two; dark=true"))).status).toBe(422)
  })

  test("every route shape validates cookies, on app.fetch and on listen()", async () => {
    const shapes = server()
      .get("/only", { cookies: sessionCookies }, (c) => c.cookies.session)
      .get(
        "/query",
        { cookies: sessionCookies, query: t.query({ q: t.string() }) },
        (c) => `${c.cookies.session}:${c.query.q}`,
      )
      .post(
        "/body",
        { cookies: sessionCookies, body: t.object({ name: t.string() }) },
        (c) => `${c.cookies.session}:${c.body.name}`,
      )
      .get(
        "/ordered",
        { cookies: sessionCookies, validationOrder: "auth-before-validation" },
        (c) => c.cookies.session,
      )
    const hooked = server()
      .derive(() => ({ role: "user" }))
      .beforeHandle(() => undefined)
      .get("/hooked", { cookies: sessionCookies }, (c) => `${c.cookies.session}:${c.role}`)
      .post(
        "/hooked-body",
        { cookies: sessionCookies, body: t.object({ name: t.string() }) },
        (c) => `${c.cookies.session}:${c.body.name}:${c.role}`,
      )
    const body = { method: "POST", body: JSON.stringify({ name: "Ada" }) }
    const json = { "content-type": "application/json" }
    const cases = [
      [shapes, "/only", {}, "s1"],
      [shapes, "/query?q=x", {}, "s1:x"],
      [shapes, "/body", { ...body, headers: json }, "s1:Ada"],
      [shapes, "/ordered", {}, "s1"],
      [hooked, "/hooked", {}, "s1:user"],
      [hooked, "/hooked-body", { ...body, headers: json }, "s1:Ada:user"],
    ] as const
    for (const [app, path, init, expected] of cases) {
      const accepted = await app.fetch(withCookie(path, "session=s1", init))
      expect(await accepted.json()).toBe(expected)
      expect((await app.fetch(withCookie(path, undefined, init))).status).toBe(422)
    }
    for (const app of [shapes, hooked]) {
      const instance = app.listen(0, { hostname: "127.0.0.1" })
      try {
        for (const [owner, path, init, expected] of cases) {
          if (owner !== app) continue
          const url = `http://127.0.0.1:${instance.port}${path}`
          const accepted = await fetch(url, {
            ...init,
            headers: { ...(init as RequestInit).headers, cookie: "session=s1" },
          })
          expect(await accepted.json()).toBe(expected)
          expect((await fetch(url, init as RequestInit)).status).toBe(422)
        }
      } finally {
        instance.stop(true)
      }
    }
  })

  test("onValidationError sees kind cookies and may heal the value", async () => {
    const kinds: string[] = []
    const app = server({
      onValidationError: (_issues, _ctx, kind) => {
        kinds.push(kind)
        return { session: "guest" }
      },
    }).get("/me", { cookies: sessionCookies }, (c) => c.cookies.session)
    const res = await app.fetch(withCookie("/me"))
    expect(await res.json()).toBe("guest")
    expect(kinds).toEqual(["cookies"])
  })

  test("an unhealable cookie repair is still a 422", async () => {
    const app = server({ onValidationError: () => ({ session: 42 }) }).get(
      "/me",
      { cookies: sessionCookies },
      (c) => c.cookies.session,
    )
    expect((await app.fetch(withCookie("/me"))).status).toBe(422)
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

describe("a 422 lists a bounded number of issues", () => {
  test("a body with thousands of invalid items answers with the first 100", async () => {
    const app = server().post(
      "/ids",
      { body: t.object({ ids: t.array(t.integer()) }) },
      (c) => c.body,
    )
    const ids = Array.from({ length: 5_000 }, () => "x")
    const res = await app.fetch(
      new Request("http://h/ids", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids }),
      }),
    )
    expect(res.status).toBe(422)
    expect(await res.json()).toHaveProperty("issues.length", 100)
  })

  test("a non-TypeBox validator's issue list is capped too", async () => {
    const many = schema<unknown>(() => ({
      issues: Array.from({ length: 1_000 }, (_, i) => ({ message: `bad ${i}` })),
    }))
    const app = server().post("/x", { body: many }, () => "ok")
    const res = await app.fetch(
      new Request("http://h/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    )
    expect(await res.json()).toHaveProperty("issues.length", 100)
  })
})

import { describe, expect, test } from "bun:test"
import { server } from "../src/index.ts"
import {
  createTransportCodecRegistry,
  decodeTransportFrame,
  decodeTransportResponse,
  encodeTransportFrame,
  encodeTransportResponse,
  plainJsonCodec,
  TransportCodecError,
} from "../src/transport-codec.ts"
import { richWireCodec } from "../src/transport-codec-rich.ts"
import { transportCodecs } from "../src/transport-plugin.ts"

describe("versioned transport codecs", () => {
  test("negotiates versions and round-trips rich values across HTTP and frames", async () => {
    const rich = richWireCodec()
    const registry = createTransportCodecRegistry([plainJsonCodec, rich])
    const value = { at: new Date("2026-01-01T00:00:00.000Z"), count: 4n }

    expect(registry.negotiate(rich.mediaType)).toBe(rich)
    const response = encodeTransportResponse(value, rich)
    const decoded = await decodeTransportResponse(response, registry)
    expect(decoded).toEqual(value)
    expect(decodeTransportFrame(encodeTransportFrame(value, rich), registry)).toEqual(value)
  })

  test("fails closed on unknown versions and bounded oversized input", async () => {
    const registry = createTransportCodecRegistry([plainJsonCodec, richWireCodec()])
    expect(() => registry.forContentType("application/vnd.nifra.wire+json;v=2")).toThrow(
      TransportCodecError,
    )
    const response = new Response(JSON.stringify({ long: "x".repeat(64) }), {
      headers: { "content-type": plainJsonCodec.mediaType },
    })
    await expect(decodeTransportResponse(response, registry, { maxBytes: 8 })).rejects.toThrow(
      "transport payload exceeds",
    )
  })

  test("server negotiates the same codec for validated HTTP requests and responses", async () => {
    const rich = richWireCodec()
    const registry = createTransportCodecRegistry([plainJsonCodec, rich])
    const bodySchema = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate(value: unknown) {
          return value !== null &&
            typeof value === "object" &&
            (value as { at?: unknown }).at instanceof Date
            ? { value }
            : { issues: [{ message: "expected date" }] }
        },
      },
    }
    const app = server()
      .use(transportCodecs(registry))
      .post("/echo", { body: bodySchema }, (c) => c.body)
    const value = { at: new Date("2026-02-03T00:00:00.000Z") }
    const response = await app.fetch(
      new Request("http://test/echo", {
        method: "POST",
        headers: { "content-type": rich.mediaType, accept: rich.mediaType },
        body: rich.encode(value),
      }),
    )
    expect(response.status).toBe(200)
    expect(await decodeTransportResponse(response, registry)).toEqual(value)
  })

  test("transport hooks preserve response controls and enforce their own request cap", async () => {
    const rich = richWireCodec()
    const registry = createTransportCodecRegistry([plainJsonCodec, rich])
    const bodySchema = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: (value: unknown) => ({ value }),
      },
    }
    const app = server()
      .use(transportCodecs(registry, { maxBytes: 128 }))
      .post("/echo", { body: bodySchema }, (c) => {
        c.set.status = 201
        c.set.headers["x-transport"] = "rich"
        return c.body
      })

    const value = { count: 4n }
    const response = await app.fetch(
      new Request("http://test/echo", {
        method: "POST",
        headers: { "content-type": rich.mediaType, accept: rich.mediaType },
        body: rich.encode(value),
      }),
    )
    expect(response.status).toBe(201)
    expect(response.headers.get("x-transport")).toBe("rich")
    expect(await decodeTransportResponse(response, registry)).toEqual(value)

    const oversized = await app.fetch(
      new Request("http://test/echo", {
        method: "POST",
        headers: { "content-type": rich.mediaType },
        body: rich.encode({ value: "x".repeat(256) }),
      }),
    )
    expect(oversized.status).toBe(413)
  })

  test("normalizes malformed payloads to TransportCodecError instead of a native throw", async () => {
    const registry = createTransportCodecRegistry([plainJsonCodec, richWireCodec()])

    // A truncated frame: the envelope itself is not JSON. Before normalizing, `JSON.parse` raised a
    // bare `SyntaxError`, so the most likely hostile input was the one case that slipped past a
    // caller catching the documented error type.
    expect(() => decodeTransportFrame("{not json", registry)).toThrow(TransportCodecError)

    // A well-formed envelope whose inner payload is garbage — the second, separately-parsed layer.
    const badPayload = JSON.stringify({ codec: "json", version: 1, payload: "{nope" })
    expect(() => decodeTransportFrame(badPayload, registry)).toThrow(TransportCodecError)

    // Same guarantee on the HTTP path.
    const response = new Response("{not json", {
      headers: { "content-type": plainJsonCodec.mediaType },
    })
    await expect(decodeTransportResponse(response, registry)).rejects.toThrow(TransportCodecError)

    const invalidUtf8 = new Response(new Uint8Array([0xc3, 0x28]), {
      headers: { "content-type": plainJsonCodec.mediaType },
    })
    try {
      await decodeTransportResponse(invalidUtf8, registry)
      throw new Error("expected invalid UTF-8 to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(TransportCodecError)
      expect((error as TransportCodecError).message).toContain("valid UTF-8")
      expect((error as TransportCodecError).cause).toBeInstanceOf(TypeError)
    }

    // The underlying parse failure stays diagnosable rather than being swallowed by the normalizer.
    try {
      decodeTransportFrame("{not json", registry)
      throw new Error("expected decodeTransportFrame to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(TransportCodecError)
      expect((error as TransportCodecError).cause).toBeInstanceOf(SyntaxError)
    }
  })
})

// The lane's pass-through and failure edges. Each one decides whether a request reaches the handler
// at all, so "uncovered" here means the fail-closed behaviour was never actually observed.
describe("transport lane edges", () => {
  const rich = richWireCodec()
  const registry = () => createTransportCodecRegistry([plainJsonCodec, rich])
  const echo = () =>
    server()
      .use(transportCodecs(registry()))
      .post("/echo", (c) => c.json({ ok: true }))

  test("rejects a maxBytes that cannot bound anything", () => {
    // A negative or fractional cap silently disables the bound it exists to enforce, so it is refused
    // at construction rather than at the first oversized request.
    for (const maxBytes of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => transportCodecs(registry(), { maxBytes })).toThrow(RangeError)
    }
    expect(() => transportCodecs(registry(), { maxBytes: 0 })).not.toThrow()
  })

  test("an unnegotiable Accept falls back instead of failing a served response", async () => {
    // Encoding runs AFTER the handler already produced a value, so an Accept the registry cannot
    // negotiate must not turn a successful request into an error - it degrades to the fallback codec.
    const unnegotiable = "application/vnd.nifra.wire+json;v=99"
    expect(() => registry().negotiate(unnegotiable)).toThrow()

    const app = server()
      .use(transportCodecs(registry()))
      .post("/echo", () => ({ hello: "world" }))
    const response = await app.fetch(
      new Request("http://test/echo", {
        method: "POST",
        headers: { "content-type": rich.mediaType, accept: unnegotiable },
        body: rich.encode({ hello: "world" }),
      }),
    )
    expect(response.status).toBe(200)
    // Served, and served as the fallback media type rather than the impossible one.
    expect(response.headers.get("content-type")).toBe(plainJsonCodec.mediaType)
  })

  test("an unknown content-type passes through untouched, it is not this lane's request", async () => {
    const response = await echo().fetch(
      new Request("http://test/echo", {
        method: "POST",
        headers: { "content-type": "text/csv" },
        body: "a,b\n1,2",
      }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  test("plain JSON keeps its native fast path", async () => {
    // The lane deliberately does not intercept v1 application/json - the kernel already handles it,
    // and re-wrapping it would cost a clone and a re-encode per request for nothing.
    const response = await echo().fetch(
      new Request("http://test/echo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  test("a body the codec cannot decode is a 400, not a handler invocation", async () => {
    let reached = false
    const app = server()
      .use(transportCodecs(registry()))
      .post("/echo", () => {
        reached = true
        return { ok: true }
      })
    const response = await app.fetch(
      new Request("http://test/echo", {
        method: "POST",
        headers: { "content-type": rich.mediaType },
        body: "{not valid",
      }),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: "invalid_transport_payload" })
    // Fail CLOSED: an undecodable payload never becomes handler input.
    expect(reached).toBe(false)
  })

  test("a payload over the cap is a 413, not a truncated decode", async () => {
    const app = server()
      .use(transportCodecs(registry(), { maxBytes: 8 }))
      .post("/echo", () => ({ ok: true }))
    const response = await app.fetch(
      new Request("http://test/echo", {
        method: "POST",
        headers: { "content-type": rich.mediaType },
        body: rich.encode({ long: "x".repeat(256) }),
      }),
    )
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ error: "payload_too_large" })
  })
})

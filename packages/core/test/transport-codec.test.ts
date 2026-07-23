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
})

import { expect, test } from "bun:test"
import {
  componentFlightFrames,
  componentFrames,
  readComponentFlightFrames,
  readComponentFrames,
} from "../src/server-components/frames.ts"
import {
  acceptsComponentFlight,
  COMPONENT_FLIGHT_MEDIA_TYPE,
  type ComponentRequest,
  componentKey,
  componentRequestHeader,
  parseComponentRequest,
  readComponentRequest,
} from "../src/server-components/protocol.ts"

test("empty transport chunks are rejected without spinning until the operation deadline", async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array())
    },
    cancel() {
      cancelled = true
    },
  })
  await expect(readComponentFrames(stream, new AbortController().signal)).rejects.toMatchObject({
    code: "component_protocol",
  })
  expect(cancelled).toBe(true)
})

const selection: ComponentRequest = {
  v: 1,
  build: "build_1",
  reference: "component_1",
  key: "example",
  parent: null,
  generation: 1,
  routeEpoch: 0,
  authEpoch: 0,
  input: { id: "example" },
}
const request = (headers: HeadersInit): Request =>
  new Request("https://fixture.test/products/example", { headers })

test("the owner GET channel validates the closed envelope and same-origin metadata", () => {
  const header = componentRequestHeader(selection)
  expect(
    readComponentRequest(request({ "x-nifra-component": header, "sec-fetch-site": "same-origin" })),
  ).toEqual(selection)
  for (const headers of [
    { "x-nifra-component": header },
    { "x-nifra-component": header, "sec-fetch-site": "cross-site" },
    {
      "x-nifra-component": header,
      "sec-fetch-site": "same-origin",
      origin: "https://foreign.test",
    },
    { "x-nifra-component": header, "sec-fetch-site": "same-origin", "x-nifra-data": "1" },
    { "x-nifra-component": header + "," + header, "sec-fetch-site": "same-origin" },
  ])
    expect(() => readComponentRequest(request(headers))).toThrow()
  expect(() =>
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: This deliberate type bypass proves the runtime rejects undeclared fields instead of trusting compile-time types.
    componentRequestHeader({ ...selection, extra: "field" } as ComponentRequest),
  ).toThrow()
})

test("every UTF-8 and frame-header split decodes the same complete bounded payload", async () => {
  const value = { html: "<p>\u03b1\ud83d\ude00\u03c9</p>", payload: { public: "example" } }
  const bytes = new Uint8Array(await new Response(componentFrames({ v: 1 }, value)).arrayBuffer())
  for (let at = 1; at < bytes.length; at++) {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, at))
        controller.enqueue(bytes.slice(at))
        controller.close()
      },
    })
    expect(await readComponentFrames(source, new AbortController().signal)).toEqual({
      metadata: { v: 1 },
      value,
    })
  }
})

test("a truncated stream or trailing frame never publishes partial content", async () => {
  const bytes = new Uint8Array(
    await new Response(componentFrames({ v: 1 }, { html: "<p>example</p>" })).arrayBuffer(),
  )
  for (const invalid of [bytes.slice(0, -1), new Uint8Array([...bytes, 3, 0, 0, 0, 0])]) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(invalid)
        controller.close()
      },
    })
    await expect(readComponentFrames(stream, new AbortController().signal)).rejects.toMatchObject({
      code: "component_protocol",
    })
  }
})

test("one-byte transport chunks have the same aggregate limit as ordinary chunks", async () => {
  const bytes = new Uint8Array(
    await new Response(componentFrames({ v: 1 }, { html: "example" })).arrayBuffer(),
  )
  let position = 0
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (position === bytes.length) controller.close()
      else controller.enqueue(bytes.slice(position, ++position))
    },
  })
  expect((await readComponentFrames(source, new AbortController().signal)).value).toEqual({
    html: "example",
  })
})

const flightMagicForTest = Uint8Array.of(78, 83, 70, 49)
const flightEncoderForTest = new TextEncoder()

const flightBytesForTest = (value: string): Uint8Array => flightEncoderForTest.encode(value)
const flightStreamForTest = (parts: readonly Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part)
      controller.close()
    },
  })
const collectFlightForTest = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> =>
  new Uint8Array(await new Response(stream).arrayBuffer())
const concatFlightForTest = (...parts: readonly Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}
const flightHeaderForTest = (type: number, length: number): Uint8Array => {
  const header = new Uint8Array(5)
  header[0] = type
  new DataView(header.buffer).setUint32(1, length)
  return header
}
const flightRecordForTest = (type: number, payload: Uint8Array): Uint8Array =>
  concatFlightForTest(flightHeaderForTest(type, payload.length), payload)
const flightWireForTest = (...records: readonly Uint8Array[]): Uint8Array =>
  concatFlightForTest(flightMagicForTest, ...records)
const decodeFlightForTest = async (
  wire: Uint8Array,
  signal = new AbortController().signal,
  maxBytes?: number,
): Promise<{ metadata: unknown; flight: Uint8Array }> => {
  const decoded = await readComponentFlightFrames(flightStreamForTest([wire]), signal, maxBytes)
  return { metadata: decoded.metadata, flight: await collectFlightForTest(decoded.flight) }
}

test("Flight frames stream large records and decode across split transport chunks", async () => {
  const payload = new Uint8Array(70_001)
  for (let index = 0; index < payload.length; index++) payload[index] = index % 251
  const encoded = componentFlightFrames(
    { route: "/items" },
    flightStreamForTest([payload]),
    new AbortController().signal,
  )
  const wire = await collectFlightForTest(encoded)
  const decoded = await readComponentFlightFrames(
    flightStreamForTest([
      wire.subarray(0, 2),
      wire.subarray(2, 4),
      wire.subarray(4, 13),
      wire.subarray(13),
    ]),
    new AbortController().signal,
  )
  expect(decoded.metadata).toEqual({ route: "/items" })
  expect(await collectFlightForTest(decoded.flight)).toEqual(payload)
})

test("Flight frame encoding rejects empty bodies, empty chunks, and exceeded limits", async () => {
  const signal = new AbortController().signal
  expect(() =>
    componentFlightFrames({ detail: "x".repeat(2_048) }, flightStreamForTest([]), signal),
  ).toThrow()

  await expect(
    collectFlightForTest(componentFlightFrames({}, flightStreamForTest([]), signal)),
  ).rejects.toMatchObject({ code: "component_protocol" })
  await expect(
    collectFlightForTest(
      componentFlightFrames({}, flightStreamForTest([new Uint8Array(0)]), signal),
    ),
  ).rejects.toMatchObject({ code: "component_protocol" })
  await expect(
    collectFlightForTest(
      componentFlightFrames({}, flightStreamForTest([flightBytesForTest("too big")]), signal, 2),
    ),
  ).rejects.toMatchObject({ code: "component_limit", status: 413 })
})

test("Flight frame encoding cancels its source on consumer cancel and request abort", async () => {
  let cancelled = 0
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(flightBytesForTest("payload"))
    },
    cancel() {
      cancelled++
      return Promise.reject(new Error("source cancellation rejected"))
    },
  })
  const reader = componentFlightFrames({}, source, new AbortController().signal).getReader()
  await reader.read()
  await reader.read()
  await reader.read()
  await reader.cancel()
  expect(cancelled).toBe(1)

  let abortedSourceCancelled = 0
  const abort = new AbortController()
  const abortSource = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(flightBytesForTest("payload"))
    },
    cancel() {
      abortedSourceCancelled++
    },
  })
  const abortReader = componentFlightFrames({}, abortSource, abort.signal).getReader()
  await abortReader.read()
  await abortReader.read()
  await abortReader.read()
  abort.abort()
  await expect(abortReader.read()).rejects.toMatchObject({ code: "component_cancelled" })
  expect(abortedSourceCancelled).toBe(1)
})

test("Flight frame decoding rejects malformed magic and metadata records", async () => {
  const metadata = flightRecordForTest(1, flightBytesForTest("{}"))
  const body = flightRecordForTest(2, flightBytesForTest("x"))
  const terminal = flightRecordForTest(3, new Uint8Array())
  const oversizedMetadata = flightHeaderForTest(1, 2_049)
  const badMagic = Uint8Array.of(0, 0, 0, 0)

  const cases: readonly Uint8Array[] = [
    flightWireForTest(body),
    flightWireForTest(flightRecordForTest(2, flightBytesForTest("{}"))),
    flightWireForTest(flightRecordForTest(1, flightBytesForTest("{")), body, terminal),
    flightWireForTest(flightRecordForTest(1, Uint8Array.of(0xff)), body, terminal),
    flightWireForTest(metadata.subarray(0, metadata.length - 1)),
    concatFlightForTest(badMagic, metadata, body, terminal),
  ]
  for (const wire of cases) {
    await expect(decodeFlightForTest(wire)).rejects.toMatchObject({
      code: "component_protocol",
    })
  }
  await expect(
    readComponentFlightFrames(
      flightStreamForTest([concatFlightForTest(flightMagicForTest, oversizedMetadata)]),
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "component_limit", status: 413 })
})

test("Flight frame decoding rejects malformed, truncated, oversized, and trailing body records", async () => {
  const metadata = flightRecordForTest(1, flightBytesForTest("{}"))
  const body = flightRecordForTest(2, flightBytesForTest("x"))
  const terminal = flightRecordForTest(3, new Uint8Array())
  const cases: readonly Uint8Array[] = [
    flightWireForTest(metadata, flightRecordForTest(2, new Uint8Array()), terminal),
    flightWireForTest(metadata, terminal),
    flightWireForTest(metadata, body, flightRecordForTest(3, flightBytesForTest("x"))),
    flightWireForTest(metadata, body, terminal, Uint8Array.of(0)),
    flightWireForTest(metadata, flightHeaderForTest(2, 3), flightBytesForTest("xy")),
    flightWireForTest(metadata, body),
    flightWireForTest(metadata, body, flightRecordForTest(4, new Uint8Array())),
  ]
  for (const wire of cases) {
    await expect(decodeFlightForTest(wire)).rejects.toMatchObject({
      code: "component_protocol",
    })
  }
  await expect(
    decodeFlightForTest(flightWireForTest(metadata, flightHeaderForTest(2, 262_145))),
  ).rejects.toMatchObject({ code: "component_limit", status: 413 })
  await expect(
    decodeFlightForTest(
      flightWireForTest(metadata, body, terminal),
      new AbortController().signal,
      0,
    ),
  ).rejects.toMatchObject({ code: "component_limit", status: 413 })
})

test("Flight frame decoder bounds the number of records", async () => {
  const metadata = flightRecordForTest(1, flightBytesForTest("{}"))
  const body = flightRecordForTest(2, Uint8Array.of(1))
  const records = Array.from({ length: 8_209 }, () => body)
  const wire = flightWireForTest(metadata, ...records, flightRecordForTest(3, new Uint8Array()))
  await expect(decodeFlightForTest(wire)).rejects.toMatchObject({
    code: "component_limit",
    status: 413,
  })
})

test("Flight frame decoder cancels a pending read on abort and normalizes source errors", async () => {
  let cancelled = 0
  const abort = new AbortController()
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(flightMagicForTest.subarray(0, 2))
    },
    cancel() {
      cancelled++
    },
  })
  const pending = readComponentFlightFrames(source, abort.signal)
  await new Promise((resolve) => setTimeout(resolve, 0))
  abort.abort()
  await expect(pending).rejects.toMatchObject({ code: "component_cancelled", status: 499 })
  expect(cancelled).toBe(1)

  const failed = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("source failure"))
    },
  })
  await expect(
    readComponentFlightFrames(failed, new AbortController().signal),
  ).rejects.toMatchObject({
    code: "component_protocol",
    status: 400,
  })
})

test("Flight frame decoder cancels its upstream source when its result is abandoned", async () => {
  let cancelled = 0
  const prefix = flightWireForTest(flightRecordForTest(1, flightBytesForTest("{}")))
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(prefix)
    },
    cancel() {
      cancelled++
    },
  })
  const decoded = await readComponentFlightFrames(source, new AbortController().signal)
  await decoded.flight.cancel()
  expect(cancelled).toBe(1)
})

test("JSON component frames enforce metadata and aggregate body limits", async () => {
  expect(() => componentFrames({ detail: "x".repeat(262_145) }, {})).toThrow()
  expect(() => componentFrames({}, "payload", 1)).toThrow()

  const metadata = flightRecordForTest(1, flightBytesForTest("{}"))
  const body = flightRecordForTest(2, flightBytesForTest('"payload"'))
  const terminal = flightRecordForTest(3, new Uint8Array())
  const wire = concatFlightForTest(Uint8Array.of(78, 83, 67, 49), metadata, body, terminal)
  await expect(
    readComponentFrames(flightStreamForTest([wire]), new AbortController().signal, 4),
  ).rejects.toMatchObject({ code: "component_limit", status: 413 })
})

test("JSON component frames reject invalid ordering, headers, terminal records, and source errors", async () => {
  const magic = Uint8Array.of(78, 83, 67, 49)
  const metadata = flightRecordForTest(1, flightBytesForTest("{}"))
  const body = flightRecordForTest(2, flightBytesForTest('"payload"'))
  const terminal = flightRecordForTest(3, new Uint8Array())
  const cases: readonly Uint8Array[] = [
    concatFlightForTest(Uint8Array.of(0, 0, 0, 0), metadata, body, terminal),
    concatFlightForTest(magic, body, metadata, terminal),
    concatFlightForTest(magic, flightHeaderForTest(4, 1), flightBytesForTest("x")),
    concatFlightForTest(magic, flightHeaderForTest(1, 262_145)),
    concatFlightForTest(magic, metadata, flightRecordForTest(2, new Uint8Array()), terminal),
    concatFlightForTest(magic, metadata, terminal),
    concatFlightForTest(magic, metadata, body, flightRecordForTest(3, flightBytesForTest("x"))),
    concatFlightForTest(magic, metadata, body, terminal, Uint8Array.of(0)),
  ]
  for (const wire of cases) {
    await expect(
      readComponentFrames(flightStreamForTest([wire]), new AbortController().signal),
    ).rejects.toMatchObject({ code: "component_protocol" })
  }

  const failed = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("source failure"))
    },
  })
  await expect(readComponentFrames(failed, new AbortController().signal)).rejects.toMatchObject({
    code: "component_protocol",
    status: 400,
  })

  const abort = new AbortController()
  abort.abort()
  await expect(readComponentFrames(flightStreamForTest([]), abort.signal)).rejects.toMatchObject({
    code: "component_cancelled",
  })
})

test("JSON and Flight frame readers time out while waiting for transport bytes", async () => {
  const jsonMagic = Uint8Array.of(78, 83, 67, 49)
  const stalledJson = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(jsonMagic.subarray(0, 2))
    },
  })
  const jsonRead = readComponentFrames(stalledJson, new AbortController().signal)

  const flightPrefix = flightWireForTest(flightRecordForTest(1, flightBytesForTest("{}")))
  const stalledFlight = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(flightPrefix)
    },
  })
  const decoded = await readComponentFlightFrames(stalledFlight, new AbortController().signal)
  const flightRead = collectFlightForTest(decoded.flight)

  const [jsonResult, flightResult] = await Promise.allSettled([jsonRead, flightRead])
  expect(jsonResult.status).toBe("rejected")
  if (jsonResult.status === "rejected")
    expect(jsonResult.reason).toMatchObject({ code: "component_timeout", status: 504 })
  expect(flightResult.status).toBe("rejected")
  if (flightResult.status === "rejected")
    expect(flightResult.reason).toMatchObject({ code: "component_timeout", status: 504 })
}, 12_000)

test("Flight negotiation accepts only its exact media type with a valid positive quality", () => {
  const accepts = (value: string | null): boolean => {
    const headers = new Headers()
    if (value !== null) headers.set("accept", value)
    return acceptsComponentFlight(new Request("https://fixture.test/", { headers }))
  }

  expect(accepts(null)).toBe(false)
  expect(accepts("application/json")).toBe(false)
  expect(accepts(`${COMPONENT_FLIGHT_MEDIA_TYPE};q=0`)).toBe(false)
  expect(accepts(`${COMPONENT_FLIGHT_MEDIA_TYPE};Q=0.25, application/json`)).toBe(true)
  expect(accepts(`${COMPONENT_FLIGHT_MEDIA_TYPE};charset=utf-8`)).toBe(true)
  expect(accepts(`${COMPONENT_FLIGHT_MEDIA_TYPE};q=1.0000`)).toBe(false)
  expect(accepts(`${COMPONENT_FLIGHT_MEDIA_TYPE};q=0.5;q=0.2`)).toBe(false)
  expect(accepts(`${COMPONENT_FLIGHT_MEDIA_TYPE};q=0.5=1`)).toBe(false)
})

test("component request keys and closed envelopes reject invalid values at the boundary", () => {
  expect(componentKey("key")).toBe(true)
  expect(componentKey("é".repeat(64))).toBe(true)
  expect(componentKey("é".repeat(65))).toBe(false)
  expect(componentKey(0)).toBe(true)
  expect(componentKey(Number.MAX_SAFE_INTEGER)).toBe(true)
  expect(componentKey(Number.MAX_SAFE_INTEGER + 1)).toBe(false)
  expect(componentKey(Number.NaN)).toBe(false)
  expect(componentKey(1.5)).toBe(false)
  expect(componentKey("")).toBe(false)

  for (const value of [
    null,
    [],
    { ...selection, extra: true },
    { ...selection, build: "bad build" },
    { ...selection, reference: "" },
    { ...selection, key: "" },
    { ...selection, parent: 1 },
    { ...selection, generation: -1 },
    { ...selection, routeEpoch: Number.POSITIVE_INFINITY },
    { ...selection, authEpoch: 1.5 },
    { ...selection, input: { value: "x".repeat(1025) } },
  ])
    expect(() => parseComponentRequest(value)).toThrow()
})

test("component request decoding rejects noncanonical, malformed and oversized headers", () => {
  const base64url = (bytes: Uint8Array): string =>
    btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/={1,2}$/, "")
  const oversized = base64url(new TextEncoder().encode("x".repeat(2049)))
  const invalidUtf8 = base64url(Uint8Array.of(0xff))
  const malformedJson = base64url(new TextEncoder().encode("not-json"))

  expect(() =>
    readComponentRequest(
      request({
        "x-nifra-component": oversized,
        "sec-fetch-site": "same-origin",
      }),
    ),
  ).toThrow(expect.objectContaining({ code: "component_limit", status: 431 }))

  for (const header of ["%", "A", "AB", "A".repeat(2733), invalidUtf8, malformedJson])
    expect(() =>
      readComponentRequest(
        request({ "x-nifra-component": header, "sec-fetch-site": "same-origin" }),
      ),
    ).toThrow()
})

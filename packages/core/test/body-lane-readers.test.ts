import { describe, expect, test } from "bun:test"
import { markTrustedBodyFraming } from "../src/server/body.ts"
import {
  readBodyFramed,
  readBoundedJsonSource,
  SCHEMA_BODY_READER,
} from "../src/server/body-lane.ts"
import { isResponseResult } from "../src/server/runtime-core.ts"
import type { RequestSource } from "../src/server/server.ts"

type Readers = {
  readonly json?: () => Promise<unknown>
  readonly jsonWithByteLength?: () => Promise<{ value: unknown; byteLength: number }>
  readonly bytes?: () => Promise<Uint8Array>
  readonly arrayBuffer?: () => Promise<ArrayBuffer>
}

const source = (headers: Record<string, string>, readers: Readers = {}): RequestSource =>
  ({
    method: "POST",
    url: "http://test/",
    headers: new Headers(headers),
    body: null,
    json: async () => ({}),
    arrayBuffer: async () => new ArrayBuffer(0),
    ...readers,
  }) as unknown as RequestSource

async function answer(value: unknown): Promise<unknown> {
  const settled = await value
  if (!isResponseResult(settled)) return settled
  const response = settled.toResponse()
  return [response.status, ((await response.json()) as { error: string }).error]
}

const reject = () => Promise.reject(new Error("socket reset"))
const poisoned = () => JSON.parse('{"__proto__": {"admin": true}}') as unknown
const bytesOf = (text: string) => new TextEncoder().encode(text)

/** Read once directly and once through the continuation form, which must agree. */
async function both(src: () => RequestSource, maxBytes = 64): Promise<unknown[]> {
  const direct = await answer(readBoundedJsonSource(src(), maxBytes))
  const continued = await readBoundedJsonSource(
    src(),
    maxBytes,
    "reject",
    (result) => answer(result),
    (error) => ["error", (error as Error).message],
  )
  return [direct, continued]
}

describe("bounded JSON source readers", () => {
  test("a malformed or oversized declared length is refused before any read", async () => {
    expect(await both(() => source({ "content-length": "ten" }))).toEqual([
      [400, "invalid_content_length"],
      [400, "invalid_content_length"],
    ])
    expect(await both(() => source({ "content-length": "100" }))).toEqual([
      [413, "payload_too_large"],
      [413, "payload_too_large"],
    ])
  })

  test("a trusted-framing source whose parsed value is poisoned answers invalid_json", async () => {
    const trusted = () => {
      const value = source({ "content-length": "30" }, { json: async () => poisoned() })
      markTrustedBodyFraming(value)
      return value
    }
    expect(await both(trusted)).toEqual([
      [400, "invalid_json"],
      [400, "invalid_json"],
    ])
  })

  test("jsonWithByteLength rechecks the delivered bytes and the proto guard", async () => {
    const over = () =>
      source(
        { "content-length": "10" },
        { jsonWithByteLength: async () => ({ value: {}, byteLength: 11 }) },
      )
    expect(await both(over)).toEqual([
      [413, "payload_too_large"],
      [413, "payload_too_large"],
    ])
    const guarded = () =>
      source(
        { "content-length": "30" },
        { jsonWithByteLength: async () => ({ value: poisoned(), byteLength: 30 }) },
      )
    expect(await both(guarded)).toEqual([
      [400, "invalid_json"],
      [400, "invalid_json"],
    ])
    const failed = () => source({ "content-length": "30" }, { jsonWithByteLength: reject })
    expect(await both(failed)).toEqual([
      [400, "invalid_json"],
      [400, "invalid_json"],
    ])
  })

  test("the bytes reader rechecks the delivered bytes and refuses a failed read", async () => {
    const over = () => source({ "content-length": "2" }, { bytes: async () => bytesOf('{"a":1}') })
    expect(await both(over)).toEqual([
      [413, "payload_too_large"],
      [413, "payload_too_large"],
    ])
    expect(await both(() => source({ "content-length": "7" }, { bytes: reject }))).toEqual([
      [400, "invalid_json"],
      [400, "invalid_json"],
    ])
  })

  test("the arrayBuffer reader rechecks, parses and refuses a failed read", async () => {
    const buffer = (text: string) => async () => bytesOf(text).buffer as ArrayBuffer
    const over = () => source({ "content-length": "2" }, { arrayBuffer: buffer('{"a":1}') })
    expect(await both(over)).toEqual([
      [413, "payload_too_large"],
      [413, "payload_too_large"],
    ])
    const malformed = () => source({ "content-length": "4" }, { arrayBuffer: buffer("{nop") })
    expect(await both(malformed)).toEqual([
      [400, "invalid_json"],
      [400, "invalid_json"],
    ])
    expect(await both(() => source({ "content-length": "7" }, { arrayBuffer: reject }))).toEqual([
      [400, "invalid_json"],
      [400, "invalid_json"],
    ])
    const ok = () => source({ "content-length": "7" }, { arrayBuffer: buffer('{"a":1}') })
    expect(await both(ok)).toEqual([{ a: 1 }, { a: 1 }])
  })

  test("a source with no declared length and no body answers invalid_json", async () => {
    expect(await both(() => source({}))).toEqual([
      [400, "invalid_json"],
      [400, "invalid_json"],
    ])
  })
})

describe("framed body schema reader", () => {
  test("a schema reader that throws synchronously reaches onError", async () => {
    const schema = {
      [SCHEMA_BODY_READER]: () => {
        throw new Error("reader crashed")
      },
    }
    const outcome = await readBodyFramed(
      source({ "content-type": "application/octet-stream" }),
      64,
      "reject",
      () => "parsed",
      () => "response",
      (error) => `error: ${(error as Error).message}`,
      schema,
    )
    expect(outcome).toBe("error: reader crashed")
  })
})

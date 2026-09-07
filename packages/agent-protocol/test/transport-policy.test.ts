import { describe, expect, test } from "bun:test"
import {
  assertTransportByteLimit,
  parseTransportContentLength,
  readBoundedTransportBytes,
} from "../src/transport-policy.ts"

describe("transport byte policy", () => {
  test("parses only safe decimal content lengths", () => {
    expect(parseTransportContentLength(null)).toBeUndefined()
    expect(parseTransportContentLength("")).toBeUndefined()
    expect(parseTransportContentLength("12")).toBe(12)
    expect(parseTransportContentLength("1.2")).toBeUndefined()
    expect(parseTransportContentLength("12x")).toBeUndefined()
    expect(parseTransportContentLength("9".repeat(40))).toBe(Number.POSITIVE_INFINITY)
  })

  test("enforces an adapter-specific minimum within the shared maximum", () => {
    expect(() => assertTransportByteLimit(512, { minimum: 1_024 })).toThrow(/between 1024/)
    expect(() => assertTransportByteLimit(65 * 1024 * 1024)).toThrow(/between 0 and 67108864/)
    expect(() => assertTransportByteLimit(1_024, { minimum: 1_024 })).not.toThrow()
  })

  test("cancels and classifies an oversized stream before retaining it", async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
      },
      cancel() {
        cancelled = true
      },
    })
    await expect(readBoundedTransportBytes(body, 2)).resolves.toEqual({
      ok: false,
      reason: "too-large",
    })
    expect(cancelled).toBe(true)
  })

  test("returns one bounded byte array for a stream split across chunks", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]))
        controller.enqueue(new Uint8Array([3]))
        controller.close()
      },
    })
    const result = await readBoundedTransportBytes(body, 3)
    expect(result.ok).toBe(true)
    if (result.ok) expect([...result.bytes]).toEqual([1, 2, 3])
  })
})

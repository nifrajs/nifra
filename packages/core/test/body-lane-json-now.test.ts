import { describe, expect, test } from "bun:test"
import {
  readBodyFramed,
  readBodyFramedNow,
  readBoundedJsonNow,
  readBoundedJsonSource,
} from "../src/server/body-lane.ts"
import { isResponseResult } from "../src/server/runtime-core.ts"
import type { RequestSource } from "../src/server/server.ts"

type Parsed = { readonly value: unknown; readonly byteLength: number }
type Source = RequestSource & {
  readonly jsonNow?: () => Parsed | undefined
  readonly jsonWithByteLength?: () => Promise<Parsed>
}

const source = (
  headers: Record<string, string>,
  readers: Pick<Source, "jsonNow" | "jsonWithByteLength"> = {},
): Source => ({
  method: "POST",
  url: "http://test/",
  headers: new Headers(headers),
  body: null,
  json: async () => ({}),
  arrayBuffer: async () => new ArrayBuffer(0),
  ...readers,
})

const declared = { "content-length": "7", "content-type": "application/json" }
const poisoned = (): unknown => JSON.parse('{"__proto__": {"admin": true}}')

const verdict = (value: unknown): unknown => {
  if (!isResponseResult(value)) return value
  const response = value.toResponse()
  return response.status
}

/** The continuation form, the one the route executors use. */
const continued = (src: Source, maxBytes = 64, policy: "reject" | "strip" | "ignore" = "reject") =>
  readBoundedJsonNow(
    src,
    maxBytes,
    policy,
    (result) => verdict(result),
    (error) => {
      throw error
    },
  )

describe("a source that already holds its body (jsonNow)", () => {
  test("answers synchronously: no promise reaches the continuation", () => {
    const result = continued(
      source(declared, { jsonNow: () => ({ value: { a: 1 }, byteLength: 7 }) }),
    )
    expect(result).not.toBeInstanceOf(Promise)
    expect(result).toEqual({ a: 1 })
  })

  test("never touches the async readers", () => {
    let touched = 0
    const result = continued(
      source(declared, {
        jsonNow: () => ({ value: { a: 1 }, byteLength: 7 }),
        jsonWithByteLength: () => {
          touched++
          return Promise.resolve({ value: {}, byteLength: 0 })
        },
      }),
    )
    expect(result).toEqual({ a: 1 })
    expect(touched).toBe(0)
  })

  test("the form without a continuation still returns a promise", async () => {
    const result = readBoundedJsonSource(
      source(declared, { jsonNow: () => ({ value: { a: 1 }, byteLength: 7 }) }),
      64,
    )
    expect(result).toBeInstanceOf(Promise)
    expect(await result).toEqual({ a: 1 })
  })

  test("a body that is not in hand yet falls back to the async reader", async () => {
    const result = continued(
      source(declared, {
        jsonNow: () => undefined,
        jsonWithByteLength: () => Promise.resolve({ value: { late: true }, byteLength: 7 }),
      }),
    )
    expect(result).toBeInstanceOf(Promise)
    expect(await result).toEqual({ late: true })
  })

  test("malformed JSON is a flat 400, whichever form asks", async () => {
    const throws = (): Parsed => {
      throw new SyntaxError("Unexpected token")
    }
    expect(continued(source(declared, { jsonNow: throws }))).toBe(400)
    expect(verdict(await readBoundedJsonSource(source(declared, { jsonNow: throws }), 64))).toBe(
      400,
    )
  })

  test("more bytes than declared, or than the cap, is a 413", async () => {
    expect(continued(source(declared, { jsonNow: () => ({ value: {}, byteLength: 9 }) }))).toBe(413)
    // A declared length over the cap is refused before the body is looked at, so it is not synchronous.
    expect(
      await continued(
        source(
          { ...declared, "content-length": "60" },
          { jsonNow: () => ({ value: {}, byteLength: 60 }) },
        ),
        16,
      ),
    ).toBe(413)
    expect(
      verdict(
        await readBoundedJsonSource(
          source(declared, { jsonNow: () => ({ value: {}, byteLength: 9 }) }),
          64,
        ),
      ),
    ).toBe(413)
  })

  const hasOwnProto = (value: unknown): boolean => {
    expect(typeof value).toBe("object")
    return typeof value === "object" && value !== null && Object.hasOwn(value, "__proto__")
  }

  test("prototype poisoning follows the app's policy", () => {
    const poison = (): Parsed => ({ value: poisoned(), byteLength: 7 })
    expect(continued(source(declared, { jsonNow: poison }), 64, "reject")).toBe(400)
    const stripped = continued(source(declared, { jsonNow: poison }), 64, "strip")
    expect(hasOwnProto(stripped)).toBe(false)
    const kept = continued(source(declared, { jsonNow: poison }), 64, "ignore")
    expect(hasOwnProto(kept)).toBe(true)
  })

  test("an unparsable Content-Length is refused before the body is read", () => {
    let read = 0
    const result = continued(
      source(
        { ...declared, "content-length": "abc" },
        {
          jsonNow: () => {
            read++
            return { value: {}, byteLength: 0 }
          },
        },
      ),
    )
    expect(result).toBeInstanceOf(Promise)
    expect(read).toBe(0)
  })

  test("a chunked request keeps the streaming lane", async () => {
    let read = 0
    const result = readBoundedJsonSource(
      source(
        {
          "transfer-encoding": "chunked",
          "content-length": "7",
          "content-type": "application/json",
        },
        {
          jsonNow: () => {
            read++
            return { value: {}, byteLength: 0 }
          },
        },
      ),
      64,
    )
    await result
    expect(read).toBe(0)
  })

  test("a continuation that throws on a ready body rejects the promise instead of throwing past it", async () => {
    const ready = source(declared, { jsonNow: () => ({ value: { a: 1 }, byteLength: 7 }) })
    const boom = new Error("continuation failed")
    const lane = readBoundedJsonSource(
      ready,
      64,
      "reject",
      () => {
        throw boom
      },
      (error) => {
        throw error
      },
    )
    expect(lane).toBeInstanceOf(Promise)
    await expect(lane).rejects.toBe(boom)
    const framed = readBodyFramed(
      ready,
      64,
      "reject",
      () => {
        throw boom
      },
      () => "response",
      (error) => {
        throw error
      },
    )
    expect(framed).toBeInstanceOf(Promise)
    await expect(framed).rejects.toBe(boom)
  })

  test("readBodyFramed hands the parsed value to the route with no promise", () => {
    const result = readBodyFramedNow(
      source(declared, { jsonNow: () => ({ value: { a: 1 }, byteLength: 7 }) }),
      64,
      "reject",
      (parsed) => ({ parsed }),
      () => ({ parsed: "response" }),
      (error) => {
        throw error
      },
    )
    expect(result).not.toBeInstanceOf(Promise)
    expect(result).toEqual({ parsed: { a: 1 } })
  })
})

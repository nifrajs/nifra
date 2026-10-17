import { describe, expect, test } from "bun:test"
import { type DenoSlots, denoRequestSlots, denoWireHeader } from "../src/server/runtime-core.ts"

// Deno itself is exercised by packages/deno/test/serve.test.ts; these pin, on any runtime, when the
// single-header reader is trusted and when `headers` has to answer instead.
const inner = Symbol("request")
const cache = Symbol("headers cache")
const slots: DenoSlots = { inner, headers: cache }

const served = (header: (name: string) => unknown, built?: Headers): object => ({
  [inner]: { header },
  [cache]: built,
})

describe("denoRequestSlots", () => {
  test("finds Deno's inner-record and headers-cache slots by their names", () => {
    const found = denoRequestSlots({ [Symbol("url")]: 1, [inner]: {}, [cache]: undefined })
    expect(found?.inner).toBe(inner)
    expect(found?.headers).toBe(cache)
  })

  test("is absent unless both slots are there", () => {
    expect(denoRequestSlots({ [inner]: {} })).toBeUndefined()
    expect(denoRequestSlots({ [cache]: undefined })).toBeUndefined()
    expect(denoRequestSlots(new Request("http://localhost/"))).toBeUndefined()
  })
})

describe("denoWireHeader", () => {
  test("answers with the inner record's value while the Headers are unbuilt", () => {
    const request = served((name) => (name === "host" ? "example.com" : null))
    expect(denoWireHeader(request, slots, "host")).toBe("example.com")
    expect(denoWireHeader(request, slots, "content-type")).toBeNull()
  })

  test("defers to built Headers", () => {
    const request = served(() => "wire", new Headers({ host: "built" }))
    expect(denoWireHeader(request, slots, "host")).toBeUndefined()
  })

  test("defers when there is no reader or it answers off-type", () => {
    const offType = served(() => 42)
    expect(denoWireHeader({ [cache]: undefined }, slots, "host")).toBeUndefined()
    expect(denoWireHeader({ [inner]: {}, [cache]: undefined }, slots, "host")).toBeUndefined()
    expect(denoWireHeader(offType, slots, "host")).toBeUndefined()
  })

  // Building `headers` on a closed request throws the same error, so the reader's is passed on.
  test("passes on the error a closed request's reader throws", () => {
    const closed = served(() => {
      throw new TypeError("Request closed")
    })
    expect(() => denoWireHeader(closed, slots, "host")).toThrow("Request closed")
  })
})

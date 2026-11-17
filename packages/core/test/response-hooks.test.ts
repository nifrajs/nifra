import { expect, test } from "bun:test"
import { markTaggedResponse } from "../src/server/respond.ts"
import { withReplacedBody } from "../src/server/response-hooks.ts"

test("body replacement reuses headers after the old length was removed", async () => {
  const NativeHeaders = globalThis.Headers
  let copies = 0
  class CountingHeaders extends NativeHeaders {
    constructor(init?: HeadersInit) {
      copies++
      super(init)
    }
  }
  globalThis.Headers = CountingHeaders
  try {
    const owner = {}
    const response = markTaggedResponse(
      new Response("old", {
        headers: { "content-type": "application/json", "content-length": "3" },
      }),
      "old",
      owner,
    )
    response.headers.delete("content-length")
    const replaced = withReplacedBody(response, new Uint8Array([1, 2, 3]))

    expect(copies).toBe(0)
    expect(replaced.headers.get("content-length")).toBeNull()
    expect([...new Uint8Array(await replaced.arrayBuffer())]).toEqual([1, 2, 3])
  } finally {
    globalThis.Headers = NativeHeaders
  }
})

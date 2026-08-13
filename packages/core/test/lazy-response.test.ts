import { describe, expect, test } from "bun:test"
// The lazy response the Node bridge takes off `c.text`/`c.json`. Tested here directly, not through a
// handler: the helpers only build it on real Node (`Bun`/`Deno` absent), so under `bun test` the
// class would never run. The class itself is runtime-agnostic - its whole point is to look like a
// `Response` until read - so it is fully exercisable in isolation.
import { lazyResponse } from "../src/server/lazy-response.ts"
import { taggedResponseBody } from "../src/server/respond.ts"

const RESPONSE_RESULT = Symbol.for("nifra.response.result")

describe("lazyResponse - deferred Response for the Node direct-write lane", () => {
  test("reads status without materializing the real Response, and toNodeBody yields the direct-write shape", () => {
    const r = lazyResponse("Hi", 201, { "content-type": "text/plain; charset=utf-8" })
    expect(r.status).toBe(201)
    const node = (r as unknown as { toNodeBody(): unknown }).toNodeBody() as {
      status: number
      headers: Record<string, string>
      body: string
    }
    expect(node).toEqual({
      status: 201,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: "Hi",
    })
  })

  test("carries the ResponseResult mark so the bridge prefers it over draining a Response", () => {
    const r = lazyResponse("x", 200, { "content-type": "text/plain" })
    expect((r as unknown as { [RESPONSE_RESULT]?: unknown })[RESPONSE_RESULT]).toBe(true)
  })

  test("is a real Response instance and forwards its members once materialized", async () => {
    const r = lazyResponse("body-text", 200, { "content-type": "text/plain; charset=utf-8" })
    expect(r instanceof Response).toBe(true)
    // A forwarded member (`text`) materializes the real Response and reads the same bytes.
    expect(await r.text()).toBe("body-text")
    expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8")
  })

  test("toNodeBody stops answering once the real Response has been observed - the hook path owns it from there", async () => {
    const r = lazyResponse("z", 200, { "content-type": "text/plain" })
    // Touch the Web surface: a response hook reading `.headers` forces materialization.
    r.headers.set("x-touched", "1")
    expect((r as unknown as { toNodeBody(): unknown }).toNodeBody()).toBeUndefined()
    // The bridge now reaches the writer through `toResponse()`; that Response carries the framework
    // body tag, so even a hook-touched response still writes its bytes without a stream drain.
    const real = (r as unknown as { toResponse(): Response }).toResponse()
    expect(taggedResponseBody(real)).toBe("z")
    expect(real.headers.get("x-touched")).toBe("1")
  })

  test("toResponse() returns a tagged Response with the same status, headers, and body", async () => {
    const r = lazyResponse('{"n":7}', 200, { "content-type": "application/json;charset=utf-8" })
    const real = (r as unknown as { toResponse(): Response }).toResponse()
    expect(real.status).toBe(200)
    expect(real.headers.get("content-type")).toBe("application/json;charset=utf-8")
    expect(taggedResponseBody(real)).toBe('{"n":7}')
    expect(await real.json()).toEqual({ n: 7 })
  })

  test("clone works after deferral", async () => {
    const r = lazyResponse("clone-me", 200, { "content-type": "text/plain" })
    const c = r.clone()
    expect(await c.text()).toBe("clone-me")
    expect(await r.text()).toBe("clone-me")
  })
})

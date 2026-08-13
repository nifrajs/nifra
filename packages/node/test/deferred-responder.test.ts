import { describe, expect, test } from "bun:test"
// Importing the adapter registers the `c.json`/`c.text` Node fast-lane factory as a module side effect.
import "../src/index.ts"

// The factory core reaches over the shared-symbol seam. Exercised directly here: core's own gate
// (`DEFERS_RESPONSE`) is false under Bun, so the branch that calls this is unreachable from a Bun test -
// but the factory (DeferringResponse.fromView) is the Node-only code that moved out of core, so it is
// tested where it runs.
type Responder = (body: string, status: number, headers: Record<string, string>) => Response
const responder = (globalThis as unknown as Record<symbol, Responder | undefined>)[
  Symbol.for("nifra.deferred.responder")
]

interface NodeBodyView {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: string
}
const nodeBody = (r: Response): NodeBodyView | undefined =>
  (r as unknown as { toNodeBody(): NodeBodyView | undefined }).toNodeBody()

describe("deferred responder - the c.json/c.text Node fast-lane factory", () => {
  test("registered as a side effect of importing the adapter", () => {
    expect(typeof responder).toBe("function")
  })

  test("reads status and the direct-write view without materializing a Response", () => {
    const r = (responder as Responder)("Hi", 201, { "content-type": "text/plain; charset=utf-8" })
    expect(r.status).toBe(201)
    expect(nodeBody(r)).toEqual({
      status: 201,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: "Hi",
    })
  })

  test("is instanceof Response and materializes identical bytes and content-type on read", async () => {
    const r = (responder as Responder)('{"n":7}', 200, {
      "content-type": "application/json;charset=utf-8",
    })
    expect(r instanceof Response).toBe(true)
    expect(await r.text()).toBe('{"n":7}')
    expect(r.headers.get("content-type")).toBe("application/json;charset=utf-8")
  })

  test("toNodeBody stops answering once the real Response has been observed", async () => {
    const r = (responder as Responder)("z", 200, { "content-type": "text/plain" })
    await r.text() // materialize the real Response
    expect(nodeBody(r)).toBeUndefined()
  })

  test("clone resolves through the forwarded Response surface", async () => {
    const r = (responder as Responder)("clone-me", 200, { "content-type": "text/plain" })
    const clone = r.clone()
    expect(await clone.text()).toBe("clone-me")
    expect(await r.text()).toBe("clone-me")
  })
})

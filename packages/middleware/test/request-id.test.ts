import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { requestId } from "@nifrajs/middleware"

describe("requestId", () => {
  test("generates an id, exposes c.requestId, echoes the header", async () => {
    const app = server()
      .use(requestId())
      .get("/", (c) => ({ id: c.requestId })) // c.requestId must be typed (threaded by derive)
    const res = await app.fetch(new Request("http://x/"))
    const body = (await res.json()) as { id: string }
    expect(body.id).toMatch(/[0-9a-f-]{36}/) // a uuid
    expect(res.headers.get("x-request-id")).toBe(body.id)
  })

  test("reuses an inbound x-request-id (trace propagation)", async () => {
    const app = server()
      .use(requestId())
      .get("/", (c) => ({ id: c.requestId }))
    const res = await app.fetch(
      new Request("http://x/", { headers: { "x-request-id": "trace-42" } }),
    )
    expect(((await res.json()) as { id: string }).id).toBe("trace-42")
    expect(res.headers.get("x-request-id")).toBe("trace-42")
  })

  test("honors a custom header + generator", async () => {
    let n = 0
    const app = server()
      .use(requestId({ header: "x-trace", generate: () => `id-${++n}` }))
      .get("/", (c) => ({ id: c.requestId }))
    const res = await app.fetch(new Request("http://x/"))
    expect(((await res.json()) as { id: string }).id).toBe("id-1")
    expect(res.headers.get("x-trace")).toBe("id-1")
  })

  test("applied twice is idempotent (one derive)", async () => {
    const plugin = requestId()
    const app = server()
      .use(plugin)
      .use(plugin)
      .get("/", (c) => ({ id: c.requestId }))
    const res = await app.fetch(new Request("http://x/", { headers: { "x-request-id": "z" } }))
    expect(((await res.json()) as { id: string }).id).toBe("z")
  })
})

import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"

describe("context extension — derive / decorate", () => {
  test("decorate (static) and derive (per-request) reach the handler", async () => {
    const app = server()
      .decorate("version", "1.0")
      .derive((c) => ({ rid: c.req.headers.get("x-rid") ?? "none" }))
      .get("/info", (c) => ({ version: c.version, rid: c.rid }))

    const r1 = await app.fetch(new Request("http://x/info", { headers: { "x-rid": "abc" } }))
    expect(await r1.json()).toEqual({ version: "1.0", rid: "abc" })

    // derive recomputes per request
    const r2 = await app.fetch(new Request("http://x/info", { headers: { "x-rid": "xyz" } }))
    expect(await r2.json()).toEqual({ version: "1.0", rid: "xyz" })
  })

  test("async derive is awaited", async () => {
    const app = server()
      .derive(async () => {
        await Promise.resolve()
        return { token: "secret" }
      })
      .get("/a", (c) => ({ token: c.token }))

    expect(await (await app.fetch(new Request("http://x/a"))).json()).toEqual({ token: "secret" })
  })

  test("order-scoped: a route registered before an extension does not get it", async () => {
    const app = server()
      .get("/early", (c) => ({ hasVersion: "version" in c }))
      .decorate("version", "1.0")

    expect(await (await app.fetch(new Request("http://x/early"))).json()).toEqual({
      hasVersion: false,
    })
  })
})

import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"

describe("context helpers — c.request alias + c.json/c.text", () => {
  test("c.request is the SAME Request as c.req", async () => {
    const app = server().get("/r", (c) => ({ same: c.request === c.req, url: c.request.url }))
    const res = await app.fetch(new Request("http://x/r"))
    expect(await res.json()).toEqual({ same: true, url: "http://x/r" })
  })

  test("c.json(body, status) → JSON Response with that status", async () => {
    const app = server().get("/j", (c) => c.json({ ok: false, error: "nope" }, 422))
    const res = await app.fetch(new Request("http://x/j"))
    expect(res.status).toBe(422)
    expect(res.headers.get("content-type")).toContain("application/json")
    expect(await res.json()).toEqual({ ok: false, error: "nope" })
  })

  test("throw c.json(...) short-circuits from a derive (the 401 pattern)", async () => {
    const app = server()
      .derive((c) => {
        if (!c.req.headers.get("authorization")) throw c.json({ error: "unauthorized" }, 401)
        return {}
      })
      .get("/p", () => ({ ok: true }))
    const res = await app.fetch(new Request("http://x/p"))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "unauthorized" })
  })

  test("c.text(body, status) → text/plain with that status", async () => {
    const app = server().get("/t", (c) => c.text("hello", 201))
    const res = await app.fetch(new Request("http://x/t"))
    expect(res.status).toBe(201)
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(await res.text()).toBe("hello")
  })

  test("c.json accepts a full ResponseInit (status + headers)", async () => {
    const app = server().get("/h", (c) =>
      c.json({ a: 1 }, { status: 418, headers: { "x-test": "1" } }),
    )
    const res = await app.fetch(new Request("http://x/h"))
    expect(res.status).toBe(418)
    expect(res.headers.get("x-test")).toBe("1")
  })
})

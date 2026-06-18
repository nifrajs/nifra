import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { methodOverride } from "../src/index.ts"

describe("methodOverride()", () => {
  test("rewrites an allowed POST before routing and preserves the body", async () => {
    const app = server()
      .use(methodOverride())
      .patch("/items", async (c) => ({ method: c.req.method, body: await c.boundedJson(64) }))

    const res = await app.fetch(
      new Request("http://x/items", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "11",
          "x-http-method-override": "PATCH",
        },
        body: '{"ok":true}',
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ method: "PATCH", body: { ok: true } })
  })

  test("ignores non-source methods by default", async () => {
    const app = server()
      .use(methodOverride())
      .delete("/items", () => ({ deleted: true }))
      .get("/items", () => ({ ok: true }))

    const res = await app.fetch(
      new Request("http://x/items", {
        headers: { "x-http-method-override": "DELETE" },
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test("rejects invalid, disallowed, and conflicting override values", async () => {
    const app = server()
      .use(methodOverride({ query: "_method" }))
      .patch("/items", () => ({ ok: true }))

    const invalid = await app.fetch(
      new Request("http://x/items", {
        method: "POST",
        headers: { "x-http-method-override": "TRACE" },
      }),
    )
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ ok: false, error: "invalid_method_override" })

    const conflict = await app.fetch(
      new Request("http://x/items?_method=PATCH", {
        method: "POST",
        headers: { "x-http-method-override": "DELETE" },
      }),
    )
    expect(conflict.status).toBe(400)
  })

  test("supports query override when explicitly enabled", async () => {
    const app = server()
      .use(methodOverride({ query: "_method", header: false }))
      .delete("/items", () => ({ method: "delete" }))

    const res = await app.fetch(new Request("http://x/items?_method=DELETE", { method: "POST" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ method: "delete" })
  })

  test("validates construction", () => {
    expect(() => methodOverride({ header: "" })).toThrow(/header/)
    expect(() => methodOverride({ query: "" })).toThrow(/query/)
  })
})

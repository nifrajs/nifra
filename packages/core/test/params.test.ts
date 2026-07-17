import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { server } from "../src/index.ts"

// A declared `params` schema validates (and can coerce) path params at the boundary, before the handler
// runs - the same "invalid -> 422" contract the `body` slot already gives, which path params never had.
describe("params schema slot (validate + coerce path params at the boundary)", () => {
  test("a malformed path param is a 422 before the handler runs", async () => {
    let handlerRan = false
    const app = server().get(
      "/users/:id",
      { params: t.object({ id: t.string({ format: "uuid" }) }) },
      (c) => {
        handlerRan = true
        return { id: c.params.id }
      },
    )
    const bad = await app.fetch(new Request("http://localhost/users/not-a-uuid"))
    expect(bad.status).toBe(422)
    expect(handlerRan).toBe(false)

    const uuid = "018f4d3a-0000-7000-8000-000000000000"
    const ok = await app.fetch(new Request(`http://localhost/users/${uuid}`))
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ id: uuid })
  })

  test("t.query coerces a numeric path param - the handler sees a real number", async () => {
    const app = server().get(
      "/items/:id",
      { params: t.query({ id: t.integer({ minimum: 1 }) }) },
      (c) => ({ doubled: c.params.id * 2 }), // c.params.id is `number`, not `string`
    )
    const ok = await app.fetch(new Request("http://localhost/items/21"))
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ doubled: 42 })

    // Out of range (after coercion) and non-numeric both 422 at the boundary.
    expect((await app.fetch(new Request("http://localhost/items/0"))).status).toBe(422)
    expect((await app.fetch(new Request("http://localhost/items/abc"))).status).toBe(422)
  })

  test("params validation runs alongside body + query on one route", async () => {
    const app = server().post(
      "/orgs/:org/items",
      {
        params: t.object({ org: t.string({ minLength: 2 }) }),
        query: t.query({ page: t.integer() }),
        body: t.object({ name: t.string() }),
      },
      (c) => ({ org: c.params.org, page: c.query.page, name: c.body.name }),
    )
    const ok = await app.fetch(
      new Request("http://localhost/orgs/acme/items?page=3", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "widget" }),
      }),
    )
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ org: "acme", page: 3, name: "widget" })

    // A bad param fails before body/query even when they're valid.
    const badParam = await app.fetch(
      new Request("http://localhost/orgs/a/items?page=3", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "widget" }),
      }),
    )
    expect(badParam.status).toBe(422)
  })

  test("no params schema -> c.params stays the raw path strings (unchanged behavior)", async () => {
    const app = server().get("/a/:x/:y", (c) => ({ x: c.params.x, y: c.params.y }))
    const res = await app.fetch(new Request("http://localhost/a/1/two"))
    expect(await res.json()).toEqual({ x: "1", y: "two" })
  })
})

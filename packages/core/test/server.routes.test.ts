import { describe, expect, test } from "bun:test"
import type { StandardSchemaV1 } from "../src/index.ts"
import { server } from "../src/index.ts"
import { defineContract, implement } from "../src/server/contract.ts"

const passThrough: StandardSchemaV1 = {
  "~standard": { version: 1, vendor: "test", validate: (value) => ({ value }) },
}

describe("Server.routes()", () => {
  test("enumerates inline routes in registration order, carrying schemas", () => {
    const app = server()
      .get("/users/:id", (c) => ({ id: c.params.id }))
      .post("/users", { body: passThrough }, () => ({ ok: true }))

    const routes = app.routes()
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /users/:id", "POST /users"])
    expect(routes[0]?.schema).toBeUndefined()
    expect(routes[1]?.schema?.body).toBe(passThrough)
  })

  test("carries a declared response schema so tooling/agents can introspect the output shape", () => {
    const app = server().get("/me", { response: passThrough }, () => ({ id: "1" }))
    // The response contract rides the same descriptor path as body/query — the OpenAPI generator and
    // `nifra context`/MCP read it from `app.routes()` to surface the exact output shape.
    expect(app.routes()[0]?.schema?.response).toBe(passThrough)
  })

  test("implement() populates routes through the same registration path", () => {
    const contract = defineContract({
      list: { method: "GET", path: "/items" },
      getOne: { method: "GET", path: "/items/:id" },
    })
    const app = implement(contract, { list: () => [], getOne: (c) => ({ id: c.params.id }) })

    expect(
      app
        .routes()
        .map((r) => `${r.method} ${r.path}`)
        .sort(),
    ).toEqual(["GET /items", "GET /items/:id"])
  })
})

describe("audit 2026-06: param/query/body parity fixes", () => {
  test("an empty path segment never matches a :param (double-slash → 404)", async () => {
    const app = server().get("/users/:id/posts", (c) => ({ id: c.params.id }))
    expect((await app.fetch(new Request("http://t/users//posts"))).status).toBe(404)
    expect((await app.fetch(new Request("http://t/users/42/posts"))).status).toBe(200)
    // trailing param position too
    const app2 = server().get("/users/:id", (c) => ({ id: c.params.id }))
    expect((await app2.fetch(new Request("http://t/users/"))).status).toBe(404)
  })

  test("repeated query keys validate as arrays; single keys stay strings", async () => {
    const schema = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: (value: unknown) => ({ value }),
      },
    }
    const app = server().get("/s", { query: schema as never }, (c) => c.query)
    const res = await app.fetch(new Request("http://t/s?tag=a&tag=b&one=x"))
    expect(await res.json()).toEqual({ tag: ["a", "b"], one: "x" })
  })

  test("hostile query keys are inert own keys (constructor crashed the promotion pre-fix)", async () => {
    const echo = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: (value: unknown) => ({ value }),
      },
    }
    const app = server().get("/s", { query: echo as never }, (c) => c.query)
    const res = await app.fetch(
      new Request("http://t/s?constructor=a&constructor=b&__proto__=x&toString=y"),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    // Bracket access on purpose throughout: dot access on these names resolves through the
    // inherited Object.prototype TYPES (constructor: Function, toString: () => string), and an
    // object-literal `__proto__: "x"` expectation would set the literal's prototype — the very
    // traps this test exists to cover.
    // biome-ignore lint/complexity/useLiteralKeys: see above — the bracket IS the assertion
    expect(body["constructor"]).toEqual(["a", "b"])
    expect(Object.hasOwn(body, "__proto__")).toBe(true)
    // biome-ignore lint/complexity/useLiteralKeys: see above
    expect(body["__proto__"]).toBe("x")
    // biome-ignore lint/complexity/useLiteralKeys: see above
    expect(body["toString"]).toBe("y")
    // biome-ignore lint/complexity/useLiteralKeys: see above
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined()
  })

  test("urlencoded form bodies validate through the body schema (HTML form parity)", async () => {
    const echo = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: (value: unknown) => ({ value }),
      },
    }
    const app = server().post("/f", { body: echo as never }, (c) => c.body)
    const res = await app.fetch(
      new Request("http://t/f", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body: "name=ada+l&tag=a&tag=b",
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: "ada l", tag: ["a", "b"] })
  })

  test("urlencoded body respects the byte cap (413, never buffered past it)", async () => {
    const echo = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: (value: unknown) => ({ value }),
      },
    }
    const app = server({ maxBodyBytes: 8 }).post("/f", { body: echo as never }, (c) => c.body)
    const res = await app.fetch(
      new Request("http://t/f", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "name=aaaaaaaaaaaaaaaaaaaa",
      }),
    )
    expect(res.status).toBe(413)
  })

  test("multipart stays 415 on the schema path (uploads own it)", async () => {
    const echo = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: (value: unknown) => ({ value }),
      },
    }
    const app = server().post("/f", { body: echo as never }, (c) => c.body)
    const res = await app.fetch(
      new Request("http://t/f", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=x" },
        body: "--x--",
      }),
    )
    expect(res.status).toBe(415)
  })
})

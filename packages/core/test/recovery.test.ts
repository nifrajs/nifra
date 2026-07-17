import { describe, expect, test } from "bun:test"
import type { StandardSchemaV1 } from "../src/index.ts"
import { server } from "../src/index.ts"

interface Person {
  name: string
  age: number
}
interface Search {
  q: string
}

function isPerson(v: unknown): v is Person {
  return (
    !!v &&
    typeof v === "object" &&
    "name" in v &&
    typeof v.name === "string" &&
    "age" in v &&
    typeof v.age === "number"
  )
}
function isSearch(v: unknown): v is Search {
  return !!v && typeof v === "object" && "q" in v && typeof v.q === "string"
}

/** A body schema whose validator is optionally async — exercises the `Promise` branches of recovery. */
function bodySchema(async: boolean): StandardSchemaV1<unknown, Person> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value: unknown) => {
        const result = isPerson(value)
          ? { value }
          : { issues: [{ message: "invalid person", path: ["age"] }] }
        return async ? Promise.resolve(result) : result
      },
    },
  }
}
function querySchema(async: boolean): StandardSchemaV1<unknown, Search> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value: unknown) => {
        const result = isSearch(value)
          ? { value }
          : { issues: [{ message: "q required", path: ["q"] }] }
        return async ? Promise.resolve(result) : result
      },
    },
  }
}

const badBody = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Ada", age: "NaN" }),
} as const

describe("onValidationError recovery", () => {
  test("body: onValidationError may return a Response directly", async () => {
    const app = server().post(
      "/users",
      { body: bodySchema(false), onValidationError: () => new Response("nope", { status: 418 }) },
      (c) => ({ age: c.body.age }),
    )
    const res = await app.fetch(new Request("http://localhost/users", badBody))
    expect(res.status).toBe(418)
    expect(await res.text()).toBe("nope")
  })

  test("body: an async healer + async schema recovers and runs the handler", async () => {
    const app = server().post(
      "/users",
      { body: bodySchema(true), onValidationError: async () => ({ name: "Ada", age: 36 }) },
      (c) => ({ name: c.body.name, age: c.body.age }),
    )
    const res = await app.fetch(new Request("http://localhost/users", badBody))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: "Ada", age: 36 })
  })

  test("body: a still-invalid healed payload keeps the 422", async () => {
    const app = server().post(
      "/users",
      {
        body: bodySchema(true),
        onValidationError: async () => ({ name: "Ada", age: "still-bad" }),
      },
      (c) => ({ age: c.body.age }),
    )
    const res = await app.fetch(new Request("http://localhost/users", badBody))
    expect(res.status).toBe(422)
  })

  test("body: returning undefined gives up — the original 422 stands", async () => {
    let called = false
    const app = server().post(
      "/users",
      {
        body: bodySchema(false),
        onValidationError: () => {
          called = true
          return undefined
        },
      },
      (c) => ({ age: c.body.age }),
    )
    const res = await app.fetch(new Request("http://localhost/users", badBody))
    expect(called).toBe(true)
    expect(res.status).toBe(422)
  })

  test("body: a sync healer + sync schema recovers and runs the handler", async () => {
    const app = server().post(
      "/users",
      { body: bodySchema(false), onValidationError: () => ({ name: "Ada", age: 36 }) },
      (c) => ({ name: c.body.name, age: c.body.age }),
    )
    const res = await app.fetch(new Request("http://localhost/users", badBody))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: "Ada", age: 36 })
  })

  test("body: adding a derive does not disable validation recovery", async () => {
    const app = server()
      .derive(() => ({ source: "derived" as const }))
      .post(
        "/users",
        { body: bodySchema(false), onValidationError: () => ({ name: "Ada", age: 36 }) },
        (c) => ({ age: c.body.age, source: c.source }),
      )
    const res = await app.fetch(new Request("http://localhost/users", badBody))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ age: 36, source: "derived" })

    const running = app.listen(0, { hostname: "127.0.0.1" })
    try {
      const native = await fetch(`http://127.0.0.1:${running.port}/users`, badBody)
      expect(native.status).toBe(200)
      expect(await native.json()).toEqual({ age: 36, source: "derived" })
    } finally {
      running.stop()
    }
  })

  test("body: a sync healer whose result still fails keeps the 422", async () => {
    const app = server().post(
      "/users",
      { body: bodySchema(false), onValidationError: () => ({ name: "Ada", age: "still-bad" }) },
      (c) => ({ age: c.body.age }),
    )
    const res = await app.fetch(new Request("http://localhost/users", badBody))
    expect(res.status).toBe(422)
  })

  test("query: a sync healer recovers an invalid query", async () => {
    const app = server().get(
      "/search",
      { query: querySchema(false), onValidationError: () => ({ q: "healed" }) },
      (c) => ({ q: c.query.q }),
    )
    const res = await app.fetch(new Request("http://localhost/search"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ q: "healed" })
  })

  test("query: an async healer + async schema recovers an invalid query", async () => {
    const app = server().get(
      "/search",
      { query: querySchema(true), onValidationError: async () => ({ q: "healed-async" }) },
      (c) => ({ q: c.query.q }),
    )
    const res = await app.fetch(new Request("http://localhost/search"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ q: "healed-async" })
  })

  test("query: a still-invalid healed query keeps the 422", async () => {
    const app = server().get(
      "/search",
      { query: querySchema(false), onValidationError: () => ({ notq: 1 }) },
      (c) => ({ q: c.query.q }),
    )
    const res = await app.fetch(new Request("http://localhost/search"))
    expect(res.status).toBe(422)
  })
})

describe("app-level default onValidationError", () => {
  const appDefault = () => new Response("app-default", { status: 400 })

  test("fires for a route without its own hook", async () => {
    const app = server({ onValidationError: appDefault }).post(
      "/users",
      { body: bodySchema(false) },
      (c) => ({ age: c.body.age }),
    )
    const res = await app.fetch(new Request("http://localhost/users", badBody))
    expect(res.status).toBe(400)
    expect(await res.text()).toBe("app-default")
  })

  test("a route's own hook takes precedence over the app default", async () => {
    const app = server({ onValidationError: appDefault }).post(
      "/users",
      { body: bodySchema(false), onValidationError: () => new Response("route", { status: 418 }) },
      (c) => ({ age: c.body.age }),
    )
    const res = await app.fetch(new Request("http://localhost/users", badBody))
    expect(res.status).toBe(418)
    expect(await res.text()).toBe("route")
  })

  test("a route can fall through to the plain 422 by returning undefined despite an app default", async () => {
    const app = server({ onValidationError: appDefault }).post(
      "/users",
      { body: bodySchema(false), onValidationError: () => undefined },
      (c) => ({ age: c.body.age }),
    )
    const res = await app.fetch(new Request("http://localhost/users", badBody))
    expect(res.status).toBe(422)
  })

  test("the app default may heal, and the healed value is re-validated", async () => {
    const app = server({ onValidationError: () => ({ name: "Ada", age: 36 }) }).post(
      "/users",
      { body: bodySchema(false) },
      (c) => ({ name: c.body.name, age: c.body.age }),
    )
    const res = await app.fetch(new Request("http://localhost/users", badBody))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: "Ada", age: 36 })
  })

  test("the hook receives which input failed via `kind`", async () => {
    const kinds: Array<"body" | "query" | "params"> = []
    const app = server({
      onValidationError: (_issues, _ctx, kind) => {
        kinds.push(kind)
        return undefined
      },
    })
      .post("/users", { body: bodySchema(false) }, (c) => ({ age: c.body.age }))
      .get("/search", { query: querySchema(false) }, (c) => ({ q: c.query.q }))
    await app.fetch(new Request("http://localhost/users", badBody))
    await app.fetch(new Request("http://localhost/search"))
    expect(kinds).toEqual(["body", "query"])
  })
})

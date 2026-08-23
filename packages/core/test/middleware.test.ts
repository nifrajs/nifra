import { describe, expect, test } from "bun:test"
import type { StandardSchemaV1 } from "@nifrajs/core"
import { server, silentLogger } from "@nifrajs/core"

const limitQuery: StandardSchemaV1<unknown, { limit: string }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) =>
      typeof value === "object" &&
      value !== null &&
      "limit" in value &&
      typeof value.limit === "string"
        ? { value: { limit: value.limit } }
        : { issues: [{ message: "limit is required" }] },
  },
}

const orderBody: StandardSchemaV1<unknown, { name: string }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) =>
      typeof value === "object" &&
      value !== null &&
      "name" in value &&
      typeof value.name === "string"
        ? { value: { name: value.name } }
        : { issues: [{ message: "name is required" }] },
  },
}

describe("lifecycle hooks", () => {
  test("general lifecycle routes preserve GET and POST behavior across validation and middleware", async () => {
    const app = server({ logger: silentLogger })
      .derive((c) => {
        const authorization = c.header("authorization")
        if (authorization !== "Bearer test") {
          throw new Response("unauthorized", { status: 401 })
        }
        return { user: "ada" }
      })
      .beforeHandle((c) => {
        c.set.headers["x-before"] = "ran"
      })
      .afterHandle((result) => ({ result, wrapped: true }))
      .get("/orders", { query: limitQuery }, (c) => ({ user: c.user, limit: c.query.limit }))
      .post("/orders", { body: orderBody }, (c) => ({ user: c.user, name: c.body.name }))

    const headers = { authorization: "Bearer test" }
    const get = await app.fetch(new Request("http://x/orders?limit=10", { headers }))
    expect(get.status).toBe(200)
    expect(get.headers.get("x-before")).toBe("ran")
    expect(await get.json()).toEqual({
      result: { user: "ada", limit: "10" },
      wrapped: true,
    })

    const post = await app.fetch(
      new Request("http://x/orders", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      }),
    )
    expect(post.status).toBe(200)
    expect(post.headers.get("x-before")).toBe("ran")
    expect(await post.json()).toEqual({
      result: { user: "ada", name: "Ada" },
      wrapped: true,
    })

    expect((await app.fetch(new Request("http://x/orders", { headers }))).status).toBe(422)
    expect((await app.fetch(new Request("http://x/orders?limit=10"))).status).toBe(401)
  })

  test("general lifecycle keeps async hooks and finalization errors on the normal error path", async () => {
    const app = server({ logger: silentLogger })
      .derive(async () => {
        await Promise.resolve()
        return { user: "ada" }
      })
      .beforeHandle(async (c) => {
        await Promise.resolve()
        if (c.user !== "ada") return new Response("forbidden", { status: 403 })
        return undefined
      })
      .get("/async", async (c) => {
        await Promise.resolve()
        return { user: c.user }
      })

    const ok = await app.fetch(new Request("http://x/async"))
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ user: "ada" })

    const bad = server({ logger: silentLogger })
      .beforeHandle(() => undefined)
      .get("/bad", () => 1n)
    const error = await bad.fetch(new Request("http://x/bad"))
    expect(error.status).toBe(500)
    expect(await error.json()).toEqual({ ok: false, error: "internal_error" })
  })

  test("onRequest short-circuits before routing", async () => {
    const app = server()
      .onRequest((req) =>
        req.headers.get("x-block") ? new Response("blocked", { status: 403 }) : undefined,
      )
      .get("/x", () => ({ ok: true }))

    const blocked = await app.fetch(new Request("http://x/x", { headers: { "x-block": "1" } }))
    expect(blocked.status).toBe(403)
    expect(await blocked.text()).toBe("blocked")

    expect(await (await app.fetch(new Request("http://x/x"))).json()).toEqual({ ok: true })
  })

  test("beforeHandle short-circuits, skipping the handler", async () => {
    let handlerRan = false
    const app = server()
      .beforeHandle((c) =>
        c.req.headers.get("authorization") ? undefined : new Response("nope", { status: 401 }),
      )
      .get("/x", () => {
        handlerRan = true
        return { ok: true }
      })

    const res = await app.fetch(new Request("http://x/x"))
    expect(res.status).toBe(401)
    expect(handlerRan).toBe(false)

    await app.fetch(new Request("http://x/x", { headers: { authorization: "Bearer t" } }))
    expect(handlerRan).toBe(true)
  })

  test("beforeHandle sees derived context (typed)", async () => {
    const app = server()
      .derive(() => ({ role: "admin" }))
      .beforeHandle((c) =>
        c.role === "admin" ? undefined : new Response("forbidden", { status: 403 }),
      )
      .get("/x", () => ({ ok: true }))

    expect((await app.fetch(new Request("http://x/x"))).status).toBe(200)
  })

  test("afterHandle transforms the result", async () => {
    const app = server()
      .afterHandle((result) => ({ wrapped: result }))
      .get("/x", () => ({ id: 1 }))

    expect(await (await app.fetch(new Request("http://x/x"))).json()).toEqual({
      wrapped: { id: 1 },
    })
  })

  test("specialized derive-before-after lifecycle preserves order and short-circuiting", async () => {
    const events: string[] = []
    const app = server()
      .derive(() => {
        events.push("derive")
        return { role: "admin" }
      })
      .beforeHandle((c) => {
        events.push(`before:${c.role}`)
        return c.req.headers.get("x-block") === "1"
          ? new Response("blocked", { status: 403 })
          : undefined
      })
      .afterHandle((result) => {
        events.push("after")
        return { wrapped: result }
      })
      .get("/specialized", () => {
        events.push("handler")
        return { ok: true }
      })

    const ok = await app.fetch(new Request("http://x/specialized"))
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ wrapped: { ok: true } })
    expect(events).toEqual(["derive", "before:admin", "handler", "after"])

    events.length = 0
    const blocked = await app.fetch(
      new Request("http://x/specialized", { headers: { "x-block": "1" } }),
    )
    expect(blocked.status).toBe(403)
    expect(await blocked.text()).toBe("blocked")
    expect(events).toEqual(["derive", "before:admin"])
  })

  test("specialized derive-before-after lifecycle preserves async continuation", async () => {
    const app = server()
      .derive(async () => ({ role: "admin" }))
      .beforeHandle(async (c) => (c.role === "admin" ? undefined : new Response("blocked")))
      .afterHandle(async (result) => ({ wrapped: result }))
      .get("/async-specialized", () => ({ ok: true }))

    const res = await app.fetch(new Request("http://x/async-specialized"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ wrapped: { ok: true } })
  })

  test("specialized derive-before-after lifecycle keeps rejection handling on the standard path", async () => {
    const handlerFailure = server({ logger: silentLogger })
      .derive(() => ({ role: "admin" }))
      .beforeHandle(() => undefined)
      .afterHandle((result) => result)
      .get("/handler-failure", async () => {
        throw new Error("handler failed")
      })
    const handlerResponse = await handlerFailure.fetch(new Request("http://x/handler-failure"))
    expect(handlerResponse.status).toBe(500)
    expect(await handlerResponse.json()).toEqual({ ok: false, error: "internal_error" })

    const afterFailure = server({ logger: silentLogger })
      .derive(() => ({ role: "admin" }))
      .beforeHandle(() => undefined)
      .afterHandle(async () => {
        throw new Error("after failed")
      })
      .get("/after-failure", () => ({ ok: true }))
    const afterResponse = await afterFailure.fetch(new Request("http://x/after-failure"))
    expect(afterResponse.status).toBe(500)
    expect(await afterResponse.json()).toEqual({ ok: false, error: "internal_error" })
  })

  test("onError returns a custom response", async () => {
    const app = server()
      .onError((err) => new Response(`caught: ${(err as Error).message}`, { status: 418 }))
      .get("/boom", () => {
        throw new Error("kaboom")
      })

    const res = await app.fetch(new Request("http://x/boom"))
    expect(res.status).toBe(418)
    expect(await res.text()).toBe("caught: kaboom")
  })

  test("onError returning undefined falls through to the default 500", async () => {
    const app = server({ logger: silentLogger })
      .onError(() => undefined)
      .get("/boom", () => {
        throw new Error("x")
      })

    const res = await app.fetch(new Request("http://x/boom"))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: "internal_error" })
  })

  test("hooks run in registration order around the handler", async () => {
    const order: string[] = []
    const app = server()
      .beforeHandle(() => {
        order.push("before1")
      })
      .beforeHandle(() => {
        order.push("before2")
      })
      .afterHandle((r) => {
        order.push("after1")
        return r
      })
      .afterHandle((r) => {
        order.push("after2")
        return r
      })
      .get("/x", () => {
        order.push("handler")
        return { ok: true }
      })

    await app.fetch(new Request("http://x/x"))
    expect(order).toEqual(["before1", "before2", "handler", "after1", "after2"])
  })

  test("a hook registered after a route does not apply to it (order-scoped)", async () => {
    let ran = false
    const app = server()
      .get("/early", () => ({ ok: true }))
      .beforeHandle(() => {
        ran = true
      })

    await app.fetch(new Request("http://x/early"))
    expect(ran).toBe(false)
  })
})

describe("around (wrapping hook)", () => {
  // A pass-through Standard Schema - exercises the body-schema (bodyOnly) route under an around wrap.
  const passThrough: StandardSchemaV1 = {
    "~standard": { version: 1, vendor: "test", validate: (value) => ({ value }) },
  }

  test("around hooks nest like an onion: first registered is outermost, handler in the middle", async () => {
    const order: string[] = []
    const app = server()
      .around(async (_c, next) => {
        order.push("a:in")
        const r = await next()
        order.push("a:out")
        return r
      })
      .around(async (_c, next) => {
        order.push("b:in")
        const r = await next()
        order.push("b:out")
        return r
      })
      .get("/x", () => {
        order.push("handler")
        return { ok: true }
      })

    const res = await app.fetch(new Request("http://x/x"))
    expect(await res.json()).toEqual({ ok: true })
    expect(order).toEqual(["a:in", "b:in", "handler", "b:out", "a:out"])
  })

  test("around wraps a body-schema route and the handler still sees the parsed body", async () => {
    let wrapped = false
    const app = server()
      .around((_c, next) => {
        wrapped = true
        return next()
      })
      .post("/echo", { body: passThrough }, (c) => ({ got: c.body }))

    const res = await app.fetch(
      new Request("http://x/echo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hi: 1 }),
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ got: { hi: 1 } })
    expect(wrapped).toBe(true)
  })

  test("calling next() more than once is rejected (guards against double-dispatch)", async () => {
    const app = server({ logger: silentLogger })
      .onError((err) => new Response((err as Error).message, { status: 599 }))
      .around((_c, next) => {
        void next() // first dispatch
        return next() // second call must throw synchronously
      })
      .get("/x", () => ({ ok: true }))

    const res = await app.fetch(new Request("http://x/x"))
    expect(res.status).toBe(599)
    expect(await res.text()).toMatch(/multiple times/)
  })

  test("an error thrown inside an around hook is caught (flat 500, no crash)", async () => {
    const app = server({ logger: silentLogger })
      .around(() => {
        throw new Error("around boom")
      })
      .get("/x", () => ({ ok: true }))

    const res = await app.fetch(new Request("http://x/x"))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: "internal_error" })
  })
})

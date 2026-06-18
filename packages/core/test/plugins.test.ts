import { describe, expect, test } from "bun:test"
import { definePlugin, type Middleware, server } from "@nifrajs/core"

const GET = (path: string) => new Request(`http://x${path}`)

describe("plugin convention — use(fn)", () => {
  test("inline plugin threads decorate + derive context to later handlers", async () => {
    // If the context types didn't thread, `c.greeting` / `c.n` below wouldn't typecheck.
    const app = server()
      .use((a) => a.decorate("greeting", "hi").derive(() => ({ n: 7 })))
      .get("/", (c) => ({ g: c.greeting, n: c.n }))

    expect(await (await app.fetch(GET("/"))).json()).toEqual({ g: "hi", n: 7 })
  })

  test("definePlugin applies; derived context is available at runtime + typed", async () => {
    const auth = definePlugin("auth", (a) => a.derive(() => ({ user: { id: "u1" } })))
    const app = server()
      .use(auth)
      .get("/me", (c) => ({ id: c.user.id }))

    expect(await (await app.fetch(GET("/me"))).json()).toEqual({ id: "u1" })
  })

  test("a plugin can register routes", async () => {
    const health = definePlugin("health", (a) => a.get("/health", () => ({ ok: true })))
    const app = server().use(health)
    expect(await (await app.fetch(GET("/health"))).json()).toEqual({ ok: true })
  })
})

describe("plugin dedupe (idempotent)", () => {
  test("a named plugin applied twice runs once", async () => {
    let applied = 0
    const p = definePlugin("once", (a) => {
      applied++
      return a.derive(() => ({ tag: applied }))
    })
    const app = server()
      .use(p)
      .use(p)
      .get("/", (c) => ({ tag: c.tag }))

    expect(applied).toBe(1) // second use() skipped
    expect(await (await app.fetch(GET("/"))).json()).toEqual({ tag: 1 })
  })

  test("a named Middleware bundle applied twice wires its hooks once", async () => {
    let calls = 0
    const stamp: Middleware = {
      name: "stamp",
      onResponse: (res) => {
        calls++
        return res
      },
    }
    const app = server()
      .use(stamp)
      .use(stamp)
      .get("/", () => ({ ok: true }))

    await app.fetch(GET("/"))
    expect(calls).toBe(1) // hook registered once, not twice
  })

  test("anonymous (un-named) plugins are not deduped", async () => {
    let applied = 0
    const mk = () => (a: ReturnType<typeof server>) => {
      applied++
      return a
    }
    server().use(mk()).use(mk())
    expect(applied).toBe(2)
  })
})

describe("Middleware bundle (object form) still works", () => {
  test("an un-named bundle's hooks fire", async () => {
    const header: Middleware = {
      onResponse: (res) => {
        res.headers.set("x-mw", "1")
        return res
      },
    }
    const app = server()
      .use(header)
      .get("/", () => ({ ok: true }))
    const res = await app.fetch(GET("/"))
    expect(res.headers.get("x-mw")).toBe("1")
  })
})

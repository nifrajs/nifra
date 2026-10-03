import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { bearer, MemoryStore, rateLimit } from "../src/index.ts"

const anyUser = bearer({
  verify: (token) => (token === "user" || token === "admin" ? token : null),
})
const adminOnly = () => bearer({ verify: (token) => (token === "admin" ? token : null) })
const as = (token: string) => ({ headers: { authorization: `Bearer ${token}` } })

describe("a second, stricter guard applies", () => {
  test("before later routes and inside a group", async () => {
    const app = server()
      .use(anyUser)
      .get("/me", () => "me")
      .group("/team", (g) => g.use(adminOnly()).get("/", () => "team"))
      .use(adminOnly())
      .get("/admin", () => "admin")
    expect((await app.fetch(new Request("http://h/me", as("user")))).status).toBe(200)
    expect((await app.fetch(new Request("http://h/admin", as("user")))).status).toBe(401)
    expect((await app.fetch(new Request("http://h/team", as("user")))).status).toBe(401)
    expect((await app.fetch(new Request("http://h/admin", as("admin")))).status).toBe(200)
    expect((await app.fetch(new Request("http://h/team", as("admin")))).status).toBe(200)
  })

  test("a tighter rate limit after a loose one", async () => {
    const app = server()
      .use(rateLimit({ store: new MemoryStore(), max: 100, windowMs: 60_000, key: () => "k" }))
      .use(rateLimit({ store: new MemoryStore(), max: 1, windowMs: 60_000, key: () => "k" }))
      .get("/", () => "ok")
    expect((await app.fetch(new Request("http://h/"))).status).toBe(200)
    expect((await app.fetch(new Request("http://h/"))).status).toBe(429)
  })

  test("the same guard instance applied twice still counts once", async () => {
    const limit = rateLimit({ store: new MemoryStore(), max: 2, windowMs: 60_000, key: () => "k" })
    const app = server()
      .use(limit)
      .use(limit)
      .get("/", () => "ok")
    expect((await app.fetch(new Request("http://h/"))).status).toBe(200)
    expect((await app.fetch(new Request("http://h/"))).status).toBe(200)
    expect((await app.fetch(new Request("http://h/"))).status).toBe(429)
  })
})

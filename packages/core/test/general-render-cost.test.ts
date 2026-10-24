import { describe, expect, test } from "bun:test"
import { Router } from "../src/router/router.ts"
import { server } from "../src/server.ts"

describe("general-path rendering parity", () => {
  for (const method of ["GET", "POST", "PUT"] as const) {
    test(`${method}: afterHandle still runs and JSON headers/body match bare rendering`, async () => {
      let calls = 0
      const app = server().afterHandle((result) => {
        calls++
        return { result, after: true }
      })
      const verb = method === "GET" ? "get" : method === "POST" ? "post" : "put"
      app[verb]("/users/:id", (c) => ({ id: c.params.id }))
      const response = await app.fetch(new Request("http://localhost/users/42", { method }))
      const bare = await server()
        .get("/", () => ({}))
        .fetch(new Request("http://localhost/"))
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe(bare.headers.get("content-type"))
      expect(await response.json()).toEqual({ result: { id: "42" }, after: true })
      expect(calls).toBe(1)
    })
  }
  test("status, headers, cookies, and response hooks retain the controlled renderer", async () => {
    let observed = 0
    const app = server()
      .afterHandle((result) => result)
      .onResponse((response) => {
        observed++
        response.headers.set("x-observed", "yes")
        return response
      })
      .post("/", (c) => {
        c.set.status = 201
        c.set.headers["x-owned"] = "yes"
        c.set.cookie("session", "a")
        c.set.cookie("theme", "b")
        return { ok: true }
      })
    const response = await app.fetch(new Request("http://localhost/", { method: "POST" }))
    expect(response.status).toBe(201)
    expect(response.headers.get("x-owned")).toBe("yes")
    expect(response.headers.get("x-observed")).toBe("yes")
    expect(response.headers.getSetCookie()).toHaveLength(2)
    expect(await response.json()).toEqual({ ok: true })
    expect(observed).toBe(1)
  })
})

test("dynamic cache hits isolate params, routers, and read/write methods", () => {
  const a = new Router<string>()
  const b = new Router<string>()
  a.add("GET", "/users/:id", "read")
  a.add("PUT", "/users/:id", "write")
  b.add("GET", "/users/:id", "other")
  // First call nominates the path, second caches it, third actually hits.
  a.find("GET", "/users/42")
  a.find("GET", "/users/42")
  const hit = a.find("GET", "/users/42")
  if (!hit.found) throw new Error("expected a cache hit")
  hit.params.id = "mutated"
  expect(a.find("PUT", "/users/42")).toEqual({
    found: true,
    payload: "write",
    params: { id: "42" },
  })
  expect(b.find("GET", "/users/42")).toEqual({
    found: true,
    payload: "other",
    params: { id: "42" },
  })
  a.add("GET", "/users/42", "static")
  expect(a.find("GET", "/users/42")).toEqual({ found: true, payload: "static", params: {} })
})

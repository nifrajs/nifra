import { describe, expect, test } from "bun:test"
import { server, silentLogger } from "../src/index.ts"

function request(method: string, path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, { method, ...init })
}

describe("Server.fetch — responses", () => {
  test("serializes a returned value to JSON with 200", async () => {
    const app = server().get("/health", () => ({ ok: true }))
    const res = await app.fetch(request("GET", "/health"))
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    expect(await res.json()).toEqual({ ok: true })
  })

  test("types and returns a path param", async () => {
    // c.params.id only type-checks because the path literal is parsed — this
    // test doubles as a compile-time check of the inference.
    const app = server().get("/users/:id", (c) => ({ id: c.params.id }))
    expect(await (await app.fetch(request("GET", "/users/42"))).json()).toEqual({ id: "42" })
  })

  test("passes a handler-built Response through untouched", async () => {
    const app = server().get("/raw", () => new Response("hi", { status: 201 }))
    const res = await app.fetch(request("GET", "/raw"))
    expect(res.status).toBe(201)
    expect(await res.text()).toBe("hi")
  })

  test("a THROWN Response is returned as-is (deliberate control flow, not a 500)", async () => {
    // Enables the guard pattern: `throw redirect(...)` / `requireSession(...)` from any handler/loader.
    const app = server({ logger: silentLogger }).get("/guard", () => {
      throw new Response(null, { status: 302, headers: { location: "/login" } })
    })
    const res = await app.fetch(request("GET", "/guard"))
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("/login")
  })

  test("honors c.set.status and c.set.headers", async () => {
    const app = server().post("/c", (c) => {
      c.set.status = 201
      c.set.headers["X-Test"] = "yes"
      return { created: true }
    })
    const res = await app.fetch(request("POST", "/c"))
    expect(res.status).toBe(201)
    expect(res.headers.get("X-Test")).toBe("yes")
  })

  test("returns 204 with no body when a handler returns undefined", async () => {
    const app = server().get("/empty", () => undefined)
    const res = await app.fetch(request("GET", "/empty"))
    expect(res.status).toBe(204)
    expect(await res.text()).toBe("")
  })

  test("awaits async handlers", async () => {
    const app = server().get("/a", async () => {
      await Promise.resolve()
      return { async: true }
    })
    expect(await (await app.fetch(request("GET", "/a"))).json()).toEqual({ async: true })
  })
})

describe("Server.fetch — errors (404/405/400/500)", () => {
  test("404 not_found for an unknown path", async () => {
    const app = server().get("/x", () => "ok")
    const res = await app.fetch(request("GET", "/nope"))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, error: "not_found" })
  })

  test("405 method_not_allowed with an Allow header", async () => {
    const app = server()
      .get("/r", () => "g")
      .post("/r", () => "p")
    const res = await app.fetch(request("DELETE", "/r"))
    expect(res.status).toBe(405)
    expect(res.headers.get("Allow")).toBe("GET, POST")
    expect(await res.json()).toEqual({ ok: false, error: "method_not_allowed" })
  })

  test("400 malformed_path for an undecodable param", async () => {
    const app = server().get("/q/:term", (c) => ({ term: c.params.term }))
    // %C3%28 is a syntactically valid escape but invalid UTF-8 -> decode throws.
    const res = await app.fetch(request("GET", "/q/%C3%28"))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, error: "malformed_path" })
  })

  test("decodes percent-encoded param values", async () => {
    const app = server().get("/q/:term", (c) => ({ term: c.params.term }))
    expect(await (await app.fetch(request("GET", "/q/a%20b"))).json()).toEqual({ term: "a b" })
  })

  test("500 internal_error when a handler throws (no leak)", async () => {
    const app = server({ logger: silentLogger }).get("/boom", () => {
      throw new Error("boom: secret detail")
    })
    const res = await app.fetch(request("GET", "/boom"))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: "internal_error" })
  })
})

describe("Server — verbs and listen", () => {
  test("supports all standard verbs", async () => {
    const app = server()
      .get("/r", () => "GET")
      .post("/r", () => "POST")
      .put("/r", () => "PUT")
      .patch("/r", () => "PATCH")
      .delete("/r", () => "DELETE")
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      expect(await (await app.fetch(request(method, "/r"))).json()).toBe(method)
    }
  })

  test("listen serves real HTTP on an ephemeral port", async () => {
    const app = server().get("/ping", () => ({ pong: true }))
    const instance = app.listen(0)
    try {
      const res = await fetch(`http://localhost:${instance.port}/ping`)
      expect(await res.json()).toEqual({ pong: true })
    } finally {
      instance.stop()
    }
  })

  test("Bun-native listen routes preserve params, lazy query, response hooks, and wildcard fallback", async () => {
    const app = server()
      .onResponse((response) => {
        response.headers.set("x-pipeline", "yes")
        return response
      })
      .get("/users/:id", (c) => ({ id: c.params.id, q: c.query.get("q") }))
      .get("/files/*path", (c) => ({ path: c.params.path }))
    const instance = app.listen(0)
    try {
      const encoded = await fetch(`http://127.0.0.1:${instance.port}/users/a%20b?q=hello`)
      expect(await encoded.json()).toEqual({ id: "a b", q: "hello" })
      expect(encoded.headers.get("x-pipeline")).toBe("yes")

      const malformed = await fetch(`http://127.0.0.1:${instance.port}/users/%C3%28`)
      expect(malformed.status).toBe(400)
      expect(await malformed.json()).toEqual({ ok: false, error: "malformed_path" })

      const wildcard = await fetch(`http://127.0.0.1:${instance.port}/files/a/b`)
      expect(await wildcard.json()).toEqual({ path: "a/b" })
    } finally {
      instance.stop()
    }
  })

  test("listen keeps onRequest URL rewrites ahead of route selection", async () => {
    const app = server()
      .onRequest(
        (request) =>
          new Request(new URL("/target", request.url).href, {
            method: request.method,
            headers: request.headers,
          }),
      )
      .get("/target", () => "rewritten")
    const instance = app.listen(0)
    try {
      const response = await fetch(`http://127.0.0.1:${instance.port}/source`)
      expect(await response.json()).toBe("rewritten")
    } finally {
      instance.stop()
    }
  })

  test("the fused Bun-native lane still enforces inherited deadlines and method errors", async () => {
    const app = server({ acceptInboundDeadlines: true }).get("/fast/:id", (c) => ({
      id: c.params.id,
    }))
    const instance = app.listen(0)
    const url = `http://127.0.0.1:${instance.port}/fast/42`
    try {
      expect(await (await fetch(url)).json()).toEqual({ id: "42" })

      const malformed = await fetch(url, { headers: { "x-nifra-deadline": "bad" } })
      expect(malformed.status).toBe(400)
      expect(await malformed.json()).toEqual({ ok: false, error: "malformed_deadline" })

      const expired = await fetch(url, { headers: { "x-nifra-deadline": "1" } })
      expect(expired.status).toBe(408)
      expect(await expired.json()).toEqual({ ok: false, error: "deadline_exceeded" })

      const wrongMethod = await fetch(url, { method: "POST" })
      expect(wrongMethod.status).toBe(405)
      expect(wrongMethod.headers.get("allow")).toBe("GET")
    } finally {
      instance.stop()
    }
  })
})

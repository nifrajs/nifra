import { describe, expect, test } from "bun:test"
import { server, silentLogger } from "../src/index.ts"
import type { StandardResult, StandardSchemaV1, StandardTypes } from "../src/schema/standard.ts"

/**
 * `app.resolveNode` is the node-direct seam: it runs the *exact same* lifecycle as `app.fetch`
 * (body cap, validation, all hooks) but renders a plain-data result as serialization primitives
 * (`{ kind: "json" }`) instead of building + draining an undici `Response`. The `@nifrajs/node` adapter
 * writes those primitives straight to the socket. Everything that isn't the common JSON-data case —
 * a handler-returned `Response`, 404/405, validation/malformed error, thrown Response, 500, timeout,
 * or any `onResponse` hook — falls back to a `{ kind: "response" }` the adapter writes the Web way.
 *
 * These tests pin (a) the discriminated outcome for each path and (b) byte-for-byte parity with
 * `app.fetch` — the fast path must be observably identical on the wire, only cheaper.
 */

function schema<Output>(
  validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>,
): StandardSchemaV1<unknown, Output> {
  return {
    "~standard": {
      version: 1,
      vendor: "nifra-test",
      validate,
      types: undefined as unknown as StandardTypes<unknown, Output>,
    },
  }
}

const nameBody = schema<{ name: string }>((value) =>
  typeof value === "object" && value !== null && "name" in value && typeof value.name === "string"
    ? { value: { name: value.name } }
    : { issues: [{ message: "name must be a string", path: ["name"] }] },
)

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init)
}

describe("resolveNode — JSON-data fast path", () => {
  test("plain object → kind:json, status 200, pre-stringified body, no headers/cookies", async () => {
    const app = server().get("/u/:id", (c) => ({ id: c.params.id }))
    const outcome = await app.resolveNode(req("/u/42"))
    expect(outcome.kind).toBe("json")
    if (outcome.kind !== "json") throw new Error("unreachable")
    expect(outcome.status).toBe(200)
    expect(outcome.body).toBe(JSON.stringify({ id: "42" }))
    expect(outcome.headers).toBeUndefined()
    expect(outcome.cookies).toBeUndefined()
  })

  test("body is byte-identical to what app.fetch serializes", async () => {
    const app = server().get("/data", () => ({ a: 1, b: [true, null, "x"], n: 3.14 }))
    const outcome = await app.resolveNode(req("/data"))
    const viaFetch = await app.fetch(req("/data"))
    expect(outcome.kind).toBe("json")
    if (outcome.kind !== "json") throw new Error("unreachable")
    expect(outcome.body).toBe(await viaFetch.text())
    expect(outcome.status).toBe(viaFetch.status)
  })

  test("undefined result → 204 with null body (matches app.fetch)", async () => {
    const app = server().get("/empty", (c) => {
      c.set.status = 204
      return undefined
    })
    const outcome = await app.resolveNode(req("/empty"))
    const viaFetch = await app.fetch(req("/empty"))
    expect(outcome.kind).toBe("json")
    if (outcome.kind !== "json") throw new Error("unreachable")
    expect(outcome.status).toBe(204)
    expect(outcome.body).toBeNull()
    expect(viaFetch.status).toBe(204)
    expect(await viaFetch.text()).toBe("")
  })

  test("a bare undefined (no explicit status) defaults to 204/null", async () => {
    const app = server().get("/void", () => undefined)
    const outcome = await app.resolveNode(req("/void"))
    expect(outcome.kind).toBe("json")
    if (outcome.kind !== "json") throw new Error("unreachable")
    expect(outcome.status).toBe(204)
    expect(outcome.body).toBeNull()
  })

  test("c.set.status + c.set.headers flow through to the json outcome", async () => {
    const app = server().post("/make", (c) => {
      c.set.status = 201
      c.set.headers["x-made"] = "yes"
      return { ok: true }
    })
    const outcome = await app.resolveNode(req("/make", { method: "POST" }))
    expect(outcome.kind).toBe("json")
    if (outcome.kind !== "json") throw new Error("unreachable")
    expect(outcome.status).toBe(201)
    expect(outcome.headers).toEqual({ "x-made": "yes" })
    expect(outcome.body).toBe(JSON.stringify({ ok: true }))
  })

  test("queued Set-Cookie lines ride on the json outcome (one entry per cookie)", async () => {
    const app = server().get("/login", (c) => {
      c.set.cookie("sid", "a")
      c.set.cookie("csrf", "b")
      return { ok: true }
    })
    const outcome = await app.resolveNode(req("/login"))
    expect(outcome.kind).toBe("json")
    if (outcome.kind !== "json") throw new Error("unreachable")
    expect(outcome.cookies).toHaveLength(2)
    expect(outcome.cookies?.[0]?.startsWith("sid=a")).toBe(true)
    expect(outcome.cookies?.[1]?.startsWith("csrf=b")).toBe(true)
  })

  test("validated body still reaches the handler on the node path", async () => {
    const app = server().post("/users", { body: nameBody }, (c) => ({ created: c.body.name }))
    const outcome = await app.resolveNode(
      req("/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      }),
    )
    expect(outcome.kind).toBe("json")
    if (outcome.kind !== "json") throw new Error("unreachable")
    expect(outcome.body).toBe(JSON.stringify({ created: "Ada" }))
  })
})

describe("resolveNode — fallback to a Response", () => {
  test("a lazy response result becomes a node-direct body without constructing a Response", async () => {
    const responseResult = Symbol.for("nifra.response.result")
    let builtResponse = false
    const html = "<!doctype html><h1>lazy</h1>"
    const app = server().get("/lazy", (c) => {
      c.set.cookie("sid", "tok")
      return {
        [responseResult]: true,
        toResponse() {
          builtResponse = true
          return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
        },
        toNodeBody() {
          return {
            status: 202,
            headers: { "content-type": "text/html; charset=utf-8" },
            body: html,
          }
        },
      }
    })
    const outcome = await app.resolveNode(req("/lazy"))
    expect(builtResponse).toBe(false)
    expect(outcome.kind).toBe("body")
    if (outcome.kind !== "body") throw new Error("unreachable")
    expect(outcome.status).toBe(202)
    expect(outcome.body).toBe(html)
    const cookies = outcome.headers?.["set-cookie"]
    if (!Array.isArray(cookies)) throw new Error("expected set-cookie array")
    expect(cookies.some((c) => c.startsWith("sid=tok"))).toBe(true)
  })

  test("a marked buffered Response becomes a node-direct body outcome", async () => {
    const nodeBody = Symbol.for("nifra.response.body")
    const html = "<!doctype html><h1>fast</h1>"
    const app = server().get("/html", (c) => {
      c.set.cookie("sid", "tok")
      const response = new Response(html, {
        status: 201,
        headers: { "content-type": "text/html; charset=utf-8", "x-page": "home" },
      })
      Object.defineProperty(response, nodeBody, { value: html })
      return response
    })
    const outcome = await app.resolveNode(req("/html"))
    const viaFetch = await app.fetch(req("/html"))
    expect(outcome.kind).toBe("body")
    if (outcome.kind !== "body") throw new Error("unreachable")
    expect(outcome.status).toBe(201)
    expect(outcome.body).toBe(await viaFetch.text())
    expect(outcome.headers?.["content-type"]).toBe("text/html; charset=utf-8")
    expect(outcome.headers?.["x-page"]).toBe("home")
    const cookies = outcome.headers?.["set-cookie"]
    expect(Array.isArray(cookies)).toBe(true)
    if (!Array.isArray(cookies)) throw new Error("expected set-cookie array")
    expect(cookies.some((c) => c.startsWith("sid=tok"))).toBe(true)
  })

  test("a handler-returned Response is wrapped, status preserved", async () => {
    const app = server().get("/r", () => new Response("raw", { status: 202 }))
    const outcome = await app.resolveNode(req("/r"))
    expect(outcome.kind).toBe("response")
    if (outcome.kind !== "response") throw new Error("unreachable")
    expect(outcome.response.status).toBe(202)
    expect(await outcome.response.text()).toBe("raw")
  })

  test("queued cookies are appended to a handler-returned Response (set-then-redirect)", async () => {
    const app = server().get("/login-redirect", (c) => {
      c.set.cookie("sid", "tok")
      return new Response(null, { status: 302, headers: { location: "/home" } })
    })
    const outcome = await app.resolveNode(req("/login-redirect"))
    expect(outcome.kind).toBe("response")
    if (outcome.kind !== "response") throw new Error("unreachable")
    expect(outcome.response.status).toBe(302)
    expect(outcome.response.headers.get("location")).toBe("/home")
    const cookies = outcome.response.headers.getSetCookie()
    expect(cookies.some((c) => c.startsWith("sid=tok"))).toBe(true)
  })

  test("404 → response", async () => {
    const app = server().get("/here", () => ({}))
    const outcome = await app.resolveNode(req("/missing"))
    expect(outcome.kind).toBe("response")
    if (outcome.kind !== "response") throw new Error("unreachable")
    expect(outcome.response.status).toBe(404)
  })

  test("405 → response with Allow header", async () => {
    const app = server().get("/only-get", () => ({}))
    const outcome = await app.resolveNode(req("/only-get", { method: "POST" }))
    expect(outcome.kind).toBe("response")
    if (outcome.kind !== "response") throw new Error("unreachable")
    expect(outcome.response.status).toBe(405)
    expect(outcome.response.headers.get("allow")).toContain("GET")
  })

  test("malformed percent-encoded path → 400 response", async () => {
    const app = server().get("/x/:id", (c) => ({ id: c.params.id }))
    const outcome = await app.resolveNode(req("/x/%ZZ"))
    expect(outcome.kind).toBe("response")
    if (outcome.kind !== "response") throw new Error("unreachable")
    expect(outcome.response.status).toBe(400)
  })

  test("a validation failure → response (never a json fast-path)", async () => {
    const app = server().post("/users", { body: nameBody }, (c) => ({ created: c.body.name }))
    const outcome = await app.resolveNode(
      req("/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: 123 }),
      }),
    )
    expect(outcome.kind).toBe("response")
    if (outcome.kind !== "response") throw new Error("unreachable")
    expect(outcome.response.status).toBe(422)
  })

  test("a thrown Response (redirect) is returned as control flow", async () => {
    const app = server().get("/guard", () => {
      throw new Response(null, { status: 303, headers: { location: "/login" } })
    })
    const outcome = await app.resolveNode(req("/guard"))
    expect(outcome.kind).toBe("response")
    if (outcome.kind !== "response") throw new Error("unreachable")
    expect(outcome.response.status).toBe(303)
    expect(outcome.response.headers.get("location")).toBe("/login")
  })

  test("a thrown Error → flat 500 response (no leak), via the same path as app.fetch", async () => {
    const app = server({ logger: silentLogger }).get("/boom", () => {
      throw new Error("kaboom")
    })
    const outcome = await app.resolveNode(req("/boom"))
    expect(outcome.kind).toBe("response")
    if (outcome.kind !== "response") throw new Error("unreachable")
    expect(outcome.response.status).toBe(500)
    expect(await outcome.response.json()).toEqual({ ok: false, error: "internal_error" })
  })

  test("onError hook result is rendered through the node path", async () => {
    const app = server({ logger: silentLogger })
      .onError(() => new Response("handled", { status: 418 }))
      .get("/boom", () => {
        throw new Error("x")
      })
    const outcome = await app.resolveNode(req("/boom"))
    expect(outcome.kind).toBe("response")
    if (outcome.kind !== "response") throw new Error("unreachable")
    expect(outcome.response.status).toBe(418)
  })

  test("request timeout → 503 response", async () => {
    const app = server({ requestTimeoutMs: 20 }).get("/slow", async () => {
      await Bun.sleep(200)
      return { done: true }
    })
    const outcome = await app.resolveNode(req("/slow"))
    expect(outcome.kind).toBe("response")
    if (outcome.kind !== "response") throw new Error("unreachable")
    expect(outcome.response.status).toBe(503)
    expect(await outcome.response.json()).toEqual({ ok: false, error: "request_timeout" })
  })

  test("an onResponse hook forces the Web path even for plain JSON data", async () => {
    let ran = false
    const app = server()
      .onResponse((res) => {
        ran = true
        const headers = new Headers(res.headers)
        headers.set("x-app", "seen")
        return new Response(res.body, { status: res.status, headers })
      })
      .get("/data", () => ({ ok: true }))
    const outcome = await app.resolveNode(req("/data"))
    expect(ran).toBe(true)
    expect(outcome.kind).toBe("response")
    if (outcome.kind !== "response") throw new Error("unreachable")
    expect(outcome.response.headers.get("x-app")).toBe("seen")
    expect(await outcome.response.json()).toEqual({ ok: true })
  })
})

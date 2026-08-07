import { describe, expect, test } from "bun:test"
import { cacheControl } from "@nifrajs/middleware"
import { server, silentLogger } from "../src/index.ts"
import { nodeDirect } from "../src/node-direct.ts"
import type { StandardResult, StandardSchemaV1, StandardTypes } from "../src/schema/standard.ts"
import { nodeOutcomeToResponse } from "../src/server/node-outcome.ts"

/**
 * `app.resolveNode` is the node-direct seam: it runs the *exact same* lifecycle as `app.fetch`
 * (body cap, validation, all hooks) but renders a plain-data result as serialization primitives
 * (`{ kind: "json" }`) instead of building + draining an undici `Response`. The `@nifrajs/node` adapter
 * writes those primitives straight to the socket. Everything that isn't the common JSON-data case -
 * a handler-returned `Response`, 404/405, validation/malformed error, thrown Response, 500, timeout,
 * or a response hook that replaces/consumes the body - falls back to a `{ kind: "response" }` the
 * adapter writes the Web way. In-place header hooks retain the direct buffered writer.
 *
 * These tests pin (a) the discriminated outcome for each path and (b) byte-for-byte parity with
 * `app.fetch` - the fast path must be observably identical on the wire, only cheaper.
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

describe("resolveNode - JSON-data fast path", () => {
  test("plain object → kind:json, status 200, pre-stringified body, no headers/cookies", async () => {
    const app = server()
      .use(nodeDirect())
      .get("/u/:id", (c) => ({ id: c.params.id }))
    const outcome = await app.resolveNode(req("/u/42"))
    expect(outcome.kind).toBe("json")
    if (outcome.kind !== "json") throw new Error("unreachable")
    expect(outcome.status).toBe(200)
    expect(outcome.body).toBe(JSON.stringify({ id: "42" }))
    expect(outcome.headers).toBeUndefined()
    expect(outcome.cookies).toBeUndefined()
  })

  test("body is byte-identical to what app.fetch serializes", async () => {
    const app = server()
      .use(nodeDirect())
      .get("/data", () => ({ a: 1, b: [true, null, "x"], n: 3.14 }))
    const outcome = await app.resolveNode(req("/data"))
    const viaFetch = await app.fetch(req("/data"))
    expect(outcome.kind).toBe("json")
    if (outcome.kind !== "json") throw new Error("unreachable")
    expect(outcome.body).toBe(await viaFetch.text())
    expect(outcome.status).toBe(viaFetch.status)
  })

  test("undefined result → 204 with null body (matches app.fetch)", async () => {
    const app = server()
      .use(nodeDirect())
      .get("/empty", (c) => {
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
    const app = server()
      .use(nodeDirect())
      .get("/void", () => undefined)
    const outcome = await app.resolveNode(req("/void"))
    expect(outcome.kind).toBe("json")
    if (outcome.kind !== "json") throw new Error("unreachable")
    expect(outcome.status).toBe(204)
    expect(outcome.body).toBeNull()
  })

  test("c.set.status + c.set.headers flow through to the json outcome", async () => {
    const app = server()
      .use(nodeDirect())
      .post("/make", (c) => {
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
    const app = server()
      .use(nodeDirect())
      .get("/login", (c) => {
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
    const app = server()
      .use(nodeDirect())
      .post("/users", { body: nameBody }, (c) => ({ created: c.body.name }))
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

  test("a Web onRequest hook that continues keeps the Node-direct response renderer", async () => {
    let seen: Request | undefined
    const app = server()
      .use(nodeDirect())
      .onRequest((request) => {
        seen = request
        expect(request.headers.get("authorization")).toBe("Bearer test")
        return undefined
      })
      .get("/data", () => ({ ok: true }))

    const request = req("/data", { headers: { authorization: "Bearer test" } })
    const outcome = await app.resolveNode(request)
    expect(seen).toBe(request)
    expect(outcome.kind).toBe("json")
    if (outcome.kind !== "json") throw new Error("unreachable")
    expect(outcome.body).toBe(JSON.stringify({ ok: true }))
  })

  test("a Web onRequest rewrite still reaches the Node-direct renderer", async () => {
    const app = server()
      .use(nodeDirect())
      .onRequest((request) => new Request(request, { method: "PATCH" }))
      .patch("/data", (context) => ({ method: context.req.method }))

    const outcome = await app.resolveNode(req("/data", { method: "POST" }))
    expect(outcome.kind).toBe("json")
    if (outcome.kind !== "json") throw new Error("unreachable")
    expect(outcome.body).toBe(JSON.stringify({ method: "PATCH" }))
  })

  test("a rewritten request remains visible to an in-place response hook", async () => {
    const app = server()
      .use(nodeDirect())
      .onRequest((request) => new Request(request, { method: "PUT" }))
      .onResponse((response, request) => {
        response.headers.set("x-seen-method", request.method)
        return response
      })
      .put("/data", () => ({ ok: true }))

    const outcome = await app.resolveNode(req("/data", { method: "POST" }))
    expect(outcome.kind).toBe("body")
    if (outcome.kind !== "body") throw new Error("unreachable")
    expect(outcome.headers?.["x-seen-method"]).toBe("PUT")
    expect(outcome.body).toBe(JSON.stringify({ ok: true }))
  })

  test("a Web onRequest rewrite routes response middleware through the Web path, headers intact", async () => {
    // The native lanes engage TOGETHER: a web-only onRequest hook (here a method rewrite, which a
    // native request twin is forbidden to do) turns the response side over to the Web hook walk as
    // well. That coupling is what guarantees a response twin always receives the exact object its
    // request twin saw (the WeakMap identity contract stateful twins key on). The middleware still
    // applies - via its Web hook - and the rewritten method is what it observes.
    const app = server()
      .use(nodeDirect())
      .onRequest((request) => new Request(request, { method: "PUT" }))
      .use(cacheControl("private", { methods: ["PUT"] }))
      .put("/data", () => ({ ok: true }))

    const outcome = await app.resolveNode(req("/data", { method: "POST" }))
    if (outcome.kind === "response") throw new Error("expected a buffered outcome")
    expect(outcome.headers?.["cache-control"]).toBe("private")
  })
})

describe("resolveNode - fallback to a Response", () => {
  test("a lazy response result becomes a node-direct body without constructing a Response", async () => {
    const responseResult = Symbol.for("nifra.response.result")
    let builtResponse = false
    const html = "<!doctype html><h1>lazy</h1>"
    const app = server()
      .use(nodeDirect())
      .get("/lazy", (c) => {
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
    const app = server()
      .use(nodeDirect())
      .get("/html", (c) => {
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
    const app = server()
      .use(nodeDirect())
      .get("/r", () => new Response("raw", { status: 202 }))
    const outcome = await app.resolveNode(req("/r"))
    expect(outcome.kind).toBe("response")
    if (outcome.kind !== "response") throw new Error("unreachable")
    expect(outcome.response.status).toBe(202)
    expect(await outcome.response.text()).toBe("raw")
  })

  test("queued cookies are appended to a handler-returned Response (set-then-redirect)", async () => {
    const app = server()
      .use(nodeDirect())
      .get("/login-redirect", (c) => {
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
    const app = server()
      .use(nodeDirect())
      .get("/here", () => ({}))
    const outcome = await app.resolveNode(req("/missing"))
    expect(outcome.kind).toBe("response")
    if (outcome.kind !== "response") throw new Error("unreachable")
    expect(outcome.response.status).toBe(404)
  })

  test("405 → response with Allow header", async () => {
    const app = server()
      .use(nodeDirect())
      .get("/only-get", () => ({}))
    const outcome = await app.resolveNode(req("/only-get", { method: "POST" }))
    expect(outcome.kind).toBe("response")
    if (outcome.kind !== "response") throw new Error("unreachable")
    expect(outcome.response.status).toBe(405)
    expect(outcome.response.headers.get("allow")).toContain("GET")
  })

  test("malformed percent-encoded path → 400 response", async () => {
    const app = server()
      .use(nodeDirect())
      .get("/x/:id", (c) => ({ id: c.params.id }))
    const outcome = await app.resolveNode(req("/x/%ZZ"))
    expect(outcome.kind).toBe("response")
    if (outcome.kind !== "response") throw new Error("unreachable")
    expect(outcome.response.status).toBe(400)
  })

  test("a validation failure → response (never a json fast-path)", async () => {
    const app = server()
      .use(nodeDirect())
      .post("/users", { body: nameBody }, (c) => ({ created: c.body.name }))
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
    const app = server()
      .use(nodeDirect())
      .get("/guard", () => {
        throw new Response(null, { status: 303, headers: { location: "/login" } })
      })
    const outcome = await app.resolveNode(req("/guard"))
    expect(outcome.kind).toBe("response")
    if (outcome.kind !== "response") throw new Error("unreachable")
    expect(outcome.response.status).toBe(303)
    expect(outcome.response.headers.get("location")).toBe("/login")
  })

  test("a thrown Error → flat 500 response (no leak), via the same path as app.fetch", async () => {
    const app = server({ logger: silentLogger })
      .use(nodeDirect())
      .get("/boom", () => {
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
      .use(nodeDirect())
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
    const app = server({ requestTimeoutMs: 20 })
      .use(nodeDirect())
      .get("/slow", async () => {
        await Bun.sleep(200)
        return { done: true }
      })
    const outcome = await app.resolveNode(req("/slow"))
    expect(outcome.kind).toBe("response")
    if (outcome.kind !== "response") throw new Error("unreachable")
    expect(outcome.response.status).toBe(503)
    expect(await outcome.response.json()).toEqual({ ok: false, error: "request_timeout" })
  })

  test("a response-replacing onResponse hook stays on the Web path", async () => {
    let ran = false
    const app = server()
      .use(nodeDirect())
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

  test("an in-place Web onResponse hook keeps a buffered body on the Node path", async () => {
    const app = server()
      .use(nodeDirect())
      .onResponse((response) => {
        response.headers.set("x-app", "seen")
        return response
      })
      .get("/data", () => ({ ok: true }))

    const outcome = await app.resolveNode(req("/data"))
    expect(outcome.kind).toBe("body")
    if (outcome.kind !== "body") throw new Error("unreachable")
    expect(outcome.headers?.["x-app"]).toBe("seen")
    expect(outcome.body).toBe(JSON.stringify({ ok: true }))
  })
})

describe("resolveNodeSource - lazy sources stay lazy", () => {
  test("a plain POST never materializes the source's Headers object", async () => {
    // `header()` is authoritative when a source implements it: its `null` means the header is
    // ABSENT, not "consult `headers` instead". The distinction is load-bearing - the Node adapter's
    // lazy sources build a full undici `Headers` only when `.headers` is read, and the body lane
    // probes `transfer-encoding` (absent on framed requests) on every POST.
    let materialized = false
    const body = JSON.stringify({ name: "Ada" })
    const source = {
      method: "POST",
      url: "http://localhost/users",
      get headers(): Headers {
        materialized = true
        return new Headers({ "content-type": "application/json" })
      },
      header(name: string): string | null {
        if (name === "content-type") return "application/json"
        if (name === "content-length") return String(body.length)
        return null
      },
      body: null,
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(body).buffer as ArrayBuffer),
      json: () => Promise.resolve(JSON.parse(body) as unknown),
    }
    const app = server()
      .use(nodeDirect())
      .post("/users", { body: nameBody }, (c) => ({ hi: c.body.name }))
    const outcome = await app.resolveNodeSource(source)
    expect(outcome.kind).toBe("json")
    if (outcome.kind !== "json") throw new Error("unreachable")
    expect(outcome.body).toBe(JSON.stringify({ hi: "Ada" }))
    expect(materialized).toBe(false)
  })
})

describe("resolveNode - stateful native middleware twins", () => {
  test("rateLimit twins carry quota from the request twin to the response twin natively", async () => {
    const { MemoryStore, rateLimit } = await import("@nifrajs/middleware")
    const app = server({ logger: silentLogger })
      .use(nodeDirect())
      .use(rateLimit({ store: new MemoryStore(), max: 2, windowMs: 60_000, header: "x-real-ip" }))
      .get("/data", () => ({ ok: true }))

    const first = await app.resolveNode(req("/data", { headers: { "x-real-ip": "10.0.0.9" } }))
    // kind "json" proves the native lanes engaged end to end - the Web hook path would come back
    // as a marked "body"/"response" outcome instead.
    expect(first.kind).toBe("json")
    if (first.kind !== "json") throw new Error("unreachable")
    expect(first.headers?.["ratelimit-limit"]).toBe("2")
    expect(first.headers?.["ratelimit-remaining"]).toBe("1")
    expect(Number(first.headers?.["ratelimit-reset"])).toBeGreaterThanOrEqual(0)

    // Third hit in the window: the request twin short-circuits with the 429.
    await app.resolveNode(req("/data", { headers: { "x-real-ip": "10.0.0.9" } }))
    const limited = await app.resolveNode(req("/data", { headers: { "x-real-ip": "10.0.0.9" } }))
    expect(limited.kind).toBe("response")
    if (limited.kind !== "response") throw new Error("unreachable")
    expect(limited.response.status).toBe(429)
    expect(limited.response.headers.get("retry-after")).not.toBeNull()
  })

  test("logger twins log method/path/status with a real duration natively", async () => {
    const { logger } = await import("@nifrajs/middleware")
    const lines: Array<{ method: string; path: string; status: number; ms: number }> = []
    const app = server({ logger: silentLogger })
      .use(nodeDirect())
      .use(logger({ log: (fields) => lines.push(fields) }))
      .get("/things/:id", (c) => ({ id: c.params.id }))

    const outcome = await app.resolveNode(req("/things/42?x=1"))
    expect(outcome.kind).toBe("json")
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ method: "GET", path: "/things/42", status: 200 })
    expect(lines[0]?.ms).toBeGreaterThanOrEqual(0)
  })

  test("language twin negotiates content-language natively and derive still types c.language", async () => {
    const { language } = await import("@nifrajs/middleware")
    const app = server({ logger: silentLogger })
      .use(nodeDirect())
      .use(language({ supported: ["en", "hi"], defaultLanguage: "en" }))
      .get("/greet", (c) => ({ lang: c.language }))

    const outcome = await app.resolveNode(
      req("/greet", { headers: { "accept-language": "hi-IN, hi;q=0.9" } }),
    )
    expect(outcome.kind).toBe("json")
    if (outcome.kind !== "json") throw new Error("unreachable")
    expect(outcome.headers?.["content-language"]).toBe("hi")
    expect(outcome.body).toBe(JSON.stringify({ lang: "hi" }))
  })
})

describe("resolveNode - portable onResponseHeaders", () => {
  test("native response hook failures are promise rejections", async () => {
    const app = server({ logger: silentLogger })
      .use(nodeDirect())
      .onResponseHeaders(() => {
        throw new TypeError("native hook failure")
      })
      .get("/data", () => ({ ok: true }))

    let outcome: ReturnType<typeof app.resolveNode> | undefined
    expect(() => {
      outcome = app.resolveNode(req("/data"))
    }).not.toThrow()
    await expect(outcome!).rejects.toThrow("native hook failure")
  })

  test("one hook implementation runs on the native Node lane AND the Web walk", async () => {
    const app = server({ logger: silentLogger })
      .use(nodeDirect())
      .onResponseHeaders((headers, req, status) => {
        headers.set("x-portable", `${req.method}:${status}`)
        if (!headers.has("x-existing")) headers.append("x-multi", "a")
      })
      .get("/data", (c) => {
        c.set.headers["X-Mixed-Case"] = "kept"
        return { ok: true }
      })

    // Native lane: a portable hook self-pairs, so the outcome stays a direct "json" render.
    const outcome = await app.resolveNode(req("/data"))
    expect(outcome.kind).toBe("json")
    if (outcome.kind !== "json") throw new Error("unreachable")
    expect(outcome.headers?.["x-portable"]).toBe("GET:200")
    expect(outcome.headers?.["x-multi"]).toBe("a")
    expect(outcome.headers?.["X-Mixed-Case"]).toBe("kept")

    // Web walk: the same registration mutates the response's own Headers.
    const viaFetch = await app.fetch(req("/data"))
    expect(viaFetch.headers.get("x-portable")).toBe("GET:200")
    expect(viaFetch.headers.get("x-multi")).toBe("a")
    expect(viaFetch.headers.get("x-mixed-case")).toBe("kept")
  })

  test("view ops resolve the record's initial mixed-case names through the prepared index", async () => {
    const app = server({ logger: silentLogger })
      .use(nodeDirect())
      .onResponseHeaders((headers) => {
        // Reads are case-insensitive over whatever casing the handler stored ...
        expect(headers.get("x-frame-options")).toBe("DENY")
        // ... a replacement collapses the differently-cased entry to one lowercase key ...
        headers.set("x-frame-options", "SAMEORIGIN")
        // ... and a delete removes the stored key regardless of its casing.
        headers.delete("x-gone")
      })
      .get("/data", (c) => {
        c.set.headers["X-Frame-Options"] = "DENY"
        c.set.headers["X-Gone"] = "bye"
        return { ok: true }
      })

    const outcome = await app.resolveNode(req("/data"))
    expect(outcome.kind).toBe("json")
    if (outcome.kind !== "json") throw new Error("unreachable")
    expect(outcome.headers?.["x-frame-options"]).toBe("SAMEORIGIN")
    expect(outcome.headers?.["X-Frame-Options"]).toBeUndefined()
    expect(outcome.headers?.["X-Gone"]).toBeUndefined()
    expect(outcome.headers?.["x-gone"]).toBeUndefined()

    const viaFetch = await app.fetch(req("/data"))
    expect(viaFetch.headers.get("x-frame-options")).toBe("SAMEORIGIN")
    expect(viaFetch.headers.get("x-gone")).toBeNull()
  })
})

describe("resolveNode - portable onResponseBody", () => {
  test("one body hook runs on the native lane AND the Web walk, from final bytes on both", async () => {
    const seen: string[] = []
    const app = server({ logger: silentLogger })
      .use(nodeDirect())
      .onResponseBody((body, headers, req, status) => {
        const text = typeof body === "string" ? body : new TextDecoder().decode(body)
        seen.push(`${req.method}:${status}`)
        headers.set("x-body-len", String(text.length))
        return text.replace("plain", "transformed")
      })
      .get("/data", () => ({ mode: "plain" }))

    // Native lane: the hook self-pairs, so the outcome stays a direct render with replaced bytes.
    const outcome = await app.resolveNode(req("/data"))
    if (outcome.kind === "response") throw new Error("expected a buffered outcome")
    expect(outcome.body).toBe(JSON.stringify({ mode: "transformed" }))
    expect(outcome.headers?.["x-body-len"]).toBe(String(JSON.stringify({ mode: "plain" }).length))

    // Web walk: the framework-built Response carries its bytes as a tag - no stream drain.
    const viaFetch = await app.fetch(req("/data"))
    expect(await viaFetch.json()).toEqual({ mode: "transformed" })
    expect(viaFetch.headers.get("x-body-len")).toBe(
      String(JSON.stringify({ mode: "plain" }).length),
    )
    expect(seen).toEqual(["GET:200", "GET:200"])
  })

  test("a handler-returned raw Response is skipped by contract (streams never drained)", async () => {
    let called = 0
    const app = server({ logger: silentLogger })
      .use(nodeDirect())
      .onResponseBody((body) => {
        called++
        return body
      })
      .get("/raw", () => new Response("raw-bytes", { headers: { "content-type": "text/plain" } }))

    const viaFetch = await app.fetch(req("/raw"))
    expect(await viaFetch.text()).toBe("raw-bytes")
    expect(called).toBe(0)
  })

  test("bodyless status replacements drop the serialized body on Web and Node lanes", async () => {
    for (const status of [204, 205, 304]) {
      const app = server({ logger: silentLogger })
        .use(nodeDirect())
        .onResponseBody(() => ({ status }))
        .get("/data", () => ({ still: "not sent" }))

      const outcome = await app.resolveNode(req("/data"))
      if (outcome.kind === "response") throw new Error("expected a direct outcome")
      expect(outcome.status).toBe(status)
      expect(outcome.body).toBeNull()

      const response = await app.fetch(req("/data"))
      expect(response.status).toBe(status)
      expect(await response.text()).toBe("")
    }
  })

  test("native header views treat prototype names as ordinary Web header names", async () => {
    const app = server({ logger: silentLogger })
      .use(nodeDirect())
      .onResponseHeaders((headers) => {
        headers.append("toString", "one")
        headers.append("toString", "two")
        headers.set("constructor", "ctor")
        headers.set("__proto__", "proto")
      })
      .get("/data", () => ({ ok: true }))

    const outcome = await app.resolveNode(req("/data"))
    expect(outcome.kind).toBe("json")
    if (outcome.kind !== "json") throw new Error("expected native JSON outcome")
    const headers = outcome.headers as Readonly<Record<string, unknown>>
    expect(Object.getOwnPropertyDescriptor(headers, "tostring")?.value).toEqual(["one", "two"])
    expect(Object.getOwnPropertyDescriptor(headers, "constructor")?.value).toBe("ctor")
    expect(Object.getOwnPropertyDescriptor(headers, "__proto__")?.value).toBe("proto")
  })

  test("response controls keep prototype-named headers as data", async () => {
    const app = server({ logger: silentLogger })
      .use(nodeDirect())
      .get("/data", (c) => {
        Object.defineProperty(c.set.headers, "__proto__", {
          value: "proto",
          enumerable: true,
          writable: true,
          configurable: true,
        })
        Object.defineProperty(c.set.headers, "constructor", {
          value: "ctor",
          enumerable: true,
          writable: true,
          configurable: true,
        })
        return { ok: true }
      })

    const outcome = await app.resolveNode(req("/data"))
    expect(outcome.kind).toBe("json")
    if (outcome.kind !== "json") throw new Error("expected native JSON outcome")
    expect(Object.getOwnPropertyDescriptor(outcome.headers, "__proto__")?.value).toBe("proto")
    expect(Object.getOwnPropertyDescriptor(outcome.headers, "constructor")?.value).toBe("ctor")
  })
})

describe("resolveNode - migrated body-tier middleware stay native", () => {
  test("etag hashes the direct render and serves a native 304 on If-None-Match", async () => {
    const { etag } = await import("@nifrajs/middleware")
    const app = server({ logger: silentLogger })
      .use(nodeDirect())
      .use(etag())
      .get("/doc", () => ({ v: 1 }))

    const first = await app.resolveNode(req("/doc"))
    if (first.kind === "response") throw new Error("expected a buffered outcome")
    const tag = first.headers?.etag as string
    expect(tag?.startsWith('W/"')).toBe(true)
    expect(first.body).toBe(JSON.stringify({ v: 1 }))

    const revalidated = await app.resolveNode(req("/doc", { headers: { "if-none-match": tag } }))
    if (revalidated.kind === "response") throw new Error("expected a buffered outcome")
    expect(revalidated.status).toBe(304)
    expect(revalidated.body).toBeNull()
    expect(revalidated.headers?.["content-type"]).toBeUndefined()
  })

  test("compression gzips the direct render natively with known length semantics", async () => {
    const { compression } = await import("@nifrajs/middleware")
    const big = "y".repeat(3000)
    const app = server({ logger: silentLogger })
      .use(nodeDirect())
      .use(compression())
      .get("/big", () => ({ data: big }))

    const outcome = await app.resolveNode(
      req("/big", { headers: { "accept-encoding": "gzip, br" } }),
    )
    if (outcome.kind === "response") throw new Error("expected a buffered outcome")
    expect(outcome.headers?.["content-encoding"]).toBe("gzip")
    expect(outcome.body).toBeInstanceOf(Uint8Array)
    const text = await new Response(
      new Response(outcome.body as Uint8Array).body?.pipeThrough(new DecompressionStream("gzip")),
    ).text()
    expect(JSON.parse(text)).toEqual({ data: big })
  })
})

// The bridge from a buffered node outcome to a real Response, used when a Web-only response hook
// has to see one. The header record it starts from allows repeated values, which a Headers built by
// assignment would silently collapse into a single comma-joined line - fatal for Set-Cookie.
describe("nodeOutcomeToResponse", () => {
  test("expands repeated header values into separate lines and appends cookies", () => {
    const res = nodeOutcomeToResponse({
      kind: "json",
      status: 200,
      headers: { "x-multi": ["a", "b"], "x-one": "solo" },
      cookies: ["sid=abc", "csrf=xyz"],
      body: '{"ok":true}',
    })

    expect(res.headers.get("x-one")).toBe("solo")
    expect(res.headers.getSetCookie()).toEqual(["sid=abc", "csrf=xyz"])
    // A repeated non-cookie header is joined for reading but was appended, not overwritten.
    expect(res.headers.get("x-multi")).toBe("a, b")
  })

  test("defaults the JSON content-type only when the outcome did not set one", async () => {
    const defaulted = nodeOutcomeToResponse({
      kind: "json",
      status: 200,
      headers: undefined,
      cookies: undefined,
      body: '{"ok":true}',
    })
    expect(defaulted.headers.get("content-type")).toBe("application/json;charset=utf-8")
    expect(await defaulted.text()).toBe('{"ok":true}')

    const explicit = nodeOutcomeToResponse({
      kind: "json",
      status: 200,
      headers: { "content-type": "application/vnd.api+json" },
      cookies: undefined,
      body: '{"ok":true}',
    })
    expect(explicit.headers.get("content-type")).toBe("application/vnd.api+json")
  })

  test("a bodyless status drops the body and its content-length", async () => {
    const res = nodeOutcomeToResponse({
      kind: "json",
      status: 204,
      headers: { "content-length": "11" },
      cookies: undefined,
      body: '{"ok":true}',
    })
    expect(res.status).toBe(204)
    expect(res.headers.get("content-length")).toBeNull()
    expect(await res.text()).toBe("")
  })

  test("a response outcome is handed back untouched", () => {
    const original = new Response("hi", { status: 201 })
    expect(nodeOutcomeToResponse({ kind: "response", response: original })).toBe(original)
  })
})

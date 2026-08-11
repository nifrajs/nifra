import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { nodeDirect } from "@nifrajs/core/node-direct"
import { requestId } from "@nifrajs/middleware"

describe("requestId", () => {
  test("generates an id, exposes c.requestId, echoes the header", async () => {
    const app = server()
      .use(requestId())
      .get("/", (c) => ({ id: c.requestId })) // c.requestId must be typed (threaded by derive)
    const res = await app.fetch(new Request("http://x/"))
    const body = (await res.json()) as { id: string }
    expect(body.id).toMatch(/[0-9a-f-]{36}/) // a uuid
    expect(res.headers.get("x-request-id")).toBe(body.id)
  })

  test("reuses an inbound x-request-id (trace propagation)", async () => {
    const app = server()
      .use(requestId())
      .get("/", (c) => ({ id: c.requestId }))
    const res = await app.fetch(
      new Request("http://x/", { headers: { "x-request-id": "trace-42" } }),
    )
    expect(((await res.json()) as { id: string }).id).toBe("trace-42")
    expect(res.headers.get("x-request-id")).toBe("trace-42")
  })

  test("honors a custom header + generator", async () => {
    let n = 0
    const app = server()
      .use(requestId({ header: "x-trace", generate: () => `id-${++n}` }))
      .get("/", (c) => ({ id: c.requestId }))
    const res = await app.fetch(new Request("http://x/"))
    expect(((await res.json()) as { id: string }).id).toBe("id-1")
    expect(res.headers.get("x-trace")).toBe("id-1")
  })

  test("applied twice is idempotent (one derive)", async () => {
    const plugin = requestId()
    const app = server()
      .use(plugin)
      .use(plugin)
      .get("/", (c) => ({ id: c.requestId }))
    const res = await app.fetch(new Request("http://x/", { headers: { "x-request-id": "z" } }))
    expect(((await res.json()) as { id: string }).id).toBe("z")
  })

  // Core deliberately does NOT merge `c.set.headers` onto a handler-returned raw Response, so the
  // echo must come from the app-global response hook. Each shape below produced a header-less
  // response before the hook-based echo.

  test("echoes on a handler-returned raw Response, same id as c.requestId", async () => {
    const app = server()
      .use(requestId())
      .get("/raw", (c) => new Response(JSON.stringify({ id: c.requestId }), { status: 200 }))
    const res = await app.fetch(new Request("http://x/raw"))
    const body = (await res.json()) as { id: string }
    expect(body.id).toMatch(/[0-9a-f-]{36}/)
    // The id in the body (c.requestId) and the id on the header are the SAME value.
    expect(res.headers.get("x-request-id")).toBe(body.id)
  })

  test("echoes on a redirect (immutable-headers Response)", async () => {
    const app = server()
      .use(requestId())
      .get("/go", () => Response.redirect("http://x/elsewhere", 302))
    const res = await app.fetch(new Request("http://x/go"))
    expect(res.status).toBe(302)
    expect(res.headers.get("x-request-id")).toMatch(/[0-9a-f-]{36}/)
  })

  test("echoes on an onRequest short-circuit (auth-gate 401)", async () => {
    const app = server()
      .use(requestId())
      .use({ onRequest: () => new Response("denied", { status: 401 }) })
      .get("/", () => ({ ok: true }))
    const res = await app.fetch(new Request("http://x/"))
    expect(res.status).toBe(401)
    expect(res.headers.get("x-request-id")).toMatch(/[0-9a-f-]{36}/)
  })

  test("echoes on the framework 404 for an unmatched path", async () => {
    const app = server()
      .use(requestId())
      .get("/", () => ({ ok: true }))
    const res = await app.fetch(new Request("http://x/nope"))
    expect(res.status).toBe(404)
    expect(res.headers.get("x-request-id")).toMatch(/[0-9a-f-]{36}/)
  })

  test("reuses an inbound id on raw, redirect, short-circuit, and 404 responses", async () => {
    const inbound = { headers: { "x-request-id": "trace-7" } }
    const raw = server()
      .use(requestId())
      .get("/raw", (c) => new Response(c.requestId, { status: 200 }))
    const rawRes = await raw.fetch(new Request("http://x/raw", inbound))
    expect(await rawRes.text()).toBe("trace-7")
    expect(rawRes.headers.get("x-request-id")).toBe("trace-7")

    const redirecting = server()
      .use(requestId())
      .get("/go", () => Response.redirect("http://x/elsewhere", 302))
    const redirectRes = await redirecting.fetch(new Request("http://x/go", inbound))
    expect(redirectRes.headers.get("x-request-id")).toBe("trace-7")

    const gated = server()
      .use(requestId())
      .use({ onRequest: () => new Response("denied", { status: 401 }) })
      .get("/", () => ({ ok: true }))
    const gatedRes = await gated.fetch(new Request("http://x/", inbound))
    expect(gatedRes.headers.get("x-request-id")).toBe("trace-7")

    const unmatched = server()
      .use(requestId())
      .get("/", () => ({ ok: true }))
    const notFoundRes = await unmatched.fetch(new Request("http://x/nope", inbound))
    expect(notFoundRes.status).toBe(404)
    expect(notFoundRes.headers.get("x-request-id")).toBe("trace-7")
  })

  test("honors a custom header option on a raw-Response return", async () => {
    let n = 0
    const app = server()
      .use(requestId({ header: "x-trace", generate: () => `id-${++n}` }))
      .get("/raw", (c) => new Response(c.requestId, { status: 200 }))
    const res = await app.fetch(new Request("http://x/raw"))
    expect(await res.text()).toBe("id-1")
    expect(res.headers.get("x-trace")).toBe("id-1")
  })

  test("stays on the Node-direct outcome lane, echoing the same id as c.requestId", async () => {
    const app = server()
      .use(nodeDirect())
      .use(requestId())
      .get("/", (c) => ({ id: c.requestId }))
    const outcome = await app.resolveNode(new Request("http://x/"))
    // The paired onNodeRequest/onNodeResponse twins must not force the app off the direct writer.
    expect(outcome.kind).toBe("json")
    if (outcome.kind !== "json") throw new Error("unreachable")
    const echoed = outcome.headers?.["x-request-id"]
    expect(echoed).toMatch(/[0-9a-f-]{36}/)
    expect(JSON.parse(outcome.body as string)).toEqual({ id: echoed })
  })

  test("Node-direct lane reuses an inbound id, including on the 404 path", async () => {
    const app = server()
      .use(nodeDirect())
      .use(requestId())
      .get("/", (c) => ({ id: c.requestId }))
    const inbound = { headers: { "x-request-id": "trace-9" } }
    const hit = await app.resolveNode(new Request("http://x/", inbound))
    if (hit.kind !== "json") throw new Error("unreachable")
    expect(hit.headers?.["x-request-id"]).toBe("trace-9")
    expect(JSON.parse(hit.body as string)).toEqual({ id: "trace-9" })

    // An unmatched path leaves the lane as a full Response outcome; the echo must still be there.
    const miss = await app.resolveNode(new Request("http://x/nope", inbound))
    if (miss.kind === "response") {
      expect(miss.response.status).toBe(404)
      expect(miss.response.headers.get("x-request-id")).toBe("trace-9")
    } else {
      if (miss.kind !== "json") throw new Error("unreachable")
      expect(miss.status).toBe(404)
      expect(miss.headers?.["x-request-id"]).toBe("trace-9")
    }
  })
})

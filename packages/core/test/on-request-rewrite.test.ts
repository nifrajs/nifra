import { describe, expect, test } from "bun:test"
import { server } from "../src/index.ts"

describe("onRequest request rewrite", () => {
  test("can replace the request before routing", async () => {
    const app = server()
      .onRequest((req) => new Request(req, { method: "PATCH" }))
      .patch("/items", () => ({ method: "patched" }))

    const res = await app.fetch(new Request("http://x/items", { method: "POST" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ method: "patched" })
  })

  test("preserves the rewritten request for handlers and onResponse hooks", async () => {
    const app = server()
      .onRequest((req) => new Request(req, { method: "PUT" }))
      .onResponse((res, req) => {
        const headers = new Headers(res.headers)
        headers.set("x-seen-method", req.method)
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
      })
      .put("/echo", async (c) => ({ method: c.req.method, body: await c.boundedJson(64) }))

    const res = await app.fetch(
      new Request("http://x/echo", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "11" },
        body: '{"ok":true}',
      }),
    )
    expect(res.headers.get("x-seen-method")).toBe("PUT")
    expect(await res.json()).toEqual({ method: "PUT", body: { ok: true } })
  })

  test("preserves the original Web Request identity when no hook rewrites it", async () => {
    let seenByRequestHook: Request | undefined
    let seenByResponseHook: Request | undefined
    const app = server()
      .onRequest((request) => {
        seenByRequestHook = request
        return undefined
      })
      .onResponse((response, request) => {
        seenByResponseHook = request
        return response
      })
      .get("/identity", () => ({ ok: true }))

    const request = new Request("http://x/identity")
    const response = await app.fetch(request)

    expect(response.status).toBe(200)
    expect(seenByRequestHook).toBe(request)
    expect(seenByResponseHook).toBe(request)
  })

  test("still short-circuits when an onRequest hook returns a response", async () => {
    const app = server()
      .onRequest(() => new Response("blocked", { status: 418 }))
      .get("/", () => "unreachable")

    const res = await app.fetch(new Request("http://x/"))
    expect(res.status).toBe(418)
    expect(await res.text()).toBe("blocked")
  })
})

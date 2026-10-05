import { describe, expect, test } from "bun:test"
import { replacedRequestOf, server } from "../src/index.ts"

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

  test("a response hook walks back from the rewritten request to the one each hook saw", async () => {
    const seen: Request[] = []
    let lineage: Request[] = []
    const app = server()
      .onRequest((req) => {
        seen.push(req)
        return undefined
      })
      .onRequest(async (req) => {
        seen.push(req)
        return new Request(req, { method: "PUT" })
      })
      .onRequest((req) => {
        seen.push(req)
        return new Request(req, { headers: { "x-step": "3" } })
      })
      .onResponse((res, req) => {
        lineage = [req]
        for (let r = replacedRequestOf(req); r !== undefined; r = replacedRequestOf(r)) {
          lineage.push(r)
        }
        return res
      })
      .put("/echo", () => ({ ok: true }))
    const original = new Request("http://x/echo", { method: "POST" })
    expect((await app.fetch(original)).status).toBe(200)
    expect(lineage).toHaveLength(3)
    expect(lineage[2]).toBe(original)
    expect(lineage[1]).toBe(seen[2])
    expect(lineage.at(-1)).toBe(seen[0])
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

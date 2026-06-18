import { describe, expect, test } from "bun:test"
import { type AppLike, runApp, runRequest } from "../src/index.ts"

/** A nifra-shaped app is anything with `.fetch`; these mimic real `server()` responses. */
const echoApp: AppLike = {
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/users/1" && req.method === "GET") {
      return Response.json({ id: "1", name: "Ada" })
    }
    if (url.pathname === "/users" && req.method === "POST") {
      const ct = req.headers.get("content-type")
      const body = req.body ? await req.json() : null
      return Response.json({ ct, received: body }, { status: 201 })
    }
    if (url.pathname === "/text")
      return new Response("plain text", { headers: { "content-type": "text/plain" } })
    if (url.pathname === "/boom") throw new Error("handler exploded")
    return new Response("Not found", { status: 404 })
  },
}

describe("runRequest", () => {
  test("GET → parsed JSON body, status, ok, timing", async () => {
    const r = await runRequest(echoApp, { path: "/users/1" })
    expect(r).toMatchObject({ method: "GET", path: "/users/1", ok: true, status: 200 })
    expect(r.body).toEqual({ id: "1", name: "Ada" })
    expect(r.headers?.["content-type"]).toContain("application/json")
    expect(typeof r.durationMs).toBe("number")
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
    expect(r.error).toBeUndefined()
  })

  test("POST encodes a plain object as JSON with a content-type", async () => {
    const r = await runRequest(echoApp, { method: "POST", path: "/users", body: { name: "Ada" } })
    expect(r.status).toBe(201)
    expect(r.body).toEqual({ ct: "application/json", received: { name: "Ada" } })
  })

  test("a caller-set content-type is not overridden", async () => {
    const r = await runRequest(echoApp, {
      method: "POST",
      path: "/users",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: { name: "Grace" },
    })
    expect((r.body as { ct: string }).ct).toBe("application/json; charset=utf-8")
  })

  test("a string body is sent as-is, with no auto JSON content-type", async () => {
    let gotType: string | null = "unset"
    let gotBody = ""
    const app: AppLike = {
      async fetch(req) {
        gotType = req.headers.get("content-type")
        gotBody = await req.text()
        return new Response("ok")
      },
    }
    await runRequest(app, { method: "POST", path: "/raw", body: "hello=world" })
    expect(gotBody).toBe("hello=world")
    expect(gotType).toBeNull() // not forced to application/json
  })

  test("non-2xx → ok false, status captured, no error", async () => {
    const r = await runRequest(echoApp, { path: "/missing" })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(404)
    expect(r.error).toBeUndefined()
  })

  test("a thrown handler is captured as error (not rethrown), with no status", async () => {
    const r = await runRequest(echoApp, { path: "/boom" })
    expect(r.ok).toBe(false)
    expect(r.status).toBeUndefined()
    expect(r.error).toMatchObject({ name: "Error", message: "handler exploded" })
  })

  test("a non-JSON response keeps body as text", async () => {
    const r = await runRequest(echoApp, { path: "/text" })
    expect(r.body).toBe("plain text")
    expect(r.bodyText).toBe("plain text")
  })

  test("relative paths resolve against the origin; absolute URLs pass through", async () => {
    const seen: string[] = []
    const app: AppLike = {
      fetch(req) {
        seen.push(req.url)
        return new Response("ok")
      },
    }
    await runRequest(app, { path: "/a" }, { origin: "http://example.test" })
    await runRequest(app, { path: "https://api.example.com/b" })
    expect(seen[0]).toBe("http://example.test/a")
    expect(seen[1]).toBe("https://api.example.com/b")
  })

  test("a body on GET is ignored (GET can't carry one) — no throw", async () => {
    const r = await runRequest(echoApp, { method: "GET", path: "/users/1", body: { x: 1 } })
    expect(r.status).toBe(200)
  })

  test("body text is truncated to maxBodyChars with a flag", async () => {
    const big: AppLike = { fetch: () => new Response("x".repeat(1000)) }
    const r = await runRequest(big, { path: "/" }, { maxBodyChars: 10 })
    expect(r.truncated).toBe(true)
    expect(r.bodyText?.length).toBe(10)
  })

  test("echoes the label", async () => {
    const r = await runRequest(echoApp, { path: "/users/1", label: "fetch user" })
    expect(r.label).toBe("fetch user")
  })

  test("a malformed spec is reported, not thrown", async () => {
    const r = await runRequest(echoApp, { path: "http://" }) // invalid absolute URL
    expect(r.ok).toBe(false)
    expect(r.error).toBeDefined()
  })
})

describe("runApp", () => {
  test("runs a batch in order, one result each, continuing past a crash", async () => {
    const results = await runApp(echoApp, [
      { path: "/users/1" },
      { path: "/boom" },
      { method: "POST", path: "/users", body: { name: "Lin" } },
    ])
    expect(results.length).toBe(3)
    expect(results[0]?.status).toBe(200)
    expect(results[1]?.error?.message).toBe("handler exploded") // crash didn't abort the batch
    expect(results[2]?.status).toBe(201)
  })

  test("an empty batch yields an empty array", async () => {
    expect(await runApp(echoApp, [])).toEqual([])
  })
})

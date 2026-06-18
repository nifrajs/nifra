import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { bodyLimit } from "../src/index.ts"

describe("bodyLimit()", () => {
  test("allows an in-limit body and leaves it readable for the handler", async () => {
    const app = server()
      .use(bodyLimit({ maxBytes: 32 }))
      .post("/echo", async (c) => ({ body: await c.boundedJson(32) }))

    const res = await app.fetch(
      new Request("http://x/echo", {
        method: "POST",
        headers: { "content-length": String(JSON.stringify({ ok: true }).length) },
        body: JSON.stringify({ ok: true }),
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ body: { ok: true } })
  })

  test("rejects lengthless bodies by default so chunked uploads cannot bypass the cap", async () => {
    const app = server()
      .use(bodyLimit({ maxBytes: 3 }))
      .post("/echo", async (c) => ({ body: new TextDecoder().decode(await c.boundedBody(16)) }))

    const res = await app.fetch(new Request("http://x/echo", { method: "POST", body: "abcdef" }))
    expect(res.status).toBe(411)
    expect(await res.json()).toEqual({ ok: false, error: "length_required" })
  })

  test("can explicitly allow lengthless bodies without consuming them", async () => {
    const app = server()
      .use(bodyLimit({ maxBytes: 3, allowLengthless: true }))
      .post("/echo", async (c) => ({ body: new TextDecoder().decode(await c.boundedBody(16)) }))

    const res = await app.fetch(new Request("http://x/echo", { method: "POST", body: "abc" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ body: "abc" })
  })

  test("rejects invalid and oversized Content-Length before routing", async () => {
    const app = server()
      .use(bodyLimit({ maxBytes: 4 }))
      .post("/echo", () => ({ ok: true }))

    const invalid = await app.fetch(
      new Request("http://x/echo", {
        method: "POST",
        headers: { "content-length": "nope" },
        body: "x",
      }),
    )
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ ok: false, error: "invalid_content_length" })

    const large = await app.fetch(
      new Request("http://x/echo", {
        method: "POST",
        headers: { "content-length": "99" },
        body: "x",
      }),
    )
    expect(large.status).toBe(413)
  })

  test("does not inspect safe methods by default", async () => {
    const app = server()
      .use(bodyLimit({ maxBytes: 0 }))
      .get("/", () => ({ ok: true }))
    expect((await app.fetch(new Request("http://x/"))).status).toBe(200)
  })

  test("honors custom methods and custom error names", async () => {
    const app = server()
      .use(bodyLimit({ maxBytes: 1, methods: ["POST"], error: "too_big" }))
      .put("/items", () => ({ ok: true }))
      .post("/items", () => ({ ok: true }))

    expect(
      (await app.fetch(new Request("http://x/items", { method: "PUT", body: "lengthless" })))
        .status,
    ).toBe(200)
    const post = await app.fetch(
      new Request("http://x/items", {
        method: "POST",
        headers: { "content-length": "999999999999999999999" },
        body: "x",
      }),
    )
    expect(post.status).toBe(413)
    expect(await post.json()).toEqual({ ok: false, error: "too_big" })
  })

  test("validates construction", () => {
    expect(() => bodyLimit({ maxBytes: -1 })).toThrow(/maxBytes/)
    expect(() => bodyLimit({ maxBytes: 1.5 })).toThrow(/maxBytes/)
  })
})

import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { e2eUrl, serveTestApp } from "../src/e2e.ts"
import { testSession } from "../src/session.ts"

const app = server()
  .post("/login", (c) => {
    c.set.cookie("sid", "abc", { secure: false })
    return { ok: true }
  })
  .get("/me", (c) => ({ user: c.cookies.sid ?? null }))
  .get("/", () => new Response("<h1>hi</h1>", { headers: { "content-type": "text/html" } }))

describe("serveTestApp", () => {
  test("serves pages over a real socket and stops cleanly", async () => {
    const www = await serveTestApp(app)
    expect(www.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const response = await fetch(new URL("/", www.baseUrl))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("<h1>hi</h1>")
    await www.stop()
    await expect(fetch(new URL("/", www.baseUrl))).rejects.toThrow()
  })

  test("a testSession jar crosses into the browser via the Cookie header", async () => {
    const { client, cookies } = testSession<typeof app>(app)
    const login = await client.login.post(undefined)
    expect(login.ok).toBe(true)
    expect(cookies.header()).toContain("sid=abc")

    const www = await serveTestApp(app)
    try {
      const me = await fetch(e2eUrl<typeof app>(www.baseUrl, "/me"), {
        headers: { Cookie: cookies.header() },
      })
      expect(await me.json()).toEqual({ user: "abc" })
    } finally {
      await www.stop()
    }
  })
})

describe("e2eUrl", () => {
  test("joins base and declared path; unknown paths fail typecheck", () => {
    expect(e2eUrl<typeof app>("http://127.0.0.1:1", "/me")).toBe("http://127.0.0.1:1/me")
    expect(e2eUrl<typeof app>("http://127.0.0.1:1/", "/me")).toBe("http://127.0.0.1:1/me")
    // @ts-expect-error - "/nope" is not a declared route
    e2eUrl<typeof app>("http://127.0.0.1:1", "/nope")
  })

  test("rejects runtime paths that escape the test app origin", () => {
    expect(() => e2eUrl<typeof app>("http://127.0.0.1:1", "//evil.example" as never)).toThrow(
      /same-origin/,
    )
    expect(() => e2eUrl<typeof app>("http://127.0.0.1:1", "/\\evil.example" as never)).toThrow(
      /same-origin/,
    )
  })
})

import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { testSession } from "../src/index.ts"

const json = (data: unknown, setCookie?: string): Response =>
  new Response(JSON.stringify(data), {
    headers: {
      "content-type": "application/json",
      ...(setCookie !== undefined ? { "set-cookie": setCookie } : {}),
    },
  })

// login sets a session cookie; me echoes back the Cookie header it received; logout expires the cookie.
const app = server()
  .get("/login", () => json({ ok: true }, "sid=abc; Path=/; HttpOnly"))
  .get("/me", (c) => ({ cookie: c.req.headers.get("cookie") }))
  .get("/logout", () => json({ ok: true }, "sid=; Max-Age=0"))

describe("testSession", () => {
  test("carries Set-Cookie across in-process requests", async () => {
    const { client, cookies } = testSession<typeof app>(app)

    const login = await client.login.get()
    expect(login.ok).toBe(true)
    expect(cookies.get("sid")).toBe("abc")

    const me = await client.me.get()
    expect(me.ok).toBe(true)
    if (me.ok) expect(me.data.cookie).toContain("sid=abc")
  })

  test("logout (Max-Age=0) clears the jar; later requests carry no session cookie", async () => {
    const { client, cookies } = testSession<typeof app>(app)
    await client.login.get()
    await client.logout.get()
    expect(cookies.get("sid")).toBeUndefined()

    const me = await client.me.get()
    if (me.ok) expect(me.data.cookie ?? "").not.toContain("sid=abc")
  })
})

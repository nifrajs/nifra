import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { basicAuth } from "../src/index.ts"

const basic = (value: string): string => `Basic ${btoa(value)}`

describe("basicAuth()", () => {
  test("authorizes static credentials and exposes the principal", async () => {
    const auth = basicAuth({ username: "admin", password: "s3cret", principal: { id: "root" } })
    const app = server()
      .use(auth)
      .get("/private", (c) => auth.requirePrincipal(c.req))

    const res = await app.fetch(
      new Request("http://x/private", { headers: { authorization: basic("admin:s3cret") } }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: "root" })
  })

  test("rejects missing, malformed, and wrong credentials with a Basic challenge", async () => {
    const app = server()
      .use(basicAuth({ username: "admin", password: "s3cret", realm: "staging" }))
      .get("/private", () => ({ ok: true }))

    for (const authorization of [undefined, "Basic !!!", basic("admin"), basic("admin:wrong")]) {
      const headers = authorization === undefined ? {} : { authorization }
      const res = await app.fetch(new Request("http://x/private", { headers }))
      expect(res.status).toBe(401)
      expect(res.headers.get("www-authenticate")).toBe('Basic realm="staging", charset="UTF-8"')
    }
  })

  test("supports an async verifier and optional mode", async () => {
    const auth = basicAuth({
      verify: async (username, password) =>
        username === "u" && password === "p" ? { user: username } : null,
      optional: true,
    })
    const app = server()
      .use(auth)
      .get("/maybe", (c) => ({ user: auth.principal(c.req)?.user ?? null }))

    expect(await (await app.fetch(new Request("http://x/maybe"))).json()).toEqual({ user: null })
    expect(
      await (
        await app.fetch(new Request("http://x/maybe", { headers: { authorization: basic("u:p") } }))
      ).json(),
    ).toEqual({ user: "u" })
  })
})

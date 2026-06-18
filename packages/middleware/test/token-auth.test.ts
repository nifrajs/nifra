import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { apiKey, bearer } from "@nifrajs/middleware"

interface User {
  readonly id: string
  readonly role: string
}
const lookup = (token: string): User | null =>
  token === "good" ? { id: "u1", role: "admin" } : null

const withAuth = (header: Record<string, string>) =>
  new Request("http://x/private", { headers: header })

describe("bearer()", () => {
  test("authorizes a valid token and exposes a typed principal", async () => {
    const auth = bearer({ verify: lookup })
    const app = server()
      .use(auth)
      // `requirePrincipal` returns `User` (typed) — `.role` is `string`, not `any`.
      .get("/private", (c) => ({ role: auth.requirePrincipal(c.req).role }))
    const res = await app.fetch(withAuth({ authorization: "Bearer good" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ role: "admin" })
  })

  test("rejects a missing token with 401 + WWW-Authenticate", async () => {
    const app = server()
      .use(bearer({ verify: lookup }))
      .get("/private", () => ({ ok: true }))
    const res = await app.fetch(new Request("http://x/private"))
    expect(res.status).toBe(401)
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="api"')
    expect(await res.json()).toEqual({ ok: false, error: "unauthorized" })
  })

  test("rejects a malformed header (not 'Bearer ') and an invalid token", async () => {
    const app = server()
      .use(bearer({ verify: lookup }))
      .get("/private", () => ({ ok: true }))
    expect((await app.fetch(withAuth({ authorization: "Basic xyz" }))).status).toBe(401)
    expect((await app.fetch(withAuth({ authorization: "Bearer wrong" }))).status).toBe(401)
  })

  test("honors a custom realm", async () => {
    const app = server()
      .use(bearer({ verify: lookup, realm: "secure" }))
      .get("/private", () => ({ ok: true }))
    const res = await app.fetch(new Request("http://x/private"))
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="secure"')
  })

  test("optional mode lets unauthenticated requests through; principal() is null", async () => {
    const auth = bearer({ verify: lookup, optional: true })
    const app = server()
      .use(auth)
      .get("/maybe", (c) => ({ user: auth.principal(c.req)?.id ?? null }))
    const anon = await app.fetch(new Request("http://x/maybe"))
    expect(anon.status).toBe(200)
    expect(await anon.json()).toEqual({ user: null })
    const authed = await app.fetch(
      new Request("http://x/maybe", { headers: { authorization: "Bearer good" } }),
    )
    expect(await authed.json()).toEqual({ user: "u1" })
  })

  test("requirePrincipal() throws 401 when no principal (optional mode, anon request)", async () => {
    const auth = bearer({ verify: lookup, optional: true })
    const app = server()
      .use(auth)
      .get("/strict", (c) => auth.requirePrincipal(c.req)) // throws 401 — short-circuits
    expect((await app.fetch(new Request("http://x/strict"))).status).toBe(401)
  })

  test("is order-scoped: routes before use() are not guarded", async () => {
    const auth = bearer({ verify: lookup })
    const app = server()
      .get("/public", () => ({ public: true })) // registered before the guard
      .use(auth)
      .get("/private", () => ({ ok: true }))
    expect((await app.fetch(new Request("http://x/public"))).status).toBe(200)
    expect((await app.fetch(new Request("http://x/private"))).status).toBe(401)
  })

  test("applied twice is idempotent (one beforeHandle)", async () => {
    const auth = bearer({ verify: lookup })
    const app = server()
      .use(auth)
      .use(auth)
      .get("/private", () => ({ ok: true }))
    // A double-wired guard would still 401 here, but a valid token must yield exactly one 200.
    expect((await app.fetch(withAuth({ authorization: "Bearer good" }))).status).toBe(200)
  })

  test("treats an empty token as no credential", async () => {
    const app = server()
      .use(bearer({ verify: lookup }))
      .get("/private", () => ({ ok: true }))
    expect((await app.fetch(withAuth({ authorization: "Bearer " }))).status).toBe(401)
  })
})

describe("apiKey({ verify })", () => {
  test("reads x-api-key, exposes the principal, and 401s without a WWW-Authenticate challenge", async () => {
    const auth = apiKey({ verify: (k) => (k === "secret" ? { tenant: "acme" } : null) })
    const app = server()
      .use(auth)
      .get("/private", (c) => auth.requirePrincipal(c.req))
    const ok = await app.fetch(withAuth({ "x-api-key": "secret" }))
    expect(await ok.json()).toEqual({ tenant: "acme" })
    const bad = await app.fetch(new Request("http://x/private"))
    expect(bad.status).toBe(401)
    expect(bad.headers.get("www-authenticate")).toBeNull() // API keys: no Bearer challenge
  })

  test("honors a custom header name", async () => {
    const auth = apiKey({ verify: (k) => (k === "k" ? { ok: true } : null), header: "X-Token" })
    const app = server()
      .use(auth)
      .get("/private", () => ({ ok: true }))
    expect((await app.fetch(withAuth({ "x-token": "k" }))).status).toBe(200)
    expect((await app.fetch(withAuth({ "x-api-key": "k" }))).status).toBe(401) // wrong header
  })

  test("optional mode passes through", async () => {
    const auth = apiKey({ verify: () => null, optional: true })
    const app = server()
      .use(auth)
      .get("/maybe", () => ({ ok: true }))
    expect((await app.fetch(new Request("http://x/maybe"))).status).toBe(200)
  })
})

describe("apiKey({ keys }) — constant-time static keys", () => {
  test("accepts a valid key (principal is the matched key) and rejects others", async () => {
    const auth = apiKey({ keys: ["alpha", "beta"] })
    const app = server()
      .use(auth)
      .get("/private", (c) => ({ key: auth.requirePrincipal(c.req) }))
    expect(await (await app.fetch(withAuth({ "x-api-key": "alpha" }))).json()).toEqual({
      key: "alpha",
    })
    expect(await (await app.fetch(withAuth({ "x-api-key": "beta" }))).json()).toEqual({
      key: "beta",
    }) // 2nd key
    expect((await app.fetch(withAuth({ "x-api-key": "gamma" }))).status).toBe(401)
    expect((await app.fetch(new Request("http://x/private"))).status).toBe(401) // no header
  })

  test("an empty configured-key set rejects everything", async () => {
    const app = server()
      .use(apiKey({ keys: [] }))
      .get("/private", () => ({ ok: true }))
    expect((await app.fetch(withAuth({ "x-api-key": "anything" }))).status).toBe(401)
  })
})

import { describe, expect, test } from "bun:test"
import { betterAuth, getSession, requireSession } from "@nifrajs/better-auth"
import { server } from "@nifrajs/core"

/**
 * A structural stub of a better-auth instance — `handler` echoes the path/method so we can assert the
 * mount, and `getSession` returns a typed payload when the test cookie is present. No DB, no
 * better-auth install: this is exactly the structural contract `@nifrajs/better-auth` consumes.
 */
const stubAuth = {
  handler: async (req: Request): Promise<Response> =>
    Response.json({ path: new URL(req.url).pathname, method: req.method }),
  api: {
    getSession: async ({ headers }: { headers: Headers }) =>
      headers.get("cookie") === "session=valid"
        ? { user: { id: "u1", email: "a@b.c" }, session: { id: "s1", expiresAt: 0 } }
        : null,
  },
  options: { basePath: "/api/auth" },
}

const authed = (path: string, method = "GET") =>
  new Request(`http://x${path}`, { method, headers: { cookie: "session=valid" } })

describe("betterAuth() mount", () => {
  test("serves better-auth's handler at /api/auth/* for GET and POST", async () => {
    const app = server().use(betterAuth(stubAuth))
    const get = await app.fetch(new Request("http://x/api/auth/get-session"))
    expect(get.status).toBe(200)
    expect(await get.json()).toEqual({ path: "/api/auth/get-session", method: "GET" })

    const post = await app.fetch(new Request("http://x/api/auth/sign-in/email", { method: "POST" }))
    expect(await post.json()).toEqual({ path: "/api/auth/sign-in/email", method: "POST" })
  })

  test("does not shadow the app's own routes", async () => {
    const app = server()
      .use(betterAuth(stubAuth))
      .get("/", () => ({ ok: true }))
    expect(await (await app.fetch(new Request("http://x/"))).json()).toEqual({ ok: true })
  })

  test("honors a custom basePath", async () => {
    const app = server().use(betterAuth(stubAuth, { basePath: "/auth/" })) // trailing slash tolerated
    const res = await app.fetch(new Request("http://x/auth/get-session"))
    expect(await res.json()).toEqual({ path: "/auth/get-session", method: "GET" })
  })

  test("falls back to auth.options.basePath, then /api/auth", async () => {
    const noOpts = { handler: stubAuth.handler, api: stubAuth.api }
    const app = server().use(betterAuth(noOpts))
    expect((await app.fetch(new Request("http://x/api/auth/x"))).status).toBe(200)
  })

  test("applied twice is idempotent (mounts once, no route conflict)", async () => {
    const plugin = betterAuth(stubAuth)
    const app = server().use(plugin).use(plugin)
    expect((await app.fetch(new Request("http://x/api/auth/get-session"))).status).toBe(200)
  })
})

describe("getSession()", () => {
  test("returns the typed session when authenticated", async () => {
    const session = await getSession(stubAuth, authed("/me"))
    // Type flows through inference: `session.user.email` is `string`, not `any`.
    expect(session?.user.email).toBe("a@b.c")
    expect(session?.session.id).toBe("s1")
  })

  test("returns null when unauthenticated", async () => {
    expect(await getSession(stubAuth, new Request("http://x/me"))).toBeNull()
  })
})

describe("requireSession() guard", () => {
  test("returns the session when authenticated", async () => {
    const { user } = await requireSession(stubAuth, authed("/me"))
    expect(user.id).toBe("u1")
  })

  test("throws a 401 JSON Response when unauthenticated and no redirect", async () => {
    try {
      await requireSession(stubAuth, new Request("http://x/me"))
      throw new Error("expected requireSession to throw")
    } catch (err) {
      expect(err).toBeInstanceOf(Response)
      const res = err as Response
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ ok: false, error: "unauthorized" })
    }
  })

  test("throws a 302 redirect Response when redirectTo is set", async () => {
    try {
      await requireSession(stubAuth, new Request("http://x/me"), { redirectTo: "/login" })
      throw new Error("expected requireSession to throw")
    } catch (err) {
      expect(err).toBeInstanceOf(Response)
      expect((err as Response).status).toBe(302)
      expect((err as Response).headers.get("location")).toBe("/login")
    }
  })

  test("rejects an off-origin redirectTo (config bug — fails loud, not a redirect)", async () => {
    await expect(
      requireSession(stubAuth, new Request("http://x/me"), { redirectTo: "//evil.com" }),
    ).rejects.toThrow(/same-origin/)
  })

  test("integrates as a route guard — 401 short-circuits the handler", async () => {
    const app = server()
      .use(betterAuth(stubAuth))
      .get("/me", async (c) => (await requireSession(stubAuth, c.req)).user)
    expect((await app.fetch(new Request("http://x/me"))).status).toBe(401)
    const ok = await app.fetch(authed("/me"))
    expect(await ok.json()).toEqual({ id: "u1", email: "a@b.c" })
  })
})

import { describe, expect, test } from "bun:test"
import { server, silentLogger } from "@nifrajs/core"
import { createSessions, csrf, MemorySessionStore, requireUser } from "../src/index.ts"

const SECRET = "integration-secret-at-least-32by"

// A realistic auth wiring on a plain nifra server: login/logout in routes (full Context → sessions
// commit/destroy), a protected route guarded by requireUser, CSRF on unsafe methods.
function makeApp() {
  const sessions = createSessions<{ userId: string }>({
    secret: SECRET,
    store: new MemorySessionStore(),
    cookie: { secure: false }, // local http test
  })
  return server({ logger: silentLogger })
    .use(csrf()) // same-origin check (derives http://localhost from the request URL)
    .post("/login", async (c) => {
      const session = await sessions.get(c)
      session.set("userId", "alice")
      sessions.regenerate(session) // rotate the id on login (fixation defense)
      await sessions.commit(c, session)
      return { ok: true }
    })
    .get("/me", async (c) => {
      const userId = requireUser(await sessions.get(c), "userId") // throws 401 if unauthenticated
      return { userId }
    })
    .post("/logout", async (c) => {
      await sessions.destroy(c, await sessions.get(c))
      return { ok: true }
    })
}

const ORIGIN = "http://localhost"
/** The `name=value` to echo back as a Cookie header (before the attributes). */
const cookieHeader = (res: Response): string => res.headers.getSetCookie()[0]?.split(";")[0] ?? ""

describe("auth end-to-end (real nifra server: login → protected → logout)", () => {
  test("the full session lifecycle round-trips over HTTP", async () => {
    const app = makeApp()

    // 1. Unauthenticated → the guard throws a 401.
    expect((await app.fetch(new Request(`${ORIGIN}/me`))).status).toBe(401)

    // 2. Log in (CSRF needs a same-origin Origin) → 200 + a session cookie.
    const login = await app.fetch(
      new Request(`${ORIGIN}/login`, { method: "POST", headers: { origin: ORIGIN } }),
    )
    expect(login.status).toBe(200)
    const cookie = cookieHeader(login)
    expect(cookie.startsWith("nifra_session=")).toBe(true)
    // Store mode keeps data server-side - the user id is not in the cookie.
    expect(cookie).not.toContain("alice")
    const setCookie = login.headers.getSetCookie()[0] ?? ""
    expect(setCookie).toContain("HttpOnly")

    // 3. The cookie authenticates the protected route.
    const me = await app.fetch(new Request(`${ORIGIN}/me`, { headers: { cookie } }))
    expect(me.status).toBe(200)
    expect(await me.json()).toEqual({ userId: "alice" })

    // 4. Log out → the server-side session is dropped, so the same cookie no longer authenticates.
    const logout = await app.fetch(
      new Request(`${ORIGIN}/logout`, { method: "POST", headers: { origin: ORIGIN, cookie } }),
    )
    expect(logout.status).toBe(200)
    expect((await app.fetch(new Request(`${ORIGIN}/me`, { headers: { cookie } }))).status).toBe(401)
  })

  test("CSRF blocks a cross-origin state-changing request", async () => {
    const app = makeApp()
    const res = await app.fetch(
      new Request(`${ORIGIN}/login`, {
        method: "POST",
        headers: { origin: "http://evil.example" },
      }),
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, error: "csrf_failed" })
  })

  test("a tampered session cookie is rejected (fail closed)", async () => {
    const app = makeApp()
    const login = await app.fetch(
      new Request(`${ORIGIN}/login`, { method: "POST", headers: { origin: ORIGIN } }),
    )
    const tampered = `${cookieHeader(login).slice(0, -3)}xxx`
    expect(
      (await app.fetch(new Request(`${ORIGIN}/me`, { headers: { cookie: tampered } }))).status,
    ).toBe(401)
  })

  test("a __Host- session cookie works end to end: set satisfies the prefix, logout deletion carries Secure", async () => {
    // c.set.cookie's secure-by-default (Secure + Path=/ + no Domain) satisfies the __Host-
    // contract with zero config, and destroy()'s deletion Set-Cookie must satisfy it too or the
    // browser discards the deletion and logout leaves the session cookie alive.
    const sessions = createSessions<{ userId: string }>({
      secret: SECRET,
      store: new MemorySessionStore(),
      cookieName: "__Host-session",
    })
    const app = server({ logger: silentLogger })
      .post("/login", async (c) => {
        const s = await sessions.get(c)
        s.set("userId", "alice")
        await sessions.commit(c, s)
        return { ok: true }
      })
      .post("/logout", async (c) => {
        await sessions.destroy(c, await sessions.get(c))
        return { ok: true }
      })
    const login = await app.fetch(new Request(`${ORIGIN}/login`, { method: "POST" }))
    const set = login.headers.getSetCookie()[0] ?? ""
    expect(set.startsWith("__Host-session=")).toBe(true)
    expect(set).toContain("Secure")
    expect(set).toContain("Path=/")
    expect(set).not.toContain("Domain")
    const cookie = cookieHeader(login)
    const logout = await app.fetch(
      new Request(`${ORIGIN}/logout`, { method: "POST", headers: { cookie } }),
    )
    const deletion = logout.headers.getSetCookie()[0] ?? ""
    expect(deletion.startsWith("__Host-session=")).toBe(true)
    expect(deletion).toContain("Max-Age=0")
    expect(deletion).toContain("Secure")
    expect(deletion).toContain("Path=/")
  })

  test("manager.read loads the session from a raw Request (the loader path)", async () => {
    const sessions = createSessions<{ userId: string }>({
      secret: SECRET,
      store: new MemorySessionStore(),
      cookie: { secure: false },
    })
    // Commit via a full context, then read back via just a Request (what a @nifrajs/web loader has).
    const app = server({ logger: silentLogger }).post("/login", async (c) => {
      const s = await sessions.get(c)
      s.set("userId", "bob")
      await sessions.commit(c, s)
      return { ok: true }
    })
    const login = await app.fetch(new Request(`${ORIGIN}/login`, { method: "POST" }))
    const cookie = cookieHeader(login)
    const session = await sessions.read(new Request(`${ORIGIN}/anything`, { headers: { cookie } }))
    expect(session.get("userId")).toBe("bob")
    // No cookie → anonymous.
    expect((await sessions.read(new Request(`${ORIGIN}/anything`))).isEmpty).toBe(true)
  })
})

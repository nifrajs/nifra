import { describe, expect, test } from "bun:test"
import { signValue } from "@nifrajs/core"
import {
  createSessions,
  MemorySessionStore,
  type SessionContext,
  type SessionManager,
} from "../src/index.ts"

const SECRET = "test-secret-at-least-32-bytes-ok!"

/** A stub SessionContext that records cookie writes/deletes and exposes them for assertions. */
function ctx(cookies: Record<string, string> = {}) {
  const setCalls: Array<{ name: string; value: string; options?: unknown }> = []
  const deleted: string[] = []
  const context: SessionContext = {
    cookies,
    set: {
      cookie: (name, value, options) => setCalls.push({ name, value, options }),
      deleteCookie: (name) => deleted.push(name),
    },
  }
  return { context, setCalls, deleted }
}

/** Run get→commit, then load a fresh ctx carrying the cookie commit wrote (the round-trip). */
const lastCookie = (setCalls: Array<{ value: string }>): string =>
  setCalls.at(-1)?.value ?? "(no cookie written)"

interface Data extends Record<string, unknown> {
  userId: string
  role: "admin" | "user"
}

test("a short secret is rejected", () => {
  expect(() => createSessions({ secret: "tooshort" })).toThrow(/at least 32 bytes/)
})

describe("session — store mode", () => {
  const make = (now: () => number = () => 1000): SessionManager<Data> =>
    createSessions<Data>({ secret: SECRET, store: new MemorySessionStore(), now, maxAge: 3600 })

  test("no cookie → a fresh empty session", async () => {
    const sessions = make()
    const session = await sessions.get(ctx().context)
    expect(session.isEmpty).toBe(true)
    expect(session.get("userId")).toBeUndefined()
    expect(session.has("userId")).toBe(false)
  })

  test("commit a new session → signed cookie + round-trips through get", async () => {
    const sessions = make()
    const a = ctx()
    const session = await sessions.get(a.context)
    // A distinctive sentinel — if store mode leaked data into the cookie, this 25-char string would
    // appear; it can't collide with a random base64url session id.
    session.set("userId", "SENTINEL-DATA-NOT-IN-COOKIE")
    session.set("role", "admin")
    await sessions.commit(a.context, session)
    expect(a.setCalls).toHaveLength(1)
    expect(a.setCalls[0]?.name).toBe("nifra_session")

    // The cookie value is a signed opaque id (not the data) — store mode keeps data server-side.
    expect(a.setCalls[0]?.value).not.toContain("SENTINEL-DATA-NOT-IN-COOKIE")

    // Round-trip: a new request carrying that cookie loads the same data.
    const b = ctx({ nifra_session: lastCookie(a.setCalls) })
    const loaded = await sessions.get(b.context)
    expect(loaded.get("userId")).toBe("SENTINEL-DATA-NOT-IN-COOKIE")
    expect(loaded.get("role")).toBe("admin")
    expect(loaded.data).toEqual({ userId: "SENTINEL-DATA-NOT-IN-COOKIE", role: "admin" })
    expect(loaded.isEmpty).toBe(false)
  })

  test("a tampered cookie fails closed (anonymous session)", async () => {
    const sessions = make()
    const a = ctx()
    const session = await sessions.get(a.context)
    session.set("userId", "u1")
    await sessions.commit(a.context, session)
    const tampered = `${lastCookie(a.setCalls).slice(0, -2)}XX` // corrupt the signature tail
    const loaded = await sessions.get(ctx({ nifra_session: tampered }).context)
    expect(loaded.isEmpty).toBe(true)
  })

  test("a valid cookie whose store record is gone → anonymous", async () => {
    const store = new MemorySessionStore()
    const sessions = createSessions<Data>({ secret: SECRET, store, now: () => 1000 })
    const a = ctx()
    const session = await sessions.get(a.context)
    session.set("userId", "u1")
    await sessions.commit(a.context, session)
    // Sign a *valid* but unknown id with the same secret → passes the signature check, misses the store.
    const ghost = await signValue("never-stored-id", SECRET)
    expect((await sessions.get(ctx({ nifra_session: ghost }).context)).isEmpty).toBe(true)
  })

  test("an expired record → anonymous + evicted from the store", async () => {
    const store = new MemorySessionStore()
    let t = 1000
    const sessions = createSessions<Data>({ secret: SECRET, store, now: () => t, maxAge: 1 })
    const a = ctx()
    const s = await sessions.get(a.context)
    s.set("userId", "u1")
    await sessions.commit(a.context, s) // expiresAt = 1000 + 1000ms
    const cookie = lastCookie(a.setCalls)
    t = 5000 // past expiry
    expect((await sessions.get(ctx({ nifra_session: cookie }).context)).isEmpty).toBe(true)
    // a second load confirms it was evicted (store.get now misses regardless of the clock)
    t = 1000
    expect((await sessions.get(ctx({ nifra_session: cookie }).context)).isEmpty).toBe(true)
  })

  test("regenerate rotates the id on commit + drops the old store record (fixation defense)", async () => {
    const store = new MemorySessionStore()
    const sessions = createSessions<Data>({ secret: SECRET, store, now: () => 1000 })
    const a = ctx()
    const s = await sessions.get(a.context)
    s.set("userId", "u1")
    await sessions.commit(a.context, s)
    const firstCookie = lastCookie(a.setCalls)

    sessions.regenerate(s)
    const b = ctx()
    await sessions.commit(b.context, s)
    const secondCookie = lastCookie(b.setCalls)
    expect(secondCookie).not.toBe(firstCookie) // new id
    // Old cookie no longer resolves; new one carries the (preserved) data.
    expect((await sessions.get(ctx({ nifra_session: firstCookie }).context)).isEmpty).toBe(true)
    expect((await sessions.get(ctx({ nifra_session: secondCookie }).context)).get("userId")).toBe(
      "u1",
    )
  })

  test("destroy drops the store record + clears the cookie", async () => {
    const store = new MemorySessionStore()
    const sessions = createSessions<Data>({ secret: SECRET, store, now: () => 1000 })
    const a = ctx()
    const s = await sessions.get(a.context)
    s.set("userId", "u1")
    await sessions.commit(a.context, s)
    const cookie = lastCookie(a.setCalls)
    const d = ctx()
    await sessions.destroy(d.context, s)
    expect(d.deleted).toContain("nifra_session")
    expect((await sessions.get(ctx({ nifra_session: cookie }).context)).isEmpty).toBe(true)
  })

  test("destroy with no session still clears the cookie", async () => {
    const sessions = make()
    const d = ctx()
    await sessions.destroy(d.context)
    expect(d.deleted).toContain("nifra_session")
  })

  test("mutators: set/unset/has/clear/data", async () => {
    const sessions = make()
    const s = await sessions.get(ctx().context)
    s.set("userId", "u1")
    s.set("role", "user")
    expect(s.has("role")).toBe(true)
    s.unset("role")
    expect(s.has("role")).toBe(false)
    expect(s.data).toEqual({ userId: "u1" })
    s.clear()
    expect(s.isEmpty).toBe(true)
  })

  test("committing a session from a different manager throws", async () => {
    const m1 = make()
    const m2 = make()
    const s = await m1.get(ctx().context)
    expect(sessions2Commit(m2, s)).rejects.toThrow(/not created by this manager/)
    expect(() => m2.regenerate(s)).toThrow(/not created by this manager/)
  })
})

// Helper so the rejects assertion above reads cleanly.
const sessions2Commit = (
  m: SessionManager<Data>,
  s: Awaited<ReturnType<SessionManager<Data>["get"]>>,
) => m.commit(ctx().context, s)

describe("session — cookie mode (stateless)", () => {
  const make = (now: () => number = () => 1000): SessionManager<Data> =>
    createSessions<Data>({ secret: SECRET, now, maxAge: 3600 })

  test("commit signs the data INTO the cookie; get round-trips it", async () => {
    const sessions = make()
    const a = ctx()
    const s = await sessions.get(a.context)
    s.set("userId", "u9")
    await sessions.commit(a.context, s)
    expect(a.setCalls[0]?.value).toContain(".") // signed payload
    const loaded = await sessions.get(ctx({ nifra_session: lastCookie(a.setCalls) }).context)
    expect(loaded.get("userId")).toBe("u9")
  })

  test("a tampered or non-JSON-but-validly-signed payload fails closed", async () => {
    const sessions = make()
    // Validly signed (passes HMAC) but not a session payload → parsePayload returns null → anonymous.
    const garbage = await signValue("not-json", SECRET)
    expect((await sessions.get(ctx({ nifra_session: garbage }).context)).isEmpty).toBe(true)
    // Signed JSON but wrong shape (missing expiresAt) → anonymous.
    const wrongShape = await signValue(JSON.stringify({ data: { userId: "x" } }), SECRET)
    expect((await sessions.get(ctx({ nifra_session: wrongShape }).context)).isEmpty).toBe(true)
  })

  test("an expired payload → anonymous", async () => {
    let t = 1000
    const sessions = createSessions<Data>({ secret: SECRET, now: () => t, maxAge: 1 })
    const a = ctx()
    const s = await sessions.get(a.context)
    s.set("userId", "u1")
    await sessions.commit(a.context, s)
    t = 5000
    expect(
      (await sessions.get(ctx({ nifra_session: lastCookie(a.setCalls) }).context)).isEmpty,
    ).toBe(true)
  })
})

describe("session — expiry modes + cookie options", () => {
  test("rolling (default) slides expiry; absolute keeps the original", async () => {
    // Rolling: maxAge cookie refreshes each commit.
    let t = 0
    const rollingMgr = createSessions<Data>({ secret: SECRET, now: () => t, maxAge: 100 })
    const a = ctx()
    const s = await rollingMgr.get(a.context)
    s.set("userId", "u1")
    await rollingMgr.commit(a.context, s)
    // Absolute: expiry fixed at first commit.
    const absMgr = createSessions<Data>({
      secret: SECRET,
      now: () => t,
      maxAge: 100,
      rolling: false,
    })
    const b = ctx()
    const s2 = await absMgr.get(b.context)
    s2.set("userId", "u1")
    await absMgr.commit(b.context, s2)
    const firstExpiryCookie = lastCookie(b.setCalls)
    t = 50_000 // 50s later
    await absMgr.commit(b.context, s2) // re-commit
    // Absolute mode preserves the original expiry, so the session still loads pre-deadline...
    expect(
      (await absMgr.get(ctx({ nifra_session: lastCookie(b.setCalls) }).context)).get("userId"),
    ).toBe("u1")
    expect(typeof firstExpiryCookie).toBe("string")
  })

  test("cookie options thread through (secure:false for dev, custom name)", async () => {
    const sessions = createSessions<Data>({
      secret: SECRET,
      now: () => 1000,
      cookieName: "sid",
      cookie: { secure: false, sameSite: "strict", path: "/app" },
    })
    const a = ctx()
    const s = await sessions.get(a.context)
    s.set("userId", "u1")
    await sessions.commit(a.context, s)
    expect(a.setCalls[0]?.name).toBe("sid")
    expect(a.setCalls[0]?.options).toMatchObject({
      secure: false,
      sameSite: "strict",
      path: "/app",
    })
  })
})

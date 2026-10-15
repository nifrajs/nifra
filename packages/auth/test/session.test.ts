import { describe, expect, test } from "bun:test"
import { signValue } from "@nifrajs/core"
import { parseCookies } from "@nifrajs/core/cookies"
import {
  createSessions,
  MemorySessionStore,
  type SessionContext,
  type SessionManager,
} from "../src/index.ts"

const SECRET = "test-secret-at-least-32-bytes-ok!"

/** A value signed as the manager signs its `nifra_session` cookie, with the cookie name bound in. */
const signSession = async (value: string): Promise<string> =>
  (await signValue(`nifra_session\n${value}`, SECRET)).slice("nifra_session\n".length)

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

function requestContext(cookie: string): SessionContext {
  return {
    cookies: parseCookies(cookie),
    request: new Request("http://local/", { headers: { cookie } }),
    set: { cookie() {}, deleteCookie() {} },
  }
}

/** Run get→commit, then load a fresh ctx carrying the cookie commit wrote (the round-trip). */
const lastCookie = (setCalls: Array<{ value: string }>): string =>
  setCalls.at(-1)?.value ?? "(no cookie written)"

/** The store-mode session id a cookie carries: the signed value is `<id>.<signature>`. */
const idOf = (cookie: string): string => cookie.slice(0, cookie.lastIndexOf("."))

interface Data extends Record<string, unknown> {
  userId: string
  role: "admin" | "user"
}

test("a short secret is rejected", () => {
  expect(() => createSessions({ secret: "tooshort" })).toThrow(/at least 32 bytes/)
})

test("rotation list: every entry must meet the floor, empty list throws", () => {
  expect(() => createSessions({ secret: [] })).toThrow(/cannot be empty/)
  expect(() => createSessions({ secret: [SECRET, "tooshort"] })).toThrow(/at least 32 bytes/)
})

test("duplicate session cookies fail closed instead of selecting an ambiguous value", async () => {
  const sessions = createSessions<Data>({ secret: SECRET, store: new MemorySessionStore() })
  const source = ctx()
  const session = await sessions.get(source.context)
  session.set("userId", "u1")
  await sessions.commit(source.context, session)
  const signed = lastCookie(source.setCalls)

  const duplicate = requestContext(`nifra_session=${signed}; nifra_session=${signed}`)
  const loaded = await sessions.get(duplicate)
  expect(loaded.isEmpty).toBe(true)
})

test("a non-finite maxAge is rejected at construction", () => {
  expect(() => createSessions({ secret: SECRET, maxAge: Number.NaN })).toThrow(/maxAge/)
})

test("a session cookie does not verify under another name that shares the secret", async () => {
  // Store mode (one shared store) and cookie mode.
  for (const mode of [{ store: new MemorySessionStore() }, {}]) {
    const user = createSessions<Data>({ secret: SECRET, cookieName: "user_session", ...mode })
    const admin = createSessions<Data>({ secret: SECRET, cookieName: "admin_session", ...mode })
    const source = ctx()
    const session = await user.get(source.context)
    session.set("role", "user")
    await user.commit(source.context, session)
    const signed = lastCookie(source.setCalls)
    expect((await user.get(ctx({ user_session: signed }).context)).get("role")).toBe("user")
    expect((await admin.get(ctx({ admin_session: signed }).context)).isEmpty).toBe(true)
  }
})

test("a value signed with the session secret outside a session is not a session", async () => {
  // An app that signs a user-influenced value with the same secret through core's signValue must not
  // hand that user a session of their choosing.
  const forged = await signValue(
    JSON.stringify({ data: { userId: "admin" }, expiresAt: 9e15 }),
    SECRET,
  )
  const sessions = createSessions<Data>({ secret: SECRET })
  expect((await sessions.get(ctx({ nifra_session: forged }).context)).isEmpty).toBe(true)
  expect(
    (
      await sessions.read(
        new Request("http://x/", {
          headers: { cookie: `nifra_session=${encodeURIComponent(forged)}` },
        }),
      )
    ).isEmpty,
  ).toBe(true)
})

test("an accepted legacy cookie lives no longer than maxAge, whatever expiry it names", async () => {
  let clock = 1_000_000
  const sessions = createSessions<Data>({
    secret: SECRET,
    acceptLegacyCookies: true,
    rolling: false,
    maxAge: 60,
    now: () => clock,
  })
  const legacy = await signValue(
    JSON.stringify({ data: { userId: "u1" }, expiresAt: 9e15 }),
    SECRET,
  )
  const source = ctx({ nifra_session: legacy })
  const loaded = await sessions.get(source.context)
  expect(loaded.get("userId")).toBe("u1")
  await sessions.commit(source.context, loaded)
  const written = source.setCalls.at(-1)?.options
  expect(
    typeof written === "object" && written !== null && "maxAge" in written
      ? written.maxAge
      : undefined,
  ).toBe(60)
  const resigned = lastCookie(source.setCalls)
  clock += 60_000
  expect((await sessions.get(ctx({ nifra_session: resigned }).context)).isEmpty).toBe(true)
})

test("with acceptLegacyCookies, a cookie signed before names were bound loads and is re-signed bound", async () => {
  const sessions = createSessions<Data>({ secret: SECRET, acceptLegacyCookies: true })
  const expiresAt = Date.now() + 60_000
  const legacy = await signValue(JSON.stringify({ data: { userId: "u1" }, expiresAt }), SECRET)
  const source = ctx({ nifra_session: legacy })
  const loaded = await sessions.get(source.context)
  expect(loaded.get("userId")).toBe("u1")
  await sessions.commit(source.context, loaded)
  const resigned = lastCookie(source.setCalls)
  const other = createSessions<Data>({ secret: SECRET, cookieName: "other" })
  expect((await other.get(ctx({ other: resigned }).context)).isEmpty).toBe(true)
  expect((await sessions.get(ctx({ nifra_session: resigned }).context)).get("userId")).toBe("u1")
})

describe("session - store mode", () => {
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
    // A distinctive sentinel - if store mode leaked data into the cookie, this 25-char string would
    // appear; it can't collide with a random base64url session id.
    session.set("userId", "SENTINEL-DATA-NOT-IN-COOKIE")
    session.set("role", "admin")
    await sessions.commit(a.context, session)
    expect(a.setCalls).toHaveLength(1)
    expect(a.setCalls[0]?.name).toBe("nifra_session")

    // The cookie value is a signed opaque id (not the data) - store mode keeps data server-side.
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
    const cookie = lastCookie(a.setCalls)
    const last = cookie.at(-1)
    // Change one signature character to a different valid base64url character. Unlike replacing
    // the tail with a fixed string, this is guaranteed to differ even when the random signature
    // already happens to end in that string.
    const tampered = `${cookie.slice(0, -1)}${last === "A" ? "B" : "A"}`
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
    const ghost = await signSession("never-stored-id")
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

  test("committing a destroyed session later in the request starts a new one", async () => {
    for (const store of [new MemorySessionStore(), undefined]) {
      const sessions =
        store === undefined
          ? createSessions<Data>({ secret: SECRET, now: () => 1000 })
          : createSessions<Data>({ secret: SECRET, store, now: () => 1000 })
      const a = ctx()
      const s = await sessions.get(a.context)
      s.set("userId", "u1")
      await sessions.commit(a.context, s)
      const before = lastCookie(a.setCalls)

      const d = ctx({ nifra_session: before })
      const loaded = await sessions.get(d.context)
      await sessions.destroy(d.context, loaded)
      expect(loaded.isEmpty).toBe(true)
      loaded.set("role", "user")
      await sessions.commit(d.context, loaded)
      const after = lastCookie(d.setCalls)

      expect(after).not.toBe(before)
      const next = await sessions.get(ctx({ nifra_session: after }).context)
      expect(next.data).toEqual({ role: "user" })
      if (store !== undefined) {
        expect((await sessions.get(ctx({ nifra_session: before }).context)).isEmpty).toBe(true)
      }
    }
  })

  test("destroy with no session still clears the cookie", async () => {
    const sessions = make()
    const d = ctx()
    await sessions.destroy(d.context)
    expect(d.deleted).toContain("nifra_session")
  })

  // A logout route that never calls `get()` used to clear the browser cookie and leave the server
  // record alive, so a copy of the cookie taken before logout kept working.
  test("destroy without a loaded session revokes the record named by the signed cookie", async () => {
    const store = new MemorySessionStore()
    const sessions = createSessions<Data>({ secret: SECRET, store, now: () => 1000 })
    const a = ctx()
    const s = await sessions.get(a.context)
    s.set("userId", "u1")
    await sessions.commit(a.context, s)
    const cookie = lastCookie(a.setCalls)

    const d = ctx({ nifra_session: cookie })
    await sessions.destroy(d.context)
    expect(d.deleted).toContain("nifra_session")
    expect((await sessions.get(ctx({ nifra_session: cookie }).context)).isEmpty).toBe(true)
  })

  test("a cookie that fails the signature check deletes nothing", async () => {
    const store = new MemorySessionStore()
    const sessions = createSessions<Data>({ secret: SECRET, store, now: () => 1000 })
    const a = ctx()
    const s = await sessions.get(a.context)
    s.set("userId", "u1")
    await sessions.commit(a.context, s)
    const cookie = lastCookie(a.setCalls)

    // Same session id, broken signature: an unauthenticated caller must not be able to log out
    // (or otherwise revoke) an id it merely guessed. The mutated character is the FIRST of the
    // signature segment - the LAST one carries only 4 significant bits of the 32-byte digest, so
    // several spellings of it decode to the same bytes and the tamper would not register.
    const dot = cookie.lastIndexOf(".")
    const head = cookie[dot + 1]
    const forged = `${cookie.slice(0, dot + 1)}${head === "A" ? "B" : "A"}${cookie.slice(dot + 2)}`
    await sessions.destroy(ctx({ nifra_session: forged }).context)
    expect((await sessions.get(ctx({ nifra_session: cookie }).context)).get("userId")).toBe("u1")
  })

  // A request that loaded the session before a logout and commits after it (a rolling renewal, a
  // slow handler) used to write the record back, so a copy of the cookie taken before logout worked
  // again.
  test("a commit that loaded the session before logout does not bring it back", async () => {
    const store = new MemorySessionStore()
    const sessions = createSessions<Data>({ secret: SECRET, store, now: () => 1000 })
    const a = ctx()
    const s = await sessions.get(a.context)
    s.set("userId", "victim")
    await sessions.commit(a.context, s)
    const cookie = lastCookie(a.setCalls)

    const inFlight = ctx({ nifra_session: cookie })
    const stale = await sessions.get(inFlight.context)
    await sessions.destroy(ctx({ nifra_session: cookie }).context)
    await sessions.commit(inFlight.context, stale)

    expect((await sessions.get(ctx({ nifra_session: cookie }).context)).isEmpty).toBe(true)
    // The browser may already hold a newer session; the stale response must not replace it.
    expect(inFlight.setCalls).toEqual([])
  })

  test("sessions written after a logout never push its marker out of a bounded memory store", async () => {
    const store = new MemorySessionStore({ max: 50 })
    const sessions = createSessions<Data>({ secret: SECRET, store, now: () => 1000 })
    const a = ctx()
    const s = await sessions.get(a.context)
    s.set("userId", "victim")
    await sessions.commit(a.context, s)
    const cookie = lastCookie(a.setCalls)

    const inFlight = ctx({ nifra_session: cookie })
    const stale = await sessions.get(inFlight.context)
    await sessions.destroy(ctx({ nifra_session: cookie }).context)
    for (let i = 0; i < 50; i++) {
      const visitor = ctx()
      const anonymous = await sessions.get(visitor.context)
      anonymous.set("userId", `anon-${i}`)
      await sessions.commit(visitor.context, anonymous)
    }
    await sessions.commit(inFlight.context, stale)

    expect((await sessions.get(ctx({ nifra_session: cookie }).context)).isEmpty).toBe(true)
    expect(inFlight.setCalls).toEqual([])
  })

  test("a commit that loaded the pre-login session does not bring it back after rotation", async () => {
    const store = new MemorySessionStore()
    const sessions = createSessions<Data>({ secret: SECRET, store, now: () => 1000 })
    const a = ctx()
    const s = await sessions.get(a.context)
    s.set("role", "user")
    await sessions.commit(a.context, s)
    const before = lastCookie(a.setCalls)

    const stale = await sessions.get(ctx({ nifra_session: before }).context)
    const login = await sessions.get(ctx({ nifra_session: before }).context)
    login.set("userId", "u1")
    sessions.regenerate(login)
    await sessions.commit(ctx().context, login)
    await sessions.commit(ctx().context, stale)

    expect((await sessions.get(ctx({ nifra_session: before }).context)).isEmpty).toBe(true)
  })

  // The write can also land after the revocation finished but before the commit's own check runs;
  // the next load still refuses the record and removes it.
  test("a load refuses and removes a record written back after revocation", async () => {
    const store = new MemorySessionStore()
    const sessions = createSessions<Data>({ secret: SECRET, store, now: () => 1000 })
    const a = ctx()
    const s = await sessions.get(a.context)
    s.set("userId", "victim")
    await sessions.commit(a.context, s)
    const cookie = lastCookie(a.setCalls)
    const id = idOf(cookie)

    await sessions.destroy(ctx({ nifra_session: cookie }).context)
    await store.set(id, { data: { userId: "victim" }, expiresAt: 10_000 })

    expect((await sessions.get(ctx({ nifra_session: cookie }).context)).isEmpty).toBe(true)
    expect(await store.get(id)).toBeUndefined()
  })

  test("a signed revocation marker never reads as a session", async () => {
    const store = new MemorySessionStore()
    const sessions = createSessions<Data>({ secret: SECRET, store, now: () => 1000 })
    const a = ctx()
    const s = await sessions.get(a.context)
    s.set("userId", "u1")
    await sessions.commit(a.context, s)
    const cookie = lastCookie(a.setCalls)
    const id = idOf(cookie)
    await sessions.destroy(ctx({ nifra_session: cookie }).context)

    // Reachable only with a value the app signed itself. Neither a commit nor a logout through it may
    // touch the marker's key.
    const marker = await signSession(`${id}.revoked`)
    const m = ctx({ nifra_session: marker })
    const loaded = await sessions.get(m.context)
    expect(loaded.isEmpty).toBe(true)
    loaded.set("userId", "attacker")
    await sessions.commit(m.context, loaded)
    expect((await store.get(`${id}.revoked`))?.data).toEqual({})
    await sessions.destroy(ctx({ nifra_session: marker }).context)
    await store.set(id, { data: { userId: "u1" }, expiresAt: 10_000 })
    expect((await sessions.get(ctx({ nifra_session: cookie }).context)).isEmpty).toBe(true)
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

describe("session - cookie mode (stateless)", () => {
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

  test("secret rotation: a session signed by the old secret survives, dropped secret fails closed", async () => {
    const OLD = "old-session-secret-32-bytes-min!!"
    const NEW = "new-session-secret-32-bytes-min!!"
    const before = createSessions<Data>({ secret: OLD, now: () => 1000, maxAge: 3600 })
    const a = ctx()
    const s = await before.get(a.context)
    s.set("userId", "u9")
    await before.commit(a.context, s)
    const cookie = lastCookie(a.setCalls)

    // Rotated deployment: [new, old] still reads the old cookie...
    const rotated = createSessions<Data>({ secret: [NEW, OLD], now: () => 1000, maxAge: 3600 })
    expect((await rotated.get(ctx({ nifra_session: cookie }).context)).get("userId")).toBe("u9")
    // ...and writes new cookies under the NEW secret (verifiable without the old one).
    const b = ctx({ nifra_session: cookie })
    const rs = await rotated.get(b.context)
    await rotated.commit(b.context, rs)
    const after = createSessions<Data>({ secret: NEW, now: () => 1000, maxAge: 3600 })
    expect(
      (await after.get(ctx({ nifra_session: lastCookie(b.setCalls) }).context)).get("userId"),
    ).toBe("u9")
    // Old secret dropped entirely -> old cookie fails closed to anonymous.
    expect((await after.get(ctx({ nifra_session: cookie }).context)).get("userId")).toBeUndefined()
  })

  test("a tampered or non-JSON-but-validly-signed payload fails closed", async () => {
    const sessions = make()
    // Validly signed (passes HMAC) but not a session payload → parsePayload returns null → anonymous.
    const garbage = await signSession("not-json")
    expect((await sessions.get(ctx({ nifra_session: garbage }).context)).isEmpty).toBe(true)
    // Signed JSON but wrong shape (missing expiresAt) → anonymous.
    const wrongShape = await signSession(JSON.stringify({ data: { userId: "x" } }))
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

describe("session - expiry modes + cookie options", () => {
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

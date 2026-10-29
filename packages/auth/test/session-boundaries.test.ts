import { describe, expect, test } from "bun:test"
import { signValue } from "@nifrajs/core/cookies"
import {
  createSessions,
  MemorySessionStore,
  type SessionContext,
  type SessionRecord,
  type SessionStore,
} from "../src/index.ts"

const SECRET = "test-secret-at-least-32-bytes-ok!"
const NAME = "nifra_session"
const T0 = 5_000_000
const MAX_AGE = 1000
const FAMILY = "family"
const GEN = `${FAMILY}~${"b".repeat(43)}`
const FAR = T0 + 10 * MAX_AGE * 1000

const forge = async (value: string): Promise<string> =>
  (await signValue(`${NAME}\n${value}`, SECRET)).slice(NAME.length + 1)

const jar = (cookies: Record<string, string> = {}, request?: Request) => {
  const written: { value: string; maxAge: number | undefined }[] = []
  const deleted: { name: string; options: object }[] = []
  const c: SessionContext = {
    cookies,
    ...(request === undefined ? {} : { request }),
    set: {
      cookie(_name, value, options) {
        written.push({ value, maxAge: options?.maxAge })
      },
      deleteCookie(name, options) {
        deleted.push({ name, options: options ?? {} })
      },
    },
  }
  return { c, written, deleted }
}

const idOf = (cookie: string): string =>
  cookie.slice(0, cookie.lastIndexOf(".")).split("*")[0] ?? ""

const record = (
  data: Record<string, unknown> = { user: "ada" },
  expiresAt = FAR,
): SessionRecord => ({
  data,
  expiresAt,
})

interface Spy {
  readonly store: SessionStore
  readonly map: Map<string, SessionRecord>
  readonly ops: string[]
}

// A store with neither `replace` nor `rotate`, so the manager takes its generic write paths; `hooks`
// run around the operations to land a logout, a clock tick or a vanished record mid-commit.
const spyStore = (
  hooks: {
    onGet?: (id: string) => "miss" | undefined
    afterSet?: (id: string, map: Map<string, SessionRecord>) => void
    onSet?: (id: string) => void
    rotate?: SessionStore["rotate"]
  } = {},
): Spy => {
  const map = new Map<string, SessionRecord>()
  const ops: string[] = []
  const store: SessionStore = {
    async get(id) {
      ops.push(`get ${id}`)
      return hooks.onGet?.(id) === "miss" ? undefined : map.get(id)
    },
    async set(id, rec) {
      ops.push(`set ${id}`)
      hooks.onSet?.(id)
      map.set(id, rec)
      hooks.afterSet?.(id, map)
    },
    async delete(id) {
      ops.push(`delete ${id}`)
      map.delete(id)
    },
    ...(hooks.rotate === undefined ? {} : { rotate: hooks.rotate }),
  }
  return { store, map, ops }
}

const writes = (spy: Spy): string[] => spy.ops.filter((op) => !op.startsWith("get "))

describe("cookie-mode payloads from a signed but malformed cookie", () => {
  const sessions = createSessions({ secret: SECRET, maxAge: MAX_AGE, now: () => T0 })
  const load = async (json: string) => sessions.get(jar({ [NAME]: await forge(json) }).c)

  test("a null payload is no session", async () => {
    expect((await load("null")).isEmpty).toBe(true)
  })

  test("a non-finite expiry is no session", async () => {
    expect((await load(`{"data":{"user":"ada"},"expiresAt":1e999}`)).isEmpty).toBe(true)
  })

  test("a payload whose data is a string is no session", async () => {
    expect((await load(`{"data":"ada","expiresAt":${FAR}}`)).isEmpty).toBe(true)
  })

  test("a payload whose data is null carries no expiry into the next commit", async () => {
    const fixed = createSessions({ secret: SECRET, maxAge: MAX_AGE, rolling: false, now: () => T0 })
    const session = await fixed.get(
      jar({ [NAME]: await forge(`{"data":null,"expiresAt":${T0 + 5000}}`) }).c,
    )
    const out = jar()
    await fixed.commit(out.c, session)
    expect(out.written[0]?.maxAge).toBe(MAX_AGE)
  })
})

describe("options", () => {
  test("a maxAge of zero is accepted and a negative one is refused", () => {
    expect(() => createSessions({ secret: SECRET, maxAge: 0 })).not.toThrow()
    expect(() => createSessions({ secret: SECRET, maxAge: -1 })).toThrow(RangeError)
  })

  test("sessions roll by default and stay fixed when rolling is false", async () => {
    for (const rolling of [undefined, false] as const) {
      let time = T0
      const sessions = createSessions({
        secret: SECRET,
        maxAge: MAX_AGE,
        now: () => time,
        ...(rolling === undefined ? {} : { rolling }),
      })
      const first = jar()
      const session = await sessions.get(first.c)
      session.set("user", "ada")
      await sessions.commit(first.c, session)
      time += 400_000
      const again = jar()
      const loaded = await sessions.get(jar({ [NAME]: first.written[0]?.value ?? "" }).c)
      await sessions.commit(again.c, loaded)
      expect(again.written[0]?.maxAge).toBe(rolling === false ? 600 : MAX_AGE)
    }
  })

  test("a marker for a logout lasts a full session life", async () => {
    const store = new MemorySessionStore()
    const sessions = createSessions({ secret: SECRET, store, maxAge: MAX_AGE, now: () => T0 })
    const out = jar()
    const session = await sessions.get(out.c)
    session.set("user", "ada")
    await sessions.commit(out.c, session)
    await sessions.destroy(out.c, session)
    const marker = await store.get(`${idOf(out.written[0]?.value ?? "")}.revoked`)
    expect(marker?.expiresAt).toBe(T0 + MAX_AGE * 1000)
  })
})

describe("cookies signed before names were bound", () => {
  const legacy = createSessions({
    secret: SECRET,
    maxAge: MAX_AGE,
    now: () => T0,
    acceptLegacyCookies: true,
  })

  test("a tampered cookie is anonymous, not an error", async () => {
    expect((await legacy.get(jar({ [NAME]: "abc.def" }).c)).isEmpty).toBe(true)
  })

  test("a value signed for another cookie name is refused", async () => {
    const store = new MemorySessionStore()
    await store.set("other\nabc", record())
    const sessions = createSessions({
      secret: SECRET,
      store,
      maxAge: MAX_AGE,
      now: () => T0,
      acceptLegacyCookies: true,
    })
    const cookie = await signValue("other\nabc", SECRET)
    expect((await sessions.get(jar({ [NAME]: cookie }).c)).isEmpty).toBe(true)
  })
})

describe("reading a stored session", () => {
  test("a record that expires at the current instant is no session", async () => {
    const store = new MemorySessionStore()
    await store.set("sid", record({ user: "ada" }, T0))
    const sessions = createSessions({ secret: SECRET, store, maxAge: MAX_AGE, now: () => T0 })
    const session = await sessions.get(jar({ [NAME]: await forge("sid") }).c)
    expect(session.isEmpty).toBe(true)
    expect(await store.get("sid")).toBeUndefined()
  })

  test("a request that names the cookie twice is anonymous", async () => {
    const sessions = createSessions({ secret: SECRET, maxAge: MAX_AGE, now: () => T0 })
    const out = jar()
    const session = await sessions.get(out.c)
    session.set("user", "ada")
    await sessions.commit(out.c, session)
    const value = out.written[0]?.value ?? ""
    const request = new Request("https://example.test/", {
      headers: { cookie: `${NAME}=${value}; ${NAME}=${value}` },
    })
    expect((await sessions.read(request)).isEmpty).toBe(true)
    expect((await sessions.get(jar({ [NAME]: value }, request).c)).isEmpty).toBe(true)
  })
})

describe("a commit racing a logout", () => {
  const manager = (spy: Spy, clock: { time: number } = { time: T0 }) =>
    createSessions({ secret: SECRET, store: spy.store, maxAge: MAX_AGE, now: () => clock.time })

  const load = async (spy: Spy, id: string, clock?: { time: number }) => {
    const sessions = manager(spy, clock)
    spy.map.set(id, record())
    const session = await sessions.get(jar({ [NAME]: await forge(id) }).c)
    spy.ops.length = 0
    return { sessions, session }
  }

  test("a record deleted after the load is not written back", async () => {
    const spy = spyStore()
    const { sessions, session } = await load(spy, "sid")
    spy.map.delete("sid")
    const out = jar()
    await sessions.commit(out.c, session)
    expect(out.written).toEqual([])
    expect(writes(spy)).toEqual([])
  })

  test.each([
    ["sid.revoked", "sid"],
    ["sid.rotated", "sid"],
    [`${FAMILY}.revoked`, GEN],
  ])("a marker %s stops the commit before any write", async (marker, id) => {
    const spy = spyStore()
    const { sessions, session } = await load(spy, id)
    spy.map.set(marker, record({}))
    const out = jar()
    await sessions.commit(out.c, session)
    expect(out.written).toEqual([])
    expect(writes(spy)).toEqual([])
  })

  test("a marker that lands during the write removes the record and sets no cookie", async () => {
    const spy = spyStore({
      afterSet: (id, map) => {
        if (id === "sid") map.set("sid.revoked", record({}))
      },
    })
    const { sessions, session } = await load(spy, "sid")
    const out = jar()
    await sessions.commit(out.c, session)
    expect(out.written).toEqual([])
    expect(spy.map.has("sid")).toBe(false)
  })

  test("a clock that reaches the expiry during the reads stops the commit", async () => {
    const clock = { time: T0 }
    let armed = false
    const spy = spyStore({
      onGet: () => {
        if (armed) clock.time = FAR
        return undefined
      },
    })
    const { sessions, session } = await load(spy, "sid", clock)
    armed = true
    const out = jar()
    await sessions.commit(out.c, session)
    expect(out.written).toEqual([])
    expect(writes(spy)).toEqual([])
  })

  test("a clock that reaches the expiry during the write deletes the record", async () => {
    const clock = { time: T0 }
    let armed = false
    const spy = spyStore({
      onSet: () => {
        if (armed) clock.time = FAR
      },
    })
    const { sessions, session } = await load(spy, "sid", clock)
    armed = true
    const out = jar()
    await sessions.commit(out.c, session)
    expect(out.written).toEqual([])
    expect(spy.map.has("sid")).toBe(false)
  })
})

describe("regeneration", () => {
  test("a store that refuses the rotation sets no cookie", async () => {
    const spy = spyStore({ rotate: async () => false })
    const sessions = createSessions({
      secret: SECRET,
      store: spy.store,
      maxAge: MAX_AGE,
      now: () => T0,
    })
    spy.map.set("sid", record())
    const session = await sessions.get(jar({ [NAME]: await forge("sid") }).c)
    sessions.regenerate(session)
    const out = jar()
    await sessions.commit(out.c, session)
    expect(out.written).toEqual([])
    expect(writes(spy)).toEqual([])
  })

  test("the old generation is marked rotated for a full session life, stamped now", async () => {
    const spy = spyStore()
    const sessions = createSessions({
      secret: SECRET,
      store: spy.store,
      maxAge: MAX_AGE,
      now: () => T0,
    })
    spy.map.set("sid", record())
    const session = await sessions.get(jar({ [NAME]: await forge("sid") }).c)
    sessions.regenerate(session)
    await sessions.commit(jar().c, session)
    expect(spy.map.get("sid.rotated")).toEqual({
      data: { rotatedAt: T0 },
      expiresAt: T0 + MAX_AGE * 1000,
    })
  })

  test("a second commit of the same session does not rotate again", async () => {
    const spy = spyStore()
    const sessions = createSessions({
      secret: SECRET,
      store: spy.store,
      maxAge: MAX_AGE,
      now: () => T0,
    })
    spy.map.set("sid", record())
    const session = await sessions.get(jar({ [NAME]: await forge("sid") }).c)
    sessions.regenerate(session)
    const first = jar()
    await sessions.commit(first.c, session)
    const second = jar()
    await sessions.commit(second.c, session)
    expect(idOf(second.written[0]?.value ?? "")).toBe(idOf(first.written[0]?.value ?? ""))
  })

  test("a clock that reaches the expiry during the rotation revokes the new generation", async () => {
    const clock = { time: T0 }
    const spy = spyStore({
      rotate: async (previousId, nextId, rec, marker) => {
        clock.time = FAR
        spy.map.set(`${previousId}.rotated`, marker)
        spy.map.delete(previousId)
        spy.map.set(nextId, rec)
        return true
      },
    })
    const sessions = createSessions({
      secret: SECRET,
      store: spy.store,
      maxAge: MAX_AGE,
      now: () => clock.time,
    })
    spy.map.set("sid", record())
    const session = await sessions.get(jar({ [NAME]: await forge("sid") }).c)
    sessions.regenerate(session)
    const out = jar()
    await sessions.commit(out.c, session)
    expect(out.written).toEqual([])
    expect(spy.map.has("sid.revoked")).toBe(true)
  })

  test("a new generation that vanishes before the cookie is signed is removed", async () => {
    const spy = spyStore({ onGet: (id) => (id.includes("~") ? "miss" : undefined) })
    const sessions = createSessions({
      secret: SECRET,
      store: spy.store,
      maxAge: MAX_AGE,
      now: () => T0,
    })
    spy.map.set("sid", record())
    const session = await sessions.get(jar({ [NAME]: await forge("sid") }).c)
    sessions.regenerate(session)
    const out = jar()
    await sessions.commit(out.c, session)
    expect(out.written).toEqual([])
    expect(spy.ops.some((op) => op.startsWith("delete sid~"))).toBe(true)
  })
})

describe("a fixed expiry", () => {
  test("the same session object keeps the expiry its first commit set", async () => {
    let time = T0
    const store = new MemorySessionStore()
    const sessions = createSessions({
      secret: SECRET,
      store,
      maxAge: MAX_AGE,
      rolling: false,
      now: () => time,
    })
    const session = await sessions.get(jar().c)
    session.set("user", "ada")
    await sessions.commit(jar().c, session)
    time += 400_000
    const again = jar()
    await sessions.commit(again.c, session)
    expect(again.written[0]?.maxAge).toBe(600)
  })

  test("a session ended and filled again starts a new life", async () => {
    let time = T0
    const sessions = createSessions({
      secret: SECRET,
      maxAge: MAX_AGE,
      rolling: false,
      now: () => time,
    })
    const first = jar()
    const session = await sessions.get(first.c)
    session.set("user", "ada")
    await sessions.commit(first.c, session)
    const loaded = await sessions.get(jar({ [NAME]: first.written[0]?.value ?? "" }).c)
    time += 400_000
    await sessions.destroy(jar().c, loaded)
    loaded.set("user", "bob")
    const out = jar()
    await sessions.commit(out.c, loaded)
    expect(out.written[0]?.maxAge).toBe(MAX_AGE)
  })
})

describe("a fixed expiry in cookie mode", () => {
  test("the same session object keeps the expiry its first commit set", async () => {
    let time = T0
    const sessions = createSessions({
      secret: SECRET,
      maxAge: MAX_AGE,
      rolling: false,
      now: () => time,
    })
    const session = await sessions.get(jar().c)
    session.set("user", "ada")
    await sessions.commit(jar().c, session)
    time += 400_000
    const again = jar()
    await sessions.commit(again.c, session)
    expect(again.written[0]?.maxAge).toBe(600)
  })
})

describe("destroy", () => {
  test("ending a session drops a pending regeneration", async () => {
    const sessions = createSessions<{ user: string }>({
      secret: SECRET,
      maxAge: MAX_AGE,
      now: () => T0,
      identity: ["user"],
    })
    const first = jar()
    const session = await sessions.get(first.c)
    session.set("user", "ada")
    await sessions.commit(first.c, session)
    const loaded = await sessions.get(jar({ [NAME]: first.written[0]?.value ?? "" }).c)
    sessions.regenerate(loaded)
    await sessions.destroy(jar().c, loaded)
    loaded.set("user", "ada")
    const again = jar()
    await sessions.commit(again.c, loaded)
    // Same data, expiry and tag give the same signed payload; a fresh tag would change it.
    expect(again.written[0]?.value).toBe(first.written[0]?.value)
  })

  test("ending a session that was never saved writes nothing to the store", async () => {
    const spy = spyStore()
    const sessions = createSessions({
      secret: SECRET,
      store: spy.store,
      maxAge: MAX_AGE,
      now: () => T0,
    })
    const session = await sessions.get(jar().c)
    await sessions.destroy(jar().c, session)
    expect(spy.ops).toEqual([])
  })

  test("a cookie-mode manager ends a request without a session object", async () => {
    const sessions = createSessions({ secret: SECRET, maxAge: MAX_AGE, now: () => T0 })
    const out = jar({ [NAME]: await forge(`{"data":{},"expiresAt":${FAR}}`) })
    await sessions.destroy(out.c)
    expect(out.deleted).toHaveLength(1)
  })

  test("the deleted cookie names the configured domain and only when one is set", async () => {
    const withDomain = createSessions({
      secret: SECRET,
      maxAge: MAX_AGE,
      cookie: { domain: "example.test", path: "/app" },
    })
    const a = jar()
    await withDomain.destroy(a.c)
    expect(a.deleted[0]?.options).toEqual({ path: "/app", domain: "example.test" })
    const without = createSessions({ secret: SECRET, maxAge: MAX_AGE })
    const b = jar()
    await without.destroy(b.c)
    expect(b.deleted[0]?.options).toStrictEqual({ path: "/" })
  })

  test("a rotated-away id outside the grace window loses its record but not its family", async () => {
    let time = T0
    const spy = spyStore()
    const sessions = createSessions({
      secret: SECRET,
      store: spy.store,
      maxAge: MAX_AGE,
      now: () => time,
    })
    spy.map.set("sid", record())
    spy.map.set("sid.rotated", { data: { rotatedAt: T0 }, expiresAt: FAR })
    time = T0 + 120_000
    await sessions.destroy(jar({ [NAME]: await forge("sid") }).c)
    expect(spy.ops).toContain("delete sid")
    expect(spy.map.has("sid.revoked")).toBe(false)
  })

  test("a rotation stamp wins over the time its marker would imply", async () => {
    const spy = spyStore()
    const sessions = createSessions({
      secret: SECRET,
      store: spy.store,
      maxAge: MAX_AGE,
      now: () => T0,
    })
    spy.map.set("sid.rotated", {
      data: { rotatedAt: T0 - 1000 },
      expiresAt: T0 + 50 * MAX_AGE * 1000,
    })
    await sessions.destroy(jar({ [NAME]: await forge("sid") }).c)
    expect(spy.map.has("sid.revoked")).toBe(true)
  })
})

import { expect, test } from "bun:test"
import {
  createSessions,
  type KVNamespaceLike,
  KVSessionStore,
  type SessionContext,
  type SessionStore,
} from "../src/index.ts"

const SECRET = "test-secret-at-least-32-bytes-ok!"

class ExpiringKV implements KVNamespaceLike {
  private readonly entries = new Map<string, { value: string; expiration?: number }>()
  beforeGet: (() => Promise<void>) | undefined
  beforePut: ((key: string) => Promise<void>) | undefined
  afterPut: ((key: string) => Promise<void>) | undefined

  constructor(private readonly now: () => number) {}

  async get(key: string): Promise<string | null> {
    await this.beforeGet?.()
    const entry = this.entries.get(key)
    if (entry?.expiration !== undefined && entry.expiration <= Math.floor(this.now() / 1000)) {
      this.entries.delete(key)
      return null
    }
    return entry?.value ?? null
  }

  async put(key: string, value: string, options?: { readonly expiration?: number }): Promise<void> {
    await this.beforePut?.(key)
    this.entries.set(key, { value, ...options })
    await this.afterPut?.(key)
  }

  delete(key: string): Promise<void> {
    this.entries.delete(key)
    return Promise.resolve()
  }
}

function context(cookie?: string) {
  const writes: string[] = []
  const c: SessionContext = {
    cookies: cookie === undefined ? {} : { nifra_session: cookie },
    set: {
      cookie: (_name, value) => writes.push(value),
      deleteCookie() {},
    },
  }
  return { c, writes }
}

function setup(rolling = true) {
  let time = 1_000
  const now = () => time
  const kv = new ExpiringKV(now)
  const serialized = new KVSessionStore(kv, { now })
  // This in-process fixture has coherent reads; real Workers KV does not and is refused by sessions.
  const store: SessionStore = {
    consistency: "strong",
    get: serialized.get.bind(serialized),
    set: serialized.set.bind(serialized),
    delete: serialized.delete.bind(serialized),
  }
  const sessions = createSessions({ secret: SECRET, maxAge: 120, rolling, store, now })
  return {
    kv,
    store,
    sessions,
    advanceTo: (value: number) => {
      time = value
    },
  }
}

async function login(sessions: ReturnType<typeof createSessions>) {
  const source = context()
  const session = await sessions.get(source.c)
  session.set("userId", "test-user")
  await sessions.commit(source.c, session)
  const cookie = source.writes[0]
  if (cookie === undefined) throw new Error("login did not issue a session cookie")
  return cookie
}

for (const rotate of [false, true]) {
  test(`an expired KV marker cannot revive a held session (rotate=${rotate})`, async () => {
    const { sessions, advanceTo } = setup()
    const cookie = await login(sessions)
    const held = context(cookie)
    const stale = await sessions.get(held.c)
    await sessions.destroy(context(cookie).c)
    expect((await sessions.get(context(cookie).c)).isEmpty).toBe(true)

    advanceTo(122_000)
    if (rotate) sessions.regenerate(stale)
    await sessions.commit(held.c, stale)

    expect(held.writes).toEqual([])
    expect((await sessions.get(context(cookie).c)).isEmpty).toBe(true)
  })
}

test("a refused rolling commit cannot extend the fence for a later retry", async () => {
  const { sessions, advanceTo } = setup()
  const cookie = await login(sessions)
  const held = context(cookie)
  const stale = await sessions.get(held.c)
  advanceTo(2_000)
  await sessions.destroy(context(cookie).c)
  advanceTo(3_000)
  await sessions.commit(held.c, stale)
  expect(held.writes).toEqual([])

  advanceTo(122_500)
  await sessions.commit(held.c, stale)
  expect(held.writes).toEqual([])
  expect((await sessions.get(context(cookie).c)).isEmpty).toBe(true)
})

test("expiry during a commit's store read cannot revive a held session", async () => {
  const { sessions, kv, advanceTo } = setup()
  const cookie = await login(sessions)
  const held = context(cookie)
  const stale = await sessions.get(held.c)
  advanceTo(2_000)
  await sessions.destroy(context(cookie).c)
  advanceTo(3_000)
  const reached = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  kv.beforeGet = async () => {
    reached.resolve()
    await resume.promise
  }
  const commit = sessions.commit(held.c, stale)
  try {
    await reached.promise
    advanceTo(122_500)
  } finally {
    kv.beforeGet = undefined
    resume.resolve()
    await commit
  }

  expect(held.writes).toEqual([])
  expect((await sessions.get(context(cookie).c)).isEmpty).toBe(true)
})

test("a logout that lands after a renewal's write leaves no session and no cookie", async () => {
  const { sessions, kv } = setup()
  const cookie = await login(sessions)
  const held = context(cookie)
  const live = await sessions.get(held.c)
  let landed = false
  // The logout lands right after the renewal's own write of the session record.
  kv.afterPut = async (key) => {
    if (key.endsWith(".revoked")) return
    kv.afterPut = undefined
    await sessions.destroy(context(cookie).c)
    landed = true
  }
  await sessions.commit(held.c, live)

  expect(landed).toBe(true)
  expect(held.writes).toEqual([])
  expect((await sessions.get(context(cookie).c)).isEmpty).toBe(true)
})

test("a renewal whose write outlives its record cannot undo a logout", async () => {
  const { sessions, kv, advanceTo } = setup()
  const cookie = await login(sessions)
  const held = context(cookie)
  const live = await sessions.get(held.c)
  advanceTo(120_000)
  const reached = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  kv.beforePut = async () => {
    kv.beforePut = undefined
    reached.resolve()
    await resume.promise
  }
  const commit = sessions.commit(held.c, live)
  try {
    await reached.promise
    // The record expires while the renewal's write is in flight, so the logout finds nothing to mark.
    advanceTo(122_000)
    await sessions.destroy(context(cookie).c)
  } finally {
    resume.resolve()
    await commit
  }

  expect(held.writes).toEqual([])
  expect((await sessions.get(context(cookie).c)).isEmpty).toBe(true)
})

test("rotation cannot bypass a live revocation marker", async () => {
  const { sessions } = setup()
  const cookie = await login(sessions)
  const held = context(cookie)
  const stale = await sessions.get(held.c)
  await sessions.destroy(context(cookie).c)
  sessions.regenerate(stale)
  await sessions.commit(held.c, stale)
  expect(held.writes).toEqual([])
})

for (const rolling of [false, true]) {
  test(`a held session cannot commit at its expiry (rolling=${rolling})`, async () => {
    const { sessions, advanceTo } = setup(rolling)
    const cookie = await login(sessions)
    const held = context(cookie)
    const stale = await sessions.get(held.c)
    advanceTo(121_000)
    await sessions.commit(held.c, stale)
    expect(held.writes).toEqual([])
    expect((await sessions.get(context(cookie).c)).isEmpty).toBe(true)
  })
}

for (const rolling of [false, true]) {
  test(`a cookie-mode session cannot renew at its expiry (rolling=${rolling})`, async () => {
    let time = 1_000
    const sessions = createSessions({ secret: SECRET, maxAge: 120, rolling, now: () => time })
    const cookie = await login(sessions)
    const held = context(cookie)
    const stale = await sessions.get(held.c)
    time = 121_000
    await sessions.commit(held.c, stale)
    expect(held.writes).toEqual([])
    expect((await sessions.get(context(cookie).c)).isEmpty).toBe(true)
  })
}

test("successful rolling commits update the expiry for subsequent renewals", async () => {
  const { sessions, advanceTo } = setup()
  const cookie = await login(sessions)
  const held = context(cookie)
  const live = await sessions.get(held.c)
  advanceTo(100_000)
  await sessions.commit(held.c, live)
  advanceTo(150_000)
  await sessions.commit(held.c, live)
  expect(held.writes).toHaveLength(2)
  expect((await sessions.get(context(held.writes[1]).c)).get("userId")).toBe("test-user")
})

import { expect, test } from "bun:test"
import {
  createSessions,
  KVSessionStore,
  MemorySessionStore,
  type SessionContext,
  type SessionStore,
} from "../src/index.ts"

const SECRET = "test-secret-at-least-32-bytes-ok!"

for (const rolling of [true, false]) {
  test(`Workers KV is refused before any session I/O (rolling=${rolling})`, () => {
    let calls = 0
    const store = new KVSessionStore({
      async get() {
        calls++
        return null
      },
      async put() {
        calls++
      },
      async delete() {
        calls++
      },
    })
    expect(() => createSessions({ secret: SECRET, store, rolling })).toThrow(
      /strongly consistent.*logout/,
    )
    expect(calls).toBe(0)
  })
}

test("an explicitly eventual custom store is refused", () => {
  const store = new MemorySessionStore()
  const configured = {
    consistency: "eventual" as const,
    get: store.get.bind(store),
    set: store.set.bind(store),
    delete: store.delete.bind(store),
  }
  expect(() => createSessions({ secret: SECRET, store: configured })).toThrow(
    /strongly consistent.*logout/,
  )
})

test("an invalid runtime consistency declaration fails closed", () => {
  const store = new MemorySessionStore()
  Reflect.set(store, "consistency", "cached")
  expect(() => createSessions({ secret: SECRET, store })).toThrow(/strongly consistent.*logout/)
})

for (const declared of [true, false]) {
  test(`a coherent custom store preserves logout (consistency declared=${declared})`, async () => {
    const memory = new MemorySessionStore()
    const methods = {
      get: memory.get.bind(memory),
      set: memory.set.bind(memory),
      delete: memory.delete.bind(memory),
    }
    const store: SessionStore = declared ? { ...methods, consistency: "strong" } : methods
    const sessions = createSessions<{ userId: string }>({ secret: SECRET, store })
    let cookie = ""
    const context: SessionContext = {
      cookies: {},
      set: {
        cookie(_name, value) {
          cookie = value
        },
        deleteCookie() {},
      },
    }
    const session = await sessions.get(context)
    session.set("userId", "test-user")
    await sessions.commit(context, session)
    const request = new Request("https://example.test/", {
      headers: { cookie: `nifra_session=${cookie}` },
    })
    expect((await sessions.read(request)).get("userId")).toBe("test-user")
    await sessions.destroy({ ...context, cookies: { nifra_session: cookie } })
    expect((await sessions.read(request)).get("userId")).toBeUndefined()
  })
}

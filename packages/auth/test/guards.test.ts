import { describe, expect, test } from "bun:test"
import {
  createSessions,
  requireSession,
  requireUser,
  type Session,
  type SessionContext,
} from "../src/index.ts"

const SECRET = "test-secret-at-least-32-bytes-ok!"
const emptyCtx = (): SessionContext => ({
  cookies: {},
  set: { cookie: () => {}, deleteCookie: () => {} },
})
const sessions = createSessions<{ userId: string }>({ secret: SECRET })
const freshSession = (): Promise<Session<{ userId: string }>> => sessions.get(emptyCtx())

/** Run `fn`, return what it threw (fails the test if it didn't). Guards are synchronous. */
const caught = (fn: () => unknown): unknown => {
  try {
    fn()
  } catch (e) {
    return e
  }
  throw new Error("expected the guard to throw")
}

describe("requireSession", () => {
  test("returns a non-empty session", async () => {
    const s = await freshSession()
    s.set("userId", "u1")
    expect(requireSession(s)).toBe(s)
  })

  test("throws a 401 Response when empty (no redirectTo)", async () => {
    const empty = await freshSession()
    const thrown = caught(() => requireSession(empty))
    expect(thrown).toBeInstanceOf(Response)
    expect((thrown as Response).status).toBe(401)
  })

  test("throws a 302 to redirectTo when empty", async () => {
    const empty = await freshSession()
    const res = caught(() => requireSession(empty, { redirectTo: "/login" })) as Response
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("/login")
  })

  test("rejects an open-redirect redirectTo as a config error", async () => {
    const empty = await freshSession()
    expect(() => requireSession(empty, { redirectTo: "//evil.com" })).toThrow(/same-origin path/)
    expect(() => requireSession(empty, { redirectTo: "https://evil.com" })).toThrow(
      /same-origin path/,
    )
  })
})

describe("requireUser", () => {
  test("returns the value when the key is present", async () => {
    const s = await freshSession()
    s.set("userId", "u7")
    expect(requireUser(s, "userId")).toBe("u7")
  })

  test("throws a 302 when absent + redirectTo", async () => {
    const empty = await freshSession()
    const res = caught(() => requireUser(empty, "userId", { redirectTo: "/login" })) as Response
    expect(res.status).toBe(302)
  })

  test("throws a 401 when absent + no redirectTo", async () => {
    const empty = await freshSession()
    expect((caught(() => requireUser(empty, "userId")) as Response).status).toBe(401)
  })
})

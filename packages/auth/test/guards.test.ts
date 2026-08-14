import { describe, expect, test } from "bun:test"
import { isResponseResult, type ResponseResult } from "../../core/src/server/runtime-core.ts"
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

/** A guard's rejection is plain data, not a `Response` - that is what keeps a thrown guard on the
 * same rendering lane as a returned `status(...)`. The `plain` render is the assertion that matters;
 * `toResponse()` is checked alongside it so the off-lane fallback stays byte-identical. */
const rejectionOf = (thrown: unknown): ResponseResult => {
  expect(thrown).not.toBeInstanceOf(Response)
  if (!isResponseResult(thrown)) throw new Error("expected a status(...) render")
  return thrown
}

describe("requireSession", () => {
  test("returns a non-empty session", async () => {
    const s = await freshSession()
    s.set("userId", "u1")
    expect(requireSession(s)).toBe(s)
  })

  test("throws a plain 401 render when empty (no redirectTo)", async () => {
    const empty = await freshSession()
    const rejection = rejectionOf(caught(() => requireSession(empty)))
    expect(rejection.plain).toEqual({ status: 401, body: { ok: false, error: "unauthorized" } })
    const res = rejection.toResponse()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, error: "unauthorized" })
  })

  test("throws a plain 302 render to redirectTo when empty", async () => {
    const empty = await freshSession()
    const rejection = rejectionOf(caught(() => requireSession(empty, { redirectTo: "/login" })))
    expect(rejection.plain).toEqual({
      status: 302,
      headers: { location: "/login" },
      body: undefined,
    })
    expect(rejection.toResponse().headers.get("location")).toBe("/login")
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

  test("throws a 302 render when absent + redirectTo", async () => {
    const empty = await freshSession()
    const rejection = rejectionOf(caught(() => requireUser(empty, "userId", { redirectTo: "/l" })))
    expect(rejection.plain?.status).toBe(302)
    expect(rejection.plain?.headers?.location).toBe("/l")
  })

  test("throws a 401 render when absent + no redirectTo", async () => {
    const empty = await freshSession()
    expect(rejectionOf(caught(() => requireUser(empty, "userId"))).plain?.status).toBe(401)
  })
})

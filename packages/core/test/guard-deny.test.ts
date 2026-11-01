import { describe, expect, test } from "bun:test"
import { assertUnauthenticated, unauthenticatedResult } from "../src/guard-deny.ts"
import { isResponseResult } from "../src/server/runtime-core.ts"

describe("assertUnauthenticated", () => {
  test("accepts the default and a well-formed custom denial", () => {
    expect(() => assertUnauthenticated({}, "auth")).not.toThrow()
    expect(() =>
      assertUnauthenticated({ unauthenticated: { status: 418, body: { ok: false } } }, "authjs"),
    ).not.toThrow()
  })

  test("refuses redirectTo beside unauthenticated, naming the package", () => {
    expect(() =>
      assertUnauthenticated({ redirectTo: "/login", unauthenticated: {} }, "better-auth"),
    ).toThrow("[nifra/better-auth] a guard takes redirectTo or unauthenticated, not both")
  })

  test("refuses a status outside 400-599, and a fractional one, naming the package", () => {
    for (const owner of ["auth", "authjs", "better-auth"]) {
      expect(() => assertUnauthenticated({ unauthenticated: { status: 399 } }, owner)).toThrow(
        `[nifra/${owner}] guard unauthenticated.status must be an integer 400-599 (got 399)`,
      )
      expect(() => assertUnauthenticated({ unauthenticated: { status: 404.5 } }, owner)).toThrow(
        RangeError,
      )
    }
  })
})

describe("unauthenticatedResult", () => {
  test("the default is a 401 JSON", () => {
    const res = unauthenticatedResult(undefined)
    expect(isResponseResult(res)).toBe(true)
    expect(res.plain?.status).toBe(401)
    expect(res.plain?.body).toEqual({ ok: false, error: "unauthorized" })
  })

  test("a custom denial carries its status, body and headers", () => {
    const res = unauthenticatedResult({
      status: 403,
      body: { ok: false, error: "forbidden" },
      headers: { "www-authenticate": 'Basic realm="x"' },
    })
    expect(isResponseResult(res)).toBe(true)
    expect(res.plain?.status).toBe(403)
    expect(res.plain?.body).toEqual({ ok: false, error: "forbidden" })
    expect(res.plain?.headers?.["www-authenticate"]).toBe('Basic realm="x"')
  })

  test("an explicit undefined body sends none, and an omitted status stays 401", () => {
    const noBody = unauthenticatedResult({ body: undefined })
    expect(noBody.plain?.status).toBe(401)
    expect(noBody.plain?.body).toBeUndefined()

    const withHeaders = unauthenticatedResult({ headers: { "x-a": "1" } })
    expect(withHeaders.plain?.status).toBe(401)
    expect(withHeaders.plain?.headers?.["x-a"]).toBe("1")
  })

  test("every shape answers as a Response with the declared status", () => {
    expect(unauthenticatedResult(undefined).toResponse().status).toBe(401)
    expect(unauthenticatedResult({ status: 403, body: undefined }).toResponse().status).toBe(403)
  })
})

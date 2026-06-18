import { describe, expect, test } from "bun:test"
import { defineContract, implement, RouteConfigError, type StandardSchemaV1 } from "@nifrajs/core"

const passThrough: StandardSchemaV1 = {
  "~standard": { version: 1, vendor: "test", validate: (value) => ({ value }) },
}

describe("defineContract — validation (L2)", () => {
  test("returns the contract on valid input", () => {
    const c = defineContract({
      list: { method: "GET", path: "/users" },
      create: { method: "POST", path: "/users" },
    })
    expect(c.list.method).toBe("GET")
    expect(c.create.path).toBe("/users")
  })

  test("allows the same path with different methods", () => {
    expect(() =>
      defineContract({
        a: { method: "GET", path: "/x" },
        b: { method: "POST", path: "/x" },
      }),
    ).not.toThrow()
  })

  test("rejects an unsupported method", () => {
    // cast bypasses the compile-time guard to exercise the runtime check
    expect(() => defineContract({ x: { method: "BREW" as "GET", path: "/x" } })).toThrow(
      RouteConfigError,
    )
  })

  test("rejects a path without a leading slash", () => {
    try {
      defineContract({ x: { method: "GET", path: "no-slash" } })
      throw new Error("expected throw")
    } catch (err) {
      expect(err).toBeInstanceOf(RouteConfigError)
      expect((err as RouteConfigError).code).toBe("INVALID_PATH")
    }
  })

  test("rejects an empty path", () => {
    expect(() => defineContract({ x: { method: "GET", path: "" } })).toThrow(RouteConfigError)
  })

  test("rejects a duplicate (method, path) across operations", () => {
    try {
      defineContract({
        a: { method: "GET", path: "/dup" },
        b: { method: "GET", path: "/dup" },
      })
      throw new Error("expected throw")
    } catch (err) {
      expect((err as RouteConfigError).code).toBe("DUPLICATE_ROUTE")
    }
  })
})

describe("implement() — response contract on the descriptor", () => {
  test("carries a contract op's `response` onto the route schema (for OpenAPI / introspection)", () => {
    const contract = defineContract({
      getMe: { method: "GET", path: "/me", response: passThrough },
    })
    const app = implement(contract, { getMe: () => ({ id: "1" }) })
    // Same descriptor path as inline routes — toOpenAPI + `nifra context` read it from app.routes().
    expect(app.routes()[0]?.schema?.response).toBe(passThrough)
  })

  test("a response-less op still produces an undefined schema (byte-identical to before)", () => {
    const app = implement(defineContract({ ping: { method: "GET", path: "/ping" } }), {
      ping: () => ({ ok: true }),
    })
    // No body/query/response ⇒ no schema object at all ⇒ the sync fast path is preserved untouched.
    expect(app.routes()[0]?.schema).toBeUndefined()
  })
})

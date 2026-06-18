import { describe, expect, test } from "bun:test"
import { RouteConfigError } from "../src/errors.ts"
import { Router } from "../src/router/router.ts"

function router() {
  return new Router<string>()
}

describe("Router.find — matching", () => {
  test("matches a static route with empty params", () => {
    const r = router()
    r.add("GET", "/health", "health")
    expect(r.find("GET", "/health")).toEqual({ found: true, payload: "health", params: {} })
  })

  test("matches the root path", () => {
    const r = router()
    r.add("GET", "/", "root")
    expect(r.find("GET", "/")).toEqual({ found: true, payload: "root", params: {} })
  })

  test("extracts a single param", () => {
    const r = router()
    r.add("GET", "/users/:id", "user")
    const m = r.find("GET", "/users/42")
    expect(m).toEqual({ found: true, payload: "user", params: { id: "42" } })
  })

  test("extracts multiple params in declaration order", () => {
    const r = router()
    r.add("GET", "/org/:org/repo/:repo", "repo")
    const m = r.find("GET", "/org/anthropic/repo/nifra")
    expect(m).toEqual({ found: true, payload: "repo", params: { org: "anthropic", repo: "nifra" } })
  })

  test("dynamic params do not bleed across repeated finds", () => {
    const r = router()
    r.add("GET", "/users/:id", "user")
    r.add("GET", "/org/:org/repo/:repo", "repo")

    const first = r.find("GET", "/org/nifra/repo/core")
    expect(first).toEqual({ found: true, payload: "repo", params: { org: "nifra", repo: "core" } })

    const second = r.find("GET", "/users/42")
    expect(second).toEqual({ found: true, payload: "user", params: { id: "42" } })

    if (first.found && second.found) {
      expect(first.params).toEqual({ org: "nifra", repo: "core" })
      expect(second.params).toEqual({ id: "42" })
      expect(first.params).not.toBe(second.params)
    }
  })

  test("dynamic cache hits still return fresh params objects", () => {
    const r = router()
    r.add("GET", "/users/:id", "user")

    const first = r.find("GET", "/users/42")
    const second = r.find("GET", "/users/42")
    expect(first).toEqual({ found: true, payload: "user", params: { id: "42" } })
    expect(second).toEqual(first)
    if (first.found && second.found) {
      expect(second.params).not.toBe(first.params)
    }
  })

  test("named wildcard captures the rest of the path", () => {
    const r = router()
    r.add("GET", "/files/*path", "files")
    const m = r.find("GET", "/files/a/b/c.txt")
    expect(m).toEqual({ found: true, payload: "files", params: { path: "a/b/c.txt" } })
  })

  test("unnamed wildcard captures under the '*' key", () => {
    const r = router()
    r.add("GET", "/assets/*", "assets")
    expect(r.find("GET", "/assets/img/logo.png")).toEqual({
      found: true,
      payload: "assets",
      params: { "*": "img/logo.png" },
    })
  })

  test("does not percent-decode param values (server boundary decodes)", () => {
    const r = router()
    r.add("GET", "/q/:term", "q")
    expect(r.find("GET", "/q/a%20b")).toEqual({
      found: true,
      payload: "q",
      params: { term: "a%20b" },
    })
  })
})

describe("Router.find — precedence and backtracking", () => {
  test("static beats param at the same position", () => {
    const r = router()
    r.add("GET", "/users/:id", "param")
    r.add("GET", "/users/me", "static")
    expect(r.find("GET", "/users/me")).toMatchObject({ payload: "static" })
    expect(r.find("GET", "/users/123")).toMatchObject({ payload: "param", params: { id: "123" } })
  })

  test("param beats wildcard at the same position", () => {
    const r = router()
    r.add("GET", "/a/*rest", "wild")
    r.add("GET", "/a/:x", "param")
    expect(r.find("GET", "/a/one")).toMatchObject({ payload: "param", params: { x: "one" } })
    expect(r.find("GET", "/a/one/two")).toMatchObject({
      payload: "wild",
      params: { rest: "one/two" },
    })
  })

  test("backtracks when a static branch dead-ends", () => {
    const r = router()
    r.add("GET", "/a/b/c", "static-c")
    r.add("GET", "/a/:x/d", "param-d")
    // /a/b/d: static 'b' is taken first, dead-ends at depth 3, then the param
    // branch must still match.
    expect(r.find("GET", "/a/b/d")).toEqual({ found: true, payload: "param-d", params: { x: "b" } })
    expect(r.find("GET", "/a/b/c")).toMatchObject({ payload: "static-c" })
  })

  test("backtracks to a wildcard when param subtree dead-ends", () => {
    const r = router()
    r.add("GET", "/a/:x/b", "param-b")
    r.add("GET", "/a/*rest", "wild")
    expect(r.find("GET", "/a/one/c")).toMatchObject({ payload: "wild", params: { rest: "one/c" } })
  })
})

describe("Router.find — 404 vs 405", () => {
  test("returns not-found for an unknown path", () => {
    const r = router()
    r.add("GET", "/known", "x")
    expect(r.find("GET", "/unknown")).toEqual({ found: false, reason: "not-found" })
  })

  test("returns method-not-allowed with the allowed list for a known path", () => {
    const r = router()
    r.add("GET", "/res", "get")
    r.add("PUT", "/res", "put")
    const m = r.find("POST", "/res")
    expect(m.found).toBe(false)
    if (m.found === false && m.reason === "method-not-allowed") {
      expect(m.allowed.sort()).toEqual(["GET", "PUT"])
    } else {
      throw new Error("expected method-not-allowed")
    }
  })

  test("a wildcard that captures zero remaining segments does not match", () => {
    const r = router()
    r.add("GET", "/files/*path", "files")
    // '/files' has no segment for the wildcard to consume -> not-found.
    expect(r.find("GET", "/files")).toEqual({ found: false, reason: "not-found" })
  })

  test("a param node that is not terminal at this depth does not match", () => {
    const r = router()
    r.add("GET", "/a/:x/b", "deep")
    // '/a/one' reaches the :x node, which has no handlers of its own -> not-found.
    expect(r.find("GET", "/a/one")).toEqual({ found: false, reason: "not-found" })
  })
})

describe("Router.find — tolerance", () => {
  test("matches regardless of method casing", () => {
    const r = router()
    r.add("GET", "/x", "x")
    const upper = r.find("GET", "/x")
    const lower = r.find("get", "/x")
    expect(lower).toMatchObject({ payload: "x" })
    expect(lower).toBe(upper)
  })

  test("static route cache does not retain arbitrary method misses", () => {
    const r = router()
    r.add("GET", "/x", "x")
    const first = r.find("X-RANDOM-1", "/x")
    const second = r.find("X-RANDOM-1", "/x")
    expect(first).toEqual({ found: false, reason: "method-not-allowed", allowed: ["GET"] })
    expect(second).toEqual(first)
    expect(second).not.toBe(first)
  })

  test("tolerates a missing leading slash at match time", () => {
    const r = router()
    r.add("GET", "/x", "x")
    expect(r.find("GET", "x")).toMatchObject({ payload: "x" })
  })

  test("treats trailing slash as distinct (strict)", () => {
    const r = router()
    r.add("GET", "/users", "no-slash")
    expect(r.find("GET", "/users/")).toEqual({ found: false, reason: "not-found" })
  })

  test("supports several methods on the same path", () => {
    const r = router()
    r.add("GET", "/r", "get")
    r.add("DELETE", "/r", "del")
    expect(r.find("GET", "/r")).toMatchObject({ payload: "get" })
    expect(r.find("DELETE", "/r")).toMatchObject({ payload: "del" })
  })

  test("adding a route invalidates dynamic cache precedence", () => {
    const r = router()
    r.add("GET", "/users/:id", "param")
    expect(r.find("GET", "/users/me")).toMatchObject({ payload: "param", params: { id: "me" } })

    r.add("GET", "/users/me", "static")
    expect(r.find("GET", "/users/me")).toMatchObject({ payload: "static", params: {} })
  })
})

describe("Router.add — boot-time rejection (L2)", () => {
  const cases: ReadonlyArray<readonly [string, () => void, string]> = [
    [
      "duplicate route",
      () => {
        const r = router()
        r.add("GET", "/dup", "a")
        r.add("GET", "/dup", "b")
      },
      "DUPLICATE_ROUTE",
    ],
    ["duplicate param name", () => router().add("GET", "/:id/:id", "x"), "DUPLICATE_PARAM"],
    [
      "wildcard name colliding with a param",
      () => router().add("GET", "/:x/*x", "x"),
      "DUPLICATE_PARAM",
    ],
    [
      "conflicting param names for same shape",
      () => {
        const r = router()
        r.add("GET", "/u/:id", "a")
        r.add("POST", "/u/:userId", "b")
      },
      "PARAM_NAME_CONFLICT",
    ],
    ["wildcard not last", () => router().add("GET", "/*rest/more", "x"), "WILDCARD_NOT_LAST"],
    ["empty param name", () => router().add("GET", "/:", "x"), "INVALID_PARAM_NAME"],
    [
      "param name starting with a digit",
      () => router().add("GET", "/:1bad", "x"),
      "INVALID_PARAM_NAME",
    ],
    ["invalid wildcard name", () => router().add("GET", "/*1bad", "x"), "INVALID_PARAM_NAME"],
    // Prototype-key param names rejected at registration (audit 2026-06, L2).
    ["__proto__ param name", () => router().add("GET", "/:__proto__", "x"), "INVALID_PARAM_NAME"],
    [
      "constructor param name",
      () => router().add("GET", "/:constructor", "x"),
      "INVALID_PARAM_NAME",
    ],
    ["prototype param name", () => router().add("GET", "/:prototype", "x"), "INVALID_PARAM_NAME"],
    [
      "__proto__ wildcard name",
      () => router().add("GET", "/*__proto__", "x"),
      "INVALID_PARAM_NAME",
    ],
    ["path without leading slash", () => router().add("GET", "no-slash", "x"), "INVALID_PATH"],
    ["empty path", () => router().add("GET", "", "x"), "INVALID_PATH"],
    // Cast exercises the runtime guard that protects non-TS callers.
    ["invalid method", () => router().add("BREW" as "GET", "/coffee", "x"), "INVALID_METHOD"],
  ]

  for (const [name, run, code] of cases) {
    test(`rejects: ${name} (code ${code})`, () => {
      expect(run).toThrow(RouteConfigError)
      try {
        run()
        throw new Error("expected throw")
      } catch (err) {
        expect(err).toBeInstanceOf(RouteConfigError)
        expect((err as RouteConfigError).code).toBe(code as never)
      }
    })
  }

  test("allows the same path shape with different methods", () => {
    const r = router()
    expect(() => {
      r.add("GET", "/u/:id", "g")
      r.add("POST", "/u/:id", "p")
    }).not.toThrow()
  })
})

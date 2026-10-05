import { describe, expect, test } from "bun:test"
import { RoutePatternOverlapLimitError, routePatternOverlap } from "../src/router/overlap.ts"

const overlap = (left: string, right: string): string | undefined =>
  routePatternOverlap(left, right)

describe("route pattern overlap", () => {
  test("returns a concrete witness for a parameter and static route", () => {
    expect(overlap("/users/:id", "/users/me")).toBe("/users/me")
  })

  test("returns a concrete witness for wildcard and nested routes", () => {
    expect(overlap("/files/*path", "/files/:name/edit")).toBe("/files/a/edit")
  })

  test("handles mixed route segments without treating unrelated literals as overlapping", () => {
    expect(overlap("/posts/:slug.json", "/posts/archive.xml")).toBeUndefined()
    expect(overlap("/posts/:slug.json", "/posts/archive.json")).toBe("/posts/archive.json")
  })

  test("does not report routes with disjoint path shapes", () => {
    expect(overlap("/users/:id", "/teams/:id")).toBeUndefined()
    expect(overlap("/users/:id", "/users/:id/settings/profile")).toBeUndefined()
  })

  test("fails closed when the offline product-state budget is exceeded", () => {
    const left = `/${"a".repeat(16_385)}`
    const right = "/a"
    expect(() => overlap(left, right)).toThrow(RoutePatternOverlapLimitError)
  })

  test("a pattern ending in optional params is every concrete path it serves", () => {
    expect(overlap("/users/:id?", "/users")).toBe("/users")
    expect(overlap("/users", "/users/:id?")).toBe("/users")
    expect(overlap("/users/:id?", "/users/me")).toBe("/users/me")
    expect(overlap("/d/:y?/:m?", "/d/:year/archive")).toBe("/d/a/archive")
    expect(overlap("/:lang?", "/")).toBe("/")
    expect(overlap("/a/:x?", "/a/:y?")).toBe("/a")
    expect(overlap("/users/:id?", "/teams/:id?")).toBeUndefined()
    expect(overlap("/users/:id?", "/users/:id/posts")).toBeUndefined()
  })

  test("a `?` outside a trailing run of whole segments is ordinary text", () => {
    expect(overlap("/a/:id?/b", "/a")).toBeUndefined()
    expect(overlap("/a/x-:id?", "/a")).toBeUndefined()
  })

  test("the state budget is shared across every concrete path of both sides", () => {
    const run = (name: string): string =>
      Array.from({ length: 400 }, (_, index) => `/:${name}${index}?`).join("")
    expect(() => overlap(`/a${run("p")}`, `/b${run("q")}`)).toThrow(RoutePatternOverlapLimitError)
  })
})

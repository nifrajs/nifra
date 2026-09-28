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
})

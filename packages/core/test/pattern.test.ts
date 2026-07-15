import { expect, test } from "bun:test"
import { compileRoutePattern, matchRoutePattern } from "../src/router/pattern.ts"

test("compiled route segments cannot diverge from their cached matcher", () => {
  const pattern = compileRoutePattern("/users/:id/*rest")
  expect(pattern.segments.every(Object.isFrozen)).toBe(true)
  expect(matchRoutePattern(pattern, "/users/42/profile/avatar")).toEqual({
    matched: true,
    params: { id: "42", rest: "profile/avatar" },
  })

  const staticSegment = pattern.segments[0] as { value: string }
  expect(() => {
    staticSegment.value = "admins"
  }).toThrow(TypeError)

  expect(matchRoutePattern(pattern, "/users/42/profile/avatar")).toEqual({
    matched: true,
    params: { id: "42", rest: "profile/avatar" },
  })
  expect(matchRoutePattern(pattern, "/admins/42/profile/avatar")).toEqual({
    matched: false,
    reason: "not-found",
  })
})

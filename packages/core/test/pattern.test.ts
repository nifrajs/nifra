import { expect, test } from "bun:test"
import { compileRoutePattern, matchRoutePattern } from "../src/router/pattern.ts"

// The grammar the error message quotes back, asserted from one place so a change to the rule shows
// up as a single test edit rather than a scattering of string literals.
const PARAM_NAME_SOURCE = "^[A-Za-z_][A-Za-z0-9_]*$"

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

test("a rejected parameter name says why", () => {
  const hint = (pattern: string): string => {
    try {
      compileRoutePattern(pattern)
    } catch (error) {
      return (error as Error).message
    }
    throw new Error(`expected ${pattern} to be rejected`)
  }

  // A reserved name would let a capture mutate the params object's prototype.
  const reserved = hint("/:__proto__")
  expect(reserved).toContain("reserved")
  expect(reserved).toContain("prototype")

  expect(hint("/:")).toContain("needs a name after it")
  expect(hint("/:9lives")).toContain(PARAM_NAME_SOURCE)

  // A duplicate is rejected WITHIN one segment too, not only across segments - two captures cannot
  // race for the same params key.
  expect(hint("/:a.:a")).toContain("duplicate parameter")
})

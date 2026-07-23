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

test("a rejected parameter name explains the per-segment grammar, not just that it is invalid", () => {
  // The grammar is per-segment, so everything after ":" is the name — `:id.json` asks for a parameter
  // literally called "id.json". The bare "invalid parameter" that produces reads as a typo rather than
  // a rule, so the message has to name the limitation and both ways out.
  const hint = (pattern: string): string => {
    try {
      compileRoutePattern(pattern)
    } catch (error) {
      return (error as Error).message
    }
    throw new Error(`expected ${pattern} to be rejected`)
  }

  const suffix = hint("/v/:id.json")
  expect(suffix).toContain("wholly static or wholly a parameter")
  // States the rule and both escape hatches. Deliberately does NOT interpolate the split name or
  // build an example path: that phrasing measured ~0.3 KB gzip in every nifra bundle, which is the
  // wrong price for prose that only renders on a boot-time misconfiguration.
  expect(suffix).toContain("own segment")
  expect(suffix).toContain("split it in the handler")
  // The offending pattern is still named, by the message this hint is appended to.
  expect(suffix).toContain('":id.json"')
  expect(hint("/:id-suffix")).toContain("wholly static or wholly a parameter")

  // A reserved name is a different failure and says so, rather than reusing the suffix explanation.
  const reserved = hint("/:__proto__")
  expect(reserved).toContain("reserved")
  expect(reserved).toContain("prototype")
  expect(reserved).not.toContain("wholly static")

  expect(hint("/:")).toContain("needs a name after it")
  // A name that is invalid for a reason other than a trailing literal falls back to the grammar.
  expect(hint("/:9lives")).toContain(PARAM_NAME_SOURCE)
})

test("a segment not starting with ':' stays static even when it contains one", () => {
  // Documented deliberately: `pre-:id` is NOT a parameter — the segment does not start with ":", so it
  // compiles to a literal. A colon is legal inside a URL path segment (`/v1/things:batchGet`), so this
  // cannot be an error without breaking those routes.
  const compiled = compileRoutePattern("/a/pre-:id")
  expect(compiled.paramNames).toEqual([])
  expect(compiled.segments[1]).toEqual({ kind: "static", value: "pre-:id" })
  expect(matchRoutePattern(compiled, "/a/pre-:id")).toEqual({ matched: true, params: {} })
  expect(matchRoutePattern(compiled, "/a/pre-42").matched).toBe(false)
})

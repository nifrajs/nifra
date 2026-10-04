import { expect, test } from "bun:test"
import { hasDotSegment, resolveDotSegments } from "../src/generated/request-target.ts"

test("an origin-form target resolves on this origin; an absolute one stays absolute; others are kept", () => {
  expect(resolveDotSegments("/a/./b/../c?x=1")).toBe("/a/c?x=1")
  // Appended to an origin, not resolved against one: `//host/..` stays a path here.
  expect(resolveDotSegments("//evil.example/../x")).toBe("//x")
  expect(resolveDotSegments("http://example.com/a/../b?x=1")).toBe("http://example.com/b?x=1")
  expect(resolveDotSegments("*")).toBe("*")
  expect(hasDotSegment("/a/../b")).toBe(true)
  expect(hasDotSegment("/a/b")).toBe(false)
})

import { describe, expect, test } from "bun:test"
import { hasLowercaseHeaderKeysMark } from "../src/server/header-case.ts"
import {
  mergeStaticHeaderRecord,
  normalizeStaticResponseHeaders,
} from "../src/server/static-headers.ts"

describe("static header records", () => {
  test("a declared value with leading or trailing space is refused", () => {
    expect(() => normalizeStaticResponseHeaders({ "x-team": " core" })).toThrow(
      'responseHeaders: the value of "x-team" has leading or trailing space',
    )
  })

  test("a request-owned __proto__ name among several is stored as an own property", () => {
    const own = JSON.parse('{"__proto__": "a", "x-request-id": "r1"}') as Record<string, string>
    const merged = mergeStaticHeaderRecord({ "x-team": "core" }, own, true)
    expect(Object.hasOwn(merged, "__proto__")).toBe(true)
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype)
    expect(Object.keys(merged)).toEqual(["x-team", "__proto__", "x-request-id"])
    expect(hasLowercaseHeaderKeysMark(merged)).toBe(true)
  })

  test("a mixed-case request name replaces the static one and withholds the lowercase mark", () => {
    const merged = mergeStaticHeaderRecord({ "x-team": "core" }, { "X-Team": "edge", a: "1" }, true)
    expect(merged).toEqual({ "X-Team": "edge", a: "1" })
    expect(hasLowercaseHeaderKeysMark(merged)).toBe(false)
  })
})

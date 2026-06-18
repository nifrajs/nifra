import { describe, expect, test } from "bun:test"
import { parseContentLength } from "../src/server/body.ts"

/**
 * `parseContentLength` is the integer guard at the front of the body-size cap (it replaced a
 * `/^\d+$/.test()` + `Number()` pair for speed). It is SECURITY-CRITICAL: a `Content-Length` that
 * parses too small lets an oversized body through the fast path, and one that's wrongly rejected
 * breaks valid requests. These tests pin: only `1*DIGIT` is accepted, everything else is `undefined`
 * (→ 400), an over-`MAX_SAFE_INTEGER` length saturates to `Infinity` (→ over any cap → 413), and the
 * result matches the legacy regex+`Number` behavior across the normal integer range.
 */
describe("parseContentLength — body-cap integer guard", () => {
  test("accepts bare digit strings (incl. leading zeros — HTTP grammar is 1*DIGIT)", () => {
    const cases: ReadonlyArray<readonly [string, number]> = [
      ["0", 0],
      ["1", 1],
      ["42", 42],
      ["123", 123],
      ["007", 7],
      ["00", 0],
      ["1000000", 1_000_000],
    ]
    for (const [input, expected] of cases) {
      expect(parseContentLength(input)).toBe(expected)
    }
  })

  test("rejects everything that isn't all-digits → undefined (caller maps to 400)", () => {
    const malformed = [
      "", // an empty Content-Length is malformed, not zero
      " ",
      " 12", // leading space
      "12 ", // trailing space
      "1 2", // embedded space
      "12a",
      "a12",
      "-5", // negative
      "+5", // signed
      "1.5", // fractional
      "1e3", // exponential — Number() would accept this; we must NOT
      "0x10", // hex — Number() would accept this; we must NOT
      "0b1",
      "1,000",
      "Infinity",
      "NaN",
    ]
    for (const input of malformed) {
      expect(parseContentLength(input)).toBeUndefined()
    }
  })

  test("a length beyond MAX_SAFE_INTEGER saturates to Infinity (still > any cap → 413)", () => {
    expect(parseContentLength("99999999999999999999")).toBe(Number.POSITIVE_INFINITY)
    // Exactly MAX_SAFE_INTEGER stays finite (and is still far over any real body cap).
    expect(parseContentLength(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER)
  })

  test("agrees with the legacy /^\\d+$/ + Number() guard across the normal range", () => {
    const legacy = (s: string): number | undefined => (/^\d+$/.test(s) ? Number(s) : undefined)
    const inputs = ["0", "42", "007", "1000000", "", " 1", "1 ", "1e3", "0x10", "-1", "1.0", "abc"]
    for (const s of inputs) {
      const expected = legacy(s)
      const got = parseContentLength(s)
      if (expected === undefined) {
        expect(got).toBeUndefined()
      } else if (Number.isSafeInteger(expected)) {
        // Both reduce to the same integer; over-MAX values both end up > cap → 413, so only the
        // safe-integer range is compared exactly.
        expect(got).toBe(expected)
      }
    }
  })
})

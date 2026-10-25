import { describe, expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { canonicalJson } from "../src/canonical-json.ts"

// biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: every runtime this suite runs on has JSON.rawJSON; TypeScript's lib does not declare it yet.
const rawJson = Reflect.get(JSON, "rawJSON") as (text: string) => unknown

describe("canonicalJson", () => {
  test("sorts keys by UTF-16 code unit at every depth and writes no whitespace", () => {
    expect(canonicalJson({ b: [3, { d: 1, c: 2 }], a: null, B: true, "10": 1, "9": 2 })).toBe(
      '{"10":1,"9":2,"B":true,"a":null,"b":[3,{"c":2,"d":1}]}',
    )
    expect(canonicalJson({ "\uffff": 1, "\ud83d\ude00": 2, "\u00e9": 3, z: 4 })).toBe(
      '{"z":4,"\u00e9":3,"\ud83d\ude00":2,"\uffff":1}',
    )
    expect(canonicalJson([[], {}, ""])).toBe('[[],{},""]')
  })

  test("leaves out undefined members and keeps null ones", () => {
    expect(canonicalJson({ a: undefined, b: null, c: { d: undefined } })).toBe('{"b":null,"c":{}}')
  })

  test("writes numbers and strings the way JSON.stringify does", () => {
    expect(canonicalJson([-0, 1e21, 5e-324, 0.1, 12345678901234567000])).toBe(
      "[0,1e+21,5e-324,0.1,12345678901234567000]",
    )
    expect(canonicalJson(['\u0000"\\\n', "\ud800", "\u2028"])).toBe(
      '["\\u0000\\"\\\\\\n","\\ud800","\u2028"]',
    )
  })

  test("treats a null-prototype object, an own __proto__ key and another realm's object as plain", () => {
    expect(canonicalJson(Object.assign(Object.create(null), { b: 1, a: 2 }))).toBe('{"a":2,"b":1}')
    expect(canonicalJson(JSON.parse('{"__proto__":{"x":1},"a":1}'))).toBe(
      '{"__proto__":{"x":1},"a":1}',
    )
    expect(canonicalJson(runInNewContext("({ b: [1], a: { c: 2 } })"))).toBe(
      '{"a":{"c":2},"b":[1]}',
    )
  })

  test("writes a raw JSON value verbatim", () => {
    expect(canonicalJson({ n: rawJson("12345678901234567891"), m: [rawJson("1.0")] })).toBe(
      '{"m":[1.0],"n":12345678901234567891}',
    )
  })

  test("throws on every value JSON cannot carry instead of hashing it as something else", () => {
    class Point {
      x = 1
    }
    const refused: unknown[] = [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      { n: Number.NEGATIVE_INFINITY },
      [1, undefined],
      // biome-ignore lint/suspicious/noSparseArray: a missing item is the case under test
      [, 1],
      new Date(0),
      { at: new Map([["k", 1]]) },
      new Set([1]),
      new Point(),
      new Uint8Array([1]),
      () => 1,
      { f: () => 1 },
      Symbol("s"),
      1n,
    ]
    for (const value of refused) expect(() => canonicalJson(value)).toThrow(TypeError)
  })
})

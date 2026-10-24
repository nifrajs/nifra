import { expect, test } from "bun:test"
import { ifNoneMatchIncludes } from "../src/_entity-tag.ts"

test("an If-None-Match list splits only outside quoted entity-tags, and compares weakly", () => {
  const cases: readonly (readonly [string, string, boolean])[] = [
    ['"a,b"', '"a,b"', true],
    ['"x", "a,b"', '"a,b"', true],
    ['"a"', '"a,b"', false],
    ['"a", "b"', '"b"', true],
    ['W/"a,b"', '"a,b"', true],
    ['"a,b"', 'W/"a,b"', true],
    ["\t*", '"z"', true],
    ["W/*", '"z"', false],
    ["plain, other", "other", true],
    ['"unclosed', '"unclosed', true],
    ['"a" ,, "c"', '"b"', false],
    ["", '"a"', false],
  ]
  for (const [value, tag, expected] of cases) {
    expect({ value, tag, match: ifNoneMatchIncludes(value, tag) }).toEqual({
      value,
      tag,
      match: expected,
    })
  }
})

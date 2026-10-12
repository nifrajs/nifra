import { expect, test } from "bun:test"
import { withoutQuery } from "../src/internal/without-query.ts"

test.each([
  ["./a.ts", "./a.ts"],
  ["./a.ts?raw", "./a.ts"],
  ["./a.ts#x", "./a.ts"],
  ["./a.ts?raw#x", "./a.ts"],
  ["./a.ts#x?raw", "./a.ts"],
  ["?raw", ""],
  // The regex form found no match here: `.` stops at the line break, so it kept every `#`.
  [`./a.ts${"#".repeat(20_000)}\n`, "./a.ts"],
])("withoutQuery(%j) is %j", (value, expected) => {
  expect(withoutQuery(value)).toBe(expected)
})

import { expect, test } from "bun:test"
import { componentInputKey, componentValue } from "../src/server-components/value.ts"

// The server and the browser each compute this key and must agree byte for byte.
test("a component input key is pinned", () => {
  expect(componentInputKey(componentValue({ b: [2, { d: null, c: "\u00e9" }], a: 1 }))).toBe(
    '{"a":1,"b":[2,{"c":"\u00e9","d":null}]}',
  )
})

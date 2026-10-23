import { describe, expect, test } from "bun:test"
import { markRepeatedPrefix, repeatedPrefixOf } from "@nifrajs/core/response-observer"

describe("repeated prefix marks", () => {
  test("a chunk keeps the source and length it was marked with", () => {
    const source = new TextEncoder().encode("<html><body>shell")
    const chunk = new TextEncoder().encode("<html><body>shell token")
    expect(repeatedPrefixOf(chunk)).toBeUndefined()
    markRepeatedPrefix(chunk, source, source.byteLength)
    expect(repeatedPrefixOf(chunk)).toEqual({ source, length: source.byteLength })
    expect(repeatedPrefixOf(chunk.slice())).toBeUndefined()
  })

  test("a length outside either array, or not a positive integer, records nothing", () => {
    const source = new Uint8Array(8)
    for (const length of [0, -1, 1.5, Number.NaN, 9]) {
      const chunk = new Uint8Array(16)
      markRepeatedPrefix(chunk, source, length)
      expect(repeatedPrefixOf(chunk)).toBeUndefined()
    }
    const short = new Uint8Array(4)
    markRepeatedPrefix(short, source, 6)
    expect(repeatedPrefixOf(short)).toBeUndefined()
  })
})

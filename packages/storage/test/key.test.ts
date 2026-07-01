import { describe, expect, test } from "bun:test"
import { assertSafeKey, StorageKeyError } from "../src/index.ts"

const SAFE = [
  "a.png",
  "avatars/u1.png",
  "a/b/c/d.json",
  "file.with.dots.txt",
  "a/./b",
  "has space.png",
]
const UNSAFE = ["", "/abs", "../escape", "a/../../b", "x/..", "..", "a\\b", "a\0b"]

describe("assertSafeKey", () => {
  test("accepts safe relative keys (nested, dotted, spaces)", () => {
    for (const key of SAFE) expect(() => assertSafeKey(key)).not.toThrow()
  })

  test("rejects traversal, absolute, NUL, backslash, and empty keys", () => {
    for (const key of UNSAFE) expect(() => assertSafeKey(key)).toThrow(StorageKeyError)
  })
})

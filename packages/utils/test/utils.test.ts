import { describe, expect, test } from "bun:test"
import { concatBytes } from "../src/bytes.ts"
import { escapeRegExp } from "../src/escape-regexp.ts"
import { bytesToHex, sha256Hex } from "../src/hash.ts"
import { isRecord } from "../src/record.ts"

describe("hashing", () => {
  test("bytesToHex pads every byte to two lowercase digits", () => {
    expect(bytesToHex(new Uint8Array([0, 1, 15, 16, 255]))).toBe("00010f10ff")
    expect(bytesToHex(new Uint8Array())).toBe("")
  })

  test("sha256Hex hashes text as UTF-8 and bytes as given", async () => {
    const known = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    expect(await sha256Hex("abc")).toBe(known)
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(known)
  })

  test("sha256Hex hashes only a view's own window", async () => {
    const backing = new Uint8Array([9, 97, 98, 99, 9])
    expect(await sha256Hex(backing.subarray(1, 4))).toBe(await sha256Hex("abc"))
  })
})

describe("small helpers", () => {
  test("concatBytes joins chunks in order", () => {
    expect(concatBytes([new Uint8Array([1, 2]), new Uint8Array(), new Uint8Array([3])], 3)).toEqual(
      new Uint8Array([1, 2, 3]),
    )
  })

  test("escapeRegExp makes every metacharacter literal", () => {
    const text = [".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"].join("")
    expect(new RegExp(`^${escapeRegExp(text)}$`).test(text)).toBe(true)
    expect(escapeRegExp("plain")).toBe("plain")
  })

  test("isRecord admits objects, not null, arrays or primitives", () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord(new Date())).toBe(true)
    for (const value of [null, [], "s", 1, undefined]) expect(isRecord(value)).toBe(false)
  })
})

import { describe, expect, test } from "bun:test"
import { concatBytes } from "../src/bytes.ts"
import { canonicalJson } from "../src/canonical-json.ts"
import { escapeRegExp } from "../src/escape-regexp.ts"
import { bytesToHex, sha256Hex } from "../src/hash.ts"
import { isRecord } from "../src/record.ts"

describe("canonicalJson", () => {
  test("sorts keys by code unit, drops undefined members, writes no whitespace", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"], c: undefined })).toBe(
      '{"a":[true,null,"x"],"b":1}',
    )
    expect(canonicalJson({ é: 1, z: 2, Z: 3 })).toBe('{"Z":3,"z":2,"é":1}')
  })

  test("accepts null-prototype and cross-realm plain records", () => {
    const bare: Record<string, unknown> = Object.create(null)
    bare.k = 1
    expect(canonicalJson(bare)).toBe('{"k":1}')
    const foreign: Record<string, unknown> = Object.create(Object.create(null))
    foreign.k = 2
    expect(canonicalJson(foreign)).toBe('{"k":2}')
  })

  test("refuses what JSON cannot carry", () => {
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      undefined,
      () => 0,
      Symbol("s"),
      1n,
    ]) {
      expect(() => canonicalJson(value)).toThrow(TypeError)
    }
    expect(() => canonicalJson(new Date(0))).toThrow("a non-plain object")
    expect(() => canonicalJson(new Map())).toThrow("a non-plain object")
    expect(() => canonicalJson(new (class Box {})())).toThrow("a non-plain object")
    expect(() => canonicalJson([1, undefined])).toThrow(TypeError)
    const holey: unknown[] = new Array(2)
    holey[1] = 1
    expect(() => canonicalJson(holey)).toThrow(TypeError)
  })

  test("writes a JSON.rawJSON value verbatim where the engine has it", () => {
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the member is optional, so an engine without JSON.rawJSON leaves it undefined.
    const raw = (JSON as { rawJSON?: (text: string) => object }).rawJSON
    if (raw === undefined) return
    expect(canonicalJson({ n: raw("12345678901234567890") })).toBe('{"n":12345678901234567890}')
  })
})

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

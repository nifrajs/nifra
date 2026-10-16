import { describe, expect, test } from "bun:test"
import { type ByteRangeResult, parseByteRange } from "../src/range.ts"

/**
 * `parseByteRange` answers `bytes=<digits>-<digits>` with a single scan and everything else with the
 * general parser. The scan exists only for speed, so it may never change an answer: every input below
 * must get exactly what the parser gave before the scan existed, kept here as `legacyParseByteRange`.
 */

const LEGACY_INTEGER = /^(?:0|[1-9]\d*)$/

function legacyParseByteRange(value: string | null, size: number): ByteRangeResult {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new RangeError("parseByteRange: size must be a non-negative safe integer")
  }
  if (value === null) return { kind: "none" }
  if (value.length > 16 * 1024) return { kind: "none" }
  const match = /^bytes\s*=\s*(.+)$/i.exec(value)
  if (match === null) return { kind: "none" }
  const source = match[1]!
  let separators = 0
  for (const character of source) {
    if (character === "," && ++separators >= 16) return { kind: "none" }
  }
  const ranges: { start: number; end: number }[] = []
  let validRangeSpec = false
  for (const raw of source.split(",")) {
    const item = raw.trim()
    const dash = item.indexOf("-")
    if (dash < 0) continue
    const left = item.slice(0, dash).trim()
    const right = item.slice(dash + 1).trim()
    if (left === "" && (!LEGACY_INTEGER.test(right) || right === "0")) continue
    if (left !== "" && !LEGACY_INTEGER.test(left)) continue
    if (right !== "" && !LEGACY_INTEGER.test(right)) continue
    validRangeSpec = true
    let start: number
    let end: number
    if (left === "") {
      const suffix = Number(right)
      start = suffix >= size ? 0 : size - suffix
      end = size - 1
    } else {
      start = Number(left)
      end = right === "" ? size - 1 : Math.min(Number(right), size - 1)
    }
    if (start > end || start >= size || size === 0) continue
    ranges.push({ start, end })
  }
  if (ranges.length === 0) return validRangeSpec ? { kind: "unsatisfiable" } : { kind: "none" }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: { start: number; end: number }[] = []
  for (const range of ranges) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && range.start <= previous.end + 1) {
      merged[merged.length - 1] = { start: previous.start, end: Math.max(previous.end, range.end) }
    } else {
      merged.push(range)
    }
  }
  return { kind: "satisfiable", ranges: merged }
}

/** Deterministic generator, so a failure names a reproducible case. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const DIGITS = [
  "",
  "0",
  "00",
  "01",
  "1",
  "5",
  "9",
  "10",
  "99",
  "100",
  "4096",
  "65535",
  "9007199254740991",
  "9007199254740993",
  "1".repeat(400),
]
const PREFIXES = [
  "bytes=",
  "BYTES=",
  "Bytes=",
  "bYtEs=",
  "bytes =",
  "bytes= ",
  " bytes=",
  "byte=",
  "bytes",
  "bytesx=",
  "byteſ=",
  "items=",
  "",
]
const SIZES = [0, 1, 2, 9, 10, 11, 100, 4096, 65535, 4_194_304, Number.MAX_SAFE_INTEGER]
const ALPHABET = [
  ..."bytesBYTES=-,0123456789",
  " ",
  "\t",
  "\n",
  "\r",
  "\v",
  "\f",
  " ",
  " ",
  " ",
  "﻿",
  "　",
  "ſ",
  "٣",
  "x",
  ";",
  "+",
]

function corpus(): (readonly [string | null, number])[] {
  const random = seeded(0x7a49e)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
  const cases: (readonly [string | null, number])[] = []
  for (const prefix of PREFIXES)
    for (const left of DIGITS)
      for (const right of DIGITS)
        for (const size of SIZES) cases.push([`${prefix}${left}-${right}`, size])
  for (let index = 0; index < 5_000; index++) {
    const specs = Array.from(
      { length: 2 + Math.floor(random() * 3) },
      () => `${pick(DIGITS)}-${pick(DIGITS)}`,
    )
    cases.push([`bytes=${specs.join(pick([",", ", ", " ,"]))}`, pick(SIZES)])
  }
  for (let index = 0; index < 50_000; index++) {
    let value = random() < 0.7 ? pick(PREFIXES) : ""
    const length = Math.floor(random() * 24)
    for (let char = 0; char < length; char++) value += pick(ALPHABET)
    cases.push([value, random() < 0.5 ? pick(SIZES) : Math.floor(random() * 1_000)])
  }
  for (const total of [16_383, 16_384, 16_385]) {
    cases.push([`bytes=0-${"1".repeat(total - 8)}`, 100], [`bytes=-${"1".repeat(total - 7)}`, 100])
  }
  for (let count = 14; count <= 18; count++) {
    cases.push([`bytes=${Array.from({ length: count }, (_, i) => `${i}-${i}`).join(",")}`, 100])
  }
  for (const size of SIZES) cases.push([null, size])
  return cases
}

function answer(
  parse: (value: string | null, size: number) => ByteRangeResult,
  value: string | null,
  size: number,
): ByteRangeResult | { readonly threw: string } {
  try {
    return parse(value, size)
  } catch (error) {
    return { threw: `${(error as Error).name}: ${(error as Error).message}` }
  }
}

describe("parseByteRange", () => {
  test("answers every input exactly as the parser before the single-range scan", () => {
    const cases = corpus()
    const single = /^bytes=\d*-\d*$/i
    // Both paths carry real weight in the corpus, so a narrowed generator cannot pass vacuously.
    expect(cases.filter(([value]) => value !== null && single.test(value)).length).toBeGreaterThan(
      9_000,
    )
    expect(cases.filter(([value]) => value === null || !single.test(value)).length).toBeGreaterThan(
      50_000,
    )
    const mismatches: string[] = []
    for (const [value, size] of cases) {
      const actual = answer(parseByteRange, value, size)
      const expected = answer(legacyParseByteRange, value, size)
      if (!Bun.deepEquals(actual, expected, true) && mismatches.length < 10) {
        mismatches.push(
          `${JSON.stringify(value)} size ${size}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
        )
      }
    }
    expect(mismatches).toEqual([])
  })

  test("rejects a size that is not a non-negative safe integer, before reading the header", () => {
    for (const size of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      for (const value of ["bytes=0-1", null]) {
        expect(answer(parseByteRange, value, size)).toEqual(
          answer(legacyParseByteRange, value, size),
        )
        expect(() => parseByteRange(value, size)).toThrow(RangeError)
      }
    }
  })

  test("single ranges", () => {
    const cases: readonly (readonly [string, number, ByteRangeResult])[] = [
      ["bytes=0-99", 1000, { kind: "satisfiable", ranges: [{ start: 0, end: 99 }] }],
      ["BYTES=5-", 10, { kind: "satisfiable", ranges: [{ start: 5, end: 9 }] }],
      ["bytes=-3", 10, { kind: "satisfiable", ranges: [{ start: 7, end: 9 }] }],
      ["bytes=-500", 100, { kind: "satisfiable", ranges: [{ start: 0, end: 99 }] }],
      ["bytes=5-500", 10, { kind: "satisfiable", ranges: [{ start: 5, end: 9 }] }],
      ["bytes=9-0", 10, { kind: "unsatisfiable" }],
      ["bytes=10-", 10, { kind: "unsatisfiable" }],
      ["bytes=0-", 0, { kind: "unsatisfiable" }],
      ["bytes=-0", 10, { kind: "none" }],
      ["bytes=-", 10, { kind: "none" }],
      ["bytes=01-5", 10, { kind: "none" }],
      ["bytes=1-05", 10, { kind: "none" }],
      ["bytes=1-2-3", 10, { kind: "none" }],
    ]
    for (const [value, size, expected] of cases) {
      expect([value, parseByteRange(value, size)]).toEqual([value, expected])
    }
  })
})

import { expect, test } from "bun:test"
import { DEFAULT_SEARCH_LIMITS, parseSearch, type SearchLimits } from "../src/search.ts"

// The parse the codec ran before it became one pass: iterate the keys to decide which are kept, iterate
// the entries to group their values, and let JSON.parse throw on every plain word. Kept here so the
// current parse is held to its output, key order included.
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"])
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
const depthOf = (v: unknown): number =>
  Array.isArray(v)
    ? 1 + Math.max(0, ...v.map(depthOf))
    : isObject(v)
      ? 1 + Math.max(0, ...Object.values(v).map(depthOf))
      : 0
const without = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(without)
    : isObject(v)
      ? Object.fromEntries(
          Object.entries(v)
            .filter(([key]) => !FORBIDDEN.has(key))
            .map(([key, item]) => [key, without(item)]),
        )
      : v

function referenceValue(raw: string, maxDepth: number): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw
  }
  return depthOf(parsed) > maxDepth ? raw : without(parsed)
}

function referenceParse(raw: string, limits: SearchLimits): Record<string, unknown> {
  if (raw.length > limits.maxLength || raw === "" || raw === "?") return {}
  const params = new URLSearchParams(raw.startsWith("?") ? raw.slice(1) : raw)
  const kept = new Set<string>()
  for (const key of params.keys()) {
    if (kept.has(key) || FORBIDDEN.has(key)) continue
    if (kept.size + 1 > limits.maxKeys) break
    kept.add(key)
  }
  const grouped = new Map<string, string[]>()
  for (const [key, value] of params) {
    if (!kept.has(key)) continue
    const values = grouped.get(key) ?? []
    values.push(value)
    grouped.set(key, values)
  }
  const out: Record<string, unknown> = {}
  for (const [key, values] of grouped) {
    const decoded = values.map((value) => referenceValue(value, limits.maxDepth))
    out[key] = decoded.length > 1 ? decoded : decoded[0]
  }
  return out
}

// Values that sit on each side of every rule the decoder has: JSON numbers and near-misses, literals
// and near-misses, whitespace JSON allows and whitespace it does not, strings, containers at and past
// the depth cap, forbidden keys inside a value, and text the URL decoder rewrites.
const VALUES = [
  "",
  "0",
  "1",
  "-1",
  "-0",
  "01",
  "1.5",
  "1.",
  ".5",
  "+1",
  "1e3",
  "1E-3",
  "1e",
  "-",
  "--1",
  "0x10",
  "1_000",
  "12345678901234567890",
  "1e400",
  "NaN",
  "Infinity",
  "٣",
  "true",
  "false",
  "null",
  "True",
  "tru",
  "nul",
  "truee",
  "t",
  "f",
  "n",
  "news",
  "total",
  "false-ish",
  " 1",
  "1 ",
  "\t2\n",
  "\r3",
  " 1",
  "1 ",
  " true ",
  "true\n",
  " ",
  '"s"',
  '"unterminated',
  '"a"b',
  "{}",
  "[]",
  "[1]",
  "[1,2",
  '{"a":1}',
  '{"a":{"b":{"c":{"d":{"e":{"f":1}}}}}}',
  "[[[[[[[1]]]]]]]",
  "[[[[[[1]]]]]]",
  '{"__proto__":{"x":1}}',
  '{"a":{"constructor":2,"b":3}}',
  '[{"prototype":1}]',
  "hello world",
  "a+b",
  "100%",
  "%",
  "%E0%A4%A",
  "%41",
  "%7B%22a%22%3A1%7D",
  "é",
  "日本",
  "a=b",
  "a&b",
]
const KEYS = [
  "a",
  "b",
  "c",
  "page",
  "q",
  "tags",
  "1",
  "0",
  "10",
  "",
  "a b",
  "%41",
  "é",
  "toString",
  "hasOwnProperty",
  "valueOf",
  "__proto__",
  "constructor",
  "prototype",
  "__proto__x",
  "k1",
  "k2",
  "k3",
  "k4",
  "k5",
]
const GLYPHS = [
  "a",
  "1",
  " ",
  "%",
  "+",
  "&",
  "=",
  "?",
  '"',
  "{",
  "}",
  "[",
  "]",
  ",",
  ":",
  "-",
  "e",
  ".",
  "t",
  "f",
  "n",
  " ",
  "é",
  "\t",
]
const LIMITS: SearchLimits[] = [
  DEFAULT_SEARCH_LIMITS,
  { maxLength: 4096, maxKeys: 2, maxDepth: 6 },
  { maxLength: 4096, maxKeys: 64, maxDepth: 2 },
  { maxLength: 40, maxKeys: 64, maxDepth: 6 },
]

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test("the one-pass parse returns what the two-pass parse returned, key order included", () => {
  const random = mulberry32(0x5eed)
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: random() < 1, so the index is inside every non-empty pool passed
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T
  const glyphs = (): string => {
    let out = ""
    for (let i = Math.floor(random() * 6); i > 0; i--) out += pick(GLYPHS)
    return out
  }
  const part = (items: readonly string[]): string => {
    const text = random() < 0.15 ? glyphs() : pick(items)
    return random() < 0.5 ? encodeURIComponent(text) : text
  }
  for (let round = 0; round < 30000; round++) {
    const pairs: string[] = []
    for (let n = Math.floor(random() * 9); n > 0; n--) {
      const roll = random()
      if (roll < 0.08) pairs.push("")
      else if (roll < 0.12) pairs.push(part(KEYS))
      else pairs.push(`${part(KEYS)}=${part(VALUES)}`)
    }
    const raw = pick(["", "?", "??"]) + pairs.join("&")
    const limits = pick(LIMITS)
    const actual = parseSearch(raw, undefined, limits)
    const expected = referenceParse(raw, limits)
    expect(actual, raw).toEqual(expected)
    expect(Object.keys(actual), raw).toEqual(Object.keys(expected))
  }
})

test("every value shape decodes as it did, alone and repeated", () => {
  for (const value of VALUES) {
    for (const raw of [
      `?v=${encodeURIComponent(value)}`,
      `?v=${value}`,
      `v=${encodeURIComponent(value)}&v=${encodeURIComponent(value)}`,
    ]) {
      expect(parseSearch(raw), raw).toEqual(referenceParse(raw, DEFAULT_SEARCH_LIMITS))
    }
  }
  expect(parseSearch("?n=-0").n).toBe(-0)
  expect(parseSearch("?a=%202%20&b=2%C2%A0").a).toBe(2)
  expect(parseSearch("?b=2%C2%A0").b).toBe("2 ")
})

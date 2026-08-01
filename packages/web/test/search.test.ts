import { expect, test } from "bun:test"
import type { StandardSchemaV1 } from "@nifrajs/core/server"
import {
  DEFAULT_SEARCH_LIMITS,
  parseSearch,
  type SearchLimits,
  serializeSearch,
  shareSearch,
  validateSearch,
} from "../src/search.ts"

// A minimal Standard Schema for the validation tests (no valibot/zod dependency needed).
type Result<T> =
  | { readonly value: T }
  | { readonly issues: readonly { readonly message: string }[] }
function makeSchema<T>(
  validate: (input: unknown) => Result<T> | Promise<Result<T>>,
): StandardSchemaV1<unknown, T> {
  return { "~standard": { version: 1, vendor: "test", validate } } as StandardSchemaV1<unknown, T>
}
const q = (s: string): string => encodeURIComponent(s)

test("parseSearch decodes JSON-first: numbers, booleans, strings, objects", () => {
  expect(parseSearch(`?page=2&q=hi&flag=true&n=null&o=${q('{"x":1}')}`)).toEqual({
    page: 2,
    q: "hi",
    flag: true,
    n: null,
    o: { x: 1 },
  })
  // A bare `?` prefix is optional.
  expect(parseSearch("page=3")).toEqual({ page: 3 })
  // A string that is not JSON stays a string; the empty query is an empty object.
  expect(parseSearch("?q=hello%20world")).toEqual({ q: "hello world" })
  expect(parseSearch("")).toEqual({})
})

test("parseSearch groups repeated keys into an array", () => {
  expect(parseSearch("?t=a&t=b")).toEqual({ t: ["a", "b"] })
  expect(parseSearch("?id=1&id=2&id=3")).toEqual({ id: [1, 2, 3] })
})

test("serializeSearch round-trips JSON-safe values and includes a leading ?", () => {
  expect(serializeSearch({ page: 2, q: "hi" })).toBe("?page=2&q=hi")
  expect(serializeSearch({})).toBe("")
  // undefined is skipped; null serializes; arrays repeat the key.
  expect(serializeSearch({ a: undefined, b: 1 })).toBe("?b=1")
  expect(serializeSearch({ n: null })).toBe("?n=null")
  expect(serializeSearch({ t: ["a", "b"] })).toBe("?t=a&t=b")

  const round = { page: 2, q: "hi", flag: false, o: { x: 1, y: [2, 3] } }
  expect(parseSearch(serializeSearch(round))).toEqual(round)
})

test("parseSearch fails closed on an oversized query", () => {
  const huge = `?q=${"x".repeat(DEFAULT_SEARCH_LIMITS.maxLength)}`
  expect(parseSearch(huge)).toEqual({})
})

test("parseSearch drops prototype-polluting keys, at the top level and nested", () => {
  expect(parseSearch("?__proto__=x&page=1")).toEqual({ page: 1 })
  expect(parseSearch(`?o=${q('{"__proto__":1,"constructor":2,"a":3}')}`)).toEqual({ o: { a: 3 } })
  // Object.prototype was not touched.
  expect(({} as Record<string, unknown>).x).toBeUndefined()
})

test("parseSearch keeps an over-deep value as its raw string instead of building the graph", () => {
  const shallow: SearchLimits = { maxLength: 4096, maxKeys: 64, maxDepth: 1 }
  const raw = '{"a":{"b":1}}'
  expect(parseSearch(`?o=${q(raw)}`, undefined, shallow)).toEqual({ o: raw })
  // Within the depth budget it decodes normally.
  expect(parseSearch(`?o=${q('{"a":1}')}`, undefined, shallow)).toEqual({ o: { a: 1 } })
})

test("parseSearch caps the number of keys", () => {
  const limited: SearchLimits = { maxLength: 4096, maxKeys: 2, maxDepth: 6 }
  expect(parseSearch("?a=1&b=2&c=3&d=4", undefined, limited)).toEqual({ a: 1, b: 2 })
})

test("validateSearch returns the typed value on success", () => {
  const schema = makeSchema<{ page: number }>((input) => ({ value: input as { page: number } }))
  expect(validateSearch(schema, { page: 7 })).toEqual({ page: 7 })
})

test("validateSearch fails closed to schema defaults on invalid input", () => {
  const schema = makeSchema<{ page: number }>((input) => {
    if (typeof (input as { page?: unknown }).page === "number")
      return { value: input as { page: number } }
    return { issues: [{ message: "not a number" }] }
  })
  // Hostile ?page=abc parsed to a string -> issues -> retry {} ... but this schema also fails on {}, so {}.
  expect(validateSearch(schema, { page: "abc" as unknown as number }) as unknown).toEqual({})

  // A schema that supplies a default for the empty object recovers to it.
  const defaulting = makeSchema<{ page: number }>((input) => {
    const page = (input as { page?: unknown }).page
    if (typeof page === "number") return { value: { page } }
    if (page === undefined) return { value: { page: 1 } } // default
    return { issues: [{ message: "bad" }] }
  })
  expect(validateSearch(defaulting, { page: "x" as unknown as number })).toEqual({ page: 1 })
})

test("validateSearch throws on an async validator (sync-only in the render path)", () => {
  const asyncSchema = makeSchema<Record<string, never>>(() => Promise.resolve({ value: {} }))
  expect(() => validateSearch(asyncSchema, {})).toThrow("must validate synchronously")

  // Async only on the fallback path (sync issues on input, async on {}) also throws.
  const asyncFallback = makeSchema<Record<string, never>>((input) =>
    Object.keys(input as object).length > 0
      ? { issues: [{ message: "x" }] }
      : Promise.resolve({ value: {} }),
  )
  expect(() => validateSearch(asyncFallback, { a: 1 })).toThrow("must validate synchronously")
})

test("shareSearch returns prev unchanged when nothing differs (stable identity)", () => {
  const prev = { page: 1, filters: { a: 1 } }
  const next = { page: 1, filters: { a: 1 } } // deep-equal, different reference
  expect(shareSearch(prev, next)).toBe(prev)
  // Same reference short-circuits too.
  expect(shareSearch(prev, prev)).toBe(prev)
})

test("shareSearch reuses references for unchanged keys and swaps only what changed", () => {
  const filters = { a: 1 }
  const prev = { page: 1, filters }
  const next = { page: 2, filters: { a: 1 } } // page changed; filters deep-equal
  const shared = shareSearch(prev, next)
  expect(shared).not.toBe(prev)
  expect(shared.page).toBe(2)
  expect(shared.filters).toBe(filters) // unchanged nested object keeps its reference
})

test("shareSearch treats a differing key set as changed, and passes non-objects through", () => {
  const prev = { a: 1 }
  const added = shareSearch<Record<string, unknown>>(prev, { a: 1, b: 2 })
  expect(added).toEqual({ a: 1, b: 2 })
  expect(added).not.toBe(prev)
  // Non-object inputs return next as-is (also exercises array vs object deep-equal paths).
  expect(shareSearch({ list: [1, 2] }, { list: [1, 3] })).toEqual({ list: [1, 3] })
  expect(shareSearch(null as unknown as object, { a: 1 })).toEqual({ a: 1 })
})

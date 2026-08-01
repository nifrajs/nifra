import { expect, test } from "bun:test"
import fc from "fast-check"
import { DEFAULT_SEARCH_LIMITS, parseSearch, searchOf, serializeSearch } from "../src/search.ts"

const PROPERTY_OPTIONS = { numRuns: 250, seed: 0x51ea7c }
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"])

const safeKey = fc
  .string({ unit: "grapheme-ascii", minLength: 1, maxLength: 12 })
  .filter((key) => !FORBIDDEN_KEYS.has(key))

const searchValue: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: "small" },
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    fc.string({ unit: "binary", maxLength: 20 }),
    fc.array(tie("value"), { maxLength: 4 }),
    fc.dictionary(safeKey, tie("value"), { maxKeys: 4 }),
  ),
})).value

const searchRecord = fc.dictionary(safeKey, searchValue, { maxKeys: 8 })

function containsForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenKey)
  if (typeof value !== "object" || value === null) return false
  return Object.entries(value).some(
    ([key, item]) => FORBIDDEN_KEYS.has(key) || containsForbiddenKey(item),
  )
}

test("property: search values round-trip through serialize, parse, and searchOf", () => {
  fc.assert(
    fc.property(searchRecord, (value) => {
      const serialized = serializeSearch(value)
      expect(parseSearch(serialized)).toEqual(value)
      expect(searchOf(undefined, serialized)).toEqual(value)
    }),
    PROPERTY_OPTIONS,
  )
})

test("property: arbitrary query strings never make the default search parser throw", () => {
  fc.assert(
    fc.property(fc.string({ unit: "binary", maxLength: 5000 }), (raw) => {
      expect(() => parseSearch(raw)).not.toThrow()
      expect(() => searchOf(undefined, raw)).not.toThrow()
    }),
    PROPERTY_OPTIONS,
  )
})

test("property: decoded JSON deeper than maxDepth remains an inert raw string", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: DEFAULT_SEARCH_LIMITS.maxDepth }),
      fc.boolean(),
      fc.string({ unit: "binary", maxLength: 20 }),
      (maxDepth, useArrays, leaf) => {
        let nested: unknown = leaf
        for (let depth = 0; depth <= maxDepth; depth += 1) {
          nested = useArrays ? [nested] : { value: nested }
        }
        const raw = JSON.stringify(nested)
        const parsed = parseSearch(`?value=${encodeURIComponent(raw)}`, undefined, {
          ...DEFAULT_SEARCH_LIMITS,
          maxDepth,
        })
        expect(parsed.value).toBe(raw)
      },
    ),
    PROPERTY_OPTIONS,
  )
})

test("property: prototype-control keys never reach parsed output", () => {
  fc.assert(
    fc.property(searchValue, (value) => {
      const hostile = JSON.stringify({
        safe: value,
        __proto__: "ignored by object literal semantics",
        constructor: { prototype: { polluted: true } },
        prototype: { constructor: "blocked" },
      })
      const raw = `?__proto__=top&constructor=top&prototype=top&payload=${encodeURIComponent(hostile)}`
      const parsed = parseSearch(raw)
      expect(containsForbiddenKey(parsed)).toBe(false)
      expect(Object.prototype).not.toHaveProperty("polluted")
    }),
    PROPERTY_OPTIONS,
  )
})

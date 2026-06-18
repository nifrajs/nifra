import { expect, test } from "bun:test"
import fc from "fast-check"
import { Router } from "../src/router/router.ts"

// Lowercase word for static segments; alphanumeric token (never empty, never a
// slash) for concrete param/wildcard values.
const word = fc
  .array(fc.constantFrom(..."abcdefgh"), { minLength: 1, maxLength: 6 })
  .map((cs) => cs.join(""))
const token = fc
  .array(fc.constantFrom(..."abcdef0123"), { minLength: 1, maxLength: 6 })
  .map((cs) => cs.join(""))

const routeArb = fc.record({
  segments: fc.array(fc.record({ isParam: fc.boolean(), staticVal: word, paramVal: token }), {
    maxLength: 6,
  }),
  // Optional trailing catch-all with a tail of 1–3 segments.
  wildcardTail: fc.option(fc.array(token, { minLength: 1, maxLength: 3 }), { nil: undefined }),
})

test("property: every registered route matches its own concrete path with correct params", () => {
  fc.assert(
    fc.property(routeArb, ({ segments, wildcardTail }) => {
      const router = new Router<number>()
      const pattern: string[] = []
      const concrete: string[] = []
      const expected: Record<string, string> = {}

      segments.forEach((seg, i) => {
        if (seg.isParam) {
          const name = `p${i}` // positional name guarantees uniqueness within the route
          pattern.push(`:${name}`)
          concrete.push(seg.paramVal)
          expected[name] = seg.paramVal
        } else {
          pattern.push(seg.staticVal)
          concrete.push(seg.staticVal)
        }
      })

      if (wildcardTail !== undefined) {
        const tail = wildcardTail.join("/")
        pattern.push("*rest")
        concrete.push(tail)
        expected.rest = tail
      }

      const patternPath = `/${pattern.join("/")}`
      const concretePath = `/${concrete.join("/")}`

      router.add("GET", patternPath, 1)
      const match = router.find("GET", concretePath)

      expect(match.found).toBe(true)
      if (match.found) {
        expect(match.payload).toBe(1)
        expect(match.params).toEqual(expected)
      }
    }),
  )
})

test("property: registering a route twice for the same method always throws", () => {
  fc.assert(
    fc.property(fc.array(word, { minLength: 1, maxLength: 5 }), (parts) => {
      const router = new Router<number>()
      const path = `/${parts.join("/")}`
      router.add("GET", path, 1)
      expect(() => router.add("GET", path, 2)).toThrow()
    }),
  )
})

/**
 * Proves the property-based testing harness (fast-check) is wired in. The
 * property itself is trivial — the real router/validator property suites arrive
 * with the code they guard in Phases 1 and 6.
 */
import { expect, test } from "bun:test"
import fc from "fast-check"

test("property harness: array reversal is involutive", () => {
  fc.assert(
    fc.property(fc.array(fc.integer()), (xs) => {
      expect([...xs].reverse().reverse()).toEqual(xs)
    }),
  )
})

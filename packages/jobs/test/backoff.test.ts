import { describe, expect, test } from "bun:test"
import { exponentialBackoff, fixedBackoff, noBackoff } from "../src/index.ts"

describe("backoff", () => {
  test("exponential: base * 2^(attempt-1), capped at maxMs", () => {
    const b = exponentialBackoff({ baseMs: 1000, maxMs: 8000 })
    expect([b(1), b(2), b(3), b(4), b(5)]).toEqual([1000, 2000, 4000, 8000, 8000])
  })

  test("exponential jitter scales down deterministically with injected random", () => {
    const b = exponentialBackoff({ baseMs: 1000, jitter: 0.5, random: () => 1 })
    expect(b(1)).toBe(500) // 1000 * (1 - 0.5*1)
  })

  test("fixed + none", () => {
    expect(fixedBackoff(250)(7)).toBe(250)
    expect(noBackoff(3)).toBe(0)
  })
})

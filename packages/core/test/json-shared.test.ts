import { describe, expect, test } from "bun:test"
import { define, isPlainPrototype, readsShippedTime } from "../src/server/json-shared.ts"

describe("shared JSON helpers", () => {
  test("recognizes dates with the shipped time-reading methods", () => {
    expect(readsShippedTime(new Date(0))).toBe(true)

    const customPrimitive = new Date(0)
    Object.defineProperty(customPrimitive, Symbol.toPrimitive, { value: () => 0 })
    expect(readsShippedTime(customPrimitive)).toBe(false)

    const customValueOf = new Date(0)
    Object.defineProperty(customValueOf, "valueOf", { value: () => 0 })
    expect(readsShippedTime(customValueOf)).toBe(false)
  })

  test("recognizes plain-record prototypes", () => {
    expect(isPlainPrototype(null)).toBe(true)
    expect(isPlainPrototype(Object.prototype)).toBe(true)
    expect(isPlainPrototype(Object.create(null))).toBe(true)
    expect(isPlainPrototype(Date.prototype)).toBe(false)
  })

  test("defines ordinary fields and keeps __proto__ as an own data property", () => {
    const output: Record<string, unknown> = {}
    const originalPrototype = Object.getPrototypeOf(output)
    const value = { safe: true }

    define(output, "value", value)
    define(output, "__proto__", value)

    expect(output.value).toBe(value)
    expect(Object.getPrototypeOf(output)).toBe(originalPrototype)
    expect(Object.hasOwn(output, "__proto__")).toBe(true)
    expect(Object.getOwnPropertyDescriptor(output, "__proto__")).toMatchObject({
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  })
})

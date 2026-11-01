import { describe, expect, test } from "bun:test"
import { boundedJsonText, JsonByteLimitError } from "../src/server/json-response.ts"

const utf8Length = (text: string): number => new TextEncoder().encode(text).byteLength

describe("boundedJsonText", () => {
  test("counts JSON primitives, escapes, wrappers, omissions, and UTF-8 exactly", () => {
    const tricky =
      'quote " slash \\ controls \b\t\n\f\r\u0000\u0001 é € 😀 \ud800\udc00 lone-high \ud800 lone-low \udc00'
    const value = {
      nullish: null,
      yes: true,
      no: false,
      integer: 7,
      notFinite: Number.NaN,
      text: tricky,
      omitted: undefined,
      callable: () => 1,
      symbol: Symbol("omitted"),
      array: [undefined, () => 1, Symbol("null"), "kept"],
    }
    const result = boundedJsonText(value, 10_000)
    expect(result).toBeDefined()
    expect(result?.text).toBe(
      '{"nullish":null,"yes":true,"no":false,"integer":7,"notFinite":null,' +
        '"text":' +
        JSON.stringify(tricky) +
        ',"array":[null,null,null,"kept"]}',
    )
    expect(result?.byteLength).toBe(utf8Length(result?.text ?? ""))
    expect(boundedJsonText(undefined, 0)).toBeUndefined()
    expect(boundedJsonText(() => 1, 0)).toBeUndefined()
    expect(boundedJsonText(Symbol("omitted"), 0)).toBeUndefined()
  })

  test("handles hooks, boxed values, raw JSON, and bigint hooks", () => {
    let key = ""
    const hooked = {
      toJSON(received: string) {
        key = received
        return { ok: true }
      },
    }
    expect(boundedJsonText(hooked, 20)).toEqual({ text: '{"ok":true}', byteLength: 11 })
    expect(key).toBe("")

    const fn = Object.assign(() => 1, { toJSON: () => "function hook" })
    expect(boundedJsonText(fn, 30)?.text).toBe('"function hook"')
    expect(boundedJsonText(new Number(3), 10)?.text).toBe("3")
    expect(boundedJsonText(new String("wrapped"), 20)?.text).toBe('"wrapped"')
    expect(boundedJsonText(new Boolean(false), 10)?.text).toBe("false")

    const raw = JSON.rawJSON('"😀"')
    expect(boundedJsonText({ raw }, 20)?.text).toBe('{"raw":"😀"}')

    const rawDescriptor = Object.getOwnPropertyDescriptor(JSON, "rawJSON")
    Object.defineProperty(JSON, "rawJSON", { value: undefined, configurable: true, writable: true })
    try {
      expect(() => boundedJsonText(raw, 20)).toThrow("Could not serialize JSON.rawJSON")
    } finally {
      if (rawDescriptor !== undefined) Object.defineProperty(JSON, "rawJSON", rawDescriptor)
    }

    const bigintDescriptor = Object.getOwnPropertyDescriptor(BigInt.prototype, "toJSON")
    Object.defineProperty(BigInt.prototype, "toJSON", {
      configurable: true,
      value: () => "hooked bigint",
    })
    try {
      expect(boundedJsonText(3n, 30)?.text).toBe('"hooked bigint"')
    } finally {
      if (bigintDescriptor === undefined) Reflect.deleteProperty(BigInt.prototype, "toJSON")
      else Object.defineProperty(BigInt.prototype, "toJSON", bigintDescriptor)
    }
  })

  test("rejects unsupported values, cycles, invalid limits, and over-budget wrappers", () => {
    expect(() => boundedJsonText(1n, 20)).toThrow(TypeError)
    expect(() => boundedJsonText(Object(1n), 20)).toThrow(TypeError)
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(() => boundedJsonText(cycle, 100)).toThrow("Converting circular structure to JSON")
    expect(() => boundedJsonText("too large", 2)).toThrow(JsonByteLimitError)
    expect(() => boundedJsonText(new Number(123), 0)).toThrow(JsonByteLimitError)
    expect(() => boundedJsonText(new String("x"), 0)).toThrow(JsonByteLimitError)
    expect(() => boundedJsonText(new Boolean(true), 0)).toThrow(JsonByteLimitError)
    expect(() => boundedJsonText({}, -1)).toThrow("non-negative safe integer")
    expect(() => boundedJsonText({}, 1.5)).toThrow("non-negative safe integer")
  })
})

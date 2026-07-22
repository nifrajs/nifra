import { describe, expect, test } from "bun:test"
import { decode, encode, parse, stringify, type Wire, WireDecodeError, WireEncodeError } from "../src/wire.ts"

/** Round-trip through the full JSON transport (encode -> JSON string -> parse -> decode). */
const rt = <T>(value: T): unknown => parse(stringify(value))

describe("wire codec: types plain JSON loses", () => {
  test("undefined survives - top level, in object, in array", () => {
    expect(rt(undefined)).toBeUndefined()
    expect(rt({ a: undefined, b: 1 })).toEqual({ a: undefined, b: 1 })
    expect(rt([undefined, 2])).toEqual([undefined, 2])
    expect(JSON.parse(JSON.stringify({ a: undefined, b: 1 }))).toEqual({ b: 1 }) // contrast
  })

  test("Date round-trips as a Date, not a string", () => {
    const d = new Date("2026-07-23T01:15:53.000Z")
    const out = rt(d)
    expect(out).toBeInstanceOf(Date)
    expect((out as Date).getTime()).toBe(d.getTime())
    expect(typeof JSON.parse(JSON.stringify(d))).toBe("string") // contrast
  })

  test("an invalid Date round-trips as an invalid Date", () => {
    expect((rt(new Date(NaN)) as Date).getTime()).toBeNaN()
  })

  test("BigInt round-trips (plain JSON throws on it)", () => {
    expect(rt(9007199254740993n)).toBe(9007199254740993n)
    expect(() => JSON.stringify(1n)).toThrow()
  })

  test("non-finite numbers and negative zero survive", () => {
    expect(rt(NaN)).toBeNaN()
    expect(rt(Infinity)).toBe(Infinity)
    expect(rt(-Infinity)).toBe(-Infinity)
    expect(Object.is(rt(-0), -0)).toBe(true) // JSON collapses -0 to 0
    expect(Object.is(JSON.parse(JSON.stringify(-0)), -0)).toBe(false) // contrast
  })

  test("Map round-trips, including rich keys and values", () => {
    const m = new Map<unknown, unknown>([
      ["k", 1],
      [42, new Date(0)],
      [{ id: 1 }, [1n, 2n]],
    ])
    const out = rt(m)
    expect(out).toBeInstanceOf(Map)
    expect(out).toEqual(m)
  })

  test("Set round-trips", () => {
    const s = new Set([1, "two", 3n])
    expect(rt(s)).toBeInstanceOf(Set)
    expect(rt(s)).toEqual(s)
  })

  test("RegExp and URL round-trip", () => {
    expect(rt(/ab+c/gi)).toEqual(/ab+c/gi)
    const u = new URL("https://example.com/p?q=1#h")
    expect(rt(u)).toEqual(u)
  })
})

describe("wire codec: binary", () => {
  const kinds: Array<[string, ArrayLike<number | bigint> & object]> = [
    ["Int8Array", new Int8Array([-1, 0, 127])],
    ["Uint8Array", new Uint8Array([0, 1, 255])],
    ["Uint8ClampedArray", new Uint8ClampedArray([0, 128, 255])],
    ["Int16Array", new Int16Array([-32768, 0, 32767])],
    ["Uint16Array", new Uint16Array([0, 65535])],
    ["Int32Array", new Int32Array([-2147483648, 2147483647])],
    ["Uint32Array", new Uint32Array([0, 4294967295])],
    ["Float32Array", new Float32Array([1.5, -2.5])],
    ["Float64Array", new Float64Array([Math.PI, -Math.E])],
    ["BigInt64Array", new BigInt64Array([-9223372036854775808n, 0n])],
    ["BigUint64Array", new BigUint64Array([0n, 18446744073709551615n])],
  ]
  for (const [name, value] of kinds) {
    test(`${name} round-trips element-for-element`, () => {
      const out = rt(value)
      expect((out as object).constructor.name).toBe(name)
      expect(Array.from(out as Iterable<unknown>)).toEqual(Array.from(value as unknown as Iterable<unknown>))
    })
  }

  test("ArrayBuffer and DataView round-trip", () => {
    const buf = new Uint8Array([1, 2, 3, 4]).buffer
    const outBuf = rt(buf)
    expect(outBuf).toBeInstanceOf(ArrayBuffer)
    expect(Array.from(new Uint8Array(outBuf as ArrayBuffer))).toEqual([1, 2, 3, 4])

    const dv = new DataView(new Uint8Array([9, 8, 7]).buffer)
    const outDv = rt(dv)
    expect(outDv).toBeInstanceOf(DataView)
    expect((outDv as DataView).getUint8(0)).toBe(9)
  })

  test("a large typed array crosses the base64 chunk boundary intact", () => {
    const big = new Uint8Array(70_000)
    for (let i = 0; i < big.length; i++) big[i] = i % 256
    const out = rt(big) as Uint8Array
    expect(out.length).toBe(70_000)
    expect(out[0]).toBe(0)
    expect(out[69_999]).toBe(69_999 % 256)
  })
})

describe("wire codec: references and cycles", () => {
  test("a shared reference decodes to a single shared instance", () => {
    const shared = { id: 1 }
    const out = rt({ a: shared, b: shared }) as { a: unknown; b: unknown }
    expect(out.a).toEqual({ id: 1 })
    expect(out.a).toBe(out.b) // identity preserved, and encoded once
  })

  test("a self-referential object round-trips", () => {
    const a: Record<string, unknown> = { name: "a" }
    a.self = a
    const out = decode(encode(a)) as Record<string, unknown>
    expect(out.name).toBe("a")
    expect(out.self).toBe(out)
  })

  test("a mutual cycle round-trips", () => {
    const a: Record<string, unknown> = {}
    const b: Record<string, unknown> = {}
    a.b = b
    b.a = a
    const out = decode(encode(a)) as { b: { a: unknown } }
    expect(out.b.a).toBe(out)
  })

  test("an array that contains itself round-trips", () => {
    const a: unknown[] = [1]
    a.push(a)
    const out = decode(encode(a)) as unknown[]
    expect(out[0]).toBe(1)
    expect(out[1]).toBe(out)
  })
})

describe("wire codec: fidelity and safety", () => {
  test("a deeply nested mix round-trips intact", () => {
    const value = {
      when: new Date("2020-01-01T00:00:00.000Z"),
      counts: new Map([["a", 1n]]),
      tags: new Set(["x", "y"]),
      maybe: undefined,
      ratio: Infinity,
      nested: [{ pattern: /x/i, blob: new Uint8Array([9, 8]) }],
    }
    expect(rt(value)).toEqual(value)
  })

  test("plain JSON data still round-trips unchanged", () => {
    const value = { a: 1, b: "two", c: [true, null, 3.5], d: { e: false } }
    expect(rt(value)).toEqual(value)
  })

  test("an object that itself owns the reserved key stays a plain object", () => {
    const value = { $w: "date", v: "not-a-real-date", other: 1 }
    const out = rt(value)
    expect(out).toEqual(value) // never decoded as a Date
    expect(out).not.toBeInstanceOf(Date)
  })

  test("functions and symbols are rejected, never silently dropped", () => {
    expect(() => encode(() => 1)).toThrow(WireEncodeError)
    expect(() => encode(Symbol("x"))).toThrow(WireEncodeError)
    expect(() => encode({ ok: 1, bad: () => 2 })).toThrow(WireEncodeError)
  })

  test("malformed wire input throws a typed decode error", () => {
    expect(() => decode({ nope: true } as unknown as Wire)).toThrow(WireDecodeError) // not { r, n }
    expect(() => decode({ r: { $w: "ref", i: 5 }, n: [] })).toThrow(WireDecodeError) // ref out of range
    expect(() => decode({ r: { $w: "ref", i: 0 }, n: [{ $w: "mystery" }] })).toThrow(WireDecodeError) // unknown tag
    expect(() => decode({ r: { $w: "ref", i: 0 }, n: [{ $w: "ta", k: "Nope", v: "" }] })).toThrow(WireDecodeError)
  })
})

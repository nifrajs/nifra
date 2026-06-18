import { describe, expect, test } from "bun:test"
import { defineEnv, env, type StandardSchemaV1 } from "../src/index.ts"

describe("env coercing helpers", () => {
  test("string: required / default / optional", () => {
    expect(defineEnv({ A: env.string() }, { source: { A: "x" } }).A).toBe("x")
    expect(defineEnv({ A: env.string({ default: "d" }) }, { source: {} }).A).toBe("d")
    expect(defineEnv({ A: env.string({ optional: true }) }, { source: {} }).A).toBeUndefined()
    expect(() => defineEnv({ A: env.string() }, { source: {} })).toThrow(/A: is required/)
    expect(() => defineEnv({ A: env.string() }, { source: { A: "" } })).toThrow(/A: is required/)
  })

  test("number: coerces, rejects non-numeric", () => {
    expect(defineEnv({ N: env.number() }, { source: { N: "42" } }).N).toBe(42)
    expect(defineEnv({ N: env.number() }, { source: { N: "3.14" } }).N).toBe(3.14)
    expect(defineEnv({ N: env.number({ default: 7 }) }, { source: {} }).N).toBe(7)
    expect(() => defineEnv({ N: env.number() }, { source: { N: "abc" } })).toThrow(
      /N: must be a number/,
    )
  })

  test("port: integer 1–65535", () => {
    expect(defineEnv({ P: env.port({ default: 3000 }) }, { source: {} }).P).toBe(3000)
    expect(defineEnv({ P: env.port() }, { source: { P: "8080" } }).P).toBe(8080)
    expect(() => defineEnv({ P: env.port() }, { source: { P: "70000" } })).toThrow(
      /port in 1–65535/,
    )
    expect(() => defineEnv({ P: env.port() }, { source: { P: "1.5" } })).toThrow(/port in 1–65535/)
  })

  test("boolean: truthy/falsy strings, case-insensitive", () => {
    for (const v of ["true", "1", "YES", "On"]) {
      expect(defineEnv({ B: env.boolean() }, { source: { B: v } }).B).toBe(true)
    }
    for (const v of ["false", "0", "no", "OFF", ""]) {
      expect(defineEnv({ B: env.boolean() }, { source: { B: v } }).B).toBe(false)
    }
    expect(defineEnv({ B: env.boolean({ default: true }) }, { source: {} }).B).toBe(true)
    expect(() => defineEnv({ B: env.boolean() }, { source: { B: "maybe" } })).toThrow(
      /must be a boolean/,
    )
  })

  test("enum: one-of with default", () => {
    const shape = { E: env.enum(["development", "production", "test"], { default: "development" }) }
    expect(defineEnv(shape, { source: { E: "production" } }).E).toBe("production")
    expect(defineEnv(shape, { source: {} }).E).toBe("development")
    expect(() => defineEnv({ E: env.enum(["a", "b"]) }, { source: { E: "c" } })).toThrow(
      /must be one of: a, b/,
    )
  })

  test("url: validates + normalizes", () => {
    expect(defineEnv({ U: env.url() }, { source: { U: "https://x.com" } }).U).toBe("https://x.com/")
    expect(() => defineEnv({ U: env.url() }, { source: { U: "not a url" } })).toThrow(
      /must be a valid URL/,
    )
    expect(defineEnv({ U: env.url({ optional: true }) }, { source: {} }).U).toBeUndefined()
  })
})

describe("defineEnv", () => {
  test("returns a frozen typed object", () => {
    const ENV = defineEnv({ A: env.string() }, { source: { A: "x" } })
    expect(Object.isFrozen(ENV)).toBe(true)
  })

  test("aggregates ALL problems into one error (not just the first)", () => {
    let message = ""
    try {
      defineEnv(
        { A: env.string(), N: env.number(), P: env.port() },
        { source: { N: "nope" } }, // A missing, N invalid, P missing
      )
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain("3 problem(s)")
    expect(message).toContain("A: is required")
    expect(message).toContain("N: must be a number")
    expect(message).toContain("P: is required")
  })

  test("error messages never echo the variable's value (secret-safe)", () => {
    let message = ""
    try {
      defineEnv({ SECRET: env.number() }, { source: { SECRET: "sk_live_supersecret_value" } })
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain("SECRET: must be a number")
    expect(message).not.toContain("sk_live_supersecret_value")
  })

  test("accepts a BYO Standard Schema (no coercion), validating the raw string", () => {
    const upper: StandardSchemaV1<string> = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: (v: unknown) =>
          typeof v === "string" && v === v.toUpperCase()
            ? { value: v }
            : { issues: [{ message: "must be uppercase" }] },
      },
    }
    expect(defineEnv({ CODE: upper }, { source: { CODE: "ABC" } }).CODE).toBe("ABC")
    expect(() => defineEnv({ CODE: upper }, { source: { CODE: "abc" } })).toThrow(
      /CODE: must be uppercase/,
    )
  })

  test("an async validator is reported, not left dangling", () => {
    const asyncSchema: StandardSchemaV1<string> = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: () => Promise.resolve({ value: "x" }),
      },
    }
    expect(() => defineEnv({ A: asyncSchema }, { source: { A: "x" } })).toThrow(
      /async validators are not supported/,
    )
  })
})

import { describe, expect, test } from "bun:test"
import { defineEnv, env, type StandardSchemaV1 } from "../src/index.ts"

/**
 * A rejected promise that counts the handlers `catch` attaches to it. The refusal is caught with
 * try/catch: Bun's `toThrow` reports a promise rejected inside its callback even once it is handled.
 */
function watchedRejection(): { promise: Promise<never>; observed: () => number } {
  let observed = 0
  class Watched<T> extends Promise<T> {
    override catch<R = never>(
      onRejected?: ((reason: unknown) => R | PromiseLike<R>) | null,
    ): Promise<T | R> {
      observed++
      return super.catch(onRejected)
    }
  }
  return { promise: Watched.reject(new Error("synthetic async failure")), observed: () => observed }
}

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

  test("number and port read decimal text only, and space alone as unset", () => {
    const number = (N: string) => defineEnv({ N: env.number({ default: 7 }) }, { source: { N } }).N
    expect(number(" 42 ")).toBe(42)
    expect(number("-.5")).toBe(-0.5)
    expect(number("   ")).toBe(7)
    for (const N of ["0x10", "1e3", "0b1", "Infinity", "4 2"]) {
      expect(() => number(N)).toThrow(/must be a number/)
    }
    expect(() => defineEnv({ N: env.number() }, { source: { N: " " } })).toThrow(/N: is required/)
    const port = (P: string) => defineEnv({ P: env.port({ default: 3000 }) }, { source: { P } }).P
    expect(port(" ")).toBe(3000)
    expect(port(" 8080 ")).toBe(8080)
    for (const P of ["0x50", "8e3", "+80"]) expect(() => port(P)).toThrow(/port in 1-65535/)
  })

  test("port: integer 1-65535", () => {
    expect(defineEnv({ P: env.port({ default: 3000 }) }, { source: {} }).P).toBe(3000)
    expect(defineEnv({ P: env.port() }, { source: { P: "8080" } }).P).toBe(8080)
    expect(() => defineEnv({ P: env.port() }, { source: { P: "70000" } })).toThrow(
      /port in 1-65535/,
    )
    expect(() => defineEnv({ P: env.port() }, { source: { P: "1.5" } })).toThrow(/port in 1-65535/)
  })

  test("boolean: truthy/falsy strings, case-insensitive", () => {
    for (const v of ["true", "1", "YES", "On"]) {
      expect(defineEnv({ B: env.boolean() }, { source: { B: v } }).B).toBe(true)
    }
    for (const v of ["false", "0", "no", "OFF", ""]) {
      expect(defineEnv({ B: env.boolean() }, { source: { B: v } }).B).toBe(false)
    }
    expect(defineEnv({ B: env.boolean({ default: true }) }, { source: {} }).B).toBe(true)
    expect(defineEnv({ B: env.boolean({ default: true }) }, { source: { B: " " } }).B).toBe(true)
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

  test("required-when-unset: every helper errors, and optional/default short-circuit it", () => {
    // The unset branch of each helper - the miss it takes when the variable is absent and there is
    // neither a default nor `optional`. Each helper owns its own copy of this branch.
    expect(() => defineEnv({ N: env.number() }, { source: {} })).toThrow(/N: is required/)
    expect(defineEnv({ N: env.number({ optional: true }) }, { source: {} }).N).toBeUndefined()
    expect(() => defineEnv({ B: env.boolean() }, { source: {} })).toThrow(/B: is required/)
    expect(() => defineEnv({ E: env.enum(["a", "b"]) }, { source: {} })).toThrow(
      /E: is required \(one of: a, b\)/,
    )
    expect(() => defineEnv({ U: env.url() }, { source: {} })).toThrow(/U: is required/)
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

  test("a BYO validator's message is withheld for a set value, in whatever form it quotes it", () => {
    const quoting = (format: (value: string) => string): StandardSchemaV1<string> => ({
      "~standard": {
        version: 1 as const,
        vendor: "valibot",
        validate: (v: unknown) => ({ issues: [{ message: format(String(v)) }] }),
      },
    })
    const cases = [
      [(v: string) => `Received ${JSON.stringify(v)}`, 'sk_live_"quoted"\\tail', 'quoted\\"'],
      [
        (v: string) => `Received "${v.slice(0, 12)}..."`,
        "sk_live_abcdefghijklmnop",
        "sk_live_abcd",
      ],
      [(v: string) => `Received ${v.toUpperCase()}`, "sk_live_lower", "SK_LIVE_LOWER"],
    ] as const
    for (const [format, secret, fragment] of cases) {
      let message = ""
      try {
        defineEnv({ SECRET: quoting(format) }, { source: { SECRET: secret } })
      } catch (e) {
        message = e instanceof Error ? e.message : ""
      }
      expect(message).toContain("SECRET: is invalid (the validator's message is withheld")
      expect(message).not.toContain(fragment)
      expect(message).not.toContain("Received")
    }
  })

  test("a BYO validator's message for an unset value is shown: there is no value to quote", () => {
    const required: StandardSchemaV1<string> = {
      "~standard": {
        version: 1 as const,
        vendor: "zod",
        validate: (v: unknown) =>
          typeof v === "string" && v !== ""
            ? { value: v }
            : { issues: [{ message: "Invalid input: expected string" }] },
      },
    }
    expect(() => defineEnv({ TOKEN: required }, { source: {} })).toThrow(
      /TOKEN: Invalid input: expected string/,
    )
    expect(() => defineEnv({ TOKEN: required }, { source: { TOKEN: "" } })).toThrow(
      /TOKEN: Invalid input: expected string/,
    )
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
      /CODE: is invalid/,
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

  test("a rejecting async validator is observed, so it is not left unhandled", () => {
    const rejection = watchedRejection()
    const rejecting: StandardSchemaV1<string> = {
      "~standard": { version: 1 as const, vendor: "test", validate: () => rejection.promise },
    }
    let refusal = ""
    try {
      defineEnv({ A: rejecting }, { source: { A: "x" } })
    } catch (error) {
      refusal = String(error)
    }
    expect(refusal).toContain("async validators are not supported")
    expect(rejection.observed()).toBeGreaterThan(0)
  })
})

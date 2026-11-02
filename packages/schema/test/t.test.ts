import { describe, expect, test } from "bun:test"
import { validateStandard } from "@nifrajs/core/schema"
import { t } from "../src/index.ts"

/**
 * Runtime contract for `t`. `validateStandard` is `@nifrajs/core`'s own normalizer -
 * using it here also proves the adapter is spec-compliant from the framework's
 * vantage point, not just structurally.
 */

describe("primitives", () => {
  test("string accepts strings, rejects non-strings", async () => {
    expect(await validateStandard(t.string(), "hi")).toEqual({ ok: true, value: "hi" })
    const bad = await validateStandard(t.string(), 42)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.issues.length).toBeGreaterThan(0)
  })

  test("number vs integer", async () => {
    expect(await validateStandard(t.number(), 3.14)).toEqual({ ok: true, value: 3.14 })
    expect(await validateStandard(t.integer(), 7)).toEqual({ ok: true, value: 7 })
    expect((await validateStandard(t.integer(), 3.14)).ok).toBe(false)
  })

  test("integer refuses what a JSON or query number cannot carry exactly", async () => {
    // `JSON.parse` already turned 9007199254740993 into this value: it must not pass as the original.
    const rounded: number = JSON.parse("9007199254740993")
    expect((await validateStandard(t.integer(), rounded)).ok).toBe(false)
    expect((await validateStandard(t.integer(), -rounded)).ok).toBe(false)
    expect(await validateStandard(t.integer(), Number.MAX_SAFE_INTEGER)).toEqual({
      ok: true,
      value: Number.MAX_SAFE_INTEGER,
    })
    expect(t.integer().jsonSchema).toMatchObject({
      minimum: Number.MIN_SAFE_INTEGER,
      maximum: Number.MAX_SAFE_INTEGER,
    })
    // A bound of the caller's own replaces the default on that side only.
    expect(t.integer({ minimum: 0 }).jsonSchema).toMatchObject({
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    })
  })

  test("boolean / literal / null", async () => {
    expect(await validateStandard(t.boolean(), true)).toEqual({ ok: true, value: true })
    expect(await validateStandard(t.literal("active"), "active")).toEqual({
      ok: true,
      value: "active",
    })
    expect((await validateStandard(t.literal("active"), "nope")).ok).toBe(false)
    expect(await validateStandard(t.null(), null)).toEqual({ ok: true, value: null })
  })

  test("constraints (options) are enforced", async () => {
    expect((await validateStandard(t.string({ minLength: 3 }), "ab")).ok).toBe(false)
    expect((await validateStandard(t.string({ minLength: 3 }), "abc")).ok).toBe(true)
    expect((await validateStandard(t.number({ minimum: 0 }), -1)).ok).toBe(false)
  })
})

describe("composites", () => {
  const user = t.object({ name: t.string(), age: t.integer() })

  test("object accepts valid, rejects missing/invalid fields", async () => {
    expect(await validateStandard(user, { name: "Ada", age: 36 })).toEqual({
      ok: true,
      value: { name: "Ada", age: 36 },
    })
    expect((await validateStandard(user, { name: "Ada" })).ok).toBe(false)
    expect((await validateStandard(user, { name: 1, age: 36 })).ok).toBe(false)
  })

  test("object rejects unknown fields by default; looseObject / opt-out accept them", async () => {
    // Strict by default: an extra key fails validation (no mass-assignment via c.body).
    expect((await validateStandard(user, { name: "Ada", age: 36, admin: true })).ok).toBe(false)
    // t.looseObject accepts + passes through the extra key. (Its Static type is still `{ name }` -
    // TypeBox widens the runtime, not the type - so read the passthrough via a Record cast.)
    const loose = t.looseObject({ name: t.string() })
    const r = await validateStandard(loose, { name: "Ada", admin: true })
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.value as Record<string, unknown>).admin).toBe(true)
    // An explicit { additionalProperties: true } on t.object opts out of the strict default too.
    const opened = t.object({ name: t.string() }, { additionalProperties: true })
    expect((await validateStandard(opened, { name: "Ada", admin: true })).ok).toBe(true)
  })

  test("__proto__ cannot be declared as a field of an object or a text-field record", () => {
    const props: Record<string, ReturnType<typeof t.string>> = Object.create(null)
    Object.defineProperty(props, "__proto__", { value: t.string(), enumerable: true })
    props.id = t.string()
    for (const build of [t.object, t.looseObject, t.query, t.cookies, t.headers])
      expect(() => build(props)).toThrow('"__proto__" cannot be a field name')
  })

  test("a nested failure carries its path", async () => {
    const r = await validateStandard(user, { name: 123, age: 36 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues[0]?.path).toEqual(["name"])
  })

  test("array", async () => {
    expect(await validateStandard(t.array(t.string()), ["a", "b"])).toEqual({
      ok: true,
      value: ["a", "b"],
    })
    expect((await validateStandard(t.array(t.string()), ["a", 2])).ok).toBe(false)
  })

  test("optional property may be omitted but is checked when present", async () => {
    const s = t.object({ name: t.string(), nick: t.optional(t.string()) })
    expect((await validateStandard(s, { name: "Ada" })).ok).toBe(true)
    expect((await validateStandard(s, { name: "Ada", nick: "A" })).ok).toBe(true)
    expect((await validateStandard(s, { name: "Ada", nick: 9 })).ok).toBe(false)
  })

  test("union accepts either branch, rejects neither", async () => {
    const s = t.union([t.string(), t.number()])
    expect((await validateStandard(s, "x")).ok).toBe(true)
    expect((await validateStandard(s, 5)).ok).toBe(true)
    expect((await validateStandard(s, true)).ok).toBe(false)
  })

  test("record", async () => {
    const s = t.record(t.number())
    expect(await validateStandard(s, { a: 1, b: 2 })).toEqual({ ok: true, value: { a: 1, b: 2 } })
    expect((await validateStandard(s, { a: "x" })).ok).toBe(false)
  })
})

describe("jsonSchema (the OpenAPI substrate)", () => {
  test("a t schema serializes to clean JSON Schema - no Symbol metadata leaks", () => {
    const schema = t.object({ name: t.string(), age: t.integer() })
    const json = JSON.parse(JSON.stringify(schema.jsonSchema))
    expect(json).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        age: {
          type: "integer",
          minimum: Number.MIN_SAFE_INTEGER,
          maximum: Number.MAX_SAFE_INTEGER,
        },
      },
      required: ["name", "age"],
      additionalProperties: false, // t.object is strict by default
    })
  })

  test("options surface as JSON Schema constraints", () => {
    const json = JSON.parse(JSON.stringify(t.string({ minLength: 3, format: "email" }).jsonSchema))
    expect(json).toEqual({ type: "string", minLength: 3, format: "email" })
  })
})

describe("t.query (coercing query-slot schema)", () => {
  test("coerces string query values to their declared scalar types", async () => {
    const q = t.query({ city_id: t.integer(), active: t.boolean(), name: t.string() })
    // Every value arrives as a string over HTTP; t.query coerces per the declared type.
    const ok = await validateStandard(q, { city_id: "3", active: "true", name: "delhi" })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.value).toEqual({ city_id: 3, active: true, name: "delhi" })
    // A non-coercible value still fails (stays a string, rejected by the integer type).
    expect((await validateStandard(q, { city_id: "abc", active: "true", name: "x" })).ok).toBe(
      false,
    )
    // Past the safe range the coerced number is not the one sent, so it is refused, not rounded.
    expect(
      (await validateStandard(q, { city_id: "9007199254740993", active: "true", name: "x" })).ok,
    ).toBe(false)
  })

  test("a plain t.object in a query slot does NOT coerce - the footgun t.query fixes", async () => {
    const plain = t.object({ city_id: t.integer() })
    expect((await validateStandard(plain, { city_id: "3" })).ok).toBe(false) // "3" is not an integer
    expect((await validateStandard(t.query({ city_id: t.integer() }), { city_id: "3" })).ok).toBe(
      true,
    )
  })

  test("open by default (unknown query field accepted), opt into strict with additionalProperties", async () => {
    const open = t.query({ page: t.integer() })
    expect((await validateStandard(open, { page: "2", utm: "x" })).ok).toBe(true)
    const strict = t.query({ page: t.integer() }, { additionalProperties: false })
    expect((await validateStandard(strict, { page: "2", utm: "x" })).ok).toBe(false)
  })
})

describe("t.headers (open, coercing header-slot schema)", () => {
  test("coerces declared header values and keeps every other header", async () => {
    const h = t.headers({ "x-retry": t.integer(), "x-dry-run": t.optional(t.boolean()) })
    const ok = await validateStandard(h, { "x-retry": "3", "user-agent": "client/1.0" })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect<unknown>(ok.value).toEqual({ "x-retry": 3, "user-agent": "client/1.0" })
    expect((await validateStandard(h, { "x-retry": "soon" })).ok).toBe(false)
  })

  test("refuses an upper-case name, which an open schema would never receive", () => {
    expect(() => t.headers({ "X-Retry": t.integer() })).toThrow(/declare "x-retry"/)
  })
})

describe("t.json", () => {
  test("accepts any JSON value at any depth", async () => {
    for (const value of [null, "s", 0, -1.5, true, [], {}, { a: [1, { b: null }], c: "x" }]) {
      expect(await validateStandard(t.json(), value)).toEqual({ ok: true, value })
    }
    // An undefined property is dropped by JSON, so it is no reason to refuse.
    expect((await validateStandard(t.json(), { a: 1, b: undefined })).ok).toBe(true)
  })

  test("refuses what JSON would lose or change", async () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    for (const value of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      () => 1,
      10n,
      new Date(0),
      new Map(),
      [undefined],
      { nested: { at: new Date(0) } },
      cycle,
    ]) {
      expect((await validateStandard(t.json(), value)).ok).toBe(false)
    }
  })

  test("works as a field and describes itself as any value", async () => {
    const schema = t.object({ payload: t.json() })
    expect((await validateStandard(schema, { payload: { tool: "x", args: [1] } })).ok).toBe(true)
    expect((await validateStandard(schema, { payload: () => 1 })).ok).toBe(false)
    expect(JSON.parse(JSON.stringify(t.json().jsonSchema))).toEqual({ "x-nifra-json": true })
  })
})

describe("t.date", () => {
  test("accepts a valid Date, or an RFC 3339 date-time it hands on as one", async () => {
    const at = new Date("2026-10-07T12:00:00.000Z")
    expect(await validateStandard(t.date(), at)).toEqual({ ok: true, value: at })
    for (const written of ["2026-10-07T12:00:00Z", "2026-10-07t14:00:00.000+02:00"])
      expect(await validateStandard(t.date(), written)).toEqual({ ok: true, value: at })
    for (const value of [
      new Date(Number.NaN),
      "2026-02-30T12:00:00Z",
      "2026-10-07T12:00:00",
      "2026-10-07T23:59:60Z",
      "2026-10-07",
      0,
      null,
    ]) {
      expect((await validateStandard(t.date(), value)).ok).toBe(false)
    }
  })

  test("describes itself as a date-time string", () => {
    expect(JSON.parse(JSON.stringify(t.date().jsonSchema))).toEqual({
      type: "string",
      format: "date-time",
      "x-nifra-date": true,
    })
  })
})

describe("t.bytes", () => {
  test("accepts a Uint8Array and the base64 it is written as", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255])
    expect(await validateStandard(t.bytes(), bytes)).toEqual({ ok: true, value: bytes })
    expect((await validateStandard(t.bytes(), Buffer.from(bytes))).ok).toBe(true)
    for (const value of ["AAEC+v8=", "", "AAECAw==", "AAECAwQ="]) {
      expect((await validateStandard(t.bytes(), value)).ok).toBe(true)
    }
    for (const value of ["AAEC+v8", "AAE=C+v8", "AAEC-v8_", "not base64!", 1, null, [1, 2]]) {
      expect((await validateStandard(t.bytes(), value)).ok).toBe(false)
    }
  })

  test("describes itself as a base64 string", () => {
    expect(JSON.parse(JSON.stringify(t.bytes().jsonSchema))).toEqual({
      type: "string",
      contentEncoding: "base64",
      "x-nifra-bytes": true,
    })
  })
})

import { describe, expect, test } from "bun:test"
import { validateStandard } from "@nifrajs/core/schema"
import { t } from "../src/index.ts"

/**
 * Runtime contract for `t`. `validateStandard` is `@nifrajs/core`'s own normalizer —
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
    // t.looseObject accepts + passes through the extra key. (Its Static type is still `{ name }` —
    // TypeBox widens the runtime, not the type — so read the passthrough via a Record cast.)
    const loose = t.looseObject({ name: t.string() })
    const r = await validateStandard(loose, { name: "Ada", admin: true })
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.value as Record<string, unknown>).admin).toBe(true)
    // An explicit { additionalProperties: true } on t.object opts out of the strict default too.
    const opened = t.object({ name: t.string() }, { additionalProperties: true })
    expect((await validateStandard(opened, { name: "Ada", admin: true })).ok).toBe(true)
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
  test("a t schema serializes to clean JSON Schema — no Symbol metadata leaks", () => {
    const schema = t.object({ name: t.string(), age: t.integer() })
    const json = JSON.parse(JSON.stringify(schema.jsonSchema))
    expect(json).toEqual({
      type: "object",
      properties: { name: { type: "string" }, age: { type: "integer" } },
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
    expect((await validateStandard(q, { city_id: "abc", active: "true", name: "x" })).ok).toBe(false)
  })

  test("a plain t.object in a query slot does NOT coerce - the footgun t.query fixes", async () => {
    const plain = t.object({ city_id: t.integer() })
    expect((await validateStandard(plain, { city_id: "3" })).ok).toBe(false) // "3" is not an integer
    expect((await validateStandard(t.query({ city_id: t.integer() }), { city_id: "3" })).ok).toBe(
      true,
    )
  })

  test("strict by default (unknown query field rejected), opt out with additionalProperties", async () => {
    const strict = t.query({ page: t.integer() })
    expect((await validateStandard(strict, { page: "2", utm: "x" })).ok).toBe(false)
    const loose = t.query({ page: t.integer() }, { additionalProperties: true })
    expect((await validateStandard(loose, { page: "2", utm: "x" })).ok).toBe(true)
  })
})

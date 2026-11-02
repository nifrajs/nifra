import { describe, expect, test } from "bun:test"
import { Kind, Type, TypeRegistry } from "@sinclair/typebox"
import { fromTypeBox, type NifraSchema, t } from "../src/index.ts"

const AT = new Date("2026-10-25T12:00:00.000Z")
const ISO = "2026-10-25T12:00:00.000Z"

function decoded(schema: NifraSchema, value: unknown): unknown {
  const outcome = schema["~standard"].validate(value)
  if (outcome instanceof Promise || outcome.issues !== undefined)
    throw new Error("expected the value to pass")
  return outcome.value
}

describe("t.date() in a request value", () => {
  test("a date-time string becomes the instant it names, offset and all", () => {
    expect(decoded(t.date(), ISO)).toEqual(AT)
    expect(decoded(t.date(), "2026-10-25T14:00:00+02:00")).toEqual(AT)
    expect(decoded(t.date(), "2026-10-25T12:00:00.000999Z")).toEqual(AT)
    expect(decoded(t.date(), "2026-10-25T12:00:00.1Z")).toEqual(new Date(AT.getTime() + 100))
    const early = decoded(t.date(), "0050-03-01T00:00:00Z")
    expect(early instanceof Date && early.toISOString()).toBe("0050-03-01T00:00:00.000Z")
    expect(decoded(t.date(), AT)).toBe(AT)
  })

  test("decodes at every depth and copies only what holds a decoded value", () => {
    const schema = t.object({
      name: t.string(),
      looksLikeADate: t.string(),
      tags: t.array(t.string()),
      at: t.date(),
      later: t.optional(t.date()),
      items: t.array(t.object({ when: t.date() })),
    })
    const tags = ["a"]
    const input = { name: "a", looksLikeADate: ISO, tags, at: ISO, items: [{ when: ISO }] }
    const before = structuredClone(input)
    const out = decoded(schema, input)
    expect(out).toEqual({ ...input, at: AT, items: [{ when: AT }] })
    expect(input).toEqual(before)
    expect(out !== input && Reflect.get(Object(out), "tags")).toBe(tags)
    const settled = { name: "a", looksLikeADate: ISO, tags, at: AT, items: [] }
    expect(decoded(schema, settled)).toBe(settled)
  })

  test("a record decodes every value, a __proto__ key included, and keeps the prototype", () => {
    const input = JSON.parse(`{"a":"${ISO}","__proto__":"${ISO}"}`)
    const out = decoded(t.record(t.date()), input)
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(Object.getOwnPropertyDescriptor(out, "__proto__")?.value).toEqual(AT)
    expect(Reflect.get(Object(out), "a")).toEqual(AT)
  })

  test("in a union the first branch that accepts the value decides", () => {
    expect(decoded(t.union([t.date(), t.null()]), ISO)).toEqual(AT)
    expect(decoded(t.union([t.date(), t.null()]), null)).toBe(null)
    expect(decoded(t.union([t.date(), t.string()]), ISO)).toEqual(AT)
    expect(decoded(t.union([t.date(), t.string()]), "soon")).toBe("soon")
    expect(decoded(t.union([t.string(), t.date()]), ISO)).toBe(ISO)
    const event = t.union([
      t.object({ kind: t.literal("at"), when: t.date() }),
      t.object({ kind: t.literal("label"), when: t.string() }),
    ])
    expect(decoded(event, { kind: "at", when: ISO })).toEqual({ kind: "at", when: AT })
    expect(decoded(event, { kind: "label", when: ISO })).toEqual({ kind: "label", when: ISO })
  })

  test("a query converts its other fields from text and decodes a date", () => {
    const query = t.query({ from: t.date(), limit: t.integer() })
    expect(decoded(query, { from: ISO, limit: "10", utm: "x" })).toEqual({
      from: AT,
      limit: 10,
      utm: "x",
    })
  })

  test("TypeBox's tuple, intersect and additionalProperties are followed", () => {
    const date = t.date().jsonSchema
    const pair = fromTypeBox(Type.Tuple([date, Type.String()]))
    expect(decoded(pair, [ISO, ISO])).toEqual([AT, ISO])
    const both = fromTypeBox(
      Type.Intersect([Type.Object({ a: date }), Type.Object({ b: Type.String() })]),
    )
    expect(decoded(both, { a: ISO, b: ISO })).toEqual({ a: AT, b: ISO })
    const rest = fromTypeBox(Type.Object({ a: Type.String() }, { additionalProperties: date }))
    expect(decoded(rest, { a: ISO, z: ISO })).toEqual({ a: ISO, z: AT })
    const patterned = fromTypeBox(Type.Record(Type.String({ pattern: "^at_" }), date))
    expect(decoded(patterned, { at_x: ISO })).toEqual({ at_x: AT })
  })

  test("a key pattern is read as TypeBox reads it, without flags", () => {
    const date = t.date().jsonSchema
    // `\\-` is an escape only without the `u` flag.
    const dashed = fromTypeBox(Type.Record(Type.String({ pattern: "^a\\-" }), date))
    expect(decoded(dashed, { "a-1": ISO })).toEqual({ "a-1": AT })
    // TypeBox does not check an `Object`'s patternProperties, so one it cannot read is skipped.
    const unread = fromTypeBox(Type.Object({}, { patternProperties: { "(": date } }))
    expect(decoded(unread, { x: ISO })).toEqual({ x: ISO })
  })

  test("a union's branches are tried in order, nested ones and untyped ones included", () => {
    const nested = t.union([t.union([t.date(), t.null()]), t.json()])
    expect(decoded(nested, ISO)).toEqual(AT)
    expect(decoded(nested, "soon")).toBe("soon")
    // A key with a backslash keeps its branch off the compiler, as it keeps the schema's.
    const escaped = t.union([
      t.object({ "a\\b": t.date() }),
      t.object({ "a\\b": t.string(), x: t.string() }),
    ])
    expect(decoded(escaped, { "a\\b": ISO })).toEqual({ "a\\b": AT })
    // `t.object` is closed, so `x` puts the value in the second branch, where it is a string.
    expect(decoded(escaped, { "a\\b": ISO, x: "y" })).toEqual({ "a\\b": ISO, x: "y" })
  })

  test("a date the decoder cannot place, or a branch it cannot check, leaves the value as it is", () => {
    const date = t.date().jsonSchema
    const negated = fromTypeBox(Type.Object({ a: Type.Not(date) }))
    expect(decoded(negated, { a: 1 })).toEqual({ a: 1 })
    if (!TypeRegistry.Has("NifraTestAny")) TypeRegistry.Set("NifraTestAny", () => true)
    const plain = fromTypeBox(
      Type.Unsafe({
        [Kind]: "NifraTestAny",
        anyOf: [{ type: "object", properties: { at: date } }, { type: "object" }],
      }),
    )
    expect(decoded(plain, { at: ISO })).toEqual({ at: ISO })
  })

  test("a string that fails the check is reported, not decoded", () => {
    const outcome = t.object({ at: t.date() })["~standard"].validate({ at: "2026-02-30T00:00:00Z" })
    expect(outcome instanceof Promise ? undefined : outcome.issues?.length).toBe(1)
  })

  test("the wire check a response contract runs leaves the string as it is", () => {
    const schema = t.object({ at: t.date() })
    const wire: unknown = Reflect.get(
      schema["~standard"].validate,
      Symbol.for("nifra.schema.validateWire"),
    )
    expect(typeof wire === "function" && wire({ at: ISO })).toEqual({ value: { at: ISO } })
  })
})

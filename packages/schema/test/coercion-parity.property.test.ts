/**
 * Parity pin for the precompiled flat coercion plan in adapter.ts: for every schema shape the plan
 * accepts (flat objects of String/Number/Integer/Boolean, optional or not), a `coerce` validate must
 * behave EXACTLY like TypeBox's own `Value.Convert` - same output value, same accept/reject verdict,
 * same in-place mutation. The generators deliberately feed the conversion quirks the plan mirrors:
 * numeric strings, "0x10", "1"/"true"/"false"/"-0", whitespace-padded numbers, non-object inputs,
 * arrays, nested junk, prototype-key names.
 */
import { describe, expect, test } from "bun:test"
import { Type } from "@sinclair/typebox"
import { Value } from "@sinclair/typebox/value"
import fc from "fast-check"
import { fromTypeBox } from "../src/adapter.ts"

const scalarKinds = ["string", "number", "integer", "boolean"] as const
type ScalarName = (typeof scalarKinds)[number]

function propOf(kind: ScalarName, optional: boolean) {
  const base =
    kind === "string"
      ? Type.String()
      : kind === "number"
        ? Type.Number()
        : kind === "integer"
          ? Type.Integer()
          : Type.Boolean()
  return optional ? Type.Optional(base) : base
}

// Values that exercise every branch of TypeBox's TryConvert* functions.
const quirkValue = fc.oneof(
  fc.string(),
  fc.constantFrom(
    "1",
    "0",
    "-0",
    "true",
    "TRUE",
    "false",
    "FaLsE",
    "0x10",
    " 12 ",
    "12.5",
    "1e3",
    "abc",
    "12abc",
    "",
    "null",
    "undefined",
    "Infinity",
    "-Infinity",
    "NaN",
  ),
  fc.integer(),
  fc.double(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.array(fc.string(), { maxLength: 2 }),
  fc.dictionary(fc.string({ maxLength: 4 }), fc.string(), { maxKeys: 2 }),
)

const keyArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 8 }).filter((k) => k !== "__proto__"),
  fc.constantFrom("a", "b", "limit", "q", "constructor", "toString", "hasOwnProperty"),
)

const schemaSpecArb = fc.uniqueArray(
  fc.tuple(keyArb, fc.constantFrom(...scalarKinds), fc.boolean()),
  { minLength: 1, maxLength: 5, selector: ([key]) => key },
)

const inputArb = (keys: readonly string[]) =>
  fc.oneof(
    // an object carrying some subset of the schema's keys plus some strangers
    fc
      .tuple(
        fc.dictionary(fc.constantFrom(...keys), quirkValue, { maxKeys: keys.length }),
        fc.dictionary(fc.string({ maxLength: 4 }), quirkValue, { maxKeys: 2 }),
      )
      .map(([own, extra]) => ({ ...extra, ...own })),
    // non-object inputs - both paths must pass them through untouched
    quirkValue,
  )

describe("flat coercion plan vs Value.Convert parity", () => {
  test("identical output, verdict, and mutation for every flat scalar schema", () => {
    fc.assert(
      fc.property(
        schemaSpecArb.chain((spec) =>
          fc.tuple(fc.constant(spec), inputArb(spec.map(([key]) => key))),
        ),
        ([spec, input]) => {
          const props = Object.fromEntries(
            spec.map(([key, kind, optional]) => [key, propOf(kind, optional)]),
          )
          const schema = Type.Object(props, { additionalProperties: true })

          // Deep-copy the input twice so in-place mutation on one path can't leak into the other.
          const forPlan = structuredClone(input)
          const forConvert = structuredClone(input)

          const nifra = fromTypeBox(schema, { coerce: true })
          const planResult = nifra["~standard"].validate(forPlan)

          const converted = Value.Convert(schema, forConvert)
          const convertOk = Value.Check(schema, converted)

          if ("value" in planResult) {
            expect(convertOk).toBe(true)
            expect(planResult.value).toEqual(converted as never)
          } else {
            expect(convertOk).toBe(false)
          }
          // Both paths mutate (or don't) their input the same way.
          expect(forPlan).toEqual(forConvert)
        },
      ),
      { numRuns: 500 },
    )
  })

  test("a backslash in a property key validates correctly (TypeCompiler miscompile pinned to eval-free)", () => {
    // TypeBox's TypeCompiler embeds property keys into generated source escaping only quotes, so a
    // key like `a\b` compiles into a checker that reads a DIFFERENT property (`\b` becomes an escape
    // sequence) and rejects every valid input with empty issues. fromTypeBox detects the hazard and
    // pins the schema to the interpretive path - this pins the fix.
    const key = "a\\b"
    const schema = Type.Object({ [key]: Type.String() }, { additionalProperties: false })
    const nifra = fromTypeBox(schema)
    const ok = nifra["~standard"].validate({ [key]: "hello" })
    expect("value" in ok).toBe(true)
    const bad = nifra["~standard"].validate({ [key]: 42 })
    expect("issues" in bad && bad.issues !== undefined && bad.issues.length > 0).toBe(true)

    // Same hazard via a string literal: Type.Literal("x\\y") compiled would compare the wrong text.
    const lit = fromTypeBox(Type.Object({ v: Type.Literal("x\\y") }))
    const litOk = lit["~standard"].validate({ v: "x\\y" })
    expect("value" in litOk).toBe(true)
  })

  test("non-flat schemas still take the full Value.Convert path (no plan short-circuit)", () => {
    // A union property makes the schema plan-ineligible; conversion must still happen (via
    // Value.Convert), proving the fallback wiring - "5" converts inside the union member.
    const schema = Type.Object(
      { v: Type.Union([Type.Integer(), Type.Literal("all")]) },
      { additionalProperties: false },
    )
    const nifra = fromTypeBox(schema, { coerce: true })
    const ok = nifra["~standard"].validate({ v: "5" })
    expect("value" in ok && ok.value).toEqual({ v: 5 })
    const lit = nifra["~standard"].validate({ v: "all" })
    expect("value" in lit && lit.value).toEqual({ v: "all" })
  })
})

import { expect, test } from "bun:test"
import fc from "fast-check"
import { outputGuard } from "../src/internal/output-guard.ts"

// The generated object projector and the closure that serves where code generation is off must
// read, keep and drop alike: same keys in the same order, same copies, same deferred-marker issues.

const PROPERTY_OPTIONS = { numRuns: 400, seed: 0x9a4d }
const DECLARED = ["id", "name", "__proto__", "constructor", "0", "10", 'a"b', "line break", ""]
const UNDECLARED = ["secret", "hasOwnProperty", "x y"]

type Json = { readonly [key: string]: unknown }

const leaf = fc.constantFrom<Json>(
  { type: "string" },
  { type: "number" },
  { type: "array", items: { type: "string" } },
  {},
)
const { object: objectSchema } = fc.letrec<{ node: Json; object: Json; array: Json }>((tie) => ({
  node: fc.oneof({ maxDepth: 3 }, leaf, tie("object"), tie("array")),
  array: tie("object").map((items) => ({ type: "array", items })),
  object: fc
    .record({
      properties: fc.uniqueArray(fc.tuple(fc.constantFrom(...DECLARED), tie("node")), {
        selector: ([key]) => key,
        maxLength: 5,
      }),
      extra: fc.constantFrom<unknown>(undefined, false, true, { type: "number" }),
      pattern: fc.boolean(),
    })
    .map(({ properties, extra, pattern }) => {
      const schema: Record<string, unknown> = {
        type: "object",
        properties: Object.fromEntries(properties),
      }
      if (extra !== undefined) schema.additionalProperties = extra
      if (pattern) schema.patternProperties = { "^x": { type: "string" } }
      return schema
    }),
}))

class Row {}
const { object: objectValue } = fc.letrec<{ value: unknown; object: unknown }>((tie) => ({
  value: fc.oneof(
    { maxDepth: 3 },
    fc.string({ maxLength: 3 }),
    fc.integer(),
    fc.constant(null),
    fc.date(),
    fc.constant({ __nifra_deferred: true, id: 1, promise: null }),
    tie("object"),
    fc.array(tie("value"), { maxLength: 3 }),
  ),
  object: fc
    .tuple(
      fc.uniqueArray(fc.tuple(fc.constantFrom(...DECLARED, ...UNDECLARED), tie("value")), {
        selector: ([key]) => key,
        maxLength: 6,
      }),
      fc.constantFrom(Object.prototype, null, Row.prototype),
    )
    .map(([entries, proto]) => Object.setPrototypeOf(Object.fromEntries(entries), proto)),
}))

/** A value's structure, key order and prototypes included, marking each object `input` holds. */
function shapeOf(value: unknown, input: ReadonlySet<object>): unknown {
  if (typeof value !== "object" || value === null) return value
  if (value instanceof Date) return { date: value.getTime() }
  const same = input.has(value)
  if (Array.isArray(value)) return { same, items: value.map((item) => shapeOf(item, input)) }
  const proto = Object.getPrototypeOf(value)
  return {
    same,
    proto: proto === Object.prototype ? "object" : proto === null ? "null" : "other",
    entries: Reflect.ownKeys(value).map((key) => [
      String(key),
      shapeOf(Reflect.get(value, key), input),
    ]),
  }
}

function objectsIn(value: unknown, into: Set<object>): Set<object> {
  if (typeof value === "object" && value !== null && !into.has(value)) {
    into.add(value)
    for (const key of Reflect.ownKeys(value)) {
      objectsIn(Reflect.get(value, key), into)
    }
  }
  return into
}

const runState = (): { label: string; issues: string[] } => ({ label: "x", issues: [] })

const compile = (jsonSchema: Json) =>
  outputGuard(
    {
      "~standard": { version: 1, vendor: "test", validate: (v: unknown) => ({ value: v }) },
      jsonSchema,
    },
    '"page.backend.ts"',
    "loaderOutput",
  ).project

test("the generated projector reads, keeps and drops what the closure does", () => {
  fc.assert(
    fc.property(
      objectSchema,
      fc.array(objectValue, { minLength: 1, maxLength: 4 }),
      (schema, values) => {
        const generated = compile(schema)
        Reflect.set(globalThis, "document", {})
        let closure: ReturnType<typeof compile>
        try {
          closure = compile(schema)
        } finally {
          Reflect.deleteProperty(globalThis, "document")
        }
        if (generated === undefined || closure === undefined) throw new Error("no projector")
        expect(String(generated).includes("switch (key)")).toBe(true)
        expect(String(closure).includes("switch (key)")).toBe(false)
        for (const input of values) {
          const held = objectsIn(input, new Set())
          const left = runState()
          const right = runState()
          expect(shapeOf(generated(input, left), held)).toEqual(
            shapeOf(closure(input, right), held),
          )
          expect(left.issues).toEqual(right.issues)
        }
      },
    ),
    PROPERTY_OPTIONS,
  )
})

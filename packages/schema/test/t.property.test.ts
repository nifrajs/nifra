import { expect, test } from "bun:test"
import type { StandardSchemaV1 } from "@nifrajs/core"
import fc from "fast-check"
import { t } from "../src/index.ts"

/**
 * Property/fuzz coverage of the validator (the Phase 6 exit criterion). Rather than
 * assert TypeBox's exact edge semantics, these check the *contract*: well-typed
 * values are always accepted, type-violating values are always rejected.
 */

// `t` validators are synchronous; assert that and read the result directly.
function accepts(schema: StandardSchemaV1, value: unknown): boolean {
  const result = schema["~standard"].validate(value)
  if (result instanceof Promise) throw new Error("t validators must be synchronous")
  return result.issues === undefined
}

const userSchema = t.object({
  name: t.string(),
  age: t.integer(),
  tags: t.array(t.string()),
  active: t.boolean(),
})

const validUser = fc.record({
  name: fc.string(),
  age: fc.integer(),
  tags: fc.array(fc.string(), { maxLength: 5 }),
  active: fc.boolean(),
})

test("property: soundness — every well-typed record is accepted", () => {
  fc.assert(fc.property(validUser, (user) => expect(accepts(userSchema, user)).toBe(true)))
})

test("property: completeness — corrupting any one field's type is rejected", () => {
  const wrongFor = { name: 1, age: "x", tags: "nope", active: 0 } as const
  const fields = ["name", "age", "tags", "active"] as const
  const corrupted = validUser.chain((user) =>
    fc.constantFrom(...fields).map((field) => ({ ...user, [field]: wrongFor[field] })),
  )
  fc.assert(fc.property(corrupted, (user) => expect(accepts(userSchema, user)).toBe(false)))
})

test("property: a primitive schema discriminates exactly on its type", () => {
  const str = t.string()
  fc.assert(
    fc.property(fc.anything(), (value) => {
      expect(accepts(str, value)).toBe(typeof value === "string")
    }),
  )
})

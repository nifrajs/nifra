import { describe, expect, test } from "bun:test"
import { Type } from "@sinclair/typebox"
import { fromTypeBox, type NifraSchema, t } from "../src/index.ts"

// `@nifrajs/web`'s output guard projects a value by its schema's declared keys before validating
// it, so the undeclared-key check of every object that projection reached cannot fail. A plain `t`
// schema offers a validate without those checks, for that projected value only.

const VALIDATE_PROJECTED = Symbol.for("nifra.schema.validateProjected")
type Validate = NifraSchema["~standard"]["validate"]

const projectedBy = (
  schema: NifraSchema,
  by: unknown = schema.jsonSchema,
): Validate | undefined => {
  const variant: unknown = Reflect.get(schema["~standard"].validate, VALIDATE_PROJECTED)
  return typeof variant === "function" ? variant(by) : undefined
}

const passes = (validate: Validate | undefined, value: unknown): boolean => {
  if (validate === undefined) throw new Error("no validate")
  const result = validate(value)
  if (result instanceof Promise) throw new Error("async validate")
  return result.issues === undefined
}

const pathsOf = (validate: Validate | undefined, value: unknown): string[] => {
  const result = validate?.(value)
  if (result === undefined || result instanceof Promise) throw new Error("no sync validate")
  return [...new Set((result.issues ?? []).map((issue) => (issue.path ?? []).join("/")))]
}

describe("the validate for a projected value", () => {
  test("skips the undeclared-key check of each object the projection reaches", () => {
    const schema = t.object({
      user: t.object({ name: t.string(), nickname: t.optional(t.string()) }),
      posts: t.array(t.object({ title: t.string() })),
      tags: t.record(t.object({ count: t.integer() })),
      pair: fromTypeBox(
        Type.Tuple([
          Type.Object({ a: Type.Integer() }, { additionalProperties: false }),
          Type.String(),
        ]),
      ),
      meta: fromTypeBox(
        Type.Object(
          {},
          {
            additionalProperties: Type.Object(
              { on: Type.Boolean() },
              { additionalProperties: false },
            ),
          },
        ),
      ),
    })
    const extra = {
      user: { name: "Ada", x: 1 },
      posts: [{ title: "a", x: 1 }],
      tags: { db: { count: 2, x: 1 } },
      pair: [{ a: 1, x: 1 }, "b"],
      meta: { flag: { on: true, x: 1 } },
      x: 1,
    }
    expect(passes(schema["~standard"].validate, extra)).toBe(false)
    expect(passes(projectedBy(schema), extra)).toBe(true)
  })

  test("still checks every declared field, and names the same paths", () => {
    const schema = t.object({ items: t.array(t.object({ id: t.integer(), name: t.string() })) })
    const bad = { items: [{ id: 1, name: "a" }, { id: "2", name: "b" }, { id: 3 }] }
    expect(pathsOf(projectedBy(schema), bad)).toEqual(pathsOf(schema["~standard"].validate, bad))
    expect(pathsOf(projectedBy(schema), bad)).toEqual(["items/1/id", "items/2/name"])
    expect(passes(projectedBy(schema), { items: [] })).toBe(true)
    expect(passes(projectedBy(schema), { items: {} })).toBe(false)
    expect(passes(projectedBy(schema), [])).toBe(false)
  })

  test("keeps each union branch's check: a union projection keeps every branch's keys", () => {
    const schema = t.object({
      who: t.union([
        t.object({ kind: t.literal("user"), name: t.string() }),
        t.object({ kind: t.literal("team"), size: t.integer() }),
      ]),
    })
    const mixed = { who: { kind: "user", name: "Ada", size: 3 } }
    expect(passes(schema["~standard"].validate, mixed)).toBe(false)
    expect(passes(projectedBy(schema), mixed)).toBe(false)
    expect(passes(projectedBy(schema), { who: { kind: "user", name: "Ada" }, x: 1 })).toBe(true)
  })

  test("keeps the check of a referenced schema and of what `not` excludes", () => {
    const tree = fromTypeBox(
      Type.Recursive((node) =>
        Type.Object(
          { name: Type.String(), children: Type.Array(node) },
          { additionalProperties: false },
        ),
      ),
    )
    expect(projectedBy(tree)).toBeUndefined()
    const notOpen = fromTypeBox(
      Type.Object(
        { v: Type.Not(Type.Object({ a: Type.String() }, { additionalProperties: false })) },
        { additionalProperties: false },
      ),
    )
    expect(passes(notOpen["~standard"].validate, { v: { a: "x", b: 1 } })).toBe(true)
    expect(passes(projectedBy(notOpen), { v: { a: "x", b: 1 } })).toBe(true)
    expect(passes(projectedBy(notOpen), { v: { a: "x" } })).toBe(false)
  })

  test("answers only for its own schema", () => {
    const schema = t.object({ id: t.string() })
    expect(projectedBy(schema, { ...schema.jsonSchema })).toBeUndefined()
    expect(projectedBy(schema, t.object({ id: t.string() }).jsonSchema)).toBeUndefined()
    const coerced = fromTypeBox(
      Type.Object({ n: Type.Integer() }, { additionalProperties: false }),
      {
        coerce: true,
      },
    )
    expect(projectedBy(coerced)).toBeUndefined()
  })

  test("is offered only when an object check would be skipped", () => {
    expect(projectedBy(t.looseObject({ id: t.string() }))).toBeUndefined()
    expect(projectedBy(t.array(t.string()))).toBeUndefined()
    expect(projectedBy(t.string())).toBeUndefined()
    expect(projectedBy(t.union([t.object({ a: t.string() }), t.null()]))).toBeUndefined()
  })

  test("is built once, and leaves the schema it came from as it was", () => {
    const schema = t.object({ user: t.object({ name: t.string() }) })
    const before = JSON.stringify(schema.jsonSchema)
    expect(projectedBy(schema)).toBe(projectedBy(schema))
    expect(JSON.stringify(schema.jsonSchema)).toBe(before)
    expect(passes(schema["~standard"].validate, { user: { name: "Ada", x: 1 } })).toBe(false)
  })
})

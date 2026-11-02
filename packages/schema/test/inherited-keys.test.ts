import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { server, silentLogger } from "@nifrajs/core"
import { responseContract } from "@nifrajs/core/response-contract"
import type { StandardIssue, StandardSchemaV1 } from "@nifrajs/core/schema"
import { type TSchema, Type } from "@sinclair/typebox"
import { compileSchema } from "../src/compile.ts"
import { fromTypeBox, t } from "../src/index.ts"
import { namesInheritedMember, ownView } from "../src/inherited.ts"
import { TEXT_SLOT } from "../src/marks.ts"

/**
 * A key named after an `Object.prototype` member must mean what any other key means: absent when the
 * object does not carry it, checked when it does. Every member name is diffed against a name no object
 * inherits, on every lane a schema validates by, so a member or lane added later is covered too.
 */

const MEMBERS = Object.getOwnPropertyNames(Object.prototype)
const CONTROL = "plain"
// `t` refuses `__proto__` as a field name; the TypeBox lanes still answer for it.
const FIELDS = MEMBERS.filter((name) => name !== "__proto__")

const dir = mkdtempSync(join(import.meta.dir, ".tmp-precompiled-inherited-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let next = 0

type Validate = StandardSchemaV1["~standard"]["validate"]
type Outcome = {
  readonly value?: unknown
  readonly issues?: ReadonlyArray<StandardIssue> | undefined
}

const textForm = (validate: Validate): Validate => {
  const form: StandardSchemaV1 = Reflect.get(validate, TEXT_SLOT)
  return form["~standard"].validate
}

const run = (validate: Validate, value: unknown): Outcome => {
  const outcome = validate(value)
  if (outcome instanceof Promise) throw new Error("expected a synchronous validator")
  return outcome
}

/** Runs `fn` while `new Function` throws, as on an edge runtime: only the `Value` checker can answer. */
function codegenBlocked<R>(fn: () => R): R {
  const RealFunction = globalThis.Function
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion lint/plugin/noChainedTypeAssertions: a stand-in that only throws; the finally block restores the real constructor.
  globalThis.Function = (() => {
    throw new EvalError("Code generation from strings disallowed for this context")
  }) as unknown as FunctionConstructor
  try {
    return fn()
  } finally {
    globalThis.Function = RealFunction
  }
}

async function precompiled(schema: TSchema): Promise<Validate> {
  const file = join(dir, `schema-${next++}.ts`)
  writeFileSync(
    file,
    compileSchema(fromTypeBox(schema), { source: "./source.ts", exportName: "schema" }),
  )
  const generated: StandardSchemaV1 = (await import(file)).schema
  return generated["~standard"].validate
}

/** Each lane's validator for `schema`; a lane that converts text is answered with text. */
const LANES: ReadonlyArray<{
  readonly name: string
  readonly text: boolean
  readonly build: (schema: TSchema) => Validate | Promise<Validate>
}> = [
  { name: "compiled", text: false, build: (s) => fromTypeBox(s)["~standard"].validate },
  {
    name: "eval-free",
    text: false,
    build: (s) => {
      const validate = fromTypeBox(s)["~standard"].validate
      return (value) => codegenBlocked(() => validate(value))
    },
  },
  { name: "precompiled", text: false, build: precompiled },
  {
    name: "coerced",
    text: true,
    build: (s) => fromTypeBox(s, { coerce: true })["~standard"].validate,
  },
  { name: "text slot", text: true, build: (s) => textForm(fromTypeBox(s)["~standard"].validate) },
  { name: "precompiled text slot", text: true, build: async (s) => textForm(await precompiled(s)) },
]

const keyed = (key: string, value: unknown): Record<string, unknown> =>
  Object.fromEntries([[key, value]])

/** `{ [key]: 1 }`, read back untyped so a handler can answer its contract with the wrong shape. */
const wrongShape = (key: string) => JSON.parse(JSON.stringify(keyed(key, 1)))

/** A schema around one key, with the objects it is answered for: the key absent, valid, invalid. */
const SHAPES: ReadonlyArray<{
  readonly name: string
  /** Whether the shape's values can arrive as text, the only kind the coercion lanes take. */
  readonly text: boolean
  readonly schema: (key: string) => TSchema
  readonly values: (key: string, text: boolean) => readonly object[]
}> = [
  {
    name: "optional array",
    text: false,
    schema: (k) => Type.Object({ [k]: Type.Optional(Type.Array(Type.String())) }),
    values: (k) => [{}, keyed(k, ["a"]), keyed(k, [1]), keyed(k, undefined)],
  },
  {
    name: "optional integer",
    text: true,
    schema: (k) => Type.Object({ [k]: Type.Optional(Type.Integer()) }),
    values: (k, text) => [{}, keyed(k, text ? "7" : 7), keyed(k, text ? "x" : "7")],
  },
  {
    name: "optional integer list",
    text: true,
    schema: (k) => Type.Object({ [k]: Type.Optional(Type.Array(Type.Integer())) }),
    values: (k, text) => [{}, keyed(k, text ? ["7"] : [7]), keyed(k, text ? ["x"] : 7)],
  },
  {
    name: "optional string, closed",
    text: true,
    schema: (k) =>
      Type.Object({ [k]: Type.Optional(Type.String()) }, { additionalProperties: false }),
    values: (k) => [{}, keyed(k, "a"), keyed(k, {}), { other: "a" }],
  },
  {
    name: "optional object in an array",
    text: false,
    schema: (k) =>
      Type.Object({ items: Type.Array(Type.Object({ [k]: Type.Optional(Type.Object({})) })) }),
    values: (k) => [{ items: [{}] }, { items: [keyed(k, {})] }, { items: [{}, keyed(k, 1)] }],
  },
  {
    name: "required unknown",
    text: false,
    schema: (k) => Type.Object({ [k]: Type.Unknown() }),
    values: (k) => [{}, keyed(k, 1), keyed(k, null)],
  },
]

/** `value` with `CONTROL` renamed to `key`, every object made plain, so prototypes do not compare. */
function renamed(value: unknown, key: string): unknown {
  if (Array.isArray(value)) return value.map((item) => renamed(item, key))
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => [
      name === CONTROL ? key : name,
      renamed(item, key),
    ]),
  )
}

const comparable = (outcome: Outcome, key: string) => ({
  value: renamed(outcome.value, key),
  issues: outcome.issues?.map((issue) => ({
    message: issue.message,
    path: issue.path?.map((segment) => (segment === CONTROL ? key : String(segment))),
  })),
})

describe("a key named after an Object.prototype member", () => {
  for (const lane of LANES) {
    test(`answers as any other key on the ${lane.name} lane`, async () => {
      const shapes = SHAPES.filter((shape) => !lane.text || shape.text)
      expect(shapes.length).toBeGreaterThan(0)
      for (const shape of shapes) {
        const controlled = await lane.build(shape.schema(CONTROL))
        const control = shape
          .values(CONTROL, lane.text)
          .map((value) => run(controlled, structuredClone(value)))
        for (const member of MEMBERS) {
          const validate = await lane.build(shape.schema(member))
          const values = shape.values(member, lane.text)
          for (const [i, input] of values.entries()) {
            const before = Reflect.ownKeys(input)
            const outcome = run(validate, input)
            expect({ shape: shape.name, member, input: i, ...comparable(outcome, member) }).toEqual(
              {
                shape: shape.name,
                member,
                input: i,
                ...comparable(control[i]!, member),
              },
            )
            // A key the object never carried is not written onto it by the check.
            if (!before.includes(member)) expect(Object.hasOwn(input, member)).toBe(false)
            if (!lane.text && outcome.issues === undefined) expect(outcome.value).toBe(input)
          }
        }
      }
    })
  }

  test("t.object and t.query read {} as the key absent", () => {
    for (const member of FIELDS) {
      const listed = t.object({ [member]: t.optional(t.array(t.string())) })
      const named = t.object({ [member]: t.optional(t.string()) })
      const query = t.query({ [member]: t.optional(t.integer()) })
      expect(run(listed["~standard"].validate, {})).toEqual({ value: {} })
      expect(run(named["~standard"].validate, {})).toEqual({ value: {} })
      expect(run(query["~standard"].validate, {})).toEqual({ value: {} })
      expect(run(query["~standard"].validate, keyed(member, "3"))).toEqual({
        value: keyed(member, 3),
      })
      expect(run(query["~standard"].validate, keyed(member, "x")).issues?.[0]?.path).toEqual([
        member,
      ])
    }
  })

  test("a query object without Object.prototype is still converted in place", () => {
    const query = t.query({ toString: t.optional(t.integer()), limit: t.integer() })
    const input: Record<string, unknown> = Object.create(null)
    input.limit = "5"
    const outcome = run(query["~standard"].validate, input)
    expect(outcome.value).toBe(input)
    expect(input.limit).toBe(5)
  })

  test("a cyclic value with a member-named key is checked without looping", () => {
    const node = t.object({ constructor: t.optional(t.string()), next: t.optional(t.json()) })
    const cyclic: Record<string, unknown> = {}
    cyclic.next = { back: cyclic }
    expect(run(node["~standard"].validate, { constructor: 1, next: [] }).issues?.[0]?.path).toEqual(
      ["constructor"],
    )
    expect(
      run(
        fromTypeBox(
          Type.Object({ constructor: Type.Optional(Type.String()), next: Type.Unknown() }),
        )["~standard"].validate,
        cyclic,
      ).value,
    ).toBe(cyclic)
  })
})

describe("the own view", () => {
  test("is taken only for a schema that declares an Object.prototype member", () => {
    for (const schema of [
      Type.Object({ toString: Type.String() }),
      Type.Array(Type.Object({ valueOf: Type.Optional(Type.Number()) })),
      Type.Union([Type.Null(), Type.Object({ constructor: Type.Unknown() })]),
    ])
      expect(namesInheritedMember(schema)).toBe(true)
    for (const schema of [
      Type.Object({ name: Type.String() }),
      Type.Record(Type.String(), Type.String()),
      Type.Object({ tags: Type.Array(Type.Literal("toString")) }),
    ])
      expect(namesInheritedMember(schema)).toBe(false)
  })

  test("drops the prototype of each plain object and keeps every other value", () => {
    class Row {
      constructor(readonly id: string) {}
    }
    const row = new Row("r")
    const when = new Date(0)
    const shared = { n: 1 }
    const list: unknown[] = [shared]
    list[2] = shared
    const input = { row, when, list }
    const view = ownView(input)
    if (typeof view !== "object" || view === null) throw new Error("expected an object view")
    expect(Object.getPrototypeOf(view)).toBeNull()
    expect(Object.getPrototypeOf(input)).toBe(Object.prototype)
    expect(Reflect.get(view, "row")).toBe(row)
    expect(Reflect.get(view, "when")).toBe(when)
    const copied = Reflect.get(view, "list")
    expect(copied).toHaveLength(3)
    expect(1 in copied).toBe(false)
    expect(copied[0]).toBe(copied[2])
    expect(copied[0]).not.toBe(shared)
    expect(Object.getPrototypeOf(copied[0])).toBeNull()
  })

  test("leaves a value that reaches no Object.prototype object as it is", () => {
    const bare: Record<string, unknown> = Object.create(null)
    bare.list = ["a", ["b"]]
    expect(ownView(bare)).toBe(bare)
    for (const value of ["x", 1, null, undefined]) expect(ownView(value)).toBe(value)
    const nested: Record<string, unknown> = Object.create(null)
    nested.list = [{}]
    expect(ownView(nested)).not.toBe(nested)
  })
})

describe("a route whose schema names an Object.prototype member", () => {
  const answer = async (
    app: { fetch(request: Request): Response | Promise<Response> },
    path: string,
    init?: RequestInit,
  ) => {
    const response = await app.fetch(new Request(`http://x${path}`, init))
    return response.status
  }
  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

  const statuses = async (key: string): Promise<readonly number[]> => {
    const optional = t.object({ [key]: t.optional(t.array(t.string())) })
    const app = server({ logger: silentLogger })
      .use(responseContract("enforce"))
      .post("/body", { body: optional }, () => ({ ok: true }))
      .get("/query", { query: t.query({ [key]: t.optional(t.integer()) }) }, () => ({}))
      .get(
        "/item/:id",
        { params: t.object({ id: t.string(), [key]: t.optional(t.string()) }) },
        () => ({}),
      )
      .get("/answer", { response: optional }, () => ({}))
      .get("/wrong", { response: optional }, () => wrongShape(key))
    return [
      await answer(app, "/body", json({})),
      await answer(app, "/body", json(keyed(key, ["a"]))),
      await answer(app, "/body", json(keyed(key, 1))),
      await answer(app, "/query"),
      await answer(app, `/query?${key}=1`),
      await answer(app, `/query?${key}=x`),
      await answer(app, "/item/1"),
      await answer(app, "/answer"),
      await answer(app, "/wrong"),
    ]
  }

  test("validates body, query, params and an enforced response as for any other key", async () => {
    const control = await statuses(CONTROL)
    expect(control).toEqual([200, 200, 422, 200, 200, 422, 200, 200, 500])
    for (const member of FIELDS) {
      expect({ member, statuses: await statuses(member) }).toEqual({ member, statuses: control })
    }
  })
})

/**
 * A key named after an `Object.prototype` member on Node: absent when the object does not carry it,
 * checked when it does, on the compiled, eval-free and precompiled lanes and through a served route.
 */

import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { after, before, test } from "node:test"
import { server, silentLogger } from "@nifrajs/core"
import { responseContract } from "@nifrajs/core/response-contract"
import type { StandardSchemaV1 } from "@nifrajs/core/schema"
import { serve } from "@nifrajs/node"
import { t } from "@nifrajs/schema"
import { compileSchema } from "@nifrajs/schema/compile"

// `t` refuses `__proto__` as a field name.
const FIELDS = Object.getOwnPropertyNames(Object.prototype).filter((name) => name !== "__proto__")

const keyed = (key: string, value: unknown): Record<string, unknown> =>
  Object.fromEntries([[key, value]])

/** `{ [key]: 1 }`, read back untyped so a handler can answer its contract with the wrong shape. */
const wrongShape = (key: string) => JSON.parse(JSON.stringify(keyed(key, 1)))

const entries = (value: unknown) =>
  value !== null && typeof value === "object" ? Object.entries(value) : value

/** A schema around one key, with a present value it accepts and one it refuses at `path`. */
const SHAPES = [
  {
    schema: (key: string) => t.object({ [key]: t.optional(t.array(t.string())) }),
    valid: ["a"],
    invalid: [1],
    path: (key: string) => [key, "0"],
  },
  {
    schema: (key: string) => t.object({ [key]: t.optional(t.string()) }),
    valid: "a",
    invalid: 1,
    path: (key: string) => [key],
  },
]
const listOf = SHAPES[0]!.schema

function run(schema: StandardSchemaV1, value: unknown) {
  const outcome = schema["~standard"].validate(value)
  if (outcome instanceof Promise) throw new Error("expected a synchronous validator")
  return outcome
}

/** What `schema` answers for `key` absent, present and valid, and present and invalid. */
const answers = (schema: StandardSchemaV1, key: string, shape: (typeof SHAPES)[number]) => [
  run(schema, {}),
  run(schema, keyed(key, shape.valid)),
  run(schema, keyed(key, shape.invalid)).issues?.map((issue) => issue.path),
]

const expected = (key: string, shape: (typeof SHAPES)[number]) => [
  { value: {} },
  { value: keyed(key, shape.valid) },
  [shape.path(key)],
]

const dir = mkdtempSync(join(import.meta.dirname, ".tmp-precompiled-"))
let url = ""
let stop: (() => Promise<void>) | undefined

before(async () => {
  let app = server({ logger: silentLogger }).use(responseContract("enforce"))
  for (const [i, key] of FIELDS.entries()) {
    app = app
      .post(`/${i}/body`, { body: listOf(key) }, () => ({ ok: true }))
      .get(`/${i}/query`, { query: t.query({ [key]: t.optional(t.integer()) }) }, () => ({}))
      .get(
        `/${i}/item/:id`,
        { params: t.object({ id: t.string(), [key]: t.optional(t.string()) }) },
        () => ({}),
      )
      .get(`/${i}/answer`, { response: listOf(key) }, () => ({}))
      .get(`/${i}/wrong`, { response: listOf(key) }, () => wrongShape(key))
  }
  const running = await serve(app, { hostname: "127.0.0.1", port: 0 })
  url = `http://127.0.0.1:${running.port}`
  stop = () => running.stop()
})

after(async () => {
  await stop?.()
  rmSync(dir, { recursive: true, force: true })
})

test("the compiled lane reads {} as the key absent", () => {
  for (const shape of SHAPES) {
    for (const key of FIELDS)
      assert.deepEqual(answers(shape.schema(key), key, shape), expected(key, shape))
  }
})

test("the eval-free lane reads {} as the key absent", () => {
  const RealFunction = globalThis.Function
  const outcomes: unknown[] = []
  try {
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion lint/plugin/noChainedTypeAssertions: a stand-in that only throws; the finally block restores the real constructor.
    globalThis.Function = (() => {
      throw new EvalError("Code generation from strings disallowed for this context")
    }) as unknown as FunctionConstructor
    for (const shape of SHAPES) {
      for (const key of FIELDS) outcomes.push(answers(shape.schema(key), key, shape))
    }
  } finally {
    globalThis.Function = RealFunction
  }
  assert.deepEqual(
    outcomes,
    SHAPES.flatMap((shape) => FIELDS.map((key) => expected(key, shape))),
  )
})

test("the precompiled lane reads {} as the key absent", async () => {
  // The scalar shape: Node strips types from the generated module, and TypeBox's TypeScript for an
  // array check annotates a for-of binding, which type stripping refuses.
  const shape = SHAPES[1]!
  for (const [i, key] of FIELDS.entries()) {
    const file = join(dir, `schema-${i}.ts`)
    writeFileSync(
      file,
      compileSchema(shape.schema(key), { source: "./source.ts", exportName: "schema" }),
    )
    const schema: StandardSchemaV1 = (await import(file)).schema
    assert.deepEqual(answers(schema, key, shape), expected(key, shape))
  }
})

test("t.query converts a present key and leaves an absent one off the input", () => {
  for (const key of FIELDS) {
    const query = t.query({ [key]: t.optional(t.integer()) })
    const input = {}
    const absent = run(query, input)
    assert.equal(absent.issues, undefined)
    assert.deepEqual(entries(absent.value), [])
    assert.equal(Object.hasOwn(input, key), false)
    assert.deepEqual(entries(run(query, keyed(key, "3")).value), [[key, 3]])
  }
})

test("a served route validates body, query, params and an enforced response", async () => {
  const status = async (path: string, body?: unknown) =>
    (
      await fetch(
        `${url}${path}`,
        body === undefined
          ? undefined
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            },
      )
    ).status
  for (const [i, key] of FIELDS.entries()) {
    assert.deepEqual(
      {
        key,
        statuses: [
          await status(`/${i}/body`, {}),
          await status(`/${i}/body`, keyed(key, ["a"])),
          await status(`/${i}/body`, keyed(key, 1)),
          await status(`/${i}/query`),
          await status(`/${i}/query?${key}=1`),
          await status(`/${i}/query?${key}=x`),
          await status(`/${i}/item/1`),
          await status(`/${i}/answer`),
          await status(`/${i}/wrong`),
        ],
      },
      { key, statuses: [200, 200, 422, 200, 200, 422, 200, 200, 500] },
    )
  }
})

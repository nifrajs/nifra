/**
 * `compileSchema` output is TypeScript, so Node strips its types and runs it as is. A module for an
 * array, tuple, record or nested schema loads and answers as the schema it was compiled from.
 */

import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { after, test } from "node:test"
import type { StandardSchemaV1 } from "@nifrajs/core/schema"
import { t } from "@nifrajs/schema"
import { compileSchema } from "@nifrajs/schema/compile"

const dir = mkdtempSync(join(import.meta.dirname, ".tmp-precompiled-"))
after(() => rmSync(dir, { recursive: true, force: true }))

const SCHEMAS = {
  list: { schema: t.array(t.string(), { minItems: 1 }), valid: ["a"], invalid: [1] },
  unique: { schema: t.array(t.integer(), { uniqueItems: true }), valid: [1, 2], invalid: [1, 1] },
  byName: { schema: t.record(t.array(t.integer())), valid: { a: [1] }, invalid: { a: [1.5] } },
  nested: {
    schema: t.object({
      rows: t.array(t.object({ tags: t.array(t.string()), note: t.optional(t.string()) })),
      grid: t.array(t.array(t.number())),
    }),
    valid: { rows: [{ tags: ["a"] }], grid: [[1], []] },
    invalid: { rows: [{ tags: [1] }], grid: [] },
  },
}

function run(schema: StandardSchemaV1, value: unknown) {
  const outcome = schema["~standard"].validate(value)
  if (outcome instanceof Promise) throw new Error("expected a synchronous validator")
  return outcome
}

test("a generated module loads under Node and answers as its source schema", async () => {
  for (const [name, { schema, valid, invalid }] of Object.entries(SCHEMAS)) {
    const file = join(dir, `${name}.ts`)
    writeFileSync(file, compileSchema(schema, { source: "./source.ts", exportName: name }))
    const compiled: StandardSchemaV1 = (await import(file))[name]
    for (const value of [valid, invalid])
      assert.deepEqual(
        { name, outcome: run(compiled, value) },
        { name, outcome: run(schema, value) },
      )
    assert.equal(run(compiled, valid).issues, undefined)
    assert.notEqual(run(compiled, invalid).issues, undefined)
  }
})

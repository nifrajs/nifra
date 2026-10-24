import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { StandardSchemaV1 } from "@nifrajs/core/schema"
import fc from "fast-check"
import { compileSchema } from "../src/compile.ts"
import { t as formT } from "../src/form.ts"
import { t } from "../src/index.ts"

const dir = mkdtempSync(join(import.meta.dir, ".tmp-precompiled-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let next = 0

async function generated(schema: Parameters<typeof compileSchema>[0]): Promise<StandardSchemaV1> {
  const file = join(dir, `schema-${next++}.ts`)
  writeFileSync(file, compileSchema(schema, { source: "./source.ts", exportName: "schema" }))
  return (await import(file)).schema
}

function result(schema: StandardSchemaV1, value: unknown) {
  const outcome = schema["~standard"].validate(value)
  if (outcome instanceof Promise) throw new Error("precompiled validators must be synchronous")
  return outcome
}

describe("static schema compilation", () => {
  test("keeps strict keys, nested issue paths and input/output parity", async () => {
    const source = t.object({
      name: t.string({ minLength: 1 }),
      items: t.array(t.object({ qty: t.integer() })),
    })
    const compiled = await generated(source)
    for (const value of [
      { name: "Ada", items: [{ qty: 3 }] },
      { name: "", items: [{ qty: 3.5 }] },
      { name: "Ada", items: [], secret: "must refuse" },
      null,
      { name: "Ada", items: [null] },
    ])
      expect(result(compiled, value)).toEqual(result(source, value))
    expect(compiled).toHaveProperty("jsonSchema")
  })

  test("issue paths decode JSON Pointer tokens exactly once in both validators", async () => {
    const source = t.object({
      "a/b": t.object({ "c~d": t.string() }),
      "~1": t.string(),
      "": t.string(),
    })
    const compiled = await generated(source)
    for (const schema of [source, compiled]) {
      const outcome = result(schema, { "a/b": { "c~d": 1 }, "~1": 2, "": 3 })
      expect(outcome.issues?.map((issue) => issue.path)).toEqual([["a/b", "c~d"], ["~1"], [""]])
    }
  })

  test("property: unknown inputs match the normal validator", async () => {
    const source = t.object({
      name: t.string(),
      age: t.optional(t.integer()),
      tags: t.array(t.string(), { uniqueItems: true }),
    })
    const compiled = await generated(source)
    fc.assert(
      fc.property(fc.anything(), (value) =>
        expect(result(compiled, value)).toEqual(result(source, value)),
      ),
      { numRuns: 250 },
    )
    expect(result(compiled, { name: "Ada", tags: ["x", "x"] })).toEqual(
      result(source, { name: "Ada", tags: ["x", "x"] }),
    )
  })

  test("runs without calling the Function constructor and enforces string formats", async () => {
    const source = t.object({ email: t.string({ format: "email" }) })
    const compiled = await generated(source)
    const original = globalThis.Function
    let attempts = 0
    const outcomes = []
    try {
      // Deliberately simulate an edge runtime that forbids dynamic code generation.
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion lint/plugin/noChainedTypeAssertions: a stand-in that only throws; the finally block restores the real constructor.
      globalThis.Function = (() => {
        attempts++
        throw new EvalError("dynamic codegen refused")
      }) as unknown as FunctionConstructor
      outcomes.push(result(compiled, { email: "a@b.co" }), result(compiled, { email: "invalid" }))
    } finally {
      globalThis.Function = original
    }
    expect(attempts).toBe(0)
    expect(outcomes).toEqual([
      result(source, { email: "a@b.co" }),
      result(source, { email: "invalid" }),
    ])
  })

  test("refuses coercion, custom runtime kinds and known compiler escape hazards", () => {
    const options = { source: "./source.ts", exportName: "schema" }
    expect(() => compileSchema(t.query({ limit: t.integer() }), options)).toThrow("coercing")
    expect(() => compileSchema({ ...t.query({ limit: t.integer() }) }, options)).toThrow("coercing")
    // A form coerces its text fields and reads multipart bodies: neither survives compilation.
    const form = formT.form({ n: t.integer(), tags: t.array(t.string()) })
    expect(() => compileSchema(form, options)).toThrow("coercing")
    const handWritten: Parameters<typeof compileSchema>[0] = {
      ...t.object({ n: t.integer() }),
      "~standard": { ...t.object({ n: t.integer() })["~standard"], validate: () => ({ value: 1 }) },
    }
    expect(() => compileSchema(handWritten, options)).toThrow("more than check jsonSchema")
    expect(() => compileSchema(t.date(), options)).toThrow("custom registry kinds")
    expect(() => compileSchema(t.object({ "a\\b": t.string() }), options)).toThrow("escape safely")
    const payload = "x', (globalThis.__nifraInjected = true), '"
    const hazards: Parameters<typeof compileSchema>[0][] = [
      t.string({ format: payload }),
      t.object({ [payload]: t.string() }),
      t.object({ "a\nb": t.string() }),
      t.literal("a\nb"),
    ]
    for (const hazard of hazards)
      expect(() => compileSchema(hazard, options)).toThrow("escape safely")
    expect(() =>
      compileSchema(t.string(), { ...options, exportName: "schema;sideEffect()" }),
    ).toThrow("identifier")
  })
})

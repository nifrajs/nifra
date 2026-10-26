import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { StandardSchemaV1 } from "@nifrajs/core/schema"
import fc from "fast-check"
import ts from "typescript"
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
    // The checker's own for-of is rewritten; the same text inside a literal must not be.
    expect(() => compileSchema(t.literal("for(const value: any of array)"), options)).toThrow(
      "whose text holds",
    )
  })
})

describe("generated module source", () => {
  // One schema per shape the checker code differs on, each with a value it accepts and one it refuses.
  const SOURCES: Record<string, { source: string; valid: unknown; invalid: unknown }> = {
    list: {
      source: "Type.Array(Type.String(), { minItems: 1, maxItems: 3 })",
      valid: ["a"],
      invalid: [1],
    },
    unique: {
      source: "Type.Array(Type.String(), { uniqueItems: true })",
      valid: ["a", "b"],
      invalid: ["a", "a"],
    },
    counted: {
      source:
        "Type.Array(Type.Number(), { contains: Type.Literal(1), minContains: 1, maxContains: 2 })",
      valid: [1, 2],
      invalid: [2, 3],
    },
    pair: {
      source: "Type.Tuple([Type.String(), Type.Number()])",
      valid: ["a", 1],
      invalid: [1, "a"],
    },
    byName: {
      source: "Type.Record(Type.String(), Type.Array(Type.Integer()))",
      valid: { a: [1] },
      invalid: { a: [1.5] },
    },
    byIndex: {
      source: "Type.Record(Type.Number(), Type.String())",
      valid: { 0: "a" },
      invalid: { 0: 1 },
    },
    nested: {
      source:
        "Type.Object({ rows: Type.Array(Type.Object({ tags: Type.Array(Type.String()), note: Type.Optional(Type.String()), id: Type.Readonly(Type.String()) })), grid: Type.Array(Type.Array(Type.Number())) }, { additionalProperties: false })",
      valid: { rows: [{ tags: ["a"], id: "r" }], grid: [[1], []] },
      invalid: { rows: [{ tags: [1], id: "r" }], grid: [] },
    },
    text: {
      source: 'Type.String({ pattern: "^a", format: "email" })',
      valid: "a@b.co",
      invalid: "b@b.co",
    },
    either: {
      source:
        'Type.Union([Type.Null(), Type.Array(Type.Object({ id: Type.String() })), Type.Literal("x")])',
      valid: [{ id: "a" }],
      invalid: [{ id: 1 }],
    },
    both: {
      source:
        "Type.Intersect([Type.Object({ id: Type.String() }), Type.Object({ n: Type.Number() })], { unevaluatedProperties: false })",
      valid: { id: "a", n: 1 },
      invalid: { id: "a", n: 1, extra: true },
    },
    tree: {
      source:
        'Type.Module({ Tree: Type.Object({ id: Type.String(), children: Type.Array(Type.Ref("Tree")) }) }).Import("Tree")',
      valid: { id: "a", children: [{ id: "b", children: [] }] },
      invalid: { id: "a", children: [{ id: "b" }] },
    },
    shaped: {
      source: 'Type.TemplateLiteral([Type.Literal("a"), Type.Number()])',
      valid: "a1",
      invalid: "b1",
    },
    binary: {
      source: "Type.Object({ at: Type.Date(), bytes: Type.Uint8Array(), big: Type.BigInt() })",
      valid: { at: new Date(0), bytes: new Uint8Array(1), big: 1n },
      invalid: { at: new Date(0), bytes: [1], big: 1n },
    },
    sized: {
      source:
        "Type.Object({ a: Type.Optional(Type.String()) }, { minProperties: 1, maxProperties: 2, additionalProperties: Type.Number() })",
      valid: { a: "x", b: 1 },
      invalid: {},
    },
  }

  test(
    "typechecks under strict options and answers as the source validator",
    async () => {
      const root = mkdtempSync(join(dir, "modules-"))
      const sourceFile = join(root, "source.ts")
      writeFileSync(
        sourceFile,
        [
          'import { Type } from "@sinclair/typebox"',
          `import { fromTypeBox } from ${JSON.stringify(join(import.meta.dir, "../src/index.ts"))}`,
          ...Object.entries(SOURCES).map(
            ([name, { source }]) => `export const ${name} = fromTypeBox(${source})`,
          ),
        ].join("\n"),
      )
      const sources: Record<string, Parameters<typeof compileSchema>[0]> = await import(sourceFile)
      const files = [sourceFile]
      for (const [name, { valid, invalid }] of Object.entries(SOURCES)) {
        const source = sources[name]
        if (source === undefined) throw new Error(`no export ${name}`)
        const file = join(root, `${name}.ts`)
        writeFileSync(file, compileSchema(source, { source: "./source.ts", exportName: name }))
        files.push(file)
        const compiled: StandardSchemaV1 = (await import(file))[name]
        for (const value of [valid, invalid])
          expect({ name, value, outcome: result(compiled, value) }).toEqual({
            name,
            value,
            outcome: result(source, value),
          })
        expect({ name, valid: result(compiled, valid).issues }).toEqual({ name, valid: undefined })
        expect(result(compiled, invalid).issues).toBeDefined()
      }
      const program = ts.createProgram(files, {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        lib: ["lib.esnext.d.ts"],
        types: [],
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        noImplicitReturns: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        verbatimModuleSyntax: true,
        isolatedModules: true,
        allowImportingTsExtensions: true,
        noEmit: true,
        skipLibCheck: true,
        paths: {
          "@nifrajs/schema/precompiled": [join(import.meta.dir, "../src/precompiled.ts")],
          "@nifrajs/core/schema": [join(import.meta.dir, "../../core/src/schema/standard.ts")],
        },
      })
      const diagnostics = ts
        .getPreEmitDiagnostics(program)
        .filter((diagnostic) => diagnostic.file?.fileName.startsWith(root))
        .map(
          (diagnostic) =>
            `${diagnostic.file?.fileName.slice(root.length + 1)} TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
        )
      expect(diagnostics).toEqual([])
    },
    { timeout: 60_000 },
  )
})

import { describe, expect, test } from "bun:test"
import type { StandardSchemaV1 } from "../src/index.ts"
import { reflectRoutes, reflectSchema } from "../src/reflection.ts"

const standard: StandardSchemaV1 = {
  "~standard": { version: 1, vendor: "test", validate: (value) => ({ value }) },
}

describe("reflectSchema", () => {
  test("distinguishes validation from JSON Schema introspection", () => {
    const validationOnly = reflectSchema(standard)
    expect(validationOnly.standard).toBe(standard)
    expect(validationOnly.jsonSchema).toBeUndefined()
    expect(validationOnly.fields).toBeUndefined()

    const raw = { type: "string", minLength: 1 }
    const rawReflection = reflectSchema(raw)
    expect(rawReflection.standard).toBeUndefined()
    expect(rawReflection.jsonSchema).toEqual(raw)
  })

  test("unwraps a carrier and normalizes object fields", () => {
    const jsonSchema = {
      type: "object",
      properties: { name: { type: "string" }, enabled: true, ignored: null },
      required: ["name", 42],
    }
    const reflected = reflectSchema({ ...standard, jsonSchema })
    expect(reflected.standard).toBeDefined()
    expect(reflected.jsonSchema).toEqual(jsonSchema)
    expect(reflected.fields).toEqual([
      { name: "name", required: true, schema: { type: "string" } },
      { name: "enabled", required: false, schema: true },
    ])

    const direct = reflectSchema({ ...standard, ...jsonSchema })
    expect(direct.fields).toEqual(reflected.fields)
  })

  test("supports boolean schemas and rejects invalid carriers", () => {
    expect(reflectSchema(false).jsonSchema).toBe(false)
    expect(reflectSchema({ ...standard, jsonSchema: null }).jsonSchema).toBeUndefined()
    expect(reflectSchema({ "~standard": {} }).jsonSchema).toBeUndefined()
    expect(reflectSchema(null).jsonSchema).toBeUndefined()
    const circular: Record<string, unknown> = { type: "object" }
    circular.self = circular
    expect(reflectSchema(circular).jsonSchema).toBeUndefined()
  })
})

describe("reflectRoutes", () => {
  test("normalizes contracts, error schemas, and tool metadata", () => {
    const routes = reflectRoutes({
      routes: () => [
        {
          method: "post",
          path: "/tools/run",
          schema: {
            body: { ...standard, jsonSchema: { type: "object", properties: {} } },
            response: standard,
            errors: { 400: { type: "object", properties: { error: { type: "string" } } } },
          },
          tool: { name: "run", description: "Run it", annotations: { readOnlyHint: true } },
        },
      ],
    })
    expect(routes).toHaveLength(1)
    expect(routes[0]?.method).toBe("POST")
    expect(routes[0]?.schema?.body?.jsonSchema).toEqual({ type: "object", properties: {} })
    expect(routes[0]?.schema?.response?.standard).toBe(standard)
    expect(routes[0]?.schema?.errors?.["400"]?.fields?.[0]?.name).toBe("error")
    expect(routes[0]?.tool?.annotations?.readOnlyHint).toBe(true)
  })

  test("fails closed for invalid and throwing route sources", () => {
    expect(
      reflectRoutes([
        { method: "get", path: "/ok" },
        { method: 1, path: "/bad" },
      ]),
    ).toEqual([{ method: "GET", path: "/ok" }])
    expect(
      reflectRoutes({
        routes: () => {
          throw new Error("boom")
        },
      }),
    ).toEqual([])
    expect(reflectRoutes(null)).toEqual([])
  })
})

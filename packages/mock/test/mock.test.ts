import { describe, expect, test } from "bun:test"
import { createMockServer, generateMockValue, UnsupportedMockSchemaError } from "../src/index.ts"

describe("generateMockValue", () => {
  test("generates string values", () => {
    const val = generateMockValue({ type: "string" }, "username")
    expect(val).toBe("mock_username")
  })

  test("generates email format strings", () => {
    const val = generateMockValue({ type: "string", format: "email" }, "contact")
    expect(val).toBe("mock@contact.com")
  })

  test("generates number values within range", () => {
    const val = generateMockValue({ type: "number", minimum: 10, maximum: 20 }) as number
    expect(val).toBeGreaterThanOrEqual(10)
    expect(val).toBeLessThanOrEqual(20)
  })

  test("generates integer values", () => {
    const val = generateMockValue({ type: "integer" }) as number
    expect(Number.isInteger(val)).toBe(true)
  })

  test("generates boolean values", () => {
    expect(generateMockValue({ type: "boolean" })).toBe(true)
  })

  test("generates null values", () => {
    expect(generateMockValue({ type: "null" })).toBeNull()
  })

  test("picks enum values", () => {
    const val = generateMockValue({ type: "string", enum: ["active", "inactive"] })
    expect(["active", "inactive"]).toContain(val as string)
  })

  test("supports const, unions, nullable types, intersections, and constraints", () => {
    expect(generateMockValue({ const: "fixed" })).toBe("fixed")
    expect(generateMockValue({ anyOf: [{ const: "a" }, { const: "b" }] }, undefined, () => 0)).toBe(
      "a",
    )
    expect(generateMockValue({ type: ["string", "null"], minLength: 12 })).toBeString()
    expect(
      generateMockValue({
        allOf: [
          { type: "object", properties: { a: { const: 1 } } },
          { type: "object", properties: { b: { const: 2 } } },
        ],
      }),
    ).toEqual({ a: 1, b: 2 })
    expect(generateMockValue({ allOf: [{ const: "same" }, { const: "same" }] })).toBe("same")
    const multiple = generateMockValue({ type: "integer", minimum: 5, maximum: 20, multipleOf: 5 })
    expect(multiple).toBeOneOf([5, 10, 15, 20])
    const items = generateMockValue({
      type: "array",
      minItems: 4,
      maxItems: 4,
      items: { type: "string" },
    })
    expect(items).toHaveLength(4)
  })

  test("fails closed for unsupported constraints", () => {
    expect(() => generateMockValue({ type: "string", pattern: "^Z{20}$" })).toThrow(
      UnsupportedMockSchemaError,
    )
    expect(() => generateMockValue({ not: { type: "string" } })).toThrow(UnsupportedMockSchemaError)
    expect(() => generateMockValue({ oneOf: [{ const: "a" }, { const: "b" }] })).toThrow(
      UnsupportedMockSchemaError,
    )
    expect(() => generateMockValue({ $ref: "#/$defs/User" })).toThrow(UnsupportedMockSchemaError)
    expect(() => generateMockValue({ allOf: [{ const: "a" }, { const: "b" }] })).toThrow(
      UnsupportedMockSchemaError,
    )
  })

  test("generates object values from properties", () => {
    const val = generateMockValue({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "integer" },
      },
    }) as Record<string, unknown>
    expect(typeof val.name).toBe("string")
    expect(typeof val.age).toBe("number")
  })

  test("generates array values from items", () => {
    const val = generateMockValue({
      type: "array",
      items: { type: "string" },
    }) as unknown[]
    expect(Array.isArray(val)).toBe(true)
    expect(val.length).toBeGreaterThanOrEqual(1)
    expect(val.length).toBeLessThanOrEqual(3)
    for (const item of val) {
      expect(typeof item).toBe("string")
    }
  })

  test("returns {} for opaque schemas", () => {
    expect(generateMockValue({})).toEqual({})
    expect(generateMockValue(null)).toEqual({})
  })

  test("handles JSON Schema boolean contracts explicitly", () => {
    expect(generateMockValue(true)).toEqual({})
    expect(() => generateMockValue(false)).toThrow(UnsupportedMockSchemaError)
  })

  test("unwraps NifraSchema .jsonSchema wrapper", () => {
    const val = generateMockValue(
      {
        jsonSchema: { type: "string" },
        "~standard": { version: 1, vendor: "test", validate: () => ({}) },
      },
      "wrapped",
    )
    expect(val).toBe("mock_wrapped")
  })

  test("clamps rng values at the top of the range instead of indexing past the end", () => {
    const topOfRange = () => 1
    expect(generateMockValue({ enum: ["a", "b"] }, undefined, topOfRange)).toBe("b")
    expect(
      generateMockValue({ anyOf: [{ const: "x" }, { const: "y" }] }, undefined, topOfRange),
    ).toBe("y")
  })

  test("produces deterministic output with seeded rng", () => {
    function seededRandom(seed: number): () => number {
      let s = seed
      return () => {
        s = (s * 1664525 + 1013904223) & 0x7fffffff
        return s / 0x7fffffff
      }
    }
    const a = generateMockValue({ type: "number" }, undefined, seededRandom(123))
    const b = generateMockValue({ type: "number" }, undefined, seededRandom(123))
    expect(a).toBe(b)
  })
})

describe("createMockServer", () => {
  test("returns mock responses for routes with response schemas", async () => {
    const fakeApp = {
      routes: () => [
        {
          method: "GET",
          path: "/users",
          schema: {
            response: {
              type: "object",
              properties: {
                users: {
                  type: "array",
                  items: { type: "object", properties: { name: { type: "string" } } },
                },
              },
            },
          },
        },
      ],
    }

    const mock = createMockServer(fakeApp, { seed: 42 })
    const res = await mock.fetch(new Request("http://localhost/users"))
    expect(res.status).toBe(200)
    expect(res.headers.get("x-nifra-mock")).toBe("true")

    const body = (await res.json()) as Record<string, unknown>
    expect(body).toHaveProperty("users")
    expect(Array.isArray(body.users)).toBe(true)
  })

  test("returns {} for routes without response schemas", async () => {
    const fakeApp = {
      routes: () => [{ method: "POST", path: "/submit" }],
    }

    const mock = createMockServer(fakeApp, { seed: 1 })
    const res = await mock.fetch(new Request("http://localhost/submit", { method: "POST" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
  })

  test("returns 404 for unregistered routes", async () => {
    const fakeApp = { routes: () => [] }
    const mock = createMockServer(fakeApp)
    const res = await mock.fetch(new Request("http://localhost/nope"))
    expect(res.status).toBe(404)
  })

  test("matches parameterized routes", async () => {
    const fakeApp = {
      routes: () => [
        {
          method: "GET",
          path: "/users/:id",
          schema: { response: { type: "object", properties: { id: { type: "string" } } } },
        },
      ],
    }

    const mock = createMockServer(fakeApp, { seed: 7 })
    const res = await mock.fetch(new Request("http://localhost/users/abc123"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toHaveProperty("id")
  })

  test("matches trailing wildcards but rejects empty parameter segments", async () => {
    const fakeApp = {
      routes: () => [
        { method: "GET", path: "/files/*path" },
        { method: "GET", path: "/users/:id/posts" },
      ],
    }
    const mock = createMockServer(fakeApp)
    expect((await mock.fetch(new Request("http://localhost/files/a/b.txt"))).status).toBe(200)
    expect((await mock.fetch(new Request("http://localhost/users//posts"))).status).toBe(404)
  })

  test("uses core precedence when param and wildcard patterns overlap", async () => {
    const fakeApp = {
      routes: () => [
        { method: "GET", path: "/files/*path", schema: { response: { const: "wildcard" } } },
        { method: "GET", path: "/files/:name", schema: { response: { const: "param" } } },
      ],
    }
    const mock = createMockServer(fakeApp)
    const response = await mock.fetch(new Request("http://localhost/files/readme"))
    expect(await response.json()).toBe("param")
  })

  test("exposes mockRoutes for inspection", () => {
    const fakeApp = {
      routes: () => [
        { method: "GET", path: "/a" },
        { method: "POST", path: "/b" },
      ],
    }
    const mock = createMockServer(fakeApp)
    expect(mock.mockRoutes).toEqual([
      { method: "GET", path: "/a" },
      { method: "POST", path: "/b" },
    ])
  })
})

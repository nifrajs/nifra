import { describe, expect, test } from "bun:test"
import { clientCall, type RouteJson, routesToJson, tsTypeOf } from "../src/introspect.ts"
import type { LoadedApp } from "../src/load.ts"

// A minimal LoadedApp whose backend exposes the routes routesToJson reads — the only field it touches.
const appWith = (routes: unknown[]): LoadedApp =>
  ({ backend: { routes: () => routes } }) as unknown as LoadedApp

// The token-efficiency contract: JSON Schema in, compact TS-shaped contract out — faithful, and a
// fraction of the raw schema's tokens (the MCP nifra_context payload is built from these).

describe("tsTypeOf", () => {
  test("object with optionals", () => {
    expect(
      tsTypeOf({
        type: "object",
        properties: { id: { type: "string" }, name: { type: "string" }, age: { type: "number" } },
        required: ["id"],
      }),
    ).toBe("{ id: string, name?: string, age?: number }")
  })

  test("arrays, nested objects, integer → number", () => {
    expect(
      tsTypeOf({
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string" } },
          profile: {
            type: "object",
            properties: { score: { type: "integer" } },
            required: ["score"],
          },
        },
        required: ["tags", "profile"],
      }),
    ).toBe("{ tags: string[], profile: { score: number } }")
  })

  test("unions, enums, consts, union arrays parenthesized", () => {
    expect(tsTypeOf({ anyOf: [{ type: "string" }, { type: "null" }] })).toBe("string | null")
    expect(tsTypeOf({ enum: ["a", "b"] })).toBe('"a" | "b"')
    expect(tsTypeOf({ const: 42 })).toBe("42")
    expect(
      tsTypeOf({ type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } }),
    ).toBe("(string | number)[]")
  })

  test("record shapes and empty objects", () => {
    expect(tsTypeOf({ type: "object" })).toBe("{}")
    expect(tsTypeOf({ type: "object", additionalProperties: true })).toBe("Record<string, unknown>")
    expect(tsTypeOf({ type: "object", additionalProperties: { type: "number" } })).toBe(
      "Record<string, number>",
    )
  })

  test("unmodeled shapes fall back to raw JSON (faithful, never lossy)", () => {
    expect(tsTypeOf({ type: "weird-custom" })).toBe('{"type":"weird-custom"}')
  })

  test("compactness: dramatically smaller than the raw schema", () => {
    const schema = {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["id", "name"],
    }
    const compact = tsTypeOf(schema)
    expect(compact.length).toBeLessThan(JSON.stringify(schema).length * 0.45)
  })
})

// The call signature must match @nifrajs/client's proxy convention exactly — it's what an agent copies
// instead of reading client.test.ts (user feedback 2026-06).
describe("clientCall — typed-client call form per route", () => {
  test("static path + verb (no schema)", () => {
    expect(clientCall("GET", "/users", undefined)).toBe("await api.users.get()")
  })

  test("root path uses .index", () => {
    expect(clientCall("GET", "/", undefined)).toBe("await api.index.get()")
  })

  test("path param becomes a call that appends the value", () => {
    expect(clientCall("GET", "/users/:id", undefined)).toBe("await api.users({ id }).get()")
  })

  test("nested static segments chain as properties", () => {
    expect(clientCall("POST", "/v1/session", { body: { type: "object" } })).toBe(
      "await api.v1.session.post(body)",
    )
  })

  test("non-body verb puts query in the first (call-options) slot", () => {
    expect(clientCall("GET", "/search", { query: { type: "object" } })).toBe(
      "await api.search.get({ query })",
    )
  })

  test("body verb with body AND query: body first, then call-options", () => {
    expect(clientCall("PUT", "/users/:id", { body: {}, query: {} })).toBe(
      "await api.users({ id }).put(body, { query })",
    )
  })

  test("body verb with query but no body still fills the body slot", () => {
    expect(clientCall("POST", "/items", { query: {} })).toBe(
      "await api.items.post(undefined, { query })",
    )
  })

  test("non-identifier segment uses bracket access", () => {
    expect(clientCall("GET", "/well-known/info", undefined)).toBe(
      'await api["well-known"].info.get()',
    )
  })
})

// Structured route JSON for the nifra_routes MCP tool (feedback 2026-06: agents want JSON, not markdown).
describe("routesToJson — structured list_routes / get_route_schema", () => {
  const bodySchema = {
    jsonSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  }

  test("lists routes sorted, with method/path/call and shaped contracts", () => {
    const out = routesToJson(
      appWith([
        { method: "POST", path: "/users", schema: { body: bodySchema } },
        { method: "GET", path: "/users/:id" },
      ]),
    )
    expect(out).toEqual([
      {
        method: "POST",
        path: "/users",
        call: "await api.users.post(body)",
        body: "{ name: string }",
      } as RouteJson,
      { method: "GET", path: "/users/:id", call: "await api.users({ id }).get()" } as RouteJson,
    ])
  })

  test("omits absent shapes (no body/query/response keys when unschematized)", () => {
    const [route] = routesToJson(appWith([{ method: "GET", path: "/health" }]))
    expect(route).toEqual({ method: "GET", path: "/health", call: "await api.health.get()" })
    expect(Object.keys(route as RouteJson)).not.toContain("body")
  })

  test("filters by path prefix", () => {
    const app = appWith([
      { method: "GET", path: "/api/orders" },
      { method: "GET", path: "/health" },
    ])
    expect(routesToJson(app, "/api").map((r) => r.path)).toEqual(["/api/orders"])
  })

  test("no backend → empty list", () => {
    expect(routesToJson({} as LoadedApp)).toEqual([])
  })
})

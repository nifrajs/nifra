import { describe, expect, test } from "bun:test"
import { generateLlmsTxt } from "../src/llms-txt.ts"

/** A schema node the way a `t`/Standard Schema exposes it: the raw JSON Schema hangs off `.jsonSchema`. */
function schema(jsonSchema: unknown): { jsonSchema: unknown } {
  return { jsonSchema }
}

const pageRoutes = [
  { pattern: "/", id: "index" },
  { pattern: "/users/:id", id: "users.$id" },
]

/** A fake backend exposing `.routes()` — the only surface {@link generateLlmsTxt} reads. Routes cover the
 * JSON-Schema shapes `tsTypeOf` renders (object/array/enum/union/const/primitives) and the `clientCall`
 * path/body/query permutations (index, path param, body verb, query-only GET). */
const backend = {
  routes: () => [
    { method: "GET", path: "/" },
    {
      method: "POST",
      path: "/users",
      schema: {
        body: schema({
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            age: { type: "number" },
            active: { type: "boolean" },
            tags: { type: "array", items: { type: "string" } },
            role: { enum: ["admin", "user"] },
            kind: { anyOf: [{ type: "string" }, { type: "number" }] },
            version: { const: 1 },
            nothing: { type: "null" },
            meta: { type: "object", additionalProperties: { type: "string" } },
          },
        }),
        query: schema({ type: "object", properties: { verbose: { type: "boolean" } } }),
        response: schema({ type: "object", properties: { id: { type: "string" } } }),
        errors: {
          404: schema({
            type: "object",
            required: ["message"],
            properties: { message: { type: "string" } },
          }),
        },
      },
    },
    {
      method: "GET",
      path: "/items/:id",
      schema: { query: schema({ type: "object", properties: { page: { type: "number" } } }) },
    },
  ],
}

describe("generateLlmsTxt", () => {
  test("summary form lists page and API routes without schemas", async () => {
    const out = await generateLlmsTxt(false, pageRoutes, backend)
    expect(out).toContain("# Nifra App Context")
    expect(out).toContain("## Page Routes")
    expect(out).toContain("`/users/:id`")
    expect(out).toContain("## API Routes")
    expect(out).toContain("**POST** `/users`")
    // summary form omits the per-route schema detail
    expect(out).not.toContain("Body Schema")
  })

  test("full form renders client calls and TypeScript schema types", async () => {
    const out = await generateLlmsTxt(true, pageRoutes, backend)
    expect(out).toContain("Client Call")
    // clientCall: index, path param, body verb + query
    expect(out).toContain("api.index")
    expect(out).toContain("api.users.post(body, { query })")
    expect(out).toContain("api.items({ id }).get({ query })")
    // tsTypeOf: object w/ required+optional, array, enum, union, const, additionalProperties
    expect(out).toContain("name: string")
    expect(out).toContain("age?: number")
    expect(out).toContain("tags?: string[]")
    expect(out).toContain('role?: "admin" | "user"')
    expect(out).toContain("kind?: string | number")
    expect(out).toContain("version?: 1")
    expect(out).toContain("Record<string, string>")
    expect(out).toContain("Query Schema")
    expect(out).toContain("Response Schema")
    // errors contract → per-status error schemas
    expect(out).toContain("Error 404 Schema")
    expect(out).toContain("message: string")
  })

  test("reports when no API routes are registered", async () => {
    const out = await generateLlmsTxt(true, [], { routes: () => [] })
    expect(out).toContain("No API routes registered.")
  })

  test("tolerates a backend without a routes() method", async () => {
    const out = await generateLlmsTxt(true, [], {})
    expect(out).toContain("No API routes registered.")
  })
})

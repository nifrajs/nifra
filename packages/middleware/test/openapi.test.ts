import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { buildOpenApiDocument, openapi, type RouteLike } from "@nifrajs/middleware"
import { t } from "@nifrajs/schema"

const stubSchema = { body: { "~standard": {} }, query: { "~standard": {} } }

interface Operation {
  parameters?: Array<{ name: string; in: string; required: boolean; schema: unknown }>
  requestBody?: { required?: boolean; content: Record<string, { schema: unknown }> }
  description?: string
  summary?: string
  responses?: Record<string, { description: string; content?: Record<string, { schema: unknown }> }>
}
interface Doc {
  openapi: string
  info: Record<string, string>
  servers?: unknown
  paths: Record<string, Record<string, Operation> | undefined>
}
const build = (routes: RouteLike[], options?: Parameters<typeof buildOpenApiDocument>[1]): Doc =>
  buildOpenApiDocument(routes, options) as unknown as Doc

describe("buildOpenApiDocument()", () => {
  test("emits 3.1 paths, methods, and templated path params", () => {
    const doc = build(
      [
        { method: "GET", path: "/users/:id" },
        { method: "DELETE", path: "/users/:id" },
        { method: "GET", path: "/health" },
      ],
      { info: { title: "T", version: "9" } },
    )
    expect(doc.openapi).toBe("3.1.0")
    expect(doc.info).toEqual({ title: "T", version: "9" })
    // ":id" → "{id}", with a path parameter declared, and both methods grouped under one path.
    expect(Object.keys(doc.paths["/users/{id}"] ?? {}).sort()).toEqual(["delete", "get"])
    expect(doc.paths["/users/{id}"]?.get?.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "string" } },
    ])
    expect(doc.paths["/health"]?.get?.responses).toEqual({ "200": { description: "OK" } })
  })

  test("emits full field-level schemas for `t` routes (body, query params, response)", () => {
    const doc = build([
      {
        method: "POST",
        path: "/items",
        schema: {
          body: t.object({ name: t.string(), qty: t.number() }),
          query: t.object({ dryRun: t.optional(t.boolean()) }),
          response: t.object({ id: t.string() }),
        },
      },
    ])
    const op = doc.paths["/items"]?.post
    // Request body carries the real object shape (not a bare `{ type: "object" }`).
    expect(op?.requestBody?.content["application/json"]?.schema).toMatchObject({
      type: "object",
      properties: { name: { type: "string" }, qty: { type: "number" } },
      required: ["name", "qty"],
    })
    // Query object decomposes into individual parameters; `t.Optional` ⇒ not required.
    expect(op?.parameters).toEqual([
      { name: "dryRun", in: "query", required: false, schema: { type: "boolean" } },
    ])
    // Declared `response` contract becomes the 200 body schema.
    expect(op?.responses?.["200"]?.content?.["application/json"]?.schema).toMatchObject({
      type: "object",
      properties: { id: { type: "string" } },
    })
  })

  test("a BYO Standard Schema (no JSON Schema) emits the route but omits unintrospectable body/query", () => {
    // zod/valibot/arktype validate at runtime but expose no portable JSON Schema, so we don't fabricate
    // a shape — the operation still appears, detail comes from `options.operations`.
    const doc = build([{ method: "POST", path: "/items", schema: stubSchema }])
    const op = doc.paths["/items"]?.post
    expect(op).toBeDefined()
    expect(op?.requestBody).toBeUndefined()
    expect(op?.parameters).toBeUndefined()
  })

  test("templatizes a wildcard segment", () => {
    const doc = build([{ method: "GET", path: "/files/*" }])
    expect(doc.paths["/files/{wildcard}"]?.get?.parameters?.[0]?.name).toBe("wildcard")
  })

  test("excludes the doc path + custom exclusions, and includes servers", () => {
    const doc = build(
      [
        { method: "GET", path: "/openapi.json" },
        { method: "GET", path: "/internal/metrics" },
        { method: "GET", path: "/public" },
      ],
      { exclude: (r) => r.path.startsWith("/internal"), servers: [{ url: "https://api.x" }] },
    )
    expect(doc.paths["/openapi.json"]).toBeUndefined()
    expect(doc.paths["/internal/metrics"]).toBeUndefined()
    expect(doc.paths["/public"]).toBeDefined()
    expect(doc.servers).toEqual([{ url: "https://api.x" }])
  })

  test("emits doc-level tags, security, and components.securitySchemes", () => {
    const doc = build([{ method: "GET", path: "/public" }], {
      tags: [{ name: "core" }],
      security: [{ bearer: [] }],
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    }) as Doc & {
      tags?: unknown
      security?: unknown
      components?: { securitySchemes?: unknown }
    }
    expect(doc.tags).toEqual([{ name: "core" }])
    expect(doc.security).toEqual([{ bearer: [] }])
    expect(doc.components?.securitySchemes).toEqual({ bearer: { type: "http", scheme: "bearer" } })
  })

  test("shallow-merges per-operation overrides", () => {
    const doc = build([{ method: "GET", path: "/users/:id" }], {
      operations: {
        "GET /users/:id": {
          summary: "Get a user",
          responses: { "200": { description: "A user" } },
        },
      },
    })
    expect(doc.paths["/users/{id}"]?.get?.summary).toBe("Get a user")
    expect(doc.paths["/users/{id}"]?.get?.responses?.["200"]?.description).toBe("A user")
  })

  test("defaults info when omitted", () => {
    expect(build([]).info).toEqual({ title: "nifra API", version: "0.0.0" })
  })
})

describe("openapi() plugin", () => {
  test("serves the generated document at /openapi.json (lazy — sees later routes)", async () => {
    const app = server()
      .use(openapi({ info: { title: "My API", version: "1.0.0" } }))
      .get("/users/:id", (c) => ({ id: c.params.id })) // registered AFTER the plugin
      .post("/users", () => ({ ok: true }))
    const res = await app.fetch(new Request("http://x/openapi.json"))
    expect(res.headers.get("content-type")).toBe("application/json")
    const doc = (await res.json()) as Doc
    expect(doc.info.title).toBe("My API")
    expect(doc.paths["/users/{id}"]?.get).toBeDefined() // route added after use() is present
    expect(doc.paths["/users"]?.post).toBeDefined()
    expect(doc.paths["/openapi.json"]).toBeUndefined() // self excluded
  })

  test("serves at a custom path", async () => {
    const app = server()
      .use(openapi({ path: "/spec.json" }))
      .get("/", () => ({ ok: true }))
    expect((await app.fetch(new Request("http://x/spec.json"))).status).toBe(200)
  })
})

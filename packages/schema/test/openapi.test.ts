import { describe, expect, test } from "bun:test"
import type { StandardSchemaV1 } from "@nifrajs/core"
import { server } from "@nifrajs/core"
import { defineContract } from "@nifrajs/core/contract"
import { t, toOpenAPI } from "../src/index.ts"

// A BYO Standard Schema: validates at runtime but exposes no JSON Schema.
const byo: StandardSchemaV1 = {
  "~standard": { version: 1, vendor: "byo", validate: (value) => ({ value }) },
}

describe("toOpenAPI(contract)", () => {
  const contract = defineContract({
    getUser: {
      method: "GET",
      path: "/users/:id",
      response: t.object({ id: t.string(), name: t.string() }),
    },
    createUser: {
      method: "POST",
      path: "/users",
      body: t.object({ name: t.string() }),
      response: t.object({ id: t.string() }),
    },
    listUsers: { method: "GET", path: "/users", query: t.object({ limit: t.integer() }) },
  })
  const doc = toOpenAPI(contract, { title: "Users API", version: "2.0.0" })

  test("top-level document shape", () => {
    expect(doc.openapi).toBe("3.1.0")
    expect(doc.info).toEqual({ title: "Users API", version: "2.0.0" })
    expect(Object.keys(doc.paths).sort()).toEqual(["/users", "/users/{id}"])
  })

  test("operationId = op name; methods lowercased; same path merges methods", () => {
    expect(doc.paths["/users/{id}"]?.get?.operationId).toBe("getUser")
    expect(doc.paths["/users"]?.get?.operationId).toBe("listUsers")
    expect(doc.paths["/users"]?.post?.operationId).toBe("createUser")
  })

  test("path params → required path parameters", () => {
    expect(doc.paths["/users/{id}"]?.get?.parameters).toContainEqual({
      name: "id",
      in: "path",
      required: true,
      schema: { type: "string" },
    })
  })

  test("query object → query parameters", () => {
    expect(doc.paths["/users"]?.get?.parameters).toContainEqual({
      name: "limit",
      in: "query",
      required: true,
      schema: { type: "integer" },
    })
  })

  test("body → requestBody carrying the t schema's JSON Schema", () => {
    const requestBody = doc.paths["/users"]?.post?.requestBody
    expect(requestBody?.required).toBe(true)
    expect(requestBody?.content["application/json"]?.schema).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false, // t.object is strict by default
    })
  })

  test("response schema → 200 content; no response → generic 200", () => {
    expect(
      doc.paths["/users/{id}"]?.get?.responses["200"]?.content?.["application/json"]?.schema,
    ).toEqual({
      type: "object",
      properties: { id: { type: "string" }, name: { type: "string" } },
      required: ["id", "name"],
      additionalProperties: false, // t.object is strict by default
    })
    // listUsers declares no response → generic 200.
    expect(doc.paths["/users"]?.get?.responses["200"]).toEqual({ description: "OK" })
  })
})

describe("toOpenAPI(app)", () => {
  const app = server()
    .post("/items", { body: t.object({ name: t.string() }) }, (c) => ({
      id: "1",
      name: c.body.name,
    }))
    .get("/items/:id", (c) => ({ id: c.params.id }))
    .get("/me", { response: t.object({ id: t.string() }) }, () => ({ id: "1" }))
    .post(
      "/orders",
      { body: t.object({ item: t.string() }), errors: { 404: t.object({ message: t.string() }) } },
      () => ({ ok: true }),
    )
  const doc = toOpenAPI(app)

  test("enumerates routes: requestBody from t, generic 200, no operationId", () => {
    expect(Object.keys(doc.paths).sort()).toEqual(["/items", "/items/{id}", "/me", "/orders"])
    expect(
      doc.paths["/items"]?.post?.requestBody?.content["application/json"]?.schema,
    ).toMatchObject({
      type: "object",
      properties: { name: { type: "string" } },
    })
    expect(doc.paths["/items"]?.post?.operationId).toBeUndefined()
    expect(doc.paths["/items/{id}"]?.get?.responses["200"]).toEqual({ description: "OK" })
    expect(doc.paths["/items/{id}"]?.get?.parameters).toContainEqual({
      name: "id",
      in: "path",
      required: true,
      schema: { type: "string" },
    })
  })

  test("a route's `errors` contract becomes non-2xx responses with each error schema", () => {
    const res404 = doc.paths["/orders"]?.post?.responses["404"]
    expect(res404?.description).toBe("Not Found")
    expect(res404?.content?.["application/json"]?.schema).toEqual({
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    })
    // the happy-path 200 still stands alongside the error
    expect(doc.paths["/orders"]?.post?.responses["200"]).toBeDefined()
  })

  test("a route's declared `response` contract becomes the 200 body schema", () => {
    expect(
      doc.paths["/me"]?.get?.responses["200"]?.content?.["application/json"]?.schema,
    ).toMatchObject({ type: "object", properties: { id: { type: "string" } } })
  })

  test("default info when omitted", () => {
    expect(doc.info).toEqual({ title: "API", version: "1.0.0" })
  })
})

describe("BYO Standard Schema (no JSON Schema) is emitted without detail", () => {
  const contract = defineContract({
    makeThing: { method: "POST", path: "/things", body: byo, response: byo },
    searchThing: { method: "GET", path: "/things", query: byo },
  })
  const doc = toOpenAPI(contract)

  test("route present; no requestBody schema; generic response; no query params", () => {
    expect(doc.paths["/things"]?.post).toBeDefined()
    expect(doc.paths["/things"]?.post?.requestBody).toBeUndefined()
    expect(doc.paths["/things"]?.post?.responses["200"]).toEqual({ description: "OK" })
    expect(doc.paths["/things"]?.get?.parameters).toBeUndefined()
  })
})

describe("document-level breadth (servers, tags, security, info.description)", () => {
  const contract = defineContract({
    getUser: { method: "GET", path: "/users/:id", response: t.object({ id: t.string() }) },
  })
  const doc = toOpenAPI(contract, {
    title: "Users API",
    version: "2.0.0",
    description: "The users service.",
    servers: [
      { url: "https://api.example.com", description: "prod" },
      { url: "http://localhost:3000" },
    ],
    tags: [{ name: "users", description: "User operations" }],
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    security: [{ bearer: [] }],
  })

  test("info carries description; servers + tags + security emitted; securitySchemes under components", () => {
    expect(doc.info).toEqual({
      title: "Users API",
      version: "2.0.0",
      description: "The users service.",
    })
    expect(doc.servers).toEqual([
      { url: "https://api.example.com", description: "prod" },
      { url: "http://localhost:3000" },
    ])
    expect(doc.tags).toEqual([{ name: "users", description: "User operations" }])
    expect(doc.security).toEqual([{ bearer: [] }])
    expect(doc.components?.securitySchemes).toEqual({ bearer: { type: "http", scheme: "bearer" } })
  })

  test("a doc without breadth options omits servers/tags/security/components entirely", () => {
    const plain = toOpenAPI(contract, { title: "X", version: "1" })
    expect(plain.servers).toBeUndefined()
    expect(plain.tags).toBeUndefined()
    expect(plain.security).toBeUndefined()
    expect(plain.components).toBeUndefined()
  })
})

describe("per-operation metadata (tags, summary, security, deprecated, non-200, non-JSON)", () => {
  const contract = defineContract({
    createUser: {
      method: "POST",
      path: "/users",
      summary: "Create a user",
      description: "Creates and returns a user.",
      tags: ["users"],
      deprecated: true,
      security: [{ bearer: ["write:users"] }],
      body: t.object({ name: t.string() }),
      response: t.object({ id: t.string() }),
      responses: {
        "400": { description: "Validation failed", schema: t.object({ error: t.string() }) },
        "404": { description: "Not found" },
      },
    },
    upload: {
      method: "POST",
      path: "/upload",
      requestContentType: "application/octet-stream",
      responseContentType: "text/plain",
      body: t.string(),
      response: t.string(),
    },
    publicPing: { method: "GET", path: "/ping", security: [] }, // [] ⇒ explicitly public
  })
  const doc = toOpenAPI(contract)

  test("op carries summary/description/tags/deprecated/security", () => {
    const op = doc.paths["/users"]?.post
    expect(op?.summary).toBe("Create a user")
    expect(op?.description).toBe("Creates and returns a user.")
    expect(op?.tags).toEqual(["users"])
    expect(op?.deprecated).toBe(true)
    expect(op?.security).toEqual([{ bearer: ["write:users"] }])
  })

  test("additional responses: schema'd 400 + description-only 404, alongside the 200", () => {
    const responses = doc.paths["/users"]?.post?.responses
    expect(responses?.["200"]?.content?.["application/json"]).toBeDefined()
    expect(responses?.["400"]?.content?.["application/json"]?.schema).toMatchObject({
      type: "object",
      properties: { error: { type: "string" } },
    })
    expect(responses?.["404"]).toEqual({ description: "Not found" })
  })

  test("non-JSON request + response content types", () => {
    const op = doc.paths["/upload"]?.post
    expect(op?.requestBody?.content["application/octet-stream"]).toBeDefined()
    expect(op?.responses["200"]?.content?.["text/plain"]).toBeDefined()
  })

  test("security: [] is emitted (explicitly public, overrides any doc default)", () => {
    expect(doc.paths["/ping"]?.get?.security).toEqual([])
  })
})

describe("$ref reuse via $id → components.schemas", () => {
  const User = t.object({ id: t.string(), name: t.string() }, { $id: "User" })
  const contract = defineContract({
    getUser: { method: "GET", path: "/users/:id", response: User },
    createUser: { method: "POST", path: "/users", body: User, response: User },
  })
  const doc = toOpenAPI(contract)

  test("a $id schema is hoisted once and referenced by $ref everywhere", () => {
    expect(doc.components?.schemas?.User).toEqual({
      type: "object",
      properties: { id: { type: "string" }, name: { type: "string" } },
      required: ["id", "name"],
      additionalProperties: false,
    })
    // $id is stripped from the hoisted component (the key is the name).
    const component = doc.components?.schemas?.User
    expect(typeof component === "object" ? component.$id : undefined).toBeUndefined()
    const ref = { $ref: "#/components/schemas/User" }
    expect(
      doc.paths["/users/{id}"]?.get?.responses["200"]?.content?.["application/json"]?.schema,
    ).toEqual(ref)
    expect(doc.paths["/users"]?.post?.requestBody?.content["application/json"]?.schema).toEqual(ref)
    expect(
      doc.paths["/users"]?.post?.responses["200"]?.content?.["application/json"]?.schema,
    ).toEqual(ref)
  })

  test("a URI $id becomes a valid component name and resolvable JSON Pointer", () => {
    const id = "https://schemas.example.com/domain/User"
    const UriUser = t.object({ id: t.string() }, { $id: id })
    const uriDoc = toOpenAPI(
      defineContract({ getUriUser: { method: "GET", path: "/uri-user", response: UriUser } }),
    )

    const componentNames = Object.keys(uriDoc.components?.schemas ?? {})
    expect(componentNames).toHaveLength(1)
    const componentName = componentNames[0] as string
    expect(componentName).toMatch(/^[A-Za-z0-9._-]+$/)
    expect(componentName).not.toBe(id)
    expect(
      uriDoc.paths["/uri-user"]?.get?.responses["200"]?.content?.["application/json"]?.schema,
    ).toEqual({ $ref: `#/components/schemas/${componentName}` })
  })

  test("a valid component name cannot collide with Object.prototype", () => {
    const PrototypeNamed = t.object({ id: t.string() }, { $id: "__proto__" })
    const prototypeDoc = toOpenAPI(
      defineContract({
        getPrototypeNamed: {
          method: "GET",
          path: "/prototype-named",
          response: PrototypeNamed,
        },
      }),
    )

    expect(Object.hasOwn(prototypeDoc.components?.schemas ?? {}, "__proto__")).toBe(true)
    expect(
      prototypeDoc.paths["/prototype-named"]?.get?.responses["200"]?.content?.["application/json"]
        ?.schema,
    ).toEqual({ $ref: "#/components/schemas/__proto__" })
  })
})

describe("operations override (escape hatch, app + contract)", () => {
  const app = server().get("/items/:id", (c) => ({ id: c.params.id }))
  const doc = toOpenAPI(app, {
    operations: { "GET /items/:id": { summary: "Get item", tags: ["items"] } },
  })

  test("an app route gains metadata it can't introspect, keyed by METHOD /path", () => {
    expect(doc.paths["/items/{id}"]?.get?.summary).toBe("Get item")
    expect(doc.paths["/items/{id}"]?.get?.tags).toEqual(["items"])
  })
})

describe("path templating edge cases", () => {
  const contract = defineContract({
    download: { method: "GET", path: "/files/*path" },
    catchAll: { method: "GET", path: "/proxy/*" },
    weirdQuery: { method: "GET", path: "/search", query: t.string() },
  })
  const doc = toOpenAPI(contract)

  test("named + anonymous wildcards templated; a non-object query yields no params", () => {
    expect(doc.paths["/files/{path}"]?.get?.parameters).toContainEqual({
      name: "path",
      in: "path",
      required: true,
      schema: { type: "string" },
    })
    expect(doc.paths["/proxy/{wildcard}"]?.get?.parameters).toContainEqual({
      name: "wildcard",
      in: "path",
      required: true,
      schema: { type: "string" },
    })
    // `t.string()` query is not an object → no query params, and no path params here.
    expect(doc.paths["/search"]?.get?.parameters).toBeUndefined()
  })
})

describe("params schema → enriched path parameters", () => {
  test("app route: declared params schema merges into OpenAPI path parameters", () => {
    const app = server().get(
      "/users/:id",
      {
        params: t.object({ id: t.string({ format: "uuid" }) }),
        response: t.object({ id: t.string() }),
      },
      (c) => ({ id: c.params.id }),
    )
    const doc = toOpenAPI(app)
    expect(doc.paths["/users/{id}"]?.get?.parameters).toContainEqual({
      name: "id",
      in: "path",
      required: true,
      schema: { type: "string", format: "uuid" },
    })
  })

  test("contract: declared params schema merges into OpenAPI path parameters", () => {
    const contract = defineContract({
      getItem: {
        method: "GET",
        path: "/items/:id",
        params: t.object({ id: t.integer({ minimum: 1 }) }),
        response: t.object({ id: t.integer() }),
      },
    })
    const doc = toOpenAPI(contract)
    expect(doc.paths["/items/{id}"]?.get?.parameters).toContainEqual({
      name: "id",
      in: "path",
      required: true,
      schema: { type: "integer", minimum: 1 },
    })
  })

  test("without params schema, path parameters fall back to bare { type: 'string' }", () => {
    const app = server().get("/things/:slug", (c) => ({ slug: c.params.slug }))
    const doc = toOpenAPI(app)
    expect(doc.paths["/things/{slug}"]?.get?.parameters).toContainEqual({
      name: "slug",
      in: "path",
      required: true,
      schema: { type: "string" },
    })
  })
})


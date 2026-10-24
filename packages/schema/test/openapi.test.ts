import { describe, expect, test } from "bun:test"
import type { StandardSchemaV1 } from "@nifrajs/core"
import { server } from "@nifrajs/core"
import { bodyParser } from "@nifrajs/core/body-parser"
import { defineContract } from "@nifrajs/core/contract"
import { snapshotProjectEvidence } from "@nifrajs/core/evidence"
import { all, method } from "@nifrajs/core/methods"
import { streaming } from "@nifrajs/core/sse"
import { z } from "zod"
import { type OpenAPIDocument, t, toOpenAPI, toOpenAPIFromEvidence } from "../src/index.ts"

// What `t.integer()` is bounded to unless told otherwise.
const safeRange = { minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }

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
      schema: { type: "integer", ...safeRange },
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

  test("toOpenAPIFromEvidence renders the same contract without loading the app", () => {
    let reflections = 0
    const source = {
      routes: () => {
        reflections += 1
        return server()
          .get("/users/:id", { params: t.object({ id: t.string({ format: "uuid" }) }) }, (c) => ({
            id: c.params.id,
          }))
          .routes()
      },
    }
    const evidence = snapshotProjectEvidence(source)
    const doc = toOpenAPIFromEvidence(evidence)

    expect(reflections).toBe(1)
    expect(doc.paths["/users/{id}"]?.get?.parameters).toContainEqual({
      name: "id",
      in: "path",
      required: true,
      schema: { type: "string", format: "uuid" },
    })
  })

  test("default info when omitted", () => {
    expect(doc.info).toEqual({ title: "API", version: "1.0.0" })
  })

  test("build-time inferred responses enrich an app without overriding explicit schemas", () => {
    const inferredApp = server()
      .get("/inferred/:id", (c) => ({ id: c.params.id }))
      .get("/explicit", { response: t.object({ explicit: t.boolean() }) }, () => ({
        explicit: true,
      }))
    const inferred = toOpenAPI(inferredApp, {
      inferredResponses: {
        "GET /inferred/:id": {
          "200": { schema: { type: "object", properties: { id: { type: "string" } } } },
          "404": {
            schema: { type: "object", properties: { error: { type: "string" } } },
          },
        },
        "GET /explicit": {
          "200": { schema: { type: "string" } },
        },
      },
    })
    expect(inferred.paths["/inferred/{id}"]?.get?.responses["404"]?.content).toEqual({
      "application/json": {
        schema: { type: "object", properties: { error: { type: "string" } } },
      },
    })
    expect(inferred.paths["/explicit"]?.get?.responses["200"]?.content).toEqual({
      "application/json": {
        schema: {
          type: "object",
          properties: { explicit: { type: "boolean" } },
          required: ["explicit"],
          additionalProperties: false,
        },
      },
    })
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

  test("a doc without breadth options omits servers/tags/security, and its components hold only the error envelope", () => {
    const plain = toOpenAPI(contract, { title: "X", version: "1" })
    expect(plain.servers).toBeUndefined()
    expect(plain.tags).toBeUndefined()
    expect(plain.security).toBeUndefined()
    expect(Object.keys(plain.components ?? {})).toEqual(["schemas"])
    expect(Object.keys(plain.components?.schemas ?? {})).toEqual(["NifraError"])
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

    const componentNames = Object.keys(uriDoc.components?.schemas ?? {}).filter(
      (name) => name !== "NifraError",
    )
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
      schema: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
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

describe("header schema → header parameters", () => {
  test("app route emits lower-case header parameters", () => {
    const doc = toOpenAPI(
      server().get(
        "/private",
        { headers: t.object({ "x-api-key": t.string() }) },
        (c) => c.headers["x-api-key"],
      ),
    )
    expect(doc.paths["/private"]?.get?.parameters).toContainEqual({
      name: "x-api-key",
      in: "header",
      required: true,
      schema: { type: "string" },
    })
  })

  test("contract operation emits its headers schema as header parameters", () => {
    const contract = defineContract({
      getSecret: {
        method: "GET",
        path: "/secret",
        headers: t.object({ "X-Api-Key": t.string() }),
        response: t.object({ ok: t.boolean() }),
      },
    })
    const doc = toOpenAPI(contract)
    expect(doc.paths["/secret"]?.get?.parameters).toContainEqual({
      name: "x-api-key",
      in: "header",
      required: true,
      schema: { type: "string" },
    })
  })
})

describe("cookie schema → cookie parameters", () => {
  test("app route emits each declared cookie with its name as written", () => {
    const doc = toOpenAPI(
      server().get(
        "/dashboard",
        { cookies: t.cookies({ sessionId: t.string(), page: t.optional(t.integer()) }) },
        (c) => ({ session: c.cookies.sessionId, page: c.cookies.page ?? 1 }),
      ),
    )
    expect(doc.paths["/dashboard"]?.get?.parameters).toEqual([
      { name: "sessionId", in: "cookie", required: true, schema: { type: "string" } },
      { name: "page", in: "cookie", required: false, schema: { type: "integer", ...safeRange } },
    ])
  })

  test("contract operation emits its cookies schema as cookie parameters", () => {
    const contract = defineContract({
      me: {
        method: "GET",
        path: "/me",
        cookies: t.cookies({ session: t.string() }),
        response: t.object({ ok: t.boolean() }),
      },
    })
    expect(toOpenAPI(contract).paths["/me"]?.get?.parameters).toEqual([
      { name: "session", in: "cookie", required: true, schema: { type: "string" } },
    ])
  })
})

describe("a body schema with a parser of its own", () => {
  const Pipeline = t.object({ name: t.string() })
  const parse = (): unknown => ({ name: "build" })
  const app = () =>
    server()
      .post(
        "/pipelines",
        // Declared out of order: the document lists them in one fixed order.
        { body: bodyParser(Pipeline, { types: ["text/yaml", "application/yaml"], parse }) },
        (c) => ({ name: c.body.name }),
      )
      .post("/plain", { body: Pipeline }, (c) => ({ name: c.body.name }))

  test("each media type it reads is a request content entry with the body schema", () => {
    const content = toOpenAPI(app()).paths["/pipelines"]?.post?.requestBody?.content
    expect(Object.keys(content ?? {})).toEqual([
      "application/json",
      "application/yaml",
      "text/yaml",
    ])
    const json = content?.["application/json"]?.schema
    expect(json).toMatchObject({ type: "object", properties: { name: { type: "string" } } })
    expect(content?.["application/yaml"]?.schema).toEqual(json)
    expect(content?.["text/yaml"]?.schema).toEqual(json)
  })

  test("a route without one keeps a single entry", () => {
    const content = toOpenAPI(app()).paths["/plain"]?.post?.requestBody?.content
    expect(Object.keys(content ?? {})).toEqual(["application/json"])
  })

  test("a document built from a stored snapshot is the same document", () => {
    const evidence = JSON.parse(JSON.stringify(snapshotProjectEvidence(app())))
    expect(JSON.stringify(toOpenAPIFromEvidence(evidence))).toBe(JSON.stringify(toOpenAPI(app())))
  })
})

describe("optional path params", () => {
  const contract = defineContract({
    report: {
      method: "GET",
      path: "/reports/:year?/:month?",
      summary: "Reports",
      response: t.object({ total: t.integer() }),
    },
    removeReport: { method: "DELETE", path: "/reports/:year" },
  })
  const doc = toOpenAPI(contract)

  test("a contract operation is one operation per concrete path", () => {
    expect(Object.keys(doc.paths).sort()).toEqual([
      "/reports",
      "/reports/{year}",
      "/reports/{year}/{month}",
    ])
    expect(Object.keys(doc.paths["/reports/{year}"] ?? {}).sort()).toEqual(["delete", "get"])
  })

  test("each path declares only the parameters it has", () => {
    expect(doc.paths["/reports"]?.get?.parameters).toBeUndefined()
    expect(doc.paths["/reports/{year}"]?.get?.parameters?.map((p) => p.name)).toEqual(["year"])
    expect(doc.paths["/reports/{year}/{month}"]?.get?.parameters).toEqual([
      { name: "year", in: "path", required: true, schema: { type: "string" } },
      { name: "month", in: "path", required: true, schema: { type: "string" } },
    ])
  })

  test("operation ids stay unique: the full path carries the contract name", () => {
    expect(doc.paths["/reports/{year}/{month}"]?.get?.operationId).toBe("report")
    expect(doc.paths["/reports/{year}"]?.get?.operationId).toBeUndefined()
    expect(doc.paths["/reports"]?.get?.operationId).toBeUndefined()
    const ids = Object.values(doc.paths)
      .flatMap((item) => Object.values(item))
      .map((operation) => operation.operationId)
      .filter((id) => id !== undefined)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("every path carries the operation's metadata and response", () => {
    for (const path of ["/reports", "/reports/{year}", "/reports/{year}/{month}"]) {
      expect(doc.paths[path]?.get?.summary).toBe("Reports")
      expect(doc.paths[path]?.get?.responses["200"]?.content).toBeDefined()
    }
  })

  test("an override reaches a shorter path by METHOD /path and the full one by name", () => {
    const overridden = toOpenAPI(contract, {
      operations: { "GET /reports": { summary: "All reports" }, report: { summary: "One month" } },
    })
    expect(overridden.paths["/reports"]?.get?.summary).toBe("All reports")
    expect(overridden.paths["/reports/{year}"]?.get?.summary).toBe("Reports")
    expect(overridden.paths["/reports/{year}/{month}"]?.get?.summary).toBe("One month")
  })

  test("an app route reads the same way, and a stored snapshot agrees", () => {
    const app = server().get("/reports/:year?/:month?", () => ({ total: 1 }))
    const live = toOpenAPI(app)
    expect(Object.keys(live.paths).sort()).toEqual([
      "/reports",
      "/reports/{year}",
      "/reports/{year}/{month}",
    ])
    expect(live.paths["/reports"]?.get?.parameters).toBeUndefined()
    const evidence = JSON.parse(JSON.stringify(snapshotProjectEvidence(app)))
    expect(JSON.stringify(toOpenAPIFromEvidence(evidence))).toBe(JSON.stringify(live))
  })
})

describe("constrained path params", () => {
  const app = server()
    .get("/users/:id{[0-9]+}", (c) => ({ id: c.params.id }))
    .get("/codes/:code{[A-Z]{2,3}}", (c) => ({ code: c.params.code }))
    .get("/pins/:pin{\\d{4}}", (c) => ({ pin: c.params.pin }))
    .get("/img/:kind{thumb|full}", (c) => ({ kind: c.params.kind }))
    .get("/f/:name.:ext{png|jpg}", (c) => ({ name: c.params.name, ext: c.params.ext }))
    .get("/o/:page{[0-9]+}?", (c) => ({ page: c.params.page ?? "" }))
    .get(
      "/orders/:id{[0-9]+}",
      { params: t.object({ id: t.string({ format: "int64" }) }) },
      (c) => ({ id: c.params.id }),
    )
  const doc = toOpenAPI(app)

  test("the path template carries the bare name, never the constraint", () => {
    expect(Object.keys(doc.paths).sort()).toEqual([
      "/codes/{code}",
      "/f/{name}.{ext}",
      "/img/{kind}",
      "/o",
      "/o/{page}",
      "/orders/{id}",
      "/pins/{pin}",
      "/users/{id}",
    ])
  })

  test("a character class is a string pattern, a list of values is an enum", () => {
    expect(doc.paths["/users/{id}"]?.get?.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "string", pattern: "^[0-9]+$" } },
    ])
    expect(doc.paths["/codes/{code}"]?.get?.parameters?.[0]?.schema).toEqual({
      type: "string",
      pattern: "^[A-Z]{2,3}$",
    })
    expect(doc.paths["/pins/{pin}"]?.get?.parameters?.[0]?.schema).toEqual({
      type: "string",
      pattern: "^\\d{4}$",
    })
    expect(doc.paths["/img/{kind}"]?.get?.parameters?.[0]?.schema).toEqual({
      type: "string",
      enum: ["thumb", "full"],
    })
  })

  test("every emitted pattern compiles and accepts what the router accepts", () => {
    for (const [path, value, other] of [
      ["/users/{id}", "42", "4a"],
      ["/codes/{code}", "FRA", "FRAN"],
      ["/pins/{pin}", "0420", "042"],
    ] as const) {
      const schema = doc.paths[path]?.get?.parameters?.[0]?.schema as { pattern: string }
      const pattern = new RegExp(schema.pattern)
      expect(pattern.test(value)).toBe(true)
      expect(pattern.test(other)).toBe(false)
    }
  })

  test("a part-literal segment lists each param, constrained or not", () => {
    expect(doc.paths["/f/{name}.{ext}"]?.get?.parameters).toEqual([
      { name: "name", in: "path", required: true, schema: { type: "string" } },
      { name: "ext", in: "path", required: true, schema: { type: "string", enum: ["png", "jpg"] } },
    ])
  })

  test("an optional constrained param is a parameter only on the path that has it", () => {
    expect(doc.paths["/o"]?.get?.parameters).toBeUndefined()
    expect(doc.paths["/o/{page}"]?.get?.parameters?.[0]?.schema).toEqual({
      type: "string",
      pattern: "^[0-9]+$",
    })
  })

  test("a declared params schema is the parameter's schema", () => {
    expect(doc.paths["/orders/{id}"]?.get?.parameters?.[0]?.schema).toEqual({
      type: "string",
      format: "int64",
    })
  })

  test("a contract operation and a stored snapshot read the same way", () => {
    const contract = defineContract({
      getUser: { method: "GET", path: "/users/:id{[0-9]+}" },
      image: { method: "GET", path: "/img/:kind{thumb|full}" },
    })
    const fromContract = toOpenAPI(contract)
    expect(fromContract.paths["/users/{id}"]?.get?.parameters?.[0]?.schema).toEqual({
      type: "string",
      pattern: "^[0-9]+$",
    })
    expect(fromContract.paths["/img/{kind}"]?.get?.parameters?.[0]?.schema).toEqual({
      type: "string",
      enum: ["thumb", "full"],
    })
    const evidence = JSON.parse(JSON.stringify(snapshotProjectEvidence(app)))
    expect(toOpenAPIFromEvidence(evidence)).toEqual(doc)
  })

  test("braces that are not a constraint are text after the param, as the router reads them", () => {
    const literal = toOpenAPI(server().get("/x/:id{int}", () => ({})))
    expect(Object.keys(literal.paths)).toEqual(["/x/{id}{int}"])
    expect(literal.paths["/x/{id}{int}"]?.get?.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "string" } },
    ])
  })
})

describe("routes registered by method name", () => {
  const app = server()
    .use(all("/echo", () => ({ ok: true })))
    .use(method(["PURGE", "DELETE"], "/cache/:key", () => ({ ok: true })))
    .use(method("PROPFIND", "/dav/*path", () => ({ ok: true })))

  test("every standard method is an operation; a custom method has no place in a path item", () => {
    const doc = toOpenAPI(app)
    expect(Object.keys(doc.paths).sort()).toEqual(["/cache/{key}", "/echo"])
    expect(Object.keys(doc.paths["/echo"] ?? {}).sort()).toEqual([
      "delete",
      "get",
      "head",
      "options",
      "patch",
      "post",
      "put",
    ])
    expect(Object.keys(doc.paths["/cache/{key}"] ?? {})).toEqual(["delete"])
  })

  test("a stored snapshot produces the same document", () => {
    expect(toOpenAPIFromEvidence(snapshotProjectEvidence(app))).toEqual(toOpenAPI(app))
  })

  test("QUERY is an operation in a 3.2 document, with its body, and absent from 3.1", () => {
    const searched = server().use(
      method("QUERY", "/search", { body: t.object({ q: t.string() }) }, (c) => ({ q: c.body.q })),
    )
    const current = toOpenAPI(searched, { openapiVersion: "3.2.0" })
    const operation = current.paths["/search"]?.query
    expect(operation?.requestBody).toEqual({
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: { q: { type: "string" } },
            required: ["q"],
          },
        },
      },
    })
    expect(Object.keys(toOpenAPI(app, { openapiVersion: "3.2.0" }).paths["/echo"] ?? {})).toContain(
      "query",
    )
    expect(toOpenAPI(searched).paths).toEqual({})
    expect(
      toOpenAPIFromEvidence(snapshotProjectEvidence(searched), { openapiVersion: "3.2.0" }),
    ).toEqual(current)
  })
})

describe("typed SSE routes", () => {
  const post = t.object({ id: t.integer(), title: t.string() })
  const app = server()
    .use(streaming())
    .sse("/feed/:room", { sse: post }, (_c, stream) => stream.close())
    .sse("/feed/:room/", { sse: t.object({ n: t.integer() }) }, (_c, stream) => stream.close())

  const item = (ref: string) => ({
    type: "object",
    required: ["data"],
    properties: {
      data: {
        type: "string",
        contentMediaType: "application/json",
        contentSchema: { $ref: ref },
      },
      event: { type: "string" },
      id: { type: "string" },
      retry: { type: "integer", minimum: 0 },
    },
  })

  test("3.2 describes each event with itemSchema and names the payload", () => {
    const doc = toOpenAPI(app, { openapiVersion: "3.2.0" })
    expect(doc.openapi).toBe("3.2.0")
    const ok = doc.paths["/feed/{room}"]?.get?.responses["200"]
    expect(ok).toEqual({
      description: "Server-Sent Events",
      content: { "text/event-stream": { itemSchema: item("#/components/schemas/FeedRoomEvent") } },
    })
    expect(doc.components?.schemas?.FeedRoomEvent).toMatchObject({
      type: "object",
      required: ["id", "title"],
    })
    // Two routes whose names collide each keep their own payload.
    expect(Object.keys(doc.components?.schemas ?? {})).toEqual([
      "FeedRoomEvent",
      "NifraError",
      "FeedRoomEvent_2",
    ])
  })

  test("3.1 keeps a valid media type and carries the item schema as an extension", () => {
    const doc = toOpenAPI(app)
    expect(doc.openapi).toBe("3.1.0")
    expect(doc.paths["/feed/{room}"]?.get?.responses["200"]?.content).toEqual({
      "text/event-stream": {
        schema: { type: "string" },
        "x-itemSchema": item("#/components/schemas/FeedRoomEvent"),
      },
    })
    expect(toOpenAPIFromEvidence(snapshotProjectEvidence(app))).toEqual(doc)
  })

  test("a stream with a body is a POST with its request body and typed events", () => {
    const posted = server()
      .use(streaming())
      .sse("/turn/events", { body: t.object({ message: t.string() }), sse: post }, (_c, stream) =>
        stream.close(),
      )
    const doc = toOpenAPI(posted, { openapiVersion: "3.2.0" })
    const operation = doc.paths["/turn/events"]?.post
    expect(doc.paths["/turn/events"]?.get).toBeUndefined()
    expect(Object.keys(operation?.requestBody?.content ?? {})).toEqual(["application/json"])
    expect(operation?.responses["200"]?.content?.["text/event-stream"]?.itemSchema).toEqual(
      item("#/components/schemas/TurnEventsEvent"),
    )
    expect(
      toOpenAPIFromEvidence(snapshotProjectEvidence(posted), { openapiVersion: "3.2.0" }),
    ).toEqual(doc)
  })
})

const jsonOf = (doc: OpenAPIDocument, path: string, method: "get" | "post", status?: string) => {
  const operation = doc.paths[path]?.[method]
  return status === undefined
    ? operation?.requestBody?.content["application/json"]?.schema
    : operation?.responses[status]?.content?.["application/json"]?.schema
}

// A BYO Standard Schema that carries its JSON Schema the way nifra's own schemas do.
const carrier = (jsonSchema: Record<string, unknown>) => ({ ...byo, jsonSchema })

describe("a Standard JSON Schema (zod) is described on its own side", () => {
  const Owner = z.object({ id: z.string() }).meta({ id: "Owner" })
  const app = server()
    .post(
      "/pets",
      {
        body: z.object({ name: z.string(), owner: Owner, legs: z.number().default(4) }),
        response: z.object({ id: z.string(), legs: z.number().default(4) }),
      },
      () => ({ id: "1", legs: 4 }),
    )
    .post("/owners", { body: z.object({ owner: Owner }) }, () => ({}))
  const doc = toOpenAPI(app)

  test("the request body is its input side, the 200 its output side", () => {
    expect(jsonOf(doc, "/pets", "post")).toMatchObject({
      type: "object",
      required: ["name", "owner"],
    })
    expect(jsonOf(doc, "/pets", "post", "200")).toMatchObject({
      required: ["id", "legs"],
      additionalProperties: false,
    })
  })

  test("its $defs become one component, and every ref points at it", () => {
    expect(doc.components?.schemas?.Owner).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    })
    expect(jsonOf(doc, "/owners", "post")).toMatchObject({
      properties: { owner: { $ref: "#/components/schemas/Owner" } },
    })
    const text = JSON.stringify(doc)
    expect(text).not.toContain("$defs")
    expect(text).not.toContain("$schema")
  })

  test("a definition key reused for another shape gets a component of its own", () => {
    const withX = (x: Record<string, unknown>) =>
      carrier({ type: "object", properties: { x: { $ref: "#/$defs/X" } }, $defs: { X: x } })
    const doc = toOpenAPI(
      server()
        .post("/a", { body: withX({ type: "string" }) }, () => ({}))
        .post("/b", { body: withX({ type: "string" }) }, () => ({}))
        .post("/c", { body: withX({ type: "number" }) }, () => ({})),
    )
    expect(doc.components?.schemas).toEqual({
      X: { type: "string" },
      X_2: { type: "number" },
      NifraError: expect.any(Object),
      NifraValidationError: expect.any(Object),
    })
    expect(jsonOf(doc, "/b", "post")).toMatchObject({
      properties: { x: { $ref: "#/components/schemas/X" } },
    })
    expect(jsonOf(doc, "/c", "post")).toMatchObject({
      properties: { x: { $ref: "#/components/schemas/X_2" } },
    })
  })

  test("a root that refers to itself becomes a component its refs point at", () => {
    const Node: z.ZodType<{ name: string; children: unknown[] }> = z.object({
      name: z.string(),
      get children() {
        return z.array(Node)
      },
    })
    const doc = toOpenAPI(
      server()
        .post("/a", { body: Node }, () => ({}))
        .post("/b", { body: Node }, () => ({})),
    )
    expect(jsonOf(doc, "/a", "post")).toEqual({ $ref: "#/components/schemas/Schema" })
    expect(jsonOf(doc, "/b", "post")).toEqual({ $ref: "#/components/schemas/Schema" })
    expect(doc.components?.schemas?.Schema).toMatchObject({
      properties: { children: { items: { $ref: "#/components/schemas/Schema" } } },
    })
  })

  test("a ref that already names a document component is left as it is", () => {
    const doc = toOpenAPI(
      server().post(
        "/a",
        {
          body: carrier({ type: "object", properties: { u: { $ref: "#/components/schemas/U" } } }),
        },
        () => ({}),
      ),
    )
    expect(jsonOf(doc, "/a", "post")).toEqual({
      type: "object",
      properties: { u: { $ref: "#/components/schemas/U" } },
    })
  })

  test("a type JSON Schema cannot express leaves the route without detail, not broken", () => {
    const doc = toOpenAPI(server().post("/at", { body: z.object({ at: z.date() }) }, () => ({})))
    expect(doc.paths["/at"]?.post?.requestBody).toBeUndefined()
  })

  test("a parameter schema's refs point at the hoisted components", () => {
    const Sort = z.enum(["asc", "desc"]).meta({ id: "Sort" })
    const doc = toOpenAPI(server().get("/list", { query: z.object({ sort: Sort }) }, () => []))
    expect(doc.paths["/list"]?.get?.parameters).toEqual([
      { name: "sort", in: "query", required: true, schema: { $ref: "#/components/schemas/Sort" } },
    ])
    expect(doc.components?.schemas?.Sort).toEqual({ type: "string", enum: ["asc", "desc"] })
  })

  test("an evidence snapshot renders the same document", () => {
    const evidence = JSON.parse(JSON.stringify(snapshotProjectEvidence(app)))
    expect(toOpenAPIFromEvidence(evidence)).toEqual(doc)
  })
})

describe("the errors the framework answers", () => {
  const error = { $ref: "#/components/schemas/NifraError" }
  const validation = { $ref: "#/components/schemas/NifraValidationError" }
  const app = server({ maxBodyBytes: 64 })
    .post("/items", { body: t.object({ tags: t.array(t.string()) }) }, () => ({}))
    .get("/items", { query: t.query({ page: t.integer() }) }, () => [])
    .get("/health", () => "ok")
    .post(
      "/declared",
      { body: t.object({ name: t.string() }), errors: { 422: t.object({ message: t.string() }) } },
      () => ({}),
    )
  const doc = toOpenAPI(app)

  test("a body route lists the body errors and the validation error", () => {
    expect(Object.keys(doc.paths["/items"]?.post?.responses ?? {})).toEqual([
      "200",
      "400",
      "413",
      "415",
      "422",
      "500",
    ])
    for (const status of ["400", "413", "415", "500"]) {
      expect(jsonOf(doc, "/items", "post", status)).toEqual(error)
    }
    expect(jsonOf(doc, "/items", "post", "422")).toEqual(validation)
  })

  test("a query route lists the validation error; a route without schemas lists only the 500", () => {
    expect(Object.keys(doc.paths["/items"]?.get?.responses ?? {})).toEqual(["200", "422", "500"])
    expect(Object.keys(doc.paths["/health"]?.get?.responses ?? {})).toEqual(["200", "500"])
    expect(jsonOf(doc, "/health", "get", "500")).toEqual(error)
  })

  test("a path parameter with a pattern lists the router's 404", () => {
    const routes = toOpenAPI(
      server()
        .get("/users/:id{[0-9]+}", () => ({}))
        .get("/teams/:slug", () => ({})),
    )
    expect(Object.keys(routes.paths["/users/{id}"]?.get?.responses ?? {})).toEqual([
      "200",
      "404",
      "500",
    ])
    expect(jsonOf(routes, "/users/{id}", "get", "404")).toEqual(error)
    expect(Object.keys(routes.paths["/teams/{slug}"]?.get?.responses ?? {})).toEqual(["200", "500"])
  })

  test("a declared 500 wins over the envelope", () => {
    const declared = toOpenAPI(
      server().get("/x", { errors: { 500: t.object({ trace: t.string() }) } }, () => ({})),
    )
    expect(jsonOf(declared, "/x", "get", "500")).toMatchObject({
      properties: { trace: { type: "string" } },
    })
  })

  test("a declared error wins", () => {
    expect(jsonOf(doc, "/declared", "post", "422")).toMatchObject({
      properties: { message: { type: "string" } },
    })
  })

  test("the components describe the bodies the server sends", async () => {
    const components = doc.components?.schemas ?? {}
    expect(components.NifraValidationError).toMatchObject({ required: ["ok", "error", "issues"] })
    expect(components.NifraError).toMatchObject({ required: ["ok", "error"] })
    const post = (body: string) =>
      app.fetch(
        new Request("http://x/items", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
      )
    const invalid: unknown = await (
      await post(JSON.stringify({ tags: Array.from({ length: 20 }, (_, i) => i) }))
    ).json()
    expect(Object.keys(invalid ?? {}).sort()).toEqual(["error", "issues", "ok"])
    expect(invalid).toMatchObject({
      ok: false,
      error: "validation",
      issues: expect.arrayContaining([{ message: expect.any(String), path: ["tags", "0"] }]),
    })
    const tooLarge = await post(JSON.stringify({ tags: ["x".repeat(100)] }))
    expect(tooLarge.status).toBe(413)
    const tooLargeBody: unknown = await tooLarge.json()
    expect(Object.keys(tooLargeBody ?? {}).sort()).toEqual(["error", "ok"])
    const many = server()
      .post("/n", { body: t.object({ list: t.array(t.string()) }) }, () => ({}))
      .fetch(
        new Request("http://x/n", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ list: Array.from({ length: 150 }, (_, i) => i) }),
        }),
      )
    const listed: unknown = await (await many).json()
    const count = Object.keys(Object(Object(listed).issues)).length
    expect(count).toBeGreaterThan(0)
    expect(components.NifraValidationError).toMatchObject({
      properties: { issues: { maxItems: count } },
    })
  })

  test("an onValidationError hook - the route's or the app's - takes the 422 out", () => {
    const hook = () => new Response("bad", { status: 400 })
    const routeHook = toOpenAPI(
      server().post(
        "/a",
        { body: t.object({ name: t.string() }), onValidationError: hook },
        () => ({}),
      ),
    )
    expect(Object.keys(routeHook.paths["/a"]?.post?.responses ?? {})).toEqual([
      "200",
      "400",
      "413",
      "415",
      "500",
    ])
    const hooked = server({ onValidationError: hook }).get(
      "/b",
      { query: t.query({ page: t.integer() }) },
      () => [],
    )
    const appHook = toOpenAPI(hooked)
    expect(Object.keys(appHook.paths["/b"]?.get?.responses ?? {})).toEqual(["200", "500"])
    expect(
      toOpenAPIFromEvidence(JSON.parse(JSON.stringify(snapshotProjectEvidence(hooked)))),
    ).toEqual(appHook)
  })

  test("a user schema named like a generated component keeps a component of its own", () => {
    const doc = toOpenAPI(
      server().post(
        "/a",
        { body: t.object({ name: t.string() }, { $id: "NifraError" }) },
        () => ({}),
      ),
    )
    expect(jsonOf(doc, "/a", "post")).toEqual({ $ref: "#/components/schemas/NifraError_2" })
    expect(doc.components?.schemas?.NifraError_2).toMatchObject({
      properties: { name: { type: "string" } },
    })
    expect(doc.components?.schemas?.NifraError).toMatchObject({ required: ["ok", "error"] })
  })

  test("an evidence snapshot renders the same document", () => {
    const evidence = JSON.parse(JSON.stringify(snapshotProjectEvidence(app)))
    expect(toOpenAPIFromEvidence(evidence)).toEqual(doc)
  })
})

describe("a tagged union is a oneOf, with a discriminator over components", () => {
  const cat = t.object({ kind: t.literal("cat"), meows: t.boolean() })
  const dog = t.object({ kind: t.literal("dog"), barks: t.boolean() })
  const pet = t.union([cat, dog])

  test("a union told apart by a required literal is a oneOf; inline members get no discriminator", () => {
    const doc = toOpenAPI(server().post("/pets", { body: pet }, () => ({})))
    const schema = jsonOf(doc, "/pets", "post")
    expect(schema).not.toHaveProperty("anyOf")
    expect(schema).toHaveProperty("oneOf", [expect.any(Object), expect.any(Object)])
    expect(schema).not.toHaveProperty("discriminator")
    expect(pet.jsonSchema.anyOf).toHaveLength(2)
  })

  test("members that are components get a mapping", () => {
    const named = z.union([
      z.object({ kind: z.literal("cat") }).meta({ id: "Cat" }),
      z.object({ kind: z.literal("dog") }).meta({ id: "Dog" }),
    ])
    const doc = toOpenAPI(server().post("/pets", { body: named }, () => ({})))
    expect(jsonOf(doc, "/pets", "post")).toEqual({
      oneOf: [{ $ref: "#/components/schemas/Cat" }, { $ref: "#/components/schemas/Dog" }],
      discriminator: {
        propertyName: "kind",
        mapping: { cat: "#/components/schemas/Cat", dog: "#/components/schemas/Dog" },
      },
    })
  })

  test("a union with no tag of its own keeps its anyOf", () => {
    const untagged = [
      t.union([t.string(), t.number()]),
      t.union([t.object({ kind: t.literal("a") }), t.object({ kind: t.literal("a") })]),
      t.union([t.object({ kind: t.optional(t.literal("a")) }), t.object({ kind: t.literal("b") })]),
    ]
    for (const body of untagged) {
      const doc = toOpenAPI(server().post("/x", { body }, () => ({})))
      const schema = jsonOf(doc, "/x", "post")
      expect(schema).toHaveProperty("anyOf", [expect.anything(), expect.anything()])
      expect(schema).not.toHaveProperty("discriminator")
    }
  })

  test("a nested union is found, under a property named like a keyword too", () => {
    const doc = toOpenAPI(
      server().post(
        "/x",
        { body: t.object({ default: pet }), response: t.object({ items: t.array(pet) }) },
        () => ({ items: [] }),
      ),
    )
    const pair = [expect.any(Object), expect.any(Object)]
    expect(jsonOf(doc, "/x", "post")).toMatchObject({
      properties: { default: { oneOf: pair } },
    })
    expect(jsonOf(doc, "/x", "post", "200")).toMatchObject({
      properties: { items: { items: { oneOf: pair } } },
    })
  })

  test("a zod discriminated union keeps its oneOf, with a discriminator once its members are components", () => {
    const inline = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("a") }),
      z.object({ kind: z.literal("b") }),
    ])
    const named = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("a") }).meta({ id: "A" }),
      z.object({ kind: z.literal("b") }).meta({ id: "B" }),
    ])
    const inlineDoc = toOpenAPI(server().post("/x", { body: inline }, () => ({})))
    expect(jsonOf(inlineDoc, "/x", "post")).toHaveProperty("oneOf", [
      expect.any(Object),
      expect.any(Object),
    ])
    expect(jsonOf(inlineDoc, "/x", "post")).not.toHaveProperty("discriminator")
    const namedDoc = toOpenAPI(server().post("/x", { body: named }, () => ({})))
    expect(jsonOf(namedDoc, "/x", "post")).toMatchObject({
      discriminator: {
        propertyName: "kind",
        mapping: { a: "#/components/schemas/A", b: "#/components/schemas/B" },
      },
    })
  })
})

describe("how query, header and cookie values are read", () => {
  const app = server()
    .get(
      "/coerced",
      {
        query: t.query({
          tag: t.optional(t.array(t.string())),
          flag: t.optional(t.boolean()),
          flags: t.optional(t.array(t.boolean())),
        }),
        headers: t.headers({ "x-dry-run": t.optional(t.boolean()) }),
      },
      (c) => c.query,
    )
    .get("/strict", { query: t.object({ flag: t.optional(t.boolean()) }) }, (c) => c.query)
    .get(
      "/zod",
      { query: z.object({ flag: z.coerce.boolean().optional(), tag: z.array(z.string()) }) },
      (c) => c.query,
    )
  const doc = toOpenAPI(app)
  const param = (path: string, name: string) =>
    doc.paths[path]?.get?.parameters?.find((parameter) => parameter.name === name)
  const read = async (url: string) => {
    const response = await app.fetch(new Request(`http://x${url}`))
    return { status: response.status, body: await response.json() }
  }

  test("a list is declared as repeated keys, and a comma stays in its value", async () => {
    expect(param("/coerced", "tag")).toMatchObject({ style: "form", explode: true })
    expect(param("/zod", "tag")).toMatchObject({ style: "form", explode: true })
    expect(param("/coerced", "flag")).not.toHaveProperty("style")
    expect(await read("/coerced?tag=a&tag=b,c")).toEqual({
      status: 200,
      body: { tag: ["a", "b,c"] },
    })
  })

  test("a coercing schema lists the boolean literals it accepts, and accepts exactly those", async () => {
    const literals = param("/coerced", "flag")?.["x-nifra-boolean-literals"]
    expect(literals).toEqual({
      true: ["true", "1"],
      false: ["false", "0", "-0"],
      caseInsensitive: true,
    })
    expect(param("/coerced", "flags")?.["x-nifra-boolean-literals"]).toEqual(literals)
    expect(param("/coerced", "x-dry-run")?.["x-nifra-boolean-literals"]).toEqual(literals)
    for (const [value, words] of [
      [true, literals?.true ?? []],
      [false, literals?.false ?? []],
    ] as const) {
      for (const word of [...words, ...words.map((w) => w.toUpperCase())]) {
        expect(await read(`/coerced?flag=${word}`)).toEqual({ status: 200, body: { flag: value } })
      }
    }
    for (const word of ["yes", "", "2"])
      expect((await read(`/coerced?flag=${word}`)).status).toBe(422)
  })

  test("a schema that does not coerce lists no literals", () => {
    expect(param("/strict", "flag")).not.toHaveProperty("x-nifra-boolean-literals")
    expect(param("/zod", "flag")).not.toHaveProperty("x-nifra-boolean-literals")
  })

  test("an evidence snapshot renders the same document", () => {
    const evidence = JSON.parse(JSON.stringify(snapshotProjectEvidence(app)))
    expect(toOpenAPIFromEvidence(evidence)).toEqual(doc)
  })
})

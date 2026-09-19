import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import {
  diffOpenApiInventory,
  type ImportedApiInventory,
  importOpenAPI,
  OpenAPIImportError,
  t,
  toOpenAPI,
} from "../src/index.ts"

const app = server()
  .get("/users/:id", (c) => ({ id: c.params.id }))
  .get("/search", { query: t.object({ q: t.string(), page: t.optional(t.number()) }) }, (c) => ({
    q: c.query.q,
  }))
  .post("/items", { body: t.object({ name: t.string() }) }, (c) => ({
    id: "1",
    name: c.body.name,
  }))
  .post(
    "/orders",
    { body: t.object({ item: t.string() }), errors: { 404: t.object({ message: t.string() }) } },
    () => ({ ok: true }),
  )

function roundtrip(): ImportedApiInventory {
  const exported = toOpenAPI(app, { title: "Roundtrip API", version: "1.0.0" })
  // Through the wire: the cycle must survive JSON transport, not just object identity.
  const transported = JSON.parse(JSON.stringify(exported)) as unknown
  return importOpenAPI(transported)
}

describe("importOpenAPI - inventory import", () => {
  test("recovers method, nifra path, query flags, body, and statuses", () => {
    const inventory = roundtrip()
    expect(inventory.title).toBe("Roundtrip API")
    const keys = inventory.routes
      .map((route) => `${route.method.toUpperCase()} ${route.path}`)
      .sort()
    expect(keys).toEqual(["GET /search", "GET /users/:id", "POST /items", "POST /orders"])
    const search = inventory.routes.find((route) => route.path === "/search")
    expect(search?.query).toEqual([
      { name: "q", required: true },
      { name: "page", required: false },
    ])
    expect(search?.hasBody).toBe(false)
    expect(inventory.routes.find((route) => route.path === "/items")?.hasBody).toBe(true)
    const orders = inventory.routes.find((route) => route.path === "/orders")
    expect(orders?.responseStatuses).toContain("200")
    expect(orders?.responseStatuses).toContain("404")
    expect(inventory.routes.find((route) => route.path === "/users/:id")?.pathParams).toEqual([
      "id",
    ])
  })

  test("export -> import -> diff is empty on the canonical fixture", () => {
    const actual = roundtrip()
    const expected: ImportedApiInventory = {
      title: "Roundtrip API",
      version: "1.0.0",
      routes: [
        {
          method: "get",
          path: "/users/:id",
          pathParams: ["id"],
          query: [],
          hasBody: false,
          requestBodyRequired: false,
          responseStatuses: ["200"],
          notes: [
            "OpenAPI path templates import as single-segment :params - greedy remainders (*rest) cannot be distinguished and need manual rewrites",
          ],
        },
        {
          method: "get",
          path: "/search",
          pathParams: [],
          query: [
            { name: "q", required: true },
            { name: "page", required: false },
          ],
          hasBody: false,
          requestBodyRequired: false,
          responseStatuses: ["200"],
          notes: [],
        },
        {
          method: "post",
          path: "/items",
          pathParams: [],
          query: [],
          hasBody: true,
          requestBodyRequired: true,
          responseStatuses: ["200"],
          notes: [],
        },
        {
          method: "post",
          path: "/orders",
          pathParams: [],
          query: [],
          hasBody: true,
          requestBodyRequired: true,
          responseStatuses: ["200", "404"],
          notes: [],
        },
      ],
      warnings: [
        "OpenAPI path templates import as single-segment :params - greedy remainders (*rest) cannot be distinguished and need manual rewrites; see route notes",
      ],
    }
    expect(diffOpenApiInventory(expected, actual)).toEqual([])
  })

  test("diff reports missing routes, lost params, body drift, and status drift", () => {
    const actual = roundtrip()
    const missing = diffOpenApiInventory(
      {
        ...actual,
        routes: [
          ...actual.routes,
          {
            method: "delete",
            path: "/gone",
            pathParams: [],
            query: [],
            hasBody: false,
            requestBodyRequired: false,
            responseStatuses: ["200"],
            notes: [],
          },
        ],
      },
      actual,
    )
    expect(missing).toContainEqual({ route: "DELETE /gone", message: "route missing after import" })
    const tampered: ImportedApiInventory = {
      ...actual,
      routes: actual.routes.map((route) =>
        route.path === "/search" ? { ...route, query: [{ name: "q", required: false }] } : route,
      ),
    }
    expect(diffOpenApiInventory(tampered, actual)).toContainEqual({
      route: "GET /search",
      message: "query parameter 'q' required flag flipped",
    })
  })

  test("preserves info when paths are omitted", () => {
    expect(importOpenAPI({ openapi: "3.1.0", info: { title: "Empty", version: "2.0.0" } })).toEqual(
      {
        title: "Empty",
        version: "2.0.0",
        routes: [],
        warnings: [],
      },
    )
  })

  test("accepts standard path-item metadata and extensions", () => {
    const inventory = importOpenAPI({
      openapi: "3.1.0",
      info: {},
      paths: {
        "/x": {
          summary: "X",
          description: "metadata",
          servers: [],
          "x-vendor": { enabled: true },
          get: { responses: { "200": {} } },
        },
      },
    })
    expect(inventory.routes.map((route) => `${route.method.toUpperCase()} ${route.path}`)).toEqual([
      "GET /x",
    ])
  })

  test("uses Nifra's parameter grammar and rejects reserved names", () => {
    const appWithUnderscore = server().get("/users/:_id", () => ({ ok: true }))
    const imported = importOpenAPI(toOpenAPI(appWithUnderscore)).routes[0]
    expect(imported?.path).toBe("/users/:_id")
    expect(imported?.pathParams).toEqual(["_id"])
    const mixed = importOpenAPI(
      toOpenAPI(
        server()
          .get("/files/:key.txt", () => ({ ok: true }))
          .get("/v:major.:minor/x", () => ({ ok: true })),
      ),
    )
    expect(mixed.routes.find((route) => route.path === "/files/:key.txt")?.pathParams).toEqual([
      "key",
    ])
    expect(mixed.routes.find((route) => route.path === "/v:major.:minor/x")?.pathParams).toEqual([
      "major",
      "minor",
    ])
    expect(() =>
      importOpenAPI({
        openapi: "3.1.0",
        info: {},
        paths: { "/users/{__proto__}": { get: { responses: { "200": {} } } } },
      }),
    ).toThrow(/invalid path parameter/)
  })

  test("fails closed on malformed responses and duplicate methods", () => {
    expect(() =>
      importOpenAPI({ openapi: "3.1.0", info: {}, paths: { "/x": { get: {} } } }),
    ).toThrow(/responses.*required/)
    expect(() =>
      importOpenAPI({ openapi: "3.1.0", info: {}, paths: { "/x": { get: { responses: null } } } }),
    ).toThrow(/responses.*object/)
    expect(() =>
      importOpenAPI({
        openapi: "3.1.0",
        info: {},
        paths: { "/x": { get: { responses: { "200": {} } }, GET: { responses: { "200": {} } } } },
      }),
    ).toThrow(/duplicate method/)
  })

  test("enforces merged parameter and limit bounds", () => {
    const pathParams = Array.from({ length: 100 }, (_, index) => ({
      name: `q${index}`,
      in: "query",
    }))
    const operationParams = Array.from({ length: 100 }, (_, index) => ({
      name: `p${index}`,
      in: "query",
    }))
    expect(() =>
      importOpenAPI(
        {
          openapi: "3.1.0",
          info: {},
          paths: {
            "/x": {
              parameters: pathParams,
              get: { parameters: operationParams, responses: { "200": {} } },
            },
          },
        },
        { maxParameters: 100 },
      ),
    ).toThrow(/merged parameters.*exceeds limit/)
    expect(() =>
      importOpenAPI({ openapi: "3.1.0", info: {}, paths: {} }, { maxPaths: Number.NaN }),
    ).toThrow(/maxPaths.*finite safe integer/)
  })
  test("fails closed on non-3.x versions, bad paths, unknown methods, and $ref params", () => {
    expect(() => importOpenAPI({ openapi: "2.0.0", info: {}, paths: {} })).toThrow(
      OpenAPIImportError,
    )
    expect(importOpenAPI({ openapi: "3.1.0", info: {} })).toEqual({
      title: "",
      version: "",
      routes: [],
      warnings: [],
    })
    expect(() => importOpenAPI({ openapi: "3.1.0", info: {}, paths: { "no-slash": {} } })).toThrow(
      /must start with \//,
    )
    expect(() =>
      importOpenAPI({ openapi: "3.1.0", info: {}, paths: { "/x": { query: {} } } }),
    ).toThrow(/unsupported method/)
    expect(() =>
      importOpenAPI({
        openapi: "3.1.0",
        info: {},
        paths: { "/x": { get: { parameters: [{ $ref: "#/components/parameters/Q" }] } } },
      }),
    ).toThrow(/must be inlined/)
  })

  test("caps document size instead of allocating", () => {
    expect(() =>
      importOpenAPI({ openapi: "3.1.0", info: {}, paths: { "/a": {}, "/b": {} } }, { maxPaths: 1 }),
    ).toThrow(/exceeds limit/)
  })
})

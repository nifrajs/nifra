import { describe, expect, test } from "bun:test"
import { diffRouteSnapshots, type RouteSnapshot, snapshotRoutes } from "../src/diff.ts"
import type { StandardSchemaV1 } from "../src/index.ts"

const standard: StandardSchemaV1 = {
  "~standard": { version: 1, vendor: "test", validate: (value) => ({ value }) },
}

/** A Standard Schema carrier with introspectable JSON Schema — what `t.*` produces. */
const carrier = (jsonSchema: Record<string, unknown>) => ({ ...standard, jsonSchema })

const objectSchema = (properties: Record<string, unknown>, required: readonly string[]) =>
  carrier({ type: "object", properties, required: [...required] })

const route = (
  method: string,
  path: string,
  schema?: Record<string, unknown>,
): Record<string, unknown> => ({ method, path, ...(schema !== undefined ? { schema } : {}) })

const snap = (routes: readonly Record<string, unknown>[]): readonly RouteSnapshot[] =>
  snapshotRoutes(routes)

describe("snapshotRoutes", () => {
  test("drops validators and survives a JSON round-trip byte-identically", () => {
    const routes = snap([
      route("post", "/users", {
        body: objectSchema({ name: { type: "string" } }, ["name"]),
        response: objectSchema({ id: { type: "string" } }, ["id"]),
        errors: { 404: carrier({ type: "object", properties: { code: { type: "string" } } }) },
      }),
      route("get", "/health"),
    ])
    expect(routes[0]?.method).toBe("POST")
    expect(routes[0]?.schema?.body?.jsonSchema).toBeDefined()
    const restored = JSON.parse(JSON.stringify(routes)) as readonly RouteSnapshot[]
    expect(restored).toEqual(routes as never)
    // Identical snapshots diff to zero changes — the baseline workflow's fixed point.
    expect(diffRouteSnapshots(routes, restored).changes).toEqual([])
  })

  test("validation-only schemas snapshot without jsonSchema", () => {
    const routes = snap([route("get", "/opaque", { query: standard })])
    expect(routes[0]?.schema?.query).toEqual({})
  })
})

describe("diffRouteSnapshots — routes", () => {
  test("removed route is breaking; added route is compatible", () => {
    const before = snap([route("GET", "/a"), route("GET", "/b")])
    const after = snap([route("GET", "/a"), route("POST", "/c")])
    const diff = diffRouteSnapshots(before, after)
    expect(diff.hasBreaking).toBe(true)
    expect(diff.changes).toEqual([
      expect.objectContaining({ severity: "breaking", path: "/b", message: "route removed" }),
      expect.objectContaining({ severity: "compatible", path: "/c", message: "route added" }),
    ])
  })

  test("method change on the same path reads as remove + add", () => {
    const diff = diffRouteSnapshots(snap([route("GET", "/x")]), snap([route("POST", "/x")]))
    expect(diff.hasBreaking).toBe(true)
    expect(diff.changes.map((c) => c.severity).sort()).toEqual(["breaking", "compatible"])
  })
})

describe("diffRouteSnapshots — request direction (body/query)", () => {
  const before = snap([
    route("POST", "/users", {
      body: objectSchema({ name: { type: "string" }, role: { type: "string", enum: ["admin"] } }, [
        "name",
      ]),
    }),
  ])

  test("new required field breaks; new optional field is compatible", () => {
    const after = snap([
      route("POST", "/users", {
        body: objectSchema(
          {
            name: { type: "string" },
            role: { type: "string", enum: ["admin"] },
            email: { type: "string" },
            nick: { type: "string" },
          },
          ["name", "email"],
        ),
      }),
    ])
    const changes = diffRouteSnapshots(before, after).changes
    expect(changes).toContainEqual(
      expect.objectContaining({ severity: "breaking", field: "email", section: "body" }),
    )
    expect(changes).toContainEqual(
      expect.objectContaining({ severity: "compatible", field: "nick" }),
    )
  })

  test("removed field breaks (strict validation rejects payloads still sending it)", () => {
    const after = snap([
      route("POST", "/users", {
        body: objectSchema({ name: { type: "string" } }, ["name"]),
      }),
    ])
    const changes = diffRouteSnapshots(before, after).changes
    expect(changes).toEqual([
      expect.objectContaining({
        severity: "breaking",
        field: "role",
        message: 'field "role" removed',
      }),
    ])
  })

  test("optional→required breaks; required→optional is compatible", () => {
    const after = snap([
      route("POST", "/users", {
        body: objectSchema(
          { name: { type: "string" }, role: { type: "string", enum: ["admin"] } },
          ["role"],
        ),
      }),
    ])
    const changes = diffRouteSnapshots(before, after).changes
    expect(changes).toContainEqual(
      expect.objectContaining({ severity: "compatible", field: "name" }),
    )
    expect(changes).toContainEqual(expect.objectContaining({ severity: "breaking", field: "role" }))
  })

  test("request enum widening is compatible; narrowing/type change breaks", () => {
    const widened = snap([
      route("POST", "/users", {
        body: objectSchema(
          { name: { type: "string" }, role: { type: "string", enum: ["admin", "viewer"] } },
          ["name"],
        ),
      }),
    ])
    expect(diffRouteSnapshots(before, widened).changes).toEqual([
      expect.objectContaining({ severity: "compatible", field: "role" }),
    ])
    const retyped = snap([
      route("POST", "/users", {
        body: objectSchema(
          { name: { type: "number" }, role: { type: "string", enum: ["admin"] } },
          ["name"],
        ),
      }),
    ])
    expect(diffRouteSnapshots(before, retyped).hasBreaking).toBe(true)
  })

  test("adding a request contract breaks; removing one is compatible", () => {
    const bare = snap([route("POST", "/users")])
    expect(diffRouteSnapshots(bare, before).changes).toEqual([
      expect.objectContaining({ severity: "breaking", message: "body schema added" }),
    ])
    expect(diffRouteSnapshots(before, bare).changes).toEqual([
      expect.objectContaining({ severity: "compatible", message: "body schema removed" }),
    ])
  })

  test("query follows request rules too", () => {
    const withQuery = snap([
      route("GET", "/list", { query: objectSchema({ cursor: { type: "string" } }, []) }),
    ])
    const requiredQuery = snap([
      route("GET", "/list", { query: objectSchema({ cursor: { type: "string" } }, ["cursor"]) }),
    ])
    expect(diffRouteSnapshots(withQuery, requiredQuery).changes).toEqual([
      expect.objectContaining({ severity: "breaking", section: "query", field: "cursor" }),
    ])
  })
})

describe("diffRouteSnapshots — response direction (response/sse)", () => {
  const before = snap([
    route("GET", "/users", {
      response: objectSchema(
        { id: { type: "string" }, plan: { type: "string", enum: ["free", "pro"] } },
        ["id", "plan"],
      ),
    }),
  ])

  test("removed response field breaks; added field is compatible", () => {
    const after = snap([
      route("GET", "/users", {
        response: objectSchema(
          {
            id: { type: "string" },
            plan: { type: "string", enum: ["free", "pro"] },
            at: { type: "string" },
          },
          ["id", "plan"],
        ),
      }),
    ])
    expect(diffRouteSnapshots(before, after).changes).toEqual([
      expect.objectContaining({ severity: "compatible", field: "at" }),
    ])
    const dropped = snap([
      route("GET", "/users", {
        response: objectSchema({ id: { type: "string" } }, ["id"]),
      }),
    ])
    expect(diffRouteSnapshots(before, dropped).changes).toEqual([
      expect.objectContaining({ severity: "breaking", field: "plan" }),
    ])
  })

  test("response required→optional breaks (readers may now get undefined)", () => {
    const after = snap([
      route("GET", "/users", {
        response: objectSchema(
          { id: { type: "string" }, plan: { type: "string", enum: ["free", "pro"] } },
          ["id"],
        ),
      }),
    ])
    expect(diffRouteSnapshots(before, after).changes).toEqual([
      expect.objectContaining({ severity: "breaking", field: "plan" }),
    ])
  })

  test("response enum narrowing is compatible; widening breaks", () => {
    const narrowed = snap([
      route("GET", "/users", {
        response: objectSchema(
          { id: { type: "string" }, plan: { type: "string", enum: ["free"] } },
          ["id", "plan"],
        ),
      }),
    ])
    expect(diffRouteSnapshots(before, narrowed).changes).toEqual([
      expect.objectContaining({ severity: "compatible", field: "plan" }),
    ])
    const widened = snap([
      route("GET", "/users", {
        response: objectSchema(
          { id: { type: "string" }, plan: { type: "string", enum: ["free", "pro", "team"] } },
          ["id", "plan"],
        ),
      }),
    ])
    expect(diffRouteSnapshots(before, widened).hasBreaking).toBe(true)
  })

  test("removing a response contract breaks; adding one is compatible", () => {
    const bare = snap([route("GET", "/users")])
    expect(diffRouteSnapshots(before, bare).changes).toEqual([
      expect.objectContaining({ severity: "breaking", message: "response schema removed" }),
    ])
    expect(diffRouteSnapshots(bare, before).changes).toEqual([
      expect.objectContaining({ severity: "compatible", message: "response schema added" }),
    ])
  })

  test("sse event payload change follows response rules", () => {
    const sseBefore = snap([
      route("GET", "/feed", { sse: objectSchema({ text: { type: "string" } }, ["text"]) }),
    ])
    const sseAfter = snap([
      route("GET", "/feed", { sse: objectSchema({ text: { type: "string" } }, []) }),
    ])
    expect(diffRouteSnapshots(sseBefore, sseAfter).changes).toEqual([
      expect.objectContaining({ severity: "breaking", section: "sse", field: "text" }),
    ])
  })

  test("non-object schema change is breaking either direction", () => {
    const stringy = snap([route("GET", "/raw", { response: carrier({ type: "string" }) })])
    const numbery = snap([route("GET", "/raw", { response: carrier({ type: "number" }) })])
    expect(diffRouteSnapshots(stringy, numbery).changes).toEqual([
      expect.objectContaining({ severity: "breaking", message: "response schema changed" }),
    ])
    expect(diffRouteSnapshots(stringy, stringy).changes).toEqual([])
  })
})

describe("diffRouteSnapshots — errors + opaque schemas", () => {
  test("removed error status breaks; added is compatible; changed body classified", () => {
    const before = snap([
      route("POST", "/pay", {
        errors: {
          402: carrier({
            type: "object",
            properties: { code: { type: "string" } },
            required: ["code"],
          }),
          409: carrier({ type: "object", properties: { code: { type: "string" } } }),
        },
      }),
    ])
    const after = snap([
      route("POST", "/pay", {
        errors: {
          402: carrier({
            type: "object",
            properties: { code: { type: "number" } },
            required: ["code"],
          }),
          422: carrier({ type: "object", properties: { code: { type: "string" } } }),
        },
      }),
    ])
    const changes = diffRouteSnapshots(before, after).changes
    expect(changes).toContainEqual(
      expect.objectContaining({
        severity: "breaking",
        field: "402",
        message: "error 402 schema changed",
      }),
    )
    expect(changes).toContainEqual(expect.objectContaining({ severity: "breaking", field: "409" }))
    expect(changes).toContainEqual(
      expect.objectContaining({ severity: "compatible", field: "422" }),
    )
  })

  test("validation-only schemas yield info, never a silent pass or false break", () => {
    const opaqueBefore = snap([route("POST", "/opaque", { body: standard })])
    const introspectable = snap([
      route("POST", "/opaque", { body: objectSchema({ a: { type: "string" } }, []) }),
    ])
    const diff = diffRouteSnapshots(opaqueBefore, introspectable)
    expect(diff.hasBreaking).toBe(false)
    expect(diff.changes).toEqual([expect.objectContaining({ severity: "info", section: "body" })])
    // Opaque on both sides and unchanged shape → nothing to report.
    expect(diffRouteSnapshots(opaqueBefore, opaqueBefore).changes).toEqual([])

    const opaqueError = snap([route("POST", "/e", { errors: { 400: standard } })])
    const typedError = snap([
      route("POST", "/e", { errors: { 400: carrier({ type: "object", properties: {} }) } }),
    ])
    expect(diffRouteSnapshots(opaqueError, typedError).changes).toEqual([
      expect.objectContaining({ severity: "info", section: "errors", field: "400" }),
    ])
  })
})

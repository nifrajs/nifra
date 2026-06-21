import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  buildRouteTable,
  clientCall,
  describeRoutes,
  type RouteJson,
  renderRouteTable,
  routesToJson,
  routeTableToJson,
  tsTypeOf,
} from "../src/introspect.ts"
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

// `nifra routes [--json]` — the focused, uniform route view (page + API routes, with methods). The
// table builder + renderer are pure; describeRoutes is the cwd-gathering wrapper.

describe("buildRouteTable", () => {
  test("pages serve GET (+ POST when they have an action); sorted by path", () => {
    const rows = buildRouteTable({
      pages: [
        { pattern: "/about", file: "about.tsx", hasAction: false },
        { pattern: "/contact", file: "contact.tsx", hasAction: true },
      ],
      api: [],
    })
    expect(rows).toEqual([
      { kind: "page", path: "/about", methods: ["GET"], file: "about.tsx" },
      { kind: "page", path: "/contact", methods: ["GET", "POST"], file: "contact.tsx" },
    ])
  })

  test("API routes sharing a path collapse into one row with all methods, sorted", () => {
    const rows = buildRouteTable({
      pages: [],
      api: [
        { method: "post", path: "/api/count" },
        { method: "get", path: "/api/count" },
      ],
    })
    expect(rows).toEqual([
      { kind: "api", path: "/api/count", methods: ["GET", "POST"], autoMounted: true },
    ])
  })

  test("autoMounted reflects the apiPrefix (default /api), as a segment boundary", () => {
    const rows = buildRouteTable({
      pages: [],
      api: [
        { method: "get", path: "/api/users" }, // under /api → auto-mounted
        { method: "get", path: "/health" }, // not under /api
        { method: "get", path: "/apiary" }, // shares the prefix string but NOT a segment boundary
      ],
    })
    const byPath = Object.fromEntries(rows.map((r) => [r.path, r.autoMounted]))
    expect(byPath["/api/users"]).toBe(true)
    expect(byPath["/health"]).toBe(false)
    expect(byPath["/apiary"]).toBe(false)
  })

  test('apiPrefix "" disables auto-mount marking', () => {
    const rows = buildRouteTable({
      pages: [],
      api: [{ method: "get", path: "/api/users" }],
      apiPrefix: "",
    })
    expect(rows[0]?.autoMounted).toBe(false)
  })
})

describe("renderRouteTable + routeTableToJson", () => {
  const rows = buildRouteTable({
    pages: [{ pattern: "/", file: "index.tsx", hasAction: false }],
    api: [{ method: "get", path: "/api/explain" }],
  })

  test("text table shows method, kind, path + an (auto-mounted) marker on API routes", () => {
    const text = renderRouteTable(rows)
    expect(text).toContain("METHOD")
    expect(text).toContain("KIND")
    expect(text).toContain("PATH")
    expect(text).toContain("/api/explain")
    expect(text).toContain("(auto-mounted)")
    expect(text).toContain("page")
    expect(text).toContain("api")
  })

  test("empty table → a clear no-routes line", () => {
    expect(renderRouteTable([])).toContain("No routes found")
  })

  test("--json shape: stable keys; file on pages, autoMounted on API routes", () => {
    const json = routeTableToJson(rows)
    // Sorted by path: "/" precedes "/api/explain".
    expect(json.routes).toEqual([
      { kind: "page", path: "/", methods: ["GET"], file: "index.tsx" },
      { kind: "api", path: "/api/explain", methods: ["GET"], autoMounted: true },
    ])
  })
})

describe("describeRoutes (cwd integration)", () => {
  test("enumerates pages (GET, +POST for an action) + backend API routes, marking auto-mount", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-routes-"))
    try {
      const routesDir = join(dir, "routes")
      await mkdir(routesDir, { recursive: true })
      await writeFile(join(routesDir, "index.tsx"), "export default function H() { return null }\n")
      await writeFile(
        join(routesDir, "submit.tsx"),
        "export default function S() { return null }\nexport const action = async () => ({ ok: true })\n",
      )
      const app: LoadedApp = {
        cwd: dir,
        routesDir,
        outDir: join(dir, "dist"),
        framework: { adapter: {}, clientModule: "x" },
        backend: {
          routes: () => [
            { method: "GET", path: "/api/explain" },
            { method: "POST", path: "/api/explain" },
            { method: "GET", path: "/health" },
          ],
        },
      }

      const text = await describeRoutes(app)
      expect(text).toContain("/api/explain")
      expect(text).toContain("(auto-mounted)")
      // The action route serves POST too.
      expect(text).toMatch(/GET, POST\s+page\s+\/submit/)

      const json = JSON.parse(await describeRoutes(app, { json: true })) as {
        routes: { path: string; methods: string[]; autoMounted?: boolean }[]
      }
      const explain = json.routes.find((r) => r.path === "/api/explain")
      expect(explain?.methods).toEqual(["GET", "POST"])
      expect(explain?.autoMounted).toBe(true)
      expect(json.routes.find((r) => r.path === "/health")?.autoMounted).toBe(false)
      const submit = json.routes.find((r) => r.path === "/submit")
      expect(submit?.methods).toEqual(["GET", "POST"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("no routes/ and no backend → a clear no-routes message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-routes-empty-"))
    try {
      const app: LoadedApp = {
        cwd: dir,
        routesDir: resolve(dir, "routes"), // doesn't exist
        outDir: join(dir, "dist"),
        framework: { adapter: {}, clientModule: "x" },
        backend: undefined,
      }
      expect(await describeRoutes(app)).toContain("No routes found")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

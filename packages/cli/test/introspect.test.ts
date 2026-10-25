import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { server } from "@nifrajs/core"
import {
  apiRoutesSection,
  buildRouteGraph,
  buildRouteTable,
  clientSpellingFor,
  describeProject,
  describeRoutes,
  type RouteJson,
  renderRouteGraph,
  renderRouteTable,
  routeGraphToJson,
  routesToJson,
  routeTableToJson,
} from "../src/introspect.ts"
import type { LoadedApp } from "../src/load.ts"

// A minimal LoadedApp whose backend exposes the routes routesToJson reads - the only field it touches.
const appWith = (routes: unknown[]): LoadedApp =>
  ({ backend: { routes: () => routes } }) as unknown as LoadedApp

// A LoadedApp for describeProject: needs cwd (for the heading) + a routesDir (a missing one → the
// page-routes section reports "no file routes", keeping the test focused on the API/index behavior).
const projectWith = (routes: unknown[]): LoadedApp =>
  ({
    cwd: "/tmp/nifra-context-app",
    routesDir: "/tmp/nifra-context-app/routes",
    outDir: "/tmp/nifra-context-app/dist",
    framework: { adapter: {}, clientModule: "@nifrajs/web-react/client" },
    // The index states which bundler the app runs on, so the plugin slots have to be there.
    resolvedPlugins: { vitePlugins: [], clientPlugins: [], serverPlugins: [] },
    backend: { routes: () => routes },
  }) as unknown as LoadedApp

describe("clientSpellingFor - the `nifra routes` collision annotation", () => {
  test("names the reserved key and the spelling that reaches the route", () => {
    expect(clientSpellingFor("/api/delete")).toEqual({
      spelling: 'api.api("delete")',
      reserved: "delete",
    })
  })

  test("a path with no collision is not annotated", () => {
    expect(clientSpellingFor("/api/remove")).toBeUndefined()
    expect(clientSpellingFor("/users/:id")).toBeUndefined()
  })

  test("a param named like a reserved key does not collide", () => {
    // Params are never spelled as property accesses, so nothing shadows them.
    expect(clientSpellingFor("/jobs/:subscribe")).toBeUndefined()
  })

  test("the route table annotates a colliding row and leaves the rest alone", () => {
    const text = renderRouteTable([
      { kind: "api", path: "/api/delete", methods: ["POST"] },
      { kind: "api", path: "/api/remove", methods: ["POST"] },
    ])
    expect(text).toContain("'delete' is a reserved typed-client key")
    expect(text).toContain('api.api("delete")')
    expect(text.split("\n").filter((line) => line.includes("reserved"))).toHaveLength(1)
  })

  test("the JSON rows carry the collision so an agent never has to guess the reserved set", () => {
    const { routes } = routeTableToJson([
      { kind: "api", path: "/api/delete", methods: ["POST"] },
      { kind: "api", path: "/api/remove", methods: ["POST"] },
    ])
    expect(routes[0]).toMatchObject({
      reservedKey: "delete",
      clientSpelling: 'api.api("delete")',
    })
    expect(routes[1]).not.toHaveProperty("reservedKey")
  })
})

// Structured route JSON for the nifra_routes MCP tool (feedback 2026-06: agents want JSON, not markdown).
describe("routesToJson - structured list_routes / get_route_schema", () => {
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

  test("a custom-method route is listed with a fetch call, in JSON and in the brief", () => {
    const routes = [
      { method: "PURGE", path: "/cache/:key" },
      { method: "GET", path: "/cache/:key" },
    ]
    expect(routesToJson(appWith(routes))).toEqual([
      { method: "GET", path: "/cache/:key", call: "await api.cache({ key }).get()" },
      { method: "PURGE", path: "/cache/:key", call: 'await fetch(url, { method: "PURGE" })' },
    ])
    const brief = apiRoutesSection(routes)
    expect(brief).toContain("- `PURGE /cache/:key`")
    expect(brief).toContain(
      '- call: `await fetch(url, { method: "PURGE" })` (no typed-client call for this method; `url` is the path above)',
    )
    expect(brief).toContain(
      "- call: `await api.cache({ key }).get()` → `{ ok, status, data, error }`",
    )
  })

  test("a QUERY route is a typed `$query` call, and a DELETE keeps its body", () => {
    const body = { standard: undefined, jsonSchema: { type: "object" }, fields: undefined }
    const brief = apiRoutesSection([
      { method: "QUERY", path: "/search", schema: { body } },
      { method: "DELETE", path: "/items", schema: { body } },
    ])
    expect(brief).toContain(
      "- call: `await api.search.$query(body)` → `{ ok, status, data, error }`",
    )
    expect(brief).toContain(
      "- call: `await api.items.delete({ body })` → `{ ok, status, data, error }`",
    )
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

// `nifra routes [--json]` - the focused, uniform route view (page + API routes, with methods). The
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
      apiPrefix: "/api",
    })
    expect(rows).toEqual([
      { kind: "api", path: "/api/count", methods: ["GET", "POST"], autoMounted: true },
    ])
  })

  test("autoMounted reflects the apiPrefix, as a segment boundary", () => {
    const rows = buildRouteTable({
      pages: [],
      api: [
        { method: "get", path: "/api/users" }, // under /api → auto-mounted
        { method: "get", path: "/health" }, // not under /api
        { method: "get", path: "/apiary" }, // shares the prefix string but NOT a segment boundary
      ],
      apiPrefix: "/api",
    })
    const byPath = Object.fromEntries(rows.map((r) => [r.path, r.autoMounted]))
    expect(byPath["/api/users"]).toBe(true)
    expect(byPath["/health"]).toBe(false)
    expect(byPath["/apiary"]).toBe(false)
  })

  test('no apiPrefix, or "", marks nothing auto-mounted', () => {
    const api = [{ method: "get", path: "/api/users" }]
    expect(buildRouteTable({ pages: [], api })[0]?.autoMounted).toBe(false)
    expect(buildRouteTable({ pages: [], api, apiPrefix: "" })[0]?.autoMounted).toBe(false)
  })
})

describe("renderRouteTable + routeTableToJson", () => {
  const rows = buildRouteTable({
    pages: [{ pattern: "/", file: "index.tsx", hasAction: false }],
    api: [{ method: "get", path: "/api/explain" }],
    apiPrefix: "/api",
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

describe("route graph", () => {
  test("builds stable parent edges and renders Mermaid without private topology", () => {
    const graph = buildRouteGraph(
      buildRouteTable({
        pages: [{ pattern: "/", file: "index.tsx", hasAction: false }],
        api: [
          { method: "GET", path: "/api" },
          { method: "GET", path: "/api/orders" },
        ],
      }),
    )

    expect(graph.nodes.map((node) => node.id)).toEqual([
      "root",
      "page:/",
      "api:/api",
      "api:/api/orders",
    ])
    expect(graph.edges).toContainEqual({ from: "api:/api", to: "api:/api/orders" })
    const mermaid = renderRouteGraph(graph)
    expect(mermaid).toContain("flowchart TD")
    expect(mermaid).toContain("api: GET /api/orders")
  })

  test("returns an independent stable JSON snapshot and escapes Mermaid label delimiters", () => {
    const graph = buildRouteGraph([{ kind: "api", path: '/api/quoted/"x"', methods: ["GET"] }])
    const snapshot = routeGraphToJson(graph)
    expect(snapshot).toEqual(graph)
    expect(snapshot).not.toBe(graph)
    expect(snapshot.nodes).not.toBe(graph.nodes)
    expect(snapshot.edges).not.toBe(graph.edges)
    const mermaid = renderRouteGraph(graph)
    expect(mermaid).not.toContain('api: GET /api/quoted/"x"')
    expect(mermaid).not.toContain("\napi: GET")
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
        "export default function S() { return null }\n",
      )
      await writeFile(
        join(routesDir, "submit.backend.ts"),
        "export const action = async () => ({ ok: true })\n",
      )
      const app: LoadedApp = {
        cwd: dir,
        configPath: `${dir}/nifra.config.ts`,
        routesDir,
        outDir: join(dir, "dist"),
        framework: { adapter: {}, clientModule: "x", apiPrefix: "/api" },
        resolvedPlugins: { vitePlugins: [], clientPlugins: [], serverPlugins: [] },
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
        configPath: `${dir}/nifra.config.ts`,
        routesDir: resolve(dir, "routes"), // doesn't exist
        outDir: join(dir, "dist"),
        framework: { adapter: {}, clientModule: "x" },
        resolvedPlugins: { vitePlugins: [], clientPlugins: [], serverPlugins: [] },
        backend: undefined,
      }
      expect(await describeRoutes(app)).toContain("No routes found")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("describeProject - nifra_context index vs slice", () => {
  // A backend with a route carrying a real schema, so the difference between the compact index (no
  // schema) and the full slice (the schema rendered as a TS shape) is observable in the output.
  const ROUTES = [
    {
      method: "GET",
      path: "/api/orders/:id",
      schema: {
        response: {
          jsonSchema: {
            type: "object",
            properties: { id: { type: "string" }, total: { type: "number" } },
            required: ["id", "total"],
          },
        },
      },
    },
    { method: "POST", path: "/api/orders" },
    { method: "GET", path: "/health" },
  ]

  test("no-arg call returns a tight INDEX: route list + conventions, NO per-route schemas", () => {
    const out = describeProject(projectWith(ROUTES))
    // Every route is listed (so the agent knows what's mounted)…
    expect(out).toContain("`GET /api/orders/:id`")
    expect(out).toContain("`POST /api/orders`")
    expect(out).toContain("`GET /health`")
    // …but the index omits the heavy per-route detail: no rendered schema, no `call:` line.
    expect(out).not.toContain("total: number") // the response schema is NOT dumped in the index
    expect(out).not.toContain("call:")
    // It points the agent at how to fetch the full contract, and still ships the conventions block.
    expect(out).toContain("nifra_context")
    expect(out).toContain("## Conventions (summary)")
  })

  test("a `path` slice returns the FULL contract (schema + call form) and drops conventions", () => {
    const out = describeProject(projectWith(ROUTES), { path: "/api/orders" })
    // Narrowed to the matching routes…
    expect(out).toContain("`GET /api/orders/:id`")
    expect(out).not.toContain("/health")
    // …with the full detail the index withheld: the response schema as a TS shape + the typed-client call.
    expect(out).toContain("response: `{ id: string, total: number }`")
    expect(out).toContain("call:")
    // A slice omits the conventions block (the agent already has it from the index call).
    expect(out).not.toContain("## Conventions (summary)")
  })

  test("a `kind: api` slice returns full API detail and no page section", () => {
    const out = describeProject(projectWith(ROUTES), { kind: "api" })
    expect(out).toContain("call:")
    expect(out).not.toContain("## Page routes")
    expect(out).not.toContain("## Conventions (summary)")
  })
})

test("the index lists the routes an opaque mount declares, marked as not analyzed", () => {
  const backend = server()
    .get("/health", () => "ok")
    .mount({
      path: "/auth",
      app: { fetch: () => new Response("third party") },
      opaque: {
        reason: "a third-party auth handler",
        routes: [{ method: "POST", path: "/auth/sign-in", capabilities: ["session.write"] }],
      },
    })
  const out = describeProject({ ...projectWith([]), backend })
  expect(out).toContain("`GET /health`")
  expect(out).toContain(
    "## Declared by opaque mounts (not analyzed)\n\n- `POST /auth/sign-in` - /auth/* (a third-party auth handler)",
  )
  expect(describeProject(projectWith([]))).not.toContain("opaque mounts")
})

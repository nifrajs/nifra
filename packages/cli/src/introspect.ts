/**
 * Introspect a loaded nifra project into a Markdown brief — the API routes (`backend.routes()`), the
 * page routes (`discoverRoutes`), and a conventions summary — for piping into an AI coding agent's
 * prompt. Used by `nifra context` (stdout) and the `nifra mcp` server (a tool result), so an agent sees
 * *this* project's actual surface, not just generic docs.
 */

import type { Manifest } from "@nifrajs/web"
import { discoverRoutes } from "@nifrajs/web/fs"
import type { LoadedApp } from "./load.ts"

/** Structural view of a `@nifrajs/core` route descriptor — declared locally so the CLI needs no type
 * dependency on core. `app.routes()` returns these. */
interface RouteDesc {
  readonly method: string
  readonly path: string
  readonly schema?: unknown
}

/** Read the backend's registered routes, if it's a `server()` with a `.routes()` method. */
export function backendRoutes(backend: unknown): RouteDesc[] {
  if (backend && typeof (backend as { routes?: unknown }).routes === "function") {
    try {
      return (backend as { routes(): RouteDesc[] }).routes()
    } catch {
      return []
    }
  }
  return []
}

/** The JSON Schema a `t`/Standard Schema carries (nifra's `t` is TypeBox-backed and exposes `.jsonSchema`),
 * or `undefined` for a validator that doesn't expose one. This is the exact field-level contract. */
function jsonSchemaOf(schema: unknown): unknown {
  if (schema && typeof schema === "object" && "jsonSchema" in schema) {
    const js = (schema as { jsonSchema?: unknown }).jsonSchema
    if (js !== undefined && js !== null) return js
  }
  return undefined
}

interface JsonSchemaNode {
  readonly type?: unknown
  readonly properties?: Record<string, unknown>
  readonly required?: unknown
  readonly items?: unknown
  readonly additionalProperties?: unknown
  readonly anyOf?: unknown
  readonly oneOf?: unknown
  readonly enum?: unknown
  readonly const?: unknown
}

/**
 * Render a JSON Schema as a compact TypeScript-like type (`{ id: string, name?: string }`) — the
 * shape agents already think in, at a fraction of the raw JSON Schema's tokens (~70-80% smaller).
 * Anything the renderer doesn't model falls back to the raw JSON for that subtree, so the output
 * is always faithful, just not always minimal.
 */
export function tsTypeOf(schema: unknown, depth = 0): string {
  if (typeof schema !== "object" || schema === null || depth > 6) return JSON.stringify(schema)
  const node = schema as JsonSchemaNode
  const union = (node.anyOf ?? node.oneOf) as unknown[] | undefined
  if (Array.isArray(union)) return union.map((u) => tsTypeOf(u, depth + 1)).join(" | ")
  if (Array.isArray(node.enum)) return node.enum.map((v) => JSON.stringify(v)).join(" | ")
  if (node.const !== undefined) return JSON.stringify(node.const)
  switch (node.type) {
    case "string":
      return "string"
    case "number":
    case "integer":
      return "number"
    case "boolean":
      return "boolean"
    case "null":
      return "null"
    case "array": {
      const item = tsTypeOf(node.items, depth + 1)
      // Parenthesize unions so `(A | B)[]` reads as the array it is.
      return item.includes(" | ") ? `(${item})[]` : `${item}[]`
    }
    case "object": {
      const props = node.properties
      if (props === undefined) {
        return node.additionalProperties === undefined || node.additionalProperties === false
          ? "{}"
          : `Record<string, ${node.additionalProperties === true ? "unknown" : tsTypeOf(node.additionalProperties, depth + 1)}>`
      }
      const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : [])
      const fields = Object.entries(props).map(
        ([key, value]) => `${key}${required.has(key) ? "" : "?"}: ${tsTypeOf(value, depth + 1)}`,
      )
      return `{ ${fields.join(", ")} }`
    }
    default:
      return JSON.stringify(schema)
  }
}

/** One route's request/response field shapes, indented under its line. Reads the declared schemas off the
 * descriptor so an agent gets the exact input + output contract — not just "this route is validated". */
function schemaLines(schema: unknown): string[] {
  const s = schema as { body?: unknown; query?: unknown; response?: unknown } | undefined
  if (!s) return []
  const out: string[] = []
  for (const key of ["query", "body", "response"] as const) {
    const declared = s[key]
    if (!declared) continue
    const js = jsonSchemaOf(declared)
    out.push(
      js
        ? `    - ${key}: \`${tsTypeOf(js)}\``
        : `    - ${key}: _(validated; shape not introspectable from this validator)_`,
    )
  }
  return out
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * The typed-client call form for a route — the exact `client<typeof app>` proxy chain an agent should
 * write, derived from the same convention `@nifrajs/client` implements (so it never has to read the
 * client tests to learn it): a static segment is a property (`.users`), a path param/wildcard is a call
 * that appends the value (`({ id })`), the root path is `.index`, and the HTTP verb is the terminal call.
 * Body verbs (POST/PUT/PATCH) take the body first then call-options; other verbs take call-options first —
 * so the `{ query }` argument lands in the right slot for each.
 */
export function clientCall(method: string, path: string, schema: unknown): string {
  const s = schema as { body?: unknown; query?: unknown } | undefined
  const verb = method.toLowerCase()
  const segs = path.split("/").filter((seg) => seg !== "")
  let chain = "api"
  if (segs.length === 0) chain += ".index"
  else
    for (const seg of segs) {
      if (seg.startsWith(":") || seg.startsWith("*")) {
        const name = seg.replace(/^[:*]/, "") || "value"
        chain += `({ ${name} })`
      } else chain += IDENT.test(seg) ? `.${seg}` : `[${JSON.stringify(seg)}]`
    }
  const isBodyVerb = verb === "post" || verb === "put" || verb === "patch"
  let call: string
  if (isBodyVerb) {
    // body is the 1st arg; if a route has a query but no body, the body slot must still be filled.
    const bodyArg = s?.body ? "body" : s?.query ? "undefined" : ""
    const opts = s?.query ? (bodyArg ? ", { query }" : "{ query }") : ""
    call = `.${verb}(${bodyArg}${opts})`
  } else {
    call = `.${verb}(${s?.query ? "{ query }" : ""})`
  }
  return `await ${chain}${call}`
}

/** Markdown section listing the backend's API routes with their request + response field shapes. */
export function apiRoutesSection(routes: readonly RouteDesc[]): string {
  if (routes.length === 0) {
    return "## API routes\n\nNo `backend.ts` server routes found (this app may be frontend-only)."
  }
  const lines = [...routes]
    .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
    .flatMap((r) => [
      `- \`${r.method} ${r.path}\``,
      ...schemaLines(r.schema),
      `    - call: \`${clientCall(r.method, r.path, r.schema)}\` → \`{ ok, status, data, error }\``,
    ])
  return `## API routes (backend.ts)\n\nEach route's \`body\`/\`query\`/\`response\` shape is its contract — the typed client derives request inputs and \`res.data\` from these, so a screen built on \`client<typeof app>\` stays in sync automatically. The \`call\` line is the exact \`client<typeof app>\` form: static path segments are properties, a path param is a call (\`({ id })\`), the verb is the terminal call (body first for POST/PUT/PATCH), and every call returns the never-throwing \`{ ok, status, data, error }\` Result.\n\n${lines.join("\n")}`
}

/** Markdown section listing the file-routed pages (URL pattern → source file). */
export function pageRoutesSection(manifest: Manifest | undefined): string {
  if (!manifest || manifest.routes.length === 0) {
    return "## Page routes\n\nNo file routes found under `routes/`."
  }
  const lines = [...manifest.routes]
    .sort((a, b) => a.pattern.localeCompare(b.pattern))
    .map((r) => `- \`${r.pattern}\` → \`${r.file}\``)
  return `## Page routes (routes/)\n\n${lines.join("\n")}`
}

const CONVENTIONS = `## Conventions (summary)

- **Backend:** \`server()\` from \`@nifrajs/core\`; returning a value sends JSON. Validate untrusted input with
  a route schema (\`{ body, query, params }\` using \`t\` from \`@nifrajs/schema\` or any Standard Schema) and read
  the typed \`c.body\` / \`c.query\` / \`c.params\` — never hand-parse.
- **Response contract (no drift):** declare \`{ response: t.object({...}) }\` on a route to lock its output
  shape — the handler is type-checked against it and the client sees exactly that shape. The contract above
  is the single source of truth for both sides.
- **Client — ALWAYS use this for API calls:** \`client<typeof app>(url)\` derives request inputs AND
  \`res.data\` from the backend's route types, so the compiler catches any frontend/backend drift. Never
  hand-roll \`fetch\` + ad-hoc response types for an internal API — that's exactly how screens drift. It
  never throws: branch on \`res.ok ? res.data : res.error\`.
- **Pages:** file-routed under \`routes/\`; \`loader\`/\`action\` are server-only but the module is also bundled
  for the browser — **never top-level-import server-only code** (DB, secrets, \`process.env\`) into a route
  file; reach it via \`ctx.api\` / \`ctx.env\`.
- \`app.fetch(Request)\` is the universal entry. Full reference: this repo's \`AGENTS.md\`, or \`llms-full.txt\`.`

/** Optional narrowing for {@link describeProject} — a path prefix and/or one section. A filtered
 * brief omits the conventions block (the agent already has it from its first full call), so
 * follow-up calls cost a fraction of the tokens. */
export interface ContextFilter {
  readonly path?: string
  readonly kind?: "api" | "pages"
}

/** Build the project brief (API routes + page routes + conventions) as Markdown — optionally
 * narrowed by {@link ContextFilter} for cheap follow-up calls. */
export function describeProject(app: LoadedApp, filter?: ContextFilter): string {
  let manifest: Manifest | undefined
  try {
    manifest = discoverRoutes(app.routesDir)
  } catch {
    // No (or unreadable) routes/ — the page-routes section reports that.
  }
  const prefix = filter?.path
  let routes = backendRoutes(app.backend)
  let pages = manifest
  if (prefix !== undefined && prefix !== "") {
    routes = routes.filter((r) => r.path.startsWith(prefix))
    if (manifest !== undefined) {
      pages = { ...manifest, routes: manifest.routes.filter((r) => r.pattern.startsWith(prefix)) }
    }
  }
  const narrowed = filter?.kind !== undefined || (prefix !== undefined && prefix !== "")
  const sections: string[] = [`# nifra project: ${app.cwd.slice(app.cwd.lastIndexOf("/") + 1)}`]
  if (!narrowed) {
    sections.push(
      "A full-stack nifra app — Web-standard, one app on Bun, Node, Deno, and the edge.",
      // Point agents at the verified surface, not recalled APIs — nifra is young, so training data is the
      // wrong source. The MCP tools (nifra_docs / nifra_example) are checked against the installed version.
      "> **Build against THIS surface + the verified tools — do not write nifra APIs from memory** (the\n> framework is young; recalled APIs drift). For framework code, call `nifra_example` (snippets\n> typechecked against the installed version) or `nifra_docs`; verify edits with `nifra_run` + `nifra_check`.",
    )
  }
  if (filter?.kind !== "pages") sections.push(apiRoutesSection(routes))
  if (filter?.kind !== "api") sections.push(pageRoutesSection(pages))
  if (!narrowed) sections.push(CONVENTIONS)
  return sections.join("\n\n")
}

/** One API route as structured JSON: method, path, the exact typed-client call form, and compact
 * TS-shaped request/response contracts (present only when the route declares the schema). */
export interface RouteJson {
  readonly method: string
  readonly path: string
  readonly call: string
  readonly body?: string
  readonly query?: string
  readonly response?: string
}

/**
 * The backend's API routes as structured JSON — what the `nifra_routes` MCP tool returns, so an agent
 * consumes the contract programmatically (`list_routes` / `get_route_schema`) instead of parsing the
 * Markdown brief. Optionally filtered to routes whose path starts with `pathPrefix`. Reuses the exact
 * same `call` form and TS-shaped contracts the Markdown brief shows.
 */
export function routesToJson(app: LoadedApp, pathPrefix?: string): RouteJson[] {
  const shape = (v: unknown): string | undefined => {
    if (!v) return undefined
    const js = jsonSchemaOf(v)
    return js ? tsTypeOf(js) : "(validated; shape not introspectable from this validator)"
  }
  let routes = backendRoutes(app.backend)
  if (pathPrefix !== undefined && pathPrefix !== "") {
    routes = routes.filter((r) => r.path.startsWith(pathPrefix))
  }
  return [...routes]
    .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
    .map((r) => {
      const s = r.schema as { body?: unknown; query?: unknown; response?: unknown } | undefined
      const body = shape(s?.body)
      const query = shape(s?.query)
      const response = shape(s?.response)
      // Spread only the shapes that exist, so an unschematized route has no body/query/response key.
      return {
        method: r.method,
        path: r.path,
        call: clientCall(r.method, r.path, r.schema),
        ...(body !== undefined && { body }),
        ...(query !== undefined && { query }),
        ...(response !== undefined && { response }),
      }
    })
}

// ===================================================================================================
// `nifra routes [--json]` — the focused, uniform view of every route the app serves, with methods.
//
// `nifra context` lists page routes + API routes for an agent's prompt (Markdown, with schemas).
// `nifra routes` answers a different question: "what does this app actually serve, and with which
// methods?" — so an agent sees instantly that `POST /api/explain` is (or isn't) mounted, instead of
// discovering it via a 405. It marks which backend routes are AUTO-MOUNTED under the page router's
// `apiPrefix` (default `/api`), and `--json` makes it machine-consumable. The table-building +
// rendering are pure (no fs / no module loads), so they're unit-tested; the cwd gathering is the thin
// async wrapper `describeRoutes`.
// ===================================================================================================

/** The kind of route: a file-routed `page` (SSR/SSG) or a backend `api` (HTTP handler). */
export type RouteKind = "page" | "api"

/** One row of the unified route table. */
export interface RouteTableEntry {
  readonly kind: RouteKind
  /** The URL pattern (page: `/blog/:slug`; api: `/api/users`). */
  readonly path: string
  /** Methods this route serves, sorted (page: `GET`, plus `POST` when it has an `action`). */
  readonly methods: readonly string[]
  /** Source file (page only — the route module path relative to `routes/`). */
  readonly file?: string
  /** True when this API route is auto-mounted under the page router's `apiPrefix` (so it's reachable
   * through the same web app, no hand-wired `if (pathname.startsWith("/api/"))`). Pages are never
   * auto-mounted (they ARE the page router); only API routes carry this flag. */
  readonly autoMounted?: boolean
}

/** A page route + whether its module exports an `action` (→ it also serves POST). The caller resolves
 * `hasAction` (a module load); kept out of the pure builder so the builder needs no fs. */
export interface PageRouteInput {
  readonly pattern: string
  readonly file: string
  readonly hasAction: boolean
}

export interface RouteTableInput {
  readonly pages: readonly PageRouteInput[]
  readonly api: readonly RouteDesc[]
  /** The page router's `apiPrefix` (default `/api`); an API route at/under it is auto-mounted. `""`
   * disables the auto-mount, so no API route is marked auto-mounted. */
  readonly apiPrefix?: string
}

/** True when `path` is at or under `prefix` as a path segment boundary (`/api` matches `/api` and
 * `/api/x`, but not `/apiary`). An empty prefix matches nothing (auto-mount disabled). */
function isUnderPrefix(path: string, prefix: string): boolean {
  if (prefix === "") return false
  return path === prefix || path.startsWith(`${prefix}/`)
}

/**
 * Build the unified, sorted route table from page routes + backend API routes. Pure — the caller
 * supplies page `hasAction` (resolved via a module load) and the API descriptors (`backend.routes()`).
 * Page routes serve `GET` (+ `POST` when they export an `action`); API routes carry their declared
 * method, and are flagged `autoMounted` when at/under `apiPrefix`. Sorted by path, then kind, then the
 * joined methods, for stable output.
 */
export function buildRouteTable(input: RouteTableInput): RouteTableEntry[] {
  const apiPrefix = input.apiPrefix ?? "/api"
  const rows: RouteTableEntry[] = []
  for (const page of input.pages) {
    const methods = page.hasAction ? ["GET", "POST"] : ["GET"]
    rows.push({ kind: "page", path: page.pattern, methods, file: page.file })
  }
  // Collapse API routes that share a path into one row with all its methods (a REST resource).
  const byPath = new Map<string, { methods: Set<string>; autoMounted: boolean }>()
  for (const r of input.api) {
    const existing = byPath.get(r.path)
    if (existing === undefined) {
      byPath.set(r.path, {
        methods: new Set([r.method.toUpperCase()]),
        autoMounted: isUnderPrefix(r.path, apiPrefix),
      })
    } else existing.methods.add(r.method.toUpperCase())
  }
  for (const [path, info] of byPath) {
    rows.push({
      kind: "api",
      path,
      methods: [...info.methods].sort(),
      autoMounted: info.autoMounted,
    })
  }
  return rows.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.kind.localeCompare(b.kind) ||
      a.methods.join(",").localeCompare(b.methods.join(",")),
  )
}

/** Render the route table as a terse aligned text table (the `nifra routes` default output). Pure. */
export function renderRouteTable(rows: readonly RouteTableEntry[]): string {
  if (rows.length === 0)
    return "No routes found (no `routes/` pages and no `backend.ts` API routes)."
  const display = rows.map((r) => ({
    methods: r.methods.join(", "),
    kind: r.kind,
    path: r.kind === "api" && r.autoMounted ? `${r.path}  (auto-mounted)` : r.path,
  }))
  const methodW = Math.max("METHOD".length, ...display.map((d) => d.methods.length))
  const kindW = Math.max("KIND".length, ...display.map((d) => d.kind.length))
  const padEnd = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - s.length))
  const line = (methods: string, kind: string, path: string): string =>
    `${padEnd(methods, methodW)}  ${padEnd(kind, kindW)}  ${path}`
  return [
    line("METHOD", "KIND", "PATH"),
    ...display.map((d) => line(d.methods, d.kind, d.path)),
  ].join("\n")
}

/** One JSON row for `nifra routes --json` (the agent-facing, stable shape). */
export interface RouteJsonRow {
  readonly kind: RouteKind
  readonly path: string
  readonly methods: readonly string[]
  readonly file?: string
  readonly autoMounted?: boolean
}

/** The route table as a JSON document for `--json` (agents). Stable keys; `file`/`autoMounted` present
 * only where meaningful (file on pages, autoMounted on API routes). */
export function routeTableToJson(rows: readonly RouteTableEntry[]): {
  readonly routes: readonly RouteJsonRow[]
} {
  return {
    routes: rows.map((r) => ({
      kind: r.kind,
      path: r.path,
      methods: r.methods,
      ...(r.file !== undefined ? { file: r.file } : {}),
      ...(r.kind === "api" ? { autoMounted: r.autoMounted === true } : {}),
    })),
  }
}

/** A route module that may export an `action` (→ the page serves POST). */
interface MaybeActionModule {
  readonly action?: unknown
}

/**
 * Gather + render the unified route table for `nifra routes`. Discovers page routes (`discoverRoutes`),
 * loads each module to detect an `action` export (→ POST), reads the backend's API routes, then renders
 * text (default) or JSON (`--json`). The page-route load mirrors what SSR would do; a load failure
 * degrades to GET-only for that route (never throws the whole command).
 */
export async function describeRoutes(
  app: LoadedApp,
  opts: { readonly json?: boolean } = {},
): Promise<string> {
  let manifest: Manifest | undefined
  try {
    manifest = discoverRoutes(app.routesDir)
  } catch {
    // No (or unreadable) routes/ — fall through with no pages; the table still shows API routes.
  }
  const pages: PageRouteInput[] = []
  for (const route of manifest?.routes ?? []) {
    let hasAction = false
    try {
      const mod = (await route.load()) as MaybeActionModule
      hasAction = typeof mod.action === "function"
    } catch {
      // A route that can't be loaded at introspection time (e.g. a server-only import) → GET-only.
    }
    pages.push({ pattern: route.pattern, file: route.file, hasAction })
  }
  const rows = buildRouteTable({ pages, api: backendRoutes(app.backend) })
  return opts.json ? JSON.stringify(routeTableToJson(rows), null, 2) : renderRouteTable(rows)
}

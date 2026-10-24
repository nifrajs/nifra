/**
 * Runtime reflection for schemas and registered routes.
 *
 * Standard Schema deliberately standardizes validation, not introspection. This module makes that
 * distinction explicit: `standard` is present when a value can validate, while `jsonSchema` and
 * `fields` are present only when the value carries inspectable JSON Schema metadata. The implementation
 * recognizes Nifra/TypeBox carriers and raw JSON Schema without depending on a validator package.
 */

import {
  isDataClassification,
  type ResponseClassification,
  routeClassification,
} from "./classification.ts"
import { normalizeRouteCapabilities } from "./internal/capability-runtime.ts"
import {
  adoptionsOf,
  type HookKind,
  type HookOrigin,
  hookOriginOf,
  hookScopeOf,
  hookSourceOf,
  type MergeAuthGapTag,
  mergeAuthGapsOf,
  routeSitesOf,
  staticHeadersOf,
} from "./internal/hook-origins.ts"
import {
  type AssuranceEvidence,
  assuranceEvidenceFor,
  evidenceProvenance,
  NIFRA_ASSURANCE_IDS,
  validEvidence,
} from "./internal/route-assurance.ts"
import { NIFRA_BACKEND_EVIDENCE } from "./mount.ts"
import type { StandardSchemaV1 } from "./schema/standard.ts"
import type { ToolAnnotations } from "./server/server.ts"

export { declaredHeaderNames } from "./server/headers.ts"

/** JSON Schema permits either a schema object or the boolean schemas `true` and `false`. */
export type JsonSchema = boolean | Readonly<Record<string, unknown>>

/** One top-level property of an introspectable object schema. */
export interface ReflectedSchemaField {
  readonly name: string
  readonly required: boolean
  readonly schema: JsonSchema
}

/** Validation and introspection capabilities discovered for one schema-like value. */
export interface SchemaReflection {
  /** The Standard Schema validator, when the value implements Standard Schema v1. */
  readonly standard: StandardSchemaV1 | undefined
  /** Raw JSON Schema metadata, when the value exposes it or is itself a raw JSON Schema. */
  readonly jsonSchema: JsonSchema | undefined
  /**
   * Set when `jsonSchema` came from the schema's Standard JSON Schema converter (`~standard.jsonSchema`)
   * rather than from metadata it carries. Such output may use `$defs` and `$ref`.
   */
  readonly converted?: true
  /** Top-level object fields, or `undefined` when the JSON Schema is absent/non-object. */
  readonly fields: readonly ReflectedSchemaField[] | undefined
  /**
   * The media types a body schema reads through a parser of its own (`bodyParser`), beyond the
   * JSON and urlencoded bodies every body schema reads. Absent when it declares none.
   */
  readonly mediaTypes?: readonly string[]
}

export interface ReflectedRouteSchema {
  /** Explicit external-protocol mode; the handler owns raw request parsing. */
  readonly wire?: "raw"
  /** Validation/authentication ordering selected for this route. */
  readonly validationOrder?: "validate-before-auth" | "auth-before-validation"
  /** Effective transport body policy; surfaced so upload/streaming exemptions are auditable. */
  readonly bodyLimit?: number | "unlimited"
  readonly bodyLimitReason?: string
  /** Request-header schema; names are normalized to lower-case at runtime. */
  readonly headers?: SchemaReflection
  /** Request-cookie schema, validated against the parsed `Cookie` header. */
  readonly cookies?: SchemaReflection
  readonly body?: SchemaReflection
  readonly query?: SchemaReflection
  /** Path-params schema - constraints (uuid format, integer min/max) declared via `params: t.object(…)`. */
  readonly params?: SchemaReflection
  readonly response?: SchemaReflection
  readonly errors?: Readonly<Record<string, SchemaReflection>>
  /** The SSE event-payload schema of a typed streaming route (`app.sse()`). */
  readonly sse?: SchemaReflection
  /**
   * Set when an `onValidationError` hook (the route's own, or the app-wide default) answers this
   * route's validation failures, so its 422 body is whatever the hook returns.
   */
  readonly validationErrorHook?: true
}

/** Which side of a schema to describe: the value a request sends, or the value a response carries. */
export type SchemaSide = "input" | "output"

export interface ReflectedRoute {
  readonly method: string
  readonly path: string
  readonly schema?: ReflectedRouteSchema
  /** Runtime response-contract mode, when a response-contract plugin covered the route. */
  readonly responseContract?: "warn" | "enforce"
  readonly assurance?: readonly AssuranceEvidence[]
  readonly capabilities?: readonly string[]
  /** Set when the route is a declared dynamic route family (a runtime-resolved template like
   * `/api/:slug/:resource`) - so the assurance gate treats it as one classified family, not a single route. */
  readonly family?: boolean
  /** Field-level response classification plus the highest sensitivity present. */
  readonly classification?: ResponseClassification
  readonly tool?: {
    readonly name: string
    readonly description: string
    readonly annotations?: ToolAnnotations
  }
}

const recordOf = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object"
    ? (value as Readonly<Record<string, unknown>>)
    : undefined

const standardOf = (value: unknown): StandardSchemaV1 | undefined => {
  const record = recordOf(value)
  const standard = recordOf(record?.["~standard"])
  return standard?.version === 1 && typeof standard.validate === "function"
    ? (value as StandardSchemaV1)
    : undefined
}

/** The JSON Schema a Standard JSON Schema (`~standard.jsonSchema`) converts `side` to, if it has one. */
const standardJsonSchemaOf = (
  standard: StandardSchemaV1,
  side: SchemaSide,
): JsonSchema | undefined => {
  const converters = recordOf(recordOf(standard["~standard"])?.jsonSchema)
  const convert = converters?.[side]
  if (typeof convert !== "function") return undefined
  try {
    return normalizeJsonSchema(Reflect.apply(convert, converters, [{ target: "draft-2020-12" }]))
  } catch {
    // A library throws for a type JSON Schema cannot express (zod's `z.date()`); the schema stays opaque.
    return undefined
  }
}

const jsonSchemaOf = (
  value: unknown,
  standard: StandardSchemaV1 | undefined,
): JsonSchema | undefined => {
  const record = recordOf(value)
  if (record !== undefined && "jsonSchema" in record) {
    const carried = record.jsonSchema
    return normalizeJsonSchema(carried)
  }
  // Some Standard Schema implementations (including TypeBox-shaped adapters) expose an object
  // schema directly rather than through `.jsonSchema`. Only treat an inspectable object shape as
  // metadata here; validation-library internals are otherwise intentionally opaque.
  if (standard !== undefined) {
    return recordOf(record?.properties) !== undefined ? normalizeJsonSchema(record) : undefined
  }
  // A malformed/opaque Standard Schema marker is not raw JSON Schema metadata.
  if (record !== undefined && "~standard" in record) return undefined
  if (typeof value === "boolean" || record !== undefined) return normalizeJsonSchema(value)
  return undefined
}

/** Strip symbol keys and other non-JSON metadata carried by schema-builder objects. */
const normalizeJsonSchema = (value: unknown): JsonSchema | undefined => {
  if (typeof value === "boolean") return value
  if (recordOf(value) === undefined) return undefined
  try {
    const normalized: unknown = JSON.parse(JSON.stringify(value))
    if (typeof normalized === "boolean") return normalized
    const record = recordOf(normalized)
    if (record === undefined) return undefined
    // `~standard` is a Standard Schema *validation* marker, never valid JSON Schema. A TypeBox-shaped
    // carrier (a JSON Schema object that also carries `~standard`, with no separate `.jsonSchema`) would
    // otherwise leak the marker into emitted OpenAPI / mock / form output.
    if (!("~standard" in record)) return record
    const { "~standard": _omitted, ...rest } = record
    return rest
  } catch {
    return undefined
  }
}

const fieldsOf = (schema: JsonSchema | undefined): readonly ReflectedSchemaField[] | undefined => {
  const record = recordOf(schema)
  const properties = recordOf(record?.properties)
  if (properties === undefined) return undefined
  const required = new Set(
    Array.isArray(record?.required)
      ? record.required.filter((name): name is string => typeof name === "string")
      : [],
  )
  const fields: ReflectedSchemaField[] = []
  for (const [name, property] of Object.entries(properties)) {
    if (typeof property !== "boolean" && recordOf(property) === undefined) continue
    fields.push({ name, required: required.has(name), schema: property as JsonSchema })
  }
  return fields
}

// The brand a body schema carries its own reader under. Spelled here rather than imported so that
// reflection does not pull the body lane into a bundle that only describes routes.
const BODY_READER = Symbol.for("nifra.body.schemaReader")

const mediaTypesOf = (value: unknown): readonly string[] | undefined => {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined
  try {
    const reader = (value as Record<symbol, unknown>)[BODY_READER]
    if (typeof reader !== "function") return undefined
    const declared = (reader as { readonly mediaTypes?: unknown }).mediaTypes
    if (!Array.isArray(declared)) return undefined
    const types = declared.filter((type): type is string => typeof type === "string")
    return types.length > 0 ? Object.freeze(types) : undefined
  } catch {
    return undefined
  }
}

/**
 * Reflect a Standard Schema, Nifra/TypeBox schema carrier, or raw JSON Schema. Never throws.
 * Validation-only schemas have `standard` but no `jsonSchema`; raw JSON Schema has the reverse.
 * A Standard JSON Schema is read on `side`, since a default or a transform makes the two differ.
 */
export function reflectSchema(value: unknown, side: SchemaSide = "input"): SchemaReflection {
  const standard = standardOf(value)
  const carried = jsonSchemaOf(value, standard)
  const converted =
    carried === undefined && standard !== undefined
      ? standardJsonSchemaOf(standard, side)
      : undefined
  const jsonSchema = carried ?? converted
  const mediaTypes = mediaTypesOf(value)
  return {
    standard,
    jsonSchema,
    ...(converted !== undefined ? { converted: true as const } : {}),
    fields: fieldsOf(jsonSchema),
    ...(mediaTypes !== undefined ? { mediaTypes } : {}),
  }
}

const routeCandidates = (source: unknown): readonly unknown[] => {
  if (Array.isArray(source)) return source
  const record = recordOf(source)
  if (typeof record?.routes !== "function") return []
  try {
    const routes = record.routes()
    return Array.isArray(routes) ? routes : []
  } catch {
    return []
  }
}

const reflectedRouteSchema = (
  value: unknown,
  appValidationHook: boolean,
): ReflectedRouteSchema | undefined => {
  const schema = recordOf(value)
  if (schema === undefined) return undefined
  const errors = recordOf(schema.errors)
  const reflectedErrors: Record<string, SchemaReflection> = {}
  if (errors !== undefined) {
    for (const [status, errorSchema] of Object.entries(errors)) {
      reflectedErrors[status] = reflectSchema(errorSchema, "output")
    }
  }
  return {
    ...(schema.wire === "raw" ? { wire: "raw" as const } : {}),
    ...(schema.validationOrder === "auth-before-validation" ||
    schema.validationOrder === "validate-before-auth"
      ? { validationOrder: schema.validationOrder }
      : {}),
    ...(schema.bodyLimit === "unlimited" || typeof schema.bodyLimit === "number"
      ? { bodyLimit: schema.bodyLimit }
      : {}),
    ...(typeof schema.bodyLimitReason === "string"
      ? { bodyLimitReason: schema.bodyLimitReason }
      : {}),
    ...(schema.headers !== undefined ? { headers: reflectSchema(schema.headers) } : {}),
    ...(schema.cookies !== undefined ? { cookies: reflectSchema(schema.cookies) } : {}),
    ...(schema.body !== undefined ? { body: reflectSchema(schema.body) } : {}),
    ...(schema.query !== undefined ? { query: reflectSchema(schema.query) } : {}),
    ...(schema.params !== undefined ? { params: reflectSchema(schema.params) } : {}),
    ...(schema.response !== undefined
      ? { response: reflectSchema(schema.response, "output") }
      : {}),
    ...(Object.keys(reflectedErrors).length > 0 ? { errors: reflectedErrors } : {}),
    ...(schema.sse !== undefined ? { sse: reflectSchema(schema.sse, "output") } : {}),
    ...(appValidationHook || typeof schema.onValidationError === "function"
      ? { validationErrorHook: true as const }
      : {}),
  }
}

const reflectedTool = (value: unknown): ReflectedRoute["tool"] => {
  const tool = recordOf(value)
  if (typeof tool?.name !== "string" || typeof tool.description !== "string") return undefined
  return {
    name: tool.name,
    description: tool.description,
    ...(recordOf(tool.annotations) !== undefined
      ? { annotations: tool.annotations as ToolAnnotations }
      : {}),
  }
}

const reflectedAssurance = (value: unknown): readonly AssuranceEvidence[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const evidence = value.filter(validEvidence).map((item) =>
    Object.freeze({
      id: item.id,
      source: item.source.trim(),
      provenance: evidenceProvenance(item),
    }),
  )
  return evidence.length > 0 ? Object.freeze(evidence) : undefined
}

/** The evidence a WebSocket handshake enforces: its route chain runs the auth guards, and the app's
 * request hooks run the rate limiter. Anything else a `GET` at the same path carries comes from code
 * a socket's message handlers never pass through, so a socket does not claim it. */
const HANDSHAKE_EVIDENCE: ReadonlySet<string> = new Set([
  NIFRA_ASSURANCE_IDS.AUTHENTICATED,
  NIFRA_ASSURANCE_IDS.RATE_LIMITED,
])

/** A server's WebSocket routes as `"WS"` routes, read off its own table the way `reflectMounts` reads
 * `fetchMounts`, so serving pays nothing for them. */
const reflectedSockets = (source: unknown): ReflectedRoute[] => {
  const record = recordOf(source)
  const sockets = record?.wsRoutes
  if (!Array.isArray(sockets)) return []
  const global = Array.isArray(record?.globalAssurance) ? record.globalAssurance : []
  const reflected: ReflectedRoute[] = []
  for (const candidate of sockets) {
    const socket = recordOf(candidate)
    if (typeof socket?.path !== "string" || !Array.isArray(socket.assurance)) continue
    // The server stored them normalized at registration.
    const capabilities = Array.isArray(socket.capabilities)
      ? socket.capabilities.filter((id): id is string => typeof id === "string")
      : []
    // Declarations scoped by method match the `GET` a handshake is.
    const evidence = reflectedAssurance(
      assuranceEvidenceFor([...socket.assurance, ...global], "GET", socket.path).filter((item) =>
        HANDSHAKE_EVIDENCE.has(item.id),
      ),
    )
    const route: { -readonly [K in keyof ReflectedRoute]: ReflectedRoute[K] } = {
      method: "WS",
      path: socket.path,
    }
    if (evidence !== undefined) route.assurance = evidence
    if (capabilities.length > 0) route.capabilities = capabilities
    reflected.push(route)
  }
  return reflected
}

/**
 * Safely enumerate and normalize route descriptors from an app or descriptor array, and a server's
 * WebSocket routes under the pseudo-method `"WS"`. Invalid entries are ignored; a missing/throwing
 * `routes()` method yields only the sockets.
 */
export function reflectRoutes(source: unknown): readonly ReflectedRoute[] {
  const reflected: ReflectedRoute[] = []
  // The app-wide `server({ onValidationError })` lives on the server, not on each route descriptor.
  const appValidationHook = typeof recordOf(source)?.defaultOnValidationError === "function"
  for (const candidate of routeCandidates(source)) {
    const route = recordOf(candidate)
    if (typeof route?.method !== "string" || typeof route.path !== "string") continue
    const schema = reflectedRouteSchema(route.schema, appValidationHook)
    const tool = reflectedTool(route.tool)
    const assurance = reflectedAssurance(route.assurance)
    const capabilities = normalizeRouteCapabilities(
      Array.isArray(route.capabilities) ? (route.capabilities as readonly string[]) : undefined,
    )
    const routeSchema = recordOf(route.schema)
    const rawClassification = routeSchema?.classification
    const fallback = isDataClassification(rawClassification) ? rawClassification : undefined
    const classification = routeClassification(routeSchema?.response, fallback)
    reflected.push({
      method: route.method.toUpperCase(),
      path: route.path,
      ...(schema !== undefined ? { schema } : {}),
      ...(route.responseContract === "warn" || route.responseContract === "enforce"
        ? { responseContract: route.responseContract }
        : {}),
      ...(assurance !== undefined ? { assurance } : {}),
      ...(capabilities.length > 0 ? { capabilities } : {}),
      ...(route.family === true ? { family: true } : {}),
      ...(classification !== undefined ? { classification } : {}),
      ...(tool !== undefined ? { tool } : {}),
    })
  }
  reflected.push(...reflectedSockets(source))
  return reflected
}

/** A mounted child (`mount()`, `mountFetch()`) whose routes route reflection cannot see. */
export interface ReflectedMount {
  /** The mount prefix with `/*`: the child serves every path under it. */
  readonly path: string
  /** Why the child is not analyzed, as declared by `opaque` on the mount. */
  readonly opaque?: string
  /** The routes the mount declares it serves. Declared, not analyzed. */
  readonly routes?: readonly ReflectedMountRoute[]
}

/** A route an opaque mount declares, normalized: method upper-cased, capabilities deduplicated. */
export interface ReflectedMountRoute {
  readonly method: string
  readonly path: string
  readonly capabilities: readonly string[]
}

const METHOD_TOKEN = /^[A-Za-z]+$/

/** The declared routes of the mount at `prefix`, or a TypeError naming the first bad entry: a
 * declaration assurance reads must say exactly what it claims. */
function declaredMountRoutes(
  prefix: string,
  shown: string,
  value: unknown,
): readonly ReflectedMountRoute[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new TypeError(`mount ${shown}: opaque routes must be an array`)
  const routes: ReflectedMountRoute[] = []
  const seen = new Set<string>()
  value.forEach((candidate: unknown, index) => {
    const at = `mount ${shown}: declared route ${index + 1}`
    const entry = recordOf(candidate)
    if (entry === undefined) throw new TypeError(`${at} is not an object`)
    const { method, path, capabilities = [] } = entry
    if (typeof method !== "string" || !METHOD_TOKEN.test(method)) {
      throw new TypeError(`${at} has no valid method`)
    }
    if (typeof path !== "string" || !path.startsWith("/") || /[?#]/.test(path)) {
      throw new TypeError(`${at} needs a path starting with "/", without a query or fragment`)
    }
    if (prefix !== "/" && path !== prefix && !path.startsWith(`${prefix}/`)) {
      throw new TypeError(`${at} path ${path} is outside the mount`)
    }
    if (
      !Array.isArray(capabilities) ||
      !capabilities.every((id: unknown) => typeof id === "string")
    ) {
      throw new TypeError(`${at} capabilities must be an array of capability ids`)
    }
    const key = `${method.toUpperCase()} ${path}`
    if (seen.has(key)) throw new TypeError(`mount ${shown} declares ${key} twice`)
    seen.add(key)
    routes.push(
      Object.freeze({
        method: method.toUpperCase(),
        path,
        capabilities: Object.freeze([...new Set<string>(capabilities)]),
      }),
    )
  })
  return Object.freeze(
    routes.sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : a.method < b.method ? -1 : 1,
    ),
  )
}

/**
 * The mounts on an app that route reflection cannot see into, sorted by path. A mount whose app
 * publishes composed evidence (the API `createWebApp` mounts) is left out: its routes reach
 * reflection through that evidence. Anything that is not a nifra server yields an empty list.
 */
export function reflectMounts(source: unknown): readonly ReflectedMount[] {
  // `fetchMounts` is the server's own mount table, read here rather than exposed through a method so
  // apps that never reflect pay nothing for it.
  const mounts = recordOf(source)?.fetchMounts
  if (!Array.isArray(mounts)) return []
  const reflected: ReflectedMount[] = []
  for (const candidate of mounts) {
    const mount = recordOf(candidate)
    if (typeof mount?.path !== "string") continue
    const app = mount.app as { readonly [NIFRA_BACKEND_EVIDENCE]?: unknown } | undefined
    if (typeof app?.[NIFRA_BACKEND_EVIDENCE] === "function") continue
    // Checked here, at analysis time, so serving pays nothing: a blank reason is no reason.
    const declaration = recordOf(mount.opaque)
    const reason = typeof mount.opaque === "string" ? mount.opaque : declaration?.reason
    const opaque = typeof reason === "string" ? reason.trim() || undefined : undefined
    const shown = mount.path === "/" ? "/*" : `${mount.path}/*`
    // Routes count only beside a reason: without one the mount stays undeclared and fails as before.
    const routes =
      opaque === undefined ? undefined : declaredMountRoutes(mount.path, shown, declaration?.routes)
    reflected.push(
      Object.freeze({
        path: shown,
        ...(opaque !== undefined ? { opaque } : {}),
        ...(routes !== undefined ? { routes } : {}),
      }),
    )
  }
  return reflected.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** One hook that runs for a route or an unmatched path: what it is, who added it, and where. */
export interface ReflectedHook {
  readonly kind: HookKind
  /** The plugin that registered it, else the function's own name, else `(anonymous)`. */
  readonly name: string
  /** Where it was registered: `app`, `group /api`, `merge #1`, `mount /auth`, or `unknown`; `route`
   * for a runtime the route resolved at registration (`responseContract`, `effectLedger`,
   * `idempotency`), whose `name` is the contract mode or the runtime. */
  readonly site: string
  /** The header names a static `responseHeaders()` declaration sets. */
  readonly headers?: readonly string[]
}

export interface ReflectedRouteHooks {
  readonly method: string
  readonly path: string
  /** In the order they run: request hooks, the route chain, then response hooks innermost first. */
  readonly hooks: readonly ReflectedHook[]
}

/** The hooks a path under `prefix` that no route matches still runs - its 404s and 405s. */
export interface ReflectedUnmatchedHooks {
  readonly prefix: string
  readonly hooks: readonly ReflectedHook[]
}

export interface ReflectedHookReport {
  /**
   * False when a hook has no recorded origin and is listed with site `unknown`. Origins are recorded
   * only outside production builds, so reflect a development load of the app.
   */
  readonly complete: boolean
  readonly routes: readonly ReflectedRouteHooks[]
  readonly unmatched: readonly ReflectedUnmatchedHooks[]
}

export type { HookKind }

/** One server in the chain a request passes through: the app, then each mounted child it reaches. */
interface HookFrame {
  readonly server: Readonly<Record<string, unknown>>
  /** What this server's own paths are prefixed with in the report (a stripped mount's path). */
  readonly base: string
}

interface HookStep {
  readonly server: Readonly<Record<string, unknown>>
  readonly probe: HookProbe
}

interface HookProbe {
  readonly method: string
  /** A route's pattern path, or an unmatched path, in the frame's own coordinates. */
  readonly path: string
  readonly matched: boolean
}

// A middleware method's own name says nothing about who registered it.
const HOOK_FIELD_NAMES = new Set([
  "onRequest",
  "onResponse",
  "onResponseHeaders",
  "onResponseFinalized",
  "around",
  "derive",
  "beforeHandle",
  "afterHandle",
  "onError",
  "run",
  "web",
])
const UNMATCHED_PROBE = "__nifra_unmatched__"

const listOf = (server: Readonly<Record<string, unknown>>, field: string): readonly unknown[] => {
  const value = server[field]
  return Array.isArray(value) ? value : []
}

const isServerRecord = (value: unknown): value is Readonly<Record<string, unknown>> => {
  const record = recordOf(value)
  return (
    record !== undefined &&
    Array.isArray(record.onRequestHooks) &&
    typeof recordOf(record.catalog)?.entries === "function"
  )
}

const catalogOf = (
  server: Readonly<Record<string, unknown>>,
): readonly { readonly method: string; readonly path: string; readonly entry: unknown }[] => {
  const entries = recordOf(server.catalog)?.entries
  const list: unknown =
    typeof entries === "function" ? Reflect.apply(entries, server.catalog, []) : []
  const routes: { method: string; path: string; entry: unknown }[] = []
  for (const candidate of Array.isArray(list) ? list : []) {
    const route = recordOf(candidate)
    if (typeof route?.method === "string" && typeof route.path === "string") {
      routes.push({ method: route.method, path: route.path, entry: route.entry })
    }
  }
  return routes
}

const joinPath = (base: string, path: string): string =>
  base === "" ? path : path === "/" ? base : `${base}${path}`

/** A `merge()` that authenticates none of its routes under a parent that authenticates its own. */
export type ReflectedMergeAuthGap = MergeAuthGapTag

/**
 * Every `merge()` in the app, its merged servers included, whose server authenticates none of its
 * routes while the parent's order-scoped auth - an `authenticate()` stage, or `authenticated` evidence
 * scoped to subsequent routes - covers the parent's own: that auth never runs for a merged route.
 * Recorded by a development load only (the same provenance {@link reflectHooks} reads), so reflect the
 * app outside production. `nifra check` reports each one (NF-C043).
 */
export function reflectMergeAuthGaps(source: unknown): readonly ReflectedMergeAuthGap[] {
  if (!isServerRecord(source)) return []
  const gaps: ReflectedMergeAuthGap[] = []
  const seen = new Set<object>()
  const visit = (server: object): void => {
    if (seen.has(server)) return
    seen.add(server)
    gaps.push(...mergeAuthGapsOf(server))
    for (const adoption of adoptionsOf(server)) visit(adoption.source)
  }
  visit(source)
  return gaps
}

/**
 * Where each route was registered: `METHOD /path` (`WS` for a socket) mapped to the `file:line:col` of
 * the call outside nifra's core that registered it, through every `group()` and `merge()`. Recorded only
 * by a development load with `NIFRA_ROUTE_SITES=1` (the CLI sets it while it loads `nifra.assurance.ts`),
 * so the map is empty otherwise. The paths are absolute, which is why they stay out of
 * {@link reflectRoutes}, whose output is written into artifacts.
 */
export function reflectRouteSites(source: unknown): ReadonlyMap<string, string> {
  const sites = new Map<string, string>()
  if (!isServerRecord(source)) return sites
  const seen = new Set<object>()
  const visit = (server: object): void => {
    if (seen.has(server)) return
    seen.add(server)
    for (const [key, site] of routeSitesOf(server)) if (!sites.has(key)) sites.set(key, site)
    for (const adoption of adoptionsOf(server)) visit(adoption.source)
  }
  visit(source)
  return sites
}

/**
 * Every hook that actually runs for each route, and for each prefix's unmatched paths, with the plugin
 * that registered it and where: the app, a `group()`, a `merge()`d server, or a `mount()`ed one. It
 * follows the same scope rules the server applies - a group's hooks cover its prefix, a merged server's
 * request hooks cover only its own routes, a mount runs its child's whole lifecycle inside the app's
 * global hooks - and reads the provenance a development load records, so reflect the app outside
 * production. A mount of a server already on the path (a self-mount) is reported once, as that
 * prefix's unmatched entry. Anything that is not a nifra server yields an empty report.
 */
export function reflectHooks(source: unknown): ReflectedHookReport {
  if (!isServerRecord(source)) return { complete: true, routes: [], unmatched: [] }
  const labels = new Map<object, string>()
  let merges = 0
  const label = (server: object, context: string): void => {
    for (const adoption of adoptionsOf(server)) {
      if (labels.has(adoption.source)) continue
      if (adoption.prefix === undefined) merges += 1
      const own = adoption.prefix !== undefined ? `group ${adoption.prefix}` : `merge #${merges}`
      const full = context === "" ? own : `${context} > ${own}`
      labels.set(adoption.source, full)
      label(adoption.source, adoption.prefix !== undefined ? context : full)
    }
  }
  labels.set(source, "app")
  label(source, "")

  let complete = true
  const siteOf = (owner: object): string => {
    const site = labels.get(owner)
    if (site === undefined) complete = false
    return site ?? "unknown"
  }
  const pluginsOf = (owner: object): readonly (readonly [string, unknown])[] => {
    const plugins = recordOf(owner)?.appliedPlugins
    return plugins instanceof Map ? [...plugins.entries()] : []
  }
  const nameOf = (hook: unknown, origin: HookOrigin): string => {
    if (origin.plugin !== undefined) return origin.plugin
    const candidates: unknown[] = [hook]
    for (let next = hookSourceOf(hook); next !== undefined; next = hookSourceOf(next)) {
      candidates.push(next)
    }
    for (const [name, plugin] of pluginsOf(origin.owner)) {
      const bundle = recordOf(plugin)
      if (bundle === undefined) continue
      const fields = Object.values(bundle)
      if (candidates.some((candidate) => fields.includes(candidate))) return name
    }
    for (const candidate of candidates) {
      const name = typeof candidate === "function" ? candidate.name : ""
      if (name !== "" && !HOOK_FIELD_NAMES.has(name)) return name
    }
    const id = recordOf(hook)?.id
    return typeof id === "string" && id !== "" ? id : "(anonymous)"
  }
  const staticEntries = (server: object): ReflectedHook[] =>
    staticHeadersOf(server).map((tag) => {
      let name = tag.plugin
      if (name === undefined) {
        for (const [pluginName, plugin] of pluginsOf(tag.owner)) {
          if (recordOf(plugin)?.responseHeaders === tag.source) name = pluginName
        }
      }
      return {
        kind: "responseHeaders",
        name: name ?? "(static)",
        site: siteOf(tag.owner),
        headers: tag.names,
      }
    })
  const entriesOf = (hook: unknown, kind: HookKind): ReflectedHook[] => {
    const origin = hookOriginOf(hook)
    if (origin === undefined) {
      complete = false
      const name = typeof hook === "function" && hook.name !== "" ? hook.name : "(anonymous)"
      return [{ kind, name, site: "unknown" }]
    }
    if (origin.statics === true) return staticEntries(origin.owner)
    return [{ kind: origin.kind, name: nameOf(hook, origin), site: siteOf(origin.owner) }]
  }
  // The hook a scoped wrapper gates, or undefined when the probe falls outside its scope.
  const inScope = (hook: unknown, probe: HookProbe): unknown => {
    let current = hook
    for (let scope = hookScopeOf(current); scope !== undefined; scope = hookScopeOf(current)) {
      const covered =
        "prefix" in scope
          ? probe.path === scope.prefix || probe.path.startsWith(`${scope.prefix}/`)
          : probe.matched &&
            scope.routes.some((route) => route.method === probe.method && route.path === probe.path)
      if (!covered) return undefined
      current = scope.inner
    }
    return current
  }
  const scoped = (hooks: readonly unknown[], kind: HookKind, probe: HookProbe): ReflectedHook[] =>
    hooks.flatMap((hook) => {
      const inner = inScope(hook, probe)
      return inner === undefined ? [] : entriesOf(inner, kind)
    })
  const probesOf = (
    frames: readonly HookFrame[],
    path: string,
    method: string,
    matched: boolean,
  ): readonly HookStep[] =>
    frames.map((frame, index) => {
      // Each frame sees the path its own mount stripped; the innermost frame's path is `path`.
      const inner = frames
        .slice(index + 1)
        .reduceRight((acc, next) => joinPath(next.base, acc), path)
      return {
        server: frame.server,
        probe: { method, path: inner, matched: matched && index === frames.length - 1 },
      }
    })
  const requestPhase = (steps: readonly HookStep[]) =>
    steps.flatMap(({ server, probe }) =>
      scoped(listOf(server, "onRequestHooks"), "onRequest", probe),
    )
  const responsePhase = (steps: readonly HookStep[]) =>
    steps
      .map(({ server, probe }) => [
        ...staticEntries(server),
        ...scoped(listOf(server, "onResponseHooks"), "onResponse", probe),
        ...scoped(listOf(server, "onResponseFinalizedHooks"), "onResponseFinalized", probe),
      ])
      .reverse()
      .flat()

  const routes: ReflectedRouteHooks[] = []
  const unmatched: ReflectedUnmatchedHooks[] = []
  const visit = (frames: readonly HookFrame[], frame: HookFrame): void => {
    const reportPath = (path: string) =>
      frames.reduceRight((acc, current) => joinPath(current.base, acc), path)
    for (const route of catalogOf(frame.server)) {
      const probes = probesOf(frames, route.path, route.method, true)
      const entry = recordOf(route.entry)
      const chain = (field: string, kind: HookKind) =>
        entry === undefined ? [] : listOf(entry, field).flatMap((hook) => entriesOf(hook, kind))
      // A runtime is pinned into the route when it registers (or is merged), so it is listed with the
      // route's site rather than a hook's; the mode is the name so a warn -> enforce change shows.
      const mode = recordOf(recordOf(entry?.responseContract)?.runtime)?.mode
      const pinned = (present: boolean, kind: HookKind, name: string): ReflectedHook[] =>
        present ? [{ kind, name, site: "route" }] : []
      routes.push({
        method: route.method,
        path: reportPath(route.path),
        hooks: [
          ...requestPhase(probes),
          ...chain("around", "around"),
          ...pinned(entry?.ledgered !== undefined, "effectLedger", "effectLedger"),
          ...chain("authStages", "authenticate"),
          ...chain("derives", "derive"),
          ...chain("beforeHandle", "beforeHandle"),
          ...pinned(entry?.idempotent !== undefined, "idempotency", "idempotency"),
          ...chain("afterHandle", "afterHandle"),
          ...pinned(typeof mode === "string", "responseContract", String(mode)),
          ...chain("onError", "onError"),
          ...responsePhase(probes),
        ],
      })
    }
    // A handshake runs the request hooks and the route chain up to `upgrade()`: no `around`, no
    // `afterHandle`, and no response phase, since an accepted handshake sends no response through it.
    for (const candidate of listOf(frame.server, "wsRoutes")) {
      const socket = recordOf(candidate)
      const chain = recordOf(socket?.chain)
      if (typeof socket?.path !== "string" || chain === undefined) continue
      const entries = (field: string, kind: HookKind) =>
        listOf(chain, field).flatMap((hook) => entriesOf(hook, kind))
      routes.push({
        method: "WS",
        path: reportPath(socket.path),
        hooks: [
          ...requestPhase(probesOf(frames, socket.path, "WS", true)),
          ...entries("authStages", "authenticate"),
          ...entries("derives", "derive"),
          ...entries("beforeHandle", "beforeHandle"),
          ...entries("onError", "onError"),
        ],
      })
    }
    const prefixes = new Set<string>(["/"])
    const collect = (server: object): void => {
      for (const adoption of adoptionsOf(server)) {
        if (adoption.prefix !== undefined) prefixes.add(adoption.prefix)
        collect(adoption.source)
      }
    }
    collect(frame.server)
    const mounts = listOf(frame.server, "fetchMounts").flatMap((candidate) => {
      const mount = recordOf(candidate)
      return typeof mount?.path === "string"
        ? [{ path: mount.path, app: mount.app, stripPrefix: mount.stripPrefix === true }]
        : []
    })
    for (const prefix of prefixes) {
      const probePath = `${prefix === "/" ? "" : prefix}/${UNMATCHED_PROBE}`
      const probes = probesOf(frames, probePath, "GET", false)
      unmatched.push({
        prefix: reportPath(prefix),
        hooks: [...requestPhase(probes), ...responsePhase(probes)],
      })
    }
    for (const { path, ...mount } of mounts) {
      // A server already on this request's path (a self-mount, or two servers mounting each other)
      // is listed like a plain fetch mount: followed, the walk would never end.
      const cyclic = frames.some((outer) => outer.server === mount.app)
      if (isServerRecord(mount.app) && !cyclic) {
        const child = mount.app
        if (!labels.has(child)) {
          const context = `mount ${reportPath(path)}`
          labels.set(child, context)
          label(child, context)
        }
        const next = { server: child, base: mount.stripPrefix ? path : "" }
        visit([...frames, next], next)
      } else {
        const probes = probesOf(frames, `${path}/${UNMATCHED_PROBE}`, "GET", false)
        unmatched.push({
          prefix: reportPath(path),
          hooks: [...requestPhase(probes), ...responsePhase(probes)],
        })
      }
    }
  }
  const root = { server: source, base: "" }
  visit([root], root)
  const byPath = (a: { readonly path: string }, b: { readonly path: string }) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  routes.sort((a, b) => byPath(a, b) || (a.method < b.method ? -1 : a.method > b.method ? 1 : 0))
  unmatched.sort((a, b) => byPath({ path: a.prefix }, { path: b.prefix }))
  return { complete, routes, unmatched }
}

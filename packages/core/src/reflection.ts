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
  staticHeadersOf,
} from "./internal/hook-origins.ts"
import {
  type AssuranceEvidence,
  evidenceProvenance,
  validEvidence,
} from "./internal/route-assurance.ts"
import { NIFRA_BACKEND_EVIDENCE } from "./mount.ts"
import type { StandardSchemaV1 } from "./schema/standard.ts"
import type { ToolAnnotations } from "./server/server.ts"

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
}

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
 */
export function reflectSchema(value: unknown): SchemaReflection {
  const standard = standardOf(value)
  const jsonSchema = jsonSchemaOf(value, standard)
  const mediaTypes = mediaTypesOf(value)
  return {
    standard,
    jsonSchema,
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

const reflectedRouteSchema = (value: unknown): ReflectedRouteSchema | undefined => {
  const schema = recordOf(value)
  if (schema === undefined) return undefined
  const errors = recordOf(schema.errors)
  const reflectedErrors: Record<string, SchemaReflection> = {}
  if (errors !== undefined) {
    for (const [status, errorSchema] of Object.entries(errors)) {
      reflectedErrors[status] = reflectSchema(errorSchema)
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
    ...(schema.response !== undefined ? { response: reflectSchema(schema.response) } : {}),
    ...(Object.keys(reflectedErrors).length > 0 ? { errors: reflectedErrors } : {}),
    ...(schema.sse !== undefined ? { sse: reflectSchema(schema.sse) } : {}),
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

/**
 * Safely enumerate and normalize route descriptors from an app or descriptor array. Invalid entries
 * are ignored; a missing/throwing `routes()` method yields an empty array.
 */
export function reflectRoutes(source: unknown): readonly ReflectedRoute[] {
  const reflected: ReflectedRoute[] = []
  for (const candidate of routeCandidates(source)) {
    const route = recordOf(candidate)
    if (typeof route?.method !== "string" || typeof route.path !== "string") continue
    const schema = reflectedRouteSchema(route.schema)
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
  return reflected
}

/** A mounted child (`mount()`, `mountFetch()`) whose routes route reflection cannot see. */
export interface ReflectedMount {
  /** The mount prefix with `/*`: the child serves every path under it. */
  readonly path: string
  /** Why the child is not analyzed, as declared by `opaque` on the mount. */
  readonly opaque?: string
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
    const opaque = typeof mount.opaque === "string" ? mount.opaque.trim() || undefined : undefined
    reflected.push(
      Object.freeze({
        path: mount.path === "/" ? "/*" : `${mount.path}/*`,
        ...(opaque !== undefined ? { opaque } : {}),
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
  /** Where it was registered: `app`, `group /api`, `merge #1`, `mount /auth`, or `unknown`. */
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

/**
 * Every hook that actually runs for each route, and for each prefix's unmatched paths, with the plugin
 * that registered it and where: the app, a `group()`, a `merge()`d server, or a `mount()`ed one. It
 * follows the same scope rules the server applies - a group's hooks cover its prefix, a merged server's
 * request hooks cover only its own routes, a mount runs its child's whole lifecycle inside the app's
 * global hooks - and reads the provenance a development load records, so reflect the app outside
 * production. Anything that is not a nifra server yields an empty report.
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
      routes.push({
        method: route.method,
        path: reportPath(route.path),
        hooks: [
          ...requestPhase(probes),
          ...chain("around", "around"),
          ...chain("authStages", "authenticate"),
          ...chain("derives", "derive"),
          ...chain("beforeHandle", "beforeHandle"),
          ...chain("afterHandle", "afterHandle"),
          ...chain("onError", "onError"),
          ...responsePhase(probes),
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
      if (isServerRecord(mount.app)) {
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

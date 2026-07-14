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
import { type AssuranceEvidence, validEvidence } from "./internal/route-assurance.ts"
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
}

export interface ReflectedRouteSchema {
  readonly body?: SchemaReflection
  readonly query?: SchemaReflection
  readonly response?: SchemaReflection
  readonly errors?: Readonly<Record<string, SchemaReflection>>
  /** The SSE event-payload schema of a typed streaming route (`app.sse()`). */
  readonly sse?: SchemaReflection
}

export interface ReflectedRoute {
  readonly method: string
  readonly path: string
  readonly schema?: ReflectedRouteSchema
  readonly assurance?: readonly AssuranceEvidence[]
  readonly capabilities?: readonly string[]
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

/**
 * Reflect a Standard Schema, Nifra/TypeBox schema carrier, or raw JSON Schema. Never throws.
 * Validation-only schemas have `standard` but no `jsonSchema`; raw JSON Schema has the reverse.
 */
export function reflectSchema(value: unknown): SchemaReflection {
  const standard = standardOf(value)
  const jsonSchema = jsonSchemaOf(value, standard)
  return { standard, jsonSchema, fields: fieldsOf(jsonSchema) }
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
    ...(schema.body !== undefined ? { body: reflectSchema(schema.body) } : {}),
    ...(schema.query !== undefined ? { query: reflectSchema(schema.query) } : {}),
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
  const evidence = value
    .filter(validEvidence)
    .map((item) => Object.freeze({ id: item.id, source: item.source.trim() }))
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
      ...(assurance !== undefined ? { assurance } : {}),
      ...(capabilities.length > 0 ? { capabilities } : {}),
      ...(classification !== undefined ? { classification } : {}),
      ...(tool !== undefined ? { tool } : {}),
    })
  }
  return reflected
}

/**
 * API breaking-change detection over route reflection.
 *
 * `snapshotRoutes` turns an app (or reflected descriptors) into a plain-JSON snapshot — the
 * `standard` validators are dropped, so a snapshot survives `JSON.stringify` and can be committed
 * as a CI baseline. `diffRouteSnapshots` compares two snapshots and classifies every change by
 * wire compatibility, direction-aware:
 *
 *   request direction (body/query — what clients SEND):  a new required field, a removed field, or
 *     a narrowed type breaks existing callers; widening (new optional field, enum superset,
 *     required→optional) is compatible.
 *   response direction (response/sse/errors — what clients RECEIVE): a removed field, a field made
 *     optional, or a widened type breaks existing readers; narrowing (new field, optional→required,
 *     enum subset) is compatible.
 *
 * The classifier FAILS CLOSED: a schema change it cannot prove compatible is reported as breaking.
 * Schemas without JSON Schema metadata (validation-only Standard Schemas) cannot be compared and
 * yield `info` — never a silent pass presented as proof.
 */

import {
  type JsonSchema,
  type ReflectedRoute,
  type ReflectedSchemaField,
  reflectRoutes,
} from "./reflection.ts"

/** One schema position in a snapshot: JSON Schema metadata only, no validator. */
export interface SchemaSnapshot {
  readonly jsonSchema?: JsonSchema
  readonly fields?: readonly ReflectedSchemaField[]
}

export interface RouteSnapshotSchema {
  readonly body?: SchemaSnapshot
  readonly query?: SchemaSnapshot
  readonly response?: SchemaSnapshot
  readonly sse?: SchemaSnapshot
  readonly errors?: Readonly<Record<string, SchemaSnapshot>>
}

/** One route in a snapshot — plain JSON, safe to persist as a CI baseline. */
export interface RouteSnapshot {
  readonly method: string
  readonly path: string
  readonly schema?: RouteSnapshotSchema
}

export type DiffSeverity = "breaking" | "compatible" | "info"

export interface RouteChange {
  readonly severity: DiffSeverity
  readonly method: string
  readonly path: string
  /** Which part of the contract changed; "route" for add/remove of the whole route. */
  readonly section: "route" | "body" | "query" | "response" | "sse" | "errors"
  /** The top-level field (or error status) the change is about, when field-granular. */
  readonly field?: string
  readonly message: string
}

export interface RoutesDiff {
  readonly changes: readonly RouteChange[]
  /** True when any change is `breaking` — the CI-gate signal. */
  readonly hasBreaking: boolean
}

const schemaSnapshot = (
  reflection:
    | {
        readonly jsonSchema?: JsonSchema | undefined
        readonly fields?: readonly ReflectedSchemaField[] | undefined
      }
    | undefined,
): SchemaSnapshot | undefined => {
  if (reflection === undefined) return undefined
  return {
    ...(reflection.jsonSchema !== undefined ? { jsonSchema: reflection.jsonSchema } : {}),
    ...(reflection.fields !== undefined ? { fields: reflection.fields } : {}),
  }
}

/**
 * Snapshot an app's routes (anything `reflectRoutes` accepts) as plain JSON. Validators are
 * dropped; only introspectable JSON Schema metadata is kept, so the result round-trips through
 * `JSON.stringify` unchanged.
 */
export function snapshotRoutes(source: unknown): readonly RouteSnapshot[] {
  return reflectRoutes(source).map((route) => snapshotRoute(route))
}

const snapshotRoute = (route: ReflectedRoute): RouteSnapshot => {
  const schema = route.schema
  if (schema === undefined) return { method: route.method, path: route.path }
  const errors: Record<string, SchemaSnapshot> = {}
  for (const [status, reflection] of Object.entries(schema.errors ?? {})) {
    const snapped = schemaSnapshot(reflection)
    if (snapped !== undefined) errors[status] = snapped
  }
  const body = schemaSnapshot(schema.body)
  const query = schemaSnapshot(schema.query)
  const response = schemaSnapshot(schema.response)
  const sse = schemaSnapshot(schema.sse)
  const snapped: RouteSnapshotSchema = {
    ...(body !== undefined ? { body } : {}),
    ...(query !== undefined ? { query } : {}),
    ...(response !== undefined ? { response } : {}),
    ...(sse !== undefined ? { sse } : {}),
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
  }
  return {
    method: route.method,
    path: route.path,
    ...(Object.keys(snapped).length > 0 ? { schema: snapped } : {}),
  }
}

type Direction = "request" | "response"

const jsonEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

const enumOf = (schema: JsonSchema | undefined): readonly unknown[] | undefined => {
  if (typeof schema !== "object" || schema === null) return undefined
  const candidate = (schema as { enum?: unknown }).enum
  return Array.isArray(candidate) ? candidate : undefined
}

const withoutEnum = (schema: JsonSchema): unknown => {
  if (typeof schema !== "object" || schema === null) return schema
  const { enum: _omitted, ...rest } = schema as Record<string, unknown>
  return rest
}

const isSuperset = (outer: readonly unknown[], inner: readonly unknown[]): boolean => {
  const keys = new Set(outer.map((value) => JSON.stringify(value)))
  return inner.every((value) => keys.has(JSON.stringify(value)))
}

/**
 * Compare two JSON Schemas for one position. Returns the change severity, or `undefined` when
 * they are equivalent. The only refinement proven compatible is an enum-only change in the
 * safe direction (request may widen, response may narrow); everything else fails closed.
 */
const compareJsonSchema = (
  direction: Direction,
  before: JsonSchema,
  after: JsonSchema,
): DiffSeverity | undefined => {
  if (jsonEqual(before, after)) return undefined
  const beforeEnum = enumOf(before)
  const afterEnum = enumOf(after)
  if (
    beforeEnum !== undefined &&
    afterEnum !== undefined &&
    jsonEqual(withoutEnum(before), withoutEnum(after))
  ) {
    const compatible =
      direction === "request"
        ? isSuperset(afterEnum, beforeEnum)
        : isSuperset(beforeEnum, afterEnum)
    return compatible ? "compatible" : "breaking"
  }
  return "breaking"
}

interface SectionContext {
  readonly method: string
  readonly path: string
  readonly section: RouteChange["section"]
  readonly direction: Direction
  readonly changes: RouteChange[]
}

const push = (
  ctx: SectionContext,
  severity: DiffSeverity,
  message: string,
  field?: string,
): void => {
  ctx.changes.push({
    severity,
    method: ctx.method,
    path: ctx.path,
    section: ctx.section,
    ...(field !== undefined ? { field } : {}),
    message,
  })
}

const fieldMap = (
  snapshot: SchemaSnapshot,
): ReadonlyMap<string, ReflectedSchemaField> | undefined => {
  if (snapshot.fields === undefined) return undefined
  return new Map(snapshot.fields.map((field) => [field.name, field]))
}

const diffFields = (ctx: SectionContext, before: SchemaSnapshot, after: SchemaSnapshot): void => {
  const beforeFields = fieldMap(before)
  const afterFields = fieldMap(after)
  if (beforeFields === undefined || afterFields === undefined) {
    // Non-object schemas: compare the whole JSON Schema in one step.
    const severity = compareJsonSchema(
      ctx.direction,
      before.jsonSchema as JsonSchema,
      after.jsonSchema as JsonSchema,
    )
    if (severity !== undefined) push(ctx, severity, `${ctx.section} schema changed`)
    return
  }
  for (const [name, beforeField] of beforeFields) {
    const afterField = afterFields.get(name)
    if (afterField === undefined) {
      // Request: strict validators reject payloads still sending the field. Response: readers lose it.
      push(ctx, "breaking", `field "${name}" removed`, name)
      continue
    }
    if (beforeField.required !== afterField.required) {
      const nowRequired = afterField.required
      const breaking = ctx.direction === "request" ? nowRequired : !nowRequired
      push(
        ctx,
        breaking ? "breaking" : "compatible",
        `field "${name}" is now ${nowRequired ? "required" : "optional"}`,
        name,
      )
    }
    const severity = compareJsonSchema(ctx.direction, beforeField.schema, afterField.schema)
    if (severity !== undefined) push(ctx, severity, `field "${name}" type changed`, name)
  }
  for (const [name, afterField] of afterFields) {
    if (beforeFields.has(name)) continue
    if (ctx.direction === "request") {
      push(
        ctx,
        afterField.required ? "breaking" : "compatible",
        `${afterField.required ? "required" : "optional"} field "${name}" added`,
        name,
      )
    } else {
      push(ctx, "compatible", `field "${name}" added`, name)
    }
  }
}

const diffSchemaSection = (
  ctx: SectionContext,
  before: SchemaSnapshot | undefined,
  after: SchemaSnapshot | undefined,
): void => {
  if (before === undefined && after === undefined) return
  if (before === undefined) {
    // A new request contract rejects payloads old clients send freely; a new response contract
    // only documents what was already returned.
    push(
      ctx,
      ctx.direction === "request" ? "breaking" : "compatible",
      `${ctx.section} schema added`,
    )
    return
  }
  if (after === undefined) {
    // Dropping a request contract loosens validation; dropping a response contract removes a
    // documented shape clients (and typed consumers) rely on.
    push(
      ctx,
      ctx.direction === "request" ? "compatible" : "breaking",
      `${ctx.section} schema removed`,
    )
    return
  }
  if (before.jsonSchema === undefined || after.jsonSchema === undefined) {
    // Validation-only schemas expose no JSON Schema metadata — nothing provable either way.
    if (before.jsonSchema !== after.jsonSchema || before.fields !== after.fields) {
      push(ctx, "info", `${ctx.section} schema is not introspectable — cannot verify compatibility`)
    }
    return
  }
  diffFields(ctx, before, after)
}

const diffErrors = (
  method: string,
  path: string,
  changes: RouteChange[],
  before: Readonly<Record<string, SchemaSnapshot>> | undefined,
  after: Readonly<Record<string, SchemaSnapshot>> | undefined,
): void => {
  const beforeEntries = before ?? {}
  const afterEntries = after ?? {}
  for (const [status, beforeSchema] of Object.entries(beforeEntries)) {
    const afterSchema = afterEntries[status]
    if (afterSchema === undefined) {
      // Clients parsing this structured error body lose a documented shape.
      changes.push({
        severity: "breaking",
        method,
        path,
        section: "errors",
        field: status,
        message: `error ${status} removed from the contract`,
      })
      continue
    }
    const ctx: SectionContext = { method, path, section: "errors", direction: "response", changes }
    if (beforeSchema.jsonSchema === undefined || afterSchema.jsonSchema === undefined) {
      if (!jsonEqual(beforeSchema, afterSchema)) {
        push(ctx, "info", `error ${status} schema is not introspectable`, status)
      }
      continue
    }
    const severity = compareJsonSchema("response", beforeSchema.jsonSchema, afterSchema.jsonSchema)
    if (severity !== undefined) push(ctx, severity, `error ${status} schema changed`, status)
  }
  for (const status of Object.keys(afterEntries)) {
    if (status in beforeEntries) continue
    changes.push({
      severity: "compatible",
      method,
      path,
      section: "errors",
      field: status,
      message: `error ${status} added to the contract`,
    })
  }
}

const routeKey = (route: RouteSnapshot): string => `${route.method.toUpperCase()} ${route.path}`

/**
 * Diff two route snapshots (`snapshotRoutes` output, possibly restored from JSON). Every change is
 * classified breaking/compatible/info; `hasBreaking` is the CI-gate bit.
 */
export function diffRouteSnapshots(
  before: readonly RouteSnapshot[],
  after: readonly RouteSnapshot[],
): RoutesDiff {
  const changes: RouteChange[] = []
  const afterByKey = new Map(after.map((route) => [routeKey(route), route]))
  const beforeKeys = new Set(before.map((route) => routeKey(route)))
  for (const beforeRoute of before) {
    const afterRoute = afterByKey.get(routeKey(beforeRoute))
    if (afterRoute === undefined) {
      changes.push({
        severity: "breaking",
        method: beforeRoute.method,
        path: beforeRoute.path,
        section: "route",
        message: "route removed",
      })
      continue
    }
    const method = beforeRoute.method
    const path = beforeRoute.path
    const beforeSchema = beforeRoute.schema ?? {}
    const afterSchema = afterRoute.schema ?? {}
    for (const section of ["body", "query"] as const) {
      diffSchemaSection(
        { method, path, section, direction: "request", changes },
        beforeSchema[section],
        afterSchema[section],
      )
    }
    for (const section of ["response", "sse"] as const) {
      diffSchemaSection(
        { method, path, section, direction: "response", changes },
        beforeSchema[section],
        afterSchema[section],
      )
    }
    diffErrors(method, path, changes, beforeSchema.errors, afterSchema.errors)
  }
  for (const afterRoute of after) {
    if (beforeKeys.has(routeKey(afterRoute))) continue
    changes.push({
      severity: "compatible",
      method: afterRoute.method,
      path: afterRoute.path,
      section: "route",
      message: "route added",
    })
  }
  return { changes, hasBreaking: changes.some((change) => change.severity === "breaking") }
}

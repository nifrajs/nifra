import { NIFRA_ASSURANCE } from "@nifrajs/core/assurance"
import type { ContractShape } from "@nifrajs/core/contract"
import { type ProjectEvidenceSnapshot, reflectedRoutesFromEvidence } from "@nifrajs/core/evidence"
import {
  compileRoutePattern,
  expandOptionalParams,
  type ParamConstraint,
  type RoutePatternSegment,
} from "@nifrajs/core/pattern"
import {
  type JsonSchema,
  type ReflectedRouteSchema,
  type ReflectedSchemaField,
  reflectRoutes,
  reflectSchema,
  type SchemaReflection,
} from "@nifrajs/core/reflection"
import type { Server } from "@nifrajs/core/server"
import { isRecord } from "./internal/record.ts"

/**
 * OpenAPI 3.1 generation. We model a practical slice of the spec - enough to feed Swagger UI / codegen
 * and to validate structurally: paths, parameters, request bodies, responses (incl. non-200 and
 * non-JSON), tags, security, servers, and `$ref` reuse via `components.schemas`.
 *
 * Schemas carry full detail for `t`/TypeBox schemas and for a Standard Schema that also implements
 * Standard JSON Schema (`~standard.jsonSchema`, as zod 4 does): requests are described by its input
 * side, responses by its output side. One that exposes neither validates at runtime but is emitted
 * without body/response detail. A **contract** is richest - its operations carry `response`, `tags`,
 * `security`, additional `responses`, etc.; an **app** emits request shapes + a generic `200` (an
 * inline handler has no response *schema* to serialize), enrichable via `options.operations`.
 *
 * Every operation also lists the errors the framework answers itself, as the shared `NifraError` /
 * `NifraValidationError` components: 400, 413 and 415 for a body, 422 for any request schema (left out
 * when an `onValidationError` hook writes that body), 404 for a path whose parameter has a pattern a
 * value can miss, 429 where `rateLimit()` covers the route, and 500 for a handler that throws. A
 * declared response wins.
 *
 * A query list is read from repeated keys (`?tag=a&tag=b`), declared as `style: form, explode: true`;
 * `?tag=a,b` is the one value `"a,b"`. A boolean read by `t.query`, `t.headers` or `t.cookies` also
 * accepts `1`/`0` and either case, which `x-nifra-boolean-literals` lists.
 * A union whose members all pin one required property to distinct values becomes a `oneOf` with a
 * `discriminator`, so a generator can emit a tagged union instead of trying each member in turn.
 *
 * A typed SSE route (`app.sse()`) answers `text/event-stream`, and its event payload becomes a named
 * component (`<OperationId>Event`, or one named after the path) so a client generator emits a type
 * for it. With `openapiVersion: "3.2.0"` the media type carries the standard `itemSchema` describing
 * each event; a 3.1 document has no field for that, so it carries the same schema as `x-itemSchema`.
 */
export interface OpenAPIInfo {
  readonly title: string
  readonly version: string
  readonly description?: string
}

export interface OpenAPIServer {
  readonly url: string
  readonly description?: string
}

export interface OpenAPITag {
  readonly name: string
  readonly description?: string
}

/** A document-wide / per-operation security requirement: scheme name → required scopes. */
export type SecurityRequirement = Readonly<Record<string, readonly string[]>>

export interface ToOpenAPIOptions {
  /** The OpenAPI version to declare. `"3.2.0"` describes SSE events with the standard `itemSchema`. */
  readonly openapiVersion?: OpenAPIVersion
  readonly title?: string
  readonly version?: string
  readonly description?: string
  /** Server URLs the API is served from (OpenAPI `servers`). */
  readonly servers?: readonly OpenAPIServer[]
  /** Tag definitions (OpenAPI top-level `tags`) - names referenced by an operation's `tags`. */
  readonly tags?: readonly OpenAPITag[]
  /** Reusable security schemes → `components.securitySchemes` (e.g. `{ bearer: { type: "http", scheme: "bearer" } }`). */
  readonly securitySchemes?: Readonly<Record<string, Record<string, unknown>>>
  /** Document-wide security requirement; a per-operation `security` (incl. `[]` for public) overrides it. */
  readonly security?: readonly SecurityRequirement[]
  /**
   * Reuse a canonical token-only route-evidence pass. This is useful for build artifacts and CLI
   * projections that already evaluated the project; it never supplies runtime validators.
   */
  readonly evidence?: ProjectEvidenceSnapshot
  /**
   * Per-operation overrides, shallow-merged over the generated operation. Keyed by `operationId`
   * (contract op name) or `"METHOD /path"` (e.g. `"GET /users/:id"`). The escape hatch for detail that
   * can't be introspected - richer response bodies, examples, app-route tags/security.
   */
  readonly operations?: Readonly<Record<string, Record<string, unknown>>>
  /**
   * Optional build-time response schemas inferred from TypeScript declarations. Keys are
   * `METHOD /path` (for example `GET /users/:id`), and explicit route/contract schemas always win.
   * This is inert OpenAPI metadata: it never enables runtime response validation.
   */
  readonly inferredResponses?: Readonly<
    Record<
      string,
      Readonly<
        Record<
          string,
          {
            readonly description?: string
            readonly schema?: JsonSchema
            readonly contentType?: string
          }
        >
      >
    >
  >
}

interface OpenAPIParameter {
  readonly name: string
  readonly in: "path" | "query" | "header" | "cookie"
  readonly required: boolean
  readonly schema: JsonSchema
  readonly style?: "form"
  readonly explode?: true
  readonly "x-nifra-boolean-literals"?: typeof BOOLEAN_LITERALS
}

/**
 * The text a coercing schema (`t.query`, `t.headers`, `t.cookies`) reads as a boolean: TypeBox's
 * `Value.Convert`, which it coerces with. Anything else, `yes` or an empty value, is a 422.
 */
const BOOLEAN_LITERALS = Object.freeze({
  true: Object.freeze(["true", "1"]),
  false: Object.freeze(["false", "0", "-0"]),
  caseInsensitive: true,
})

export type OpenAPIVersion = "3.1.0" | "3.2.0"

interface OpenAPIMediaType {
  readonly schema?: JsonSchema
  /** OpenAPI 3.2: the schema of each item of a sequential media type such as an event stream. */
  readonly itemSchema?: JsonSchema
  readonly "x-itemSchema"?: JsonSchema
}

interface OpenAPIRequestBody {
  readonly required: boolean
  readonly content: Record<string, OpenAPIMediaType>
}

interface OpenAPIHeader {
  readonly description?: string
  readonly schema: JsonSchema
}

interface OpenAPIResponse {
  description: string
  headers?: Record<string, OpenAPIHeader>
  content?: Record<string, OpenAPIMediaType>
}

interface OpenAPIOperation {
  operationId?: string
  summary?: string
  description?: string
  tags?: readonly string[]
  deprecated?: boolean
  security?: readonly SecurityRequirement[]
  parameters?: OpenAPIParameter[]
  requestBody?: OpenAPIRequestBody
  responses: Record<string, OpenAPIResponse>
}

interface OpenAPIComponents {
  schemas?: Record<string, JsonSchema>
  securitySchemes?: Readonly<Record<string, Record<string, unknown>>>
}

export interface OpenAPIDocument {
  readonly openapi: OpenAPIVersion
  readonly info: OpenAPIInfo
  readonly paths: Record<string, Record<string, OpenAPIOperation>>
  readonly servers?: readonly OpenAPIServer[]
  readonly tags?: readonly OpenAPITag[]
  readonly security?: readonly SecurityRequirement[]
  readonly components?: OpenAPIComponents
}

type SchemaRecord = Readonly<Record<string, unknown>>

const recordOf = (value: unknown): SchemaRecord | undefined => (isRecord(value) ? value : undefined)

// Plain assignment would run the `__proto__` setter for a key spelled that way.
const setOwn = (target: Record<string, unknown>, key: string, value: unknown): void => {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

// Keywords whose values are data, and keywords whose keys are names; a walk reads neither as keywords.
const DATA_KEYWORDS: ReadonlySet<string> = new Set([
  "const",
  "default",
  "enum",
  "example",
  "examples",
])
const NAME_MAPS: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
])

function mapValues(
  record: SchemaRecord,
  map: (value: unknown) => unknown,
): SchemaRecord | undefined {
  let copy: Record<string, unknown> | undefined
  for (const [key, value] of Object.entries(record)) {
    const next = map(value)
    if (next === value) continue
    copy ??= { ...record }
    setOwn(copy, key, next)
  }
  return copy
}

type Visit = (schema: SchemaRecord) => SchemaRecord

/** `node` rebuilt bottom-up through `visit`, copying only the nodes that change. */
function mapSchema(node: unknown, visit: Visit): unknown {
  if (Array.isArray(node)) {
    const next = node.map((item) => mapSchema(item, visit))
    return next.some((item, index) => item !== node[index]) ? next : node
  }
  return isRecord(node) ? mapSchemaRecord(node, visit) : node
}

function mapSchemaRecord(record: SchemaRecord, visit: Visit): SchemaRecord {
  let changed: Record<string, unknown> | undefined
  for (const [key, value] of Object.entries(record)) {
    if (DATA_KEYWORDS.has(key)) continue
    const names = NAME_MAPS.has(key) ? recordOf(value) : undefined
    const next =
      names === undefined
        ? mapSchema(value, visit)
        : (mapValues(names, (entry) => mapSchema(entry, visit)) ?? names)
    if (next === value) continue
    changed ??= { ...record }
    setOwn(changed, key, next)
  }
  return visit(changed ?? record)
}

const DEFINITION_REF = /^#\/\$defs\/([^/]*)((?:\/.*)?)$/

/** A `#` pointer into the schema's own root: not into its `$defs`, and not a document `components` ref. */
const isRootRef = (ref: string): boolean =>
  (ref === "#" || ref.startsWith("#/")) &&
  !DEFINITION_REF.test(ref) &&
  !ref.startsWith("#/components/")

const pointerToken = (token: string): string => token.replaceAll("~1", "/").replaceAll("~0", "~")

/** The `$defs` keys a node refers to through `#/$defs/<key>`. */
function definitionRefs(node: unknown): string[] {
  const keys: string[] = []
  mapSchema(node, (schema) => {
    const match = typeof schema.$ref === "string" ? DEFINITION_REF.exec(schema.$ref) : null
    if (match !== null) keys.push(pointerToken(match[1] ?? ""))
    return schema
  })
  return keys
}

/** Whether a node points into its own root (`#`, `#/properties/...`). */
function refersToRoot(node: unknown): boolean {
  let found = false
  mapSchema(node, (schema) => {
    if (typeof schema.$ref === "string" && isRootRef(schema.$ref)) found = true
    return schema
  })
  return found
}

/** `key`'s definition and every definition it reaches, keyed and sorted: equal means interchangeable. */
function definitionClosure(key: string, defs: SchemaRecord): string {
  const reached = new Set([key])
  const pending = [key]
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const ref of definitionRefs(defs[next])) {
      if (!reached.has(ref) && Object.hasOwn(defs, ref)) {
        reached.add(ref)
        pending.push(ref)
      }
    }
  }
  return JSON.stringify([key, [...reached].sort().map((name) => [name, defs[name]])])
}

const componentBase = (id: string): string =>
  /^[A-Za-z0-9._-]+$/.test(id)
    ? id
    : `Schema_${[...new TextEncoder().encode(id)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`

/**
 * Collects schemas that carry a `$id` into `components.schemas`, returning a `$ref` in their place -
 * so a schema used by N operations is emitted once. Schemas without a `$id` stay inline (the existing
 * behavior). The first sighting of an id wins; later ones just `$ref` it.
 */
class SchemaStore {
  readonly schemas: Record<string, JsonSchema> = {}
  private readonly componentNames = new Map<string, string>()
  private readonly componentIds = new Map<string, string>()
  // Names the generator chose itself; a user `$id` spelled the same must not resolve to one of them.
  private readonly reserved = new Set<string>()
  private readonly definitionNames = new Map<string, string>()
  private readonly rootNames = new Map<string, string>()
  private readonly sharedRefs = new Map<string, JsonSchema>()

  private taken(name: string): boolean {
    return (
      Object.hasOwn(this.schemas, name) || this.componentIds.has(name) || this.reserved.has(name)
    )
  }

  private freeName(base: string): string {
    let name = base
    let suffix = 2
    while (this.taken(name)) {
      name = `${base}_${suffix}`
      suffix += 1
    }
    this.reserved.add(name)
    return name
  }

  private componentName(id: string): string {
    const known = this.componentNames.get(id)
    if (known !== undefined) return known
    const base = componentBase(id)
    let name = base
    let suffix = 2
    while (
      (this.componentIds.has(name) && this.componentIds.get(name) !== id) ||
      this.reserved.has(name)
    ) {
      name = `${base}_${suffix}`
      suffix += 1
    }
    this.componentNames.set(id, name)
    this.componentIds.set(name, id)
    return name
  }

  /**
   * `schema` without its dialect and `$defs`, each definition kept as a component and every
   * `#/$defs/...` ref pointed at it: inside an OpenAPI document a `#` pointer resolves against the
   * document, so a definition left in place is unreachable. A root that refers to itself (`#`) is
   * kept as a component too, and a `$ref` to it comes back in its place.
   */
  private withoutDefinitions(schema: SchemaRecord): SchemaRecord {
    const selfReferent = refersToRoot(schema)
    if (!selfReferent && !Object.hasOwn(schema, "$schema") && !Object.hasOwn(schema, "$defs"))
      return schema
    const { $schema: _dialect, $defs, ...rest } = schema
    const defs = recordOf($defs) ?? {}
    const names = new Map<string, string>()
    for (const key of Object.keys(defs)) {
      const signature = definitionClosure(key, defs)
      let name = this.definitionNames.get(signature)
      if (name === undefined) {
        name = this.freeName(componentBase(key))
        this.definitionNames.set(signature, name)
      }
      names.set(key, name)
    }
    let root: string | undefined
    if (selfReferent) {
      const signature = JSON.stringify(schema)
      root =
        typeof rest.$id === "string"
          ? this.componentName(rest.$id)
          : (this.rootNames.get(signature) ?? this.freeName("Schema"))
      this.rootNames.set(signature, root)
    }
    const rewriteRef: Visit = (current) => {
      const ref = current.$ref
      if (typeof ref !== "string" || !ref.startsWith("#")) return current
      const match = DEFINITION_REF.exec(ref)
      if (match !== null) {
        const name = names.get(pointerToken(match[1] ?? ""))
        return name === undefined
          ? current
          : { ...current, $ref: `#/components/schemas/${name}${match[2] ?? ""}` }
      }
      return root === undefined || !isRootRef(ref)
        ? current
        : { ...current, $ref: `#/components/schemas/${root}${ref.slice(1)}` }
    }
    for (const [key, name] of names) {
      if (!Object.hasOwn(this.schemas, name)) {
        const definition = defs[key]
        if (typeof definition === "boolean") setOwn(this.schemas, name, definition)
        else if (isRecord(definition))
          setOwn(this.schemas, name, mapSchemaRecord(definition, rewriteRef))
      }
    }
    const local = mapSchemaRecord(rest, rewriteRef)
    // A root with a `$id` is hoisted under that name by `collect`, like any other.
    if (root === undefined || typeof local.$id === "string") return local
    if (!Object.hasOwn(this.schemas, root)) setOwn(this.schemas, root, local)
    return { $ref: `#/components/schemas/${root}` }
  }

  /** Hoist a schema with a `$id` into components + return a `$ref`; otherwise return it inline. */
  collect(schema: JsonSchema | undefined): JsonSchema | undefined {
    if (schema === undefined) return undefined
    if (typeof schema === "boolean") return schema
    const local = this.withoutDefinitions(schema)
    const id = typeof local.$id === "string" ? local.$id : undefined
    if (id === undefined) return local
    const componentName = this.componentName(id)
    if (!Object.hasOwn(this.schemas, componentName)) {
      const hoisted = { ...local }
      delete hoisted.$id // the component key is the name; drop the redundant base-URI hint
      setOwn(this.schemas, componentName, hoisted)
    }
    return { $ref: `#/components/schemas/${componentName}` }
  }

  /** Keep `schema` as a component named after `base` (deduped), unless it is one already. */
  named(base: string, schema: JsonSchema): JsonSchema {
    const collected = this.collect(schema) ?? schema
    if (typeof collected === "object" && typeof collected.$ref === "string") return collected
    const name = this.freeName(base)
    setOwn(this.schemas, name, collected)
    return { $ref: `#/components/schemas/${name}` }
  }

  /** One component for a schema the generator itself contributes, added on first use. */
  shared(base: string, schema: JsonSchema): JsonSchema {
    const known = this.sharedRefs.get(base)
    if (known !== undefined) return known
    const ref = this.named(base, schema)
    this.sharedRefs.set(base, ref)
    return ref
  }

  /** A parameter schema's fields, read through the same `$defs` hoisting as a body schema. */
  fields(schema: SchemaReflection | undefined): readonly ReflectedSchemaField[] | undefined {
    const json = recordOf(schema?.jsonSchema)
    if (schema?.fields === undefined || json === undefined || !Object.hasOwn(json, "$defs"))
      return schema?.fields
    const properties = recordOf(this.withoutDefinitions(json).properties) ?? {}
    return schema.fields.map((field) => {
      const hoisted = properties[field.name]
      return typeof hoisted === "boolean" || isRecord(hoisted)
        ? { ...field, schema: hoisted }
        : field
    })
  }
}

interface PathParameter {
  readonly name: string
  readonly constraint: ParamConstraint | undefined
}

/**
 * `/users/:id/*rest` as `/users/{id}/{rest}`, with its params in order. Split by the router's own
 * compiler, so names and constraints end where the router ends them.
 */
function templatedPath(path: string): {
  readonly template: string
  readonly parameters: readonly PathParameter[]
} {
  const parameters: PathParameter[] = []
  const take = (name: string, constraint?: ParamConstraint): string => {
    parameters.push({ name, constraint })
    return `{${name}}`
  }
  let segments: readonly RoutePatternSegment[]
  try {
    segments = compileRoutePattern(path).segments
  } catch {
    return { template: path, parameters }
  }
  const template = segments
    .map((segment) =>
      segment.kind === "static"
        ? segment.value
        : segment.kind === "param"
          ? take(segment.name)
          : segment.kind === "wildcard"
            ? take(segment.name === "*" ? "wildcard" : segment.name)
            : segment.parts
                .map((part) => (part.t === "lit" ? part.v : take(part.name, part.c)))
                .join(""),
    )
    .join("/")
  return { template: `/${template}`, parameters }
}

type Fields = readonly ReflectedSchemaField[] | undefined

const typeOf = (schema: JsonSchema): unknown => (isRecord(schema) ? schema.type : undefined)

/** Whether a field reads booleans: a boolean, or a list of them. */
const readsBoolean = (schema: JsonSchema): boolean =>
  typeOf(schema) === "boolean" ||
  (typeOf(schema) === "array" &&
    isRecord(schema) &&
    typeOf(recordOf(schema.items) ?? {}) === "boolean")

function pathParameters(path: string, paramsFields: Fields): OpenAPIParameter[] {
  // Build a lookup of per-field schemas from the declared params schema (if any).
  const fieldSchemas = new Map<string, JsonSchema>()
  if (paramsFields !== undefined) {
    for (const field of paramsFields) {
      fieldSchemas.set(field.name, field.schema)
    }
  }
  // A declared field schema (uuid format, integer type, etc.) wins. Without one, a constraint in
  // the path says what the router accepts; without either, the parameter is any string.
  return templatedPath(path).parameters.map(({ name, constraint }) => ({
    name,
    in: "path",
    required: true,
    schema:
      fieldSchemas.get(name) ??
      (constraint === undefined
        ? { type: "string" }
        : constraint.oneOf === undefined
          ? { type: "string", pattern: `^${constraint.source}$` }
          : { type: "string", enum: constraint.oneOf }),
  }))
}

/**
 * The query, header or cookie parameters `fields` declares, with how the server reads their text. A
 * header name is listed lowercase; a cookie name is case-sensitive, so it keeps its case.
 */
function valueParameters(
  fields: Fields,
  location: "query" | "header" | "cookie",
  coerces: boolean,
): OpenAPIParameter[] {
  // Only an introspectable object schema decomposes into individual parameters.
  if (fields === undefined) return []
  return fields.map((field) => {
    const parameter: { -readonly [K in keyof OpenAPIParameter]: OpenAPIParameter[K] } = {
      name: location === "header" ? field.name.toLowerCase() : field.name,
      in: location,
      required: field.required,
      schema: field.schema,
    }
    // The query parser collects repeated keys and never splits a value on commas.
    if (location === "query" && typeOf(field.schema) === "array") {
      parameter.style = "form"
      parameter.explode = true
    }
    if (coerces && readsBoolean(field.schema))
      parameter["x-nifra-boolean-literals"] = BOOLEAN_LITERALS
    return parameter
  })
}

interface OperationInput {
  readonly path: string
  readonly body: SchemaReflection | undefined
  readonly query: SchemaReflection | undefined
  readonly headers: SchemaReflection | undefined
  readonly cookies?: SchemaReflection | undefined
  /** Reflected params schema - per-field constraints merge into path parameters. */
  readonly params: SchemaReflection | undefined
  readonly response: SchemaReflection | undefined
  /** A typed SSE route's event payload schema. */
  readonly sse?: SchemaReflection | undefined
  /** An `onValidationError` hook writes this route's 422 body, so the default envelope is not it. */
  readonly validationErrorHook?: boolean | undefined
  /** `rateLimit()` covers the route, so it can answer 429. */
  readonly rateLimited?: boolean | undefined
  readonly operationId: string | undefined
  // `| undefined` (not just `?`) so a contract op's optional fields - `string | undefined` etc. - are
  // assignable under `exactOptionalPropertyTypes` when spread into this literal.
  readonly summary?: string | undefined
  readonly description?: string | undefined
  readonly tags?: readonly string[] | undefined
  readonly deprecated?: boolean | undefined
  readonly security?: readonly SecurityRequirement[] | undefined
  readonly requestContentType?: string | undefined
  readonly responseContentType?: string | undefined
  readonly responses?:
    | Readonly<
        Record<string, { description?: string; schema?: SchemaReflection; contentType?: string }>
      >
    | undefined
  readonly inferredResponses?:
    | Readonly<Record<string, { description?: string; schema?: JsonSchema; contentType?: string }>>
    | undefined
}

const STATUS_TEXT: Readonly<Record<string, string>> = {
  "400": "Bad Request",
  "401": "Unauthorized",
  "403": "Forbidden",
  "404": "Not Found",
  "405": "Method Not Allowed",
  "409": "Conflict",
  "410": "Gone",
  "413": "Content Too Large",
  "415": "Unsupported Media Type",
  "422": "Unprocessable Entity",
  "429": "Too Many Requests",
  "500": "Internal Server Error",
  "502": "Bad Gateway",
  "503": "Service Unavailable",
}

const ERROR_ENVELOPE: JsonSchema = {
  type: "object",
  required: ["ok", "error"],
  properties: { ok: { type: "boolean", const: false }, error: { type: "string" } },
}

const RETRY_AFTER: OpenAPIHeader = {
  description: "Seconds until the limit's window resets.",
  schema: { type: "integer", minimum: 0 },
}

const VALIDATION_ERROR_ENVELOPE: JsonSchema = {
  type: "object",
  required: ["ok", "error", "issues"],
  properties: {
    ok: { type: "boolean", const: false },
    error: { type: "string", const: "validation" },
    issues: {
      type: "array",
      // Core's 422 lists at most this many issues.
      maxItems: 100,
      items: {
        type: "object",
        required: ["message"],
        properties: {
          message: { type: "string" },
          path: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
}

/** The errors the framework answers for this operation itself, around whatever its handler returns. */
function frameworkResponses(
  input: OperationInput,
  store: SchemaStore,
): Record<string, OpenAPIResponse> {
  const responses: Record<string, OpenAPIResponse> = {}
  const answer = (
    status: string,
    component: string,
    schema: JsonSchema,
    headers?: Record<string, OpenAPIHeader>,
  ): void => {
    const response: OpenAPIResponse = {
      description: STATUS_TEXT[status] ?? "Error",
      content: { "application/json": { schema: store.shared(component, schema) } },
    }
    if (headers !== undefined) response.headers = headers
    responses[status] = response
  }
  if (input.body !== undefined) {
    answer("400", "NifraError", ERROR_ENVELOPE)
    answer("413", "NifraError", ERROR_ENVELOPE)
    answer("415", "NifraError", ERROR_ENVELOPE)
  }
  const validates = [input.body, input.query, input.params, input.headers, input.cookies].some(
    (schema) => schema !== undefined,
  )
  if (validates && input.validationErrorHook !== true)
    answer("422", "NifraValidationError", VALIDATION_ERROR_ENVELOPE)
  // A value outside a parameter's pattern matches no route, so the router answers it.
  if (templatedPath(input.path).parameters.some((parameter) => parameter.constraint !== undefined))
    answer("404", "NifraError", ERROR_ENVELOPE)
  if (input.rateLimited === true)
    answer("429", "NifraError", ERROR_ENVELOPE, { "Retry-After": RETRY_AFTER })
  answer("500", "NifraError", ERROR_ENVELOPE)
  return responses
}

function reflectedErrorsToResponses(
  errors: ReflectedRouteSchema["errors"],
): OperationInput["responses"] {
  if (errors === undefined) return undefined
  const out: Record<string, { description?: string; schema?: SchemaReflection }> = {}
  for (const [status, reflection] of Object.entries(errors)) {
    if (reflection.jsonSchema !== undefined || reflection.standard !== undefined) {
      out[status] = { description: STATUS_TEXT[status] ?? "Error", schema: reflection }
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function sseComponentName(input: OperationInput): string {
  if (input.operationId !== undefined && /^[A-Za-z0-9._-]+$/.test(input.operationId))
    return `${input.operationId}Event`
  const words = input.path
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => `${word[0]?.toUpperCase()}${word.slice(1)}`)
  return `${words.join("") || "Root"}Event`
}

/** OAS 3.2 4.14.4's event shape, with `data` carrying JSON that matches the route's payload schema. */
function sseItemSchema(payload: JsonSchema | undefined): JsonSchema {
  return {
    type: "object",
    required: ["data"],
    properties: {
      data:
        payload === undefined
          ? { type: "string" }
          : { type: "string", contentMediaType: "application/json", contentSchema: payload },
      event: { type: "string" },
      id: { type: "string" },
      retry: { type: "integer", minimum: 0 },
    },
  }
}

function buildResponses(
  input: OperationInput,
  store: SchemaStore,
  version: OpenAPIVersion,
): Record<string, OpenAPIResponse> {
  const responses: Record<string, OpenAPIResponse> = {}
  if (input.sse !== undefined) {
    const payload =
      input.sse.jsonSchema === undefined
        ? undefined
        : store.named(sseComponentName(input), input.sse.jsonSchema)
    const item = sseItemSchema(payload)
    responses["200"] = {
      description: "Server-Sent Events",
      content: {
        "text/event-stream":
          version === "3.2.0"
            ? { itemSchema: item }
            : { schema: { type: "string" }, "x-itemSchema": item },
      },
    }
  } else if (input.response !== undefined) {
    const schema = store.collect(input.response.jsonSchema)
    responses["200"] =
      schema !== undefined
        ? {
            description: "OK",
            content: { [input.responseContentType ?? "application/json"]: { schema } },
          }
        : { description: "OK" }
  } else {
    responses["200"] = { description: "OK" }
  }
  Object.assign(responses, frameworkResponses(input, store))
  // Additional (or overriding) responses declared on the contract op.
  if (input.responses !== undefined) {
    for (const [status, def] of Object.entries(input.responses)) {
      const response: OpenAPIResponse = { description: def.description ?? "" }
      const schema = def.schema !== undefined ? store.collect(def.schema.jsonSchema) : undefined
      if (schema !== undefined)
        response.content = { [def.contentType ?? "application/json"]: { schema } }
      responses[status] = response
    }
  }
  // Build-time TypeScript inference is an additive documentation convenience. Explicit route and
  // contract schemas above remain authoritative for both status and body details.
  if (input.inferredResponses !== undefined) {
    for (const [status, definition] of Object.entries(input.inferredResponses)) {
      if (!/^[1-5][0-9]{2}$/.test(status) || responses[status] !== undefined) continue
      const response: OpenAPIResponse = {
        description: definition.description ?? STATUS_TEXT[status] ?? "Response",
      }
      const schema = store.collect(definition.schema)
      if (schema !== undefined) {
        response.content = {
          [definition.contentType ?? "application/json"]: { schema },
        }
      }
      responses[status] = response
    }
  }
  return responses
}

const isBinary = (schema: unknown): boolean =>
  typeof schema === "object" &&
  schema !== null &&
  (schema as { type?: unknown }).type === "string" &&
  (schema as { format?: unknown }).format === "binary"

/**
 * Whether a body schema declares a file field (a binary string, or a list of them) - the shape
 * `t.form` produces. JSON cannot carry a file, so such a body is `multipart/form-data`. Read off
 * the plain JSON Schema so a document built from a stored evidence snapshot agrees with a live one.
 */
function hasFileField(schema: JsonSchema | undefined): boolean {
  if (typeof schema !== "object" || schema === null) return false
  const properties = (schema as { properties?: unknown }).properties
  if (typeof properties !== "object" || properties === null) return false
  return Object.values(properties).some(
    (property) =>
      isBinary(property) ||
      (typeof property === "object" &&
        property !== null &&
        isBinary((property as { items?: unknown }).items)),
  )
}

function buildOperation(
  input: OperationInput,
  store: SchemaStore,
  version: OpenAPIVersion,
): OpenAPIOperation {
  const operation: OpenAPIOperation = { responses: buildResponses(input, store, version) }
  if (input.operationId !== undefined) operation.operationId = input.operationId
  if (input.summary !== undefined) operation.summary = input.summary
  if (input.description !== undefined) operation.description = input.description
  if (input.tags !== undefined && input.tags.length > 0) operation.tags = input.tags
  if (input.deprecated === true) operation.deprecated = true
  if (input.security !== undefined) operation.security = input.security // `[]` ⇒ explicitly public

  const parameters = [
    ...pathParameters(input.path, store.fields(input.params)),
    ...valueParameters(store.fields(input.query), "query", input.query?.coerces === true),
    ...valueParameters(store.fields(input.headers), "header", input.headers?.coerces === true),
    ...valueParameters(store.fields(input.cookies), "cookie", input.cookies?.coerces === true),
  ]
  if (parameters.length > 0) operation.parameters = parameters

  if (input.body !== undefined) {
    const schema = store.collect(input.body.jsonSchema)
    if (schema !== undefined) {
      const contentType =
        input.requestContentType ??
        (hasFileField(input.body.jsonSchema) ? "multipart/form-data" : "application/json")
      const content: Record<string, { schema: typeof schema }> = { [contentType]: { schema } }
      // A body schema with a parser of its own reads those media types too: one entry each, in a
      // fixed order so a live document and one built from a stored snapshot are the same document.
      for (const type of [...(input.body.mediaTypes ?? [])].sort()) content[type] ??= { schema }
      operation.requestBody = { required: true, content }
    }
  }
  return operation
}

const PATH_ITEM_METHODS: ReadonlySet<string> = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
])

function addOperation(
  paths: Record<string, Record<string, OpenAPIOperation>>,
  method: string,
  input: OperationInput,
  store: SchemaStore,
  operations: ToOpenAPIOptions["operations"],
  version: OpenAPIVersion,
): void {
  // A path item has a field for each standard method and no place for any other, so a route
  // registered under a custom method is left out of the document. 3.2 added the `query` field;
  // a 3.1 document has none, so a QUERY route is left out of it too.
  const field = method.toLowerCase()
  if (!PATH_ITEM_METHODS.has(field) && !(field === "query" && version === "3.2.0")) return
  const templated = templatedPath(input.path).template
  const pathItem = paths[templated] ?? {}
  paths[templated] = pathItem
  let operation = buildOperation(input, store, version)
  // Shallow-merge an override keyed by operationId or "METHOD /path".
  const override =
    operations?.[input.operationId ?? ""] ?? operations?.[`${method.toUpperCase()} ${input.path}`]
  if (override !== undefined) operation = { ...operation, ...override } as OpenAPIOperation
  pathItem[field] = operation
}

/** The one string `member` pins property `name` to, by `const` or a one-value `enum`. */
function pinnedValue(member: SchemaRecord, name: string): string | undefined {
  const property = recordOf(recordOf(member.properties)?.[name])
  if (property === undefined) return undefined
  if (typeof property.const === "string") return property.const
  const values = property.enum
  return Array.isArray(values) && values.length === 1 && typeof values[0] === "string"
    ? values[0]
    : undefined
}

/** The property every member requires and pins to a value of its own, if there is one. */
function sharedTag(members: readonly SchemaRecord[]): string | undefined {
  for (const name of Object.keys(recordOf(members[0]?.properties) ?? {})) {
    const values = new Set<string>()
    const tags = members.every((member) => {
      const required = Array.isArray(member.required) && member.required.includes(name)
      const value = required ? pinnedValue(member, name) : undefined
      if (value === undefined || values.has(value)) return false
      values.add(value)
      return true
    })
    if (tags) return name
  }
  return undefined
}

const COMPONENT_REF = /^#\/components\/schemas\/([^/]+)$/

/**
 * A union whose members are told apart by one tag property, as a `oneOf`, plus a `discriminator` with
 * a `mapping` when every member is a component: distinct required tags make the members exclusive, so
 * `anyOf` and `oneOf` accept the same values.
 */
function discriminated(schema: SchemaRecord, components: SchemaRecord): SchemaRecord {
  const { oneOf, anyOf } = schema
  const members: readonly unknown[] | undefined =
    Array.isArray(oneOf) && anyOf === undefined
      ? oneOf
      : Array.isArray(anyOf) && oneOf === undefined
        ? anyOf
        : undefined
  if (members === undefined || members.length < 2 || schema.discriminator !== undefined)
    return schema
  const refs = members.map((member) => {
    const ref = recordOf(member)?.$ref
    return typeof ref === "string" ? COMPONENT_REF.exec(ref)?.[1] : undefined
  })
  const resolved = members.map((member, index) => {
    const name = refs[index]
    return recordOf(name === undefined ? member : components[name])
  })
  if (!resolved.every((member): member is SchemaRecord => member !== undefined)) return schema
  const tag = sharedTag(resolved)
  if (tag === undefined) return schema
  const { anyOf: _anyOf, oneOf: _oneOf, ...rest } = schema
  const named = refs.filter((name): name is string => name !== undefined)
  // A discriminator only selects components (OpenAPI 3.1 and 3.2 never consider inline members).
  if (named.length < refs.length) return { ...rest, oneOf: members }
  const mapping = Object.fromEntries(
    resolved.map((member, index) => [
      pinnedValue(member, tag),
      `#/components/schemas/${named[index]}`,
    ]),
  )
  return { ...rest, oneOf: members, discriminator: { propertyName: tag, mapping } }
}

/** Every schema in the document - parameters, bodies, responses, components - through `discriminated`. */
function discriminateDocument(
  paths: Record<string, Record<string, OpenAPIOperation>>,
  components: Record<string, JsonSchema>,
): void {
  const visit = (schema: JsonSchema): JsonSchema =>
    typeof schema === "boolean"
      ? schema
      : mapSchemaRecord(schema, (node) => discriminated(node, components))
  // Copies, never edits: a merged `options.operations` override may hand in the caller's own objects.
  const media = (content: Record<string, OpenAPIMediaType>): Record<string, OpenAPIMediaType> =>
    Object.fromEntries(
      Object.entries(content).map(([type, entry]) => [
        type,
        {
          ...entry,
          ...(entry.schema === undefined ? {} : { schema: visit(entry.schema) }),
          ...(entry.itemSchema === undefined ? {} : { itemSchema: visit(entry.itemSchema) }),
          ...(entry["x-itemSchema"] === undefined
            ? {}
            : { "x-itemSchema": visit(entry["x-itemSchema"]) }),
        },
      ]),
    )
  for (const [name, schema] of Object.entries(components)) setOwn(components, name, visit(schema))
  for (const pathItem of Object.values(paths)) {
    for (const operation of Object.values(pathItem)) {
      if (operation.parameters !== undefined) {
        operation.parameters = operation.parameters.map((parameter) => ({
          ...parameter,
          schema: visit(parameter.schema),
        }))
      }
      if (operation.requestBody !== undefined) {
        operation.requestBody = {
          ...operation.requestBody,
          content: media(operation.requestBody.content),
        }
      }
      if (operation.responses === undefined) continue
      operation.responses = Object.fromEntries(
        Object.entries(operation.responses).map(([status, response]) => [
          status,
          response.content === undefined
            ? response
            : { ...response, content: media(response.content) },
        ]),
      )
    }
  }
}

function isApp(input: ContractShape | Server): input is Server {
  // Duck-typed so @nifrajs/schema keeps @nifrajs/core a type-only dependency. A contract
  // is a plain record of operations; only a Server exposes a `routes()` method.
  return typeof (input as { routes?: unknown }).routes === "function"
}

/** Generate an OpenAPI 3.1 document from a contract or a running app. See the module doc for the detail model. */
export function toOpenAPI(
  input: ContractShape | Server,
  options: ToOpenAPIOptions = {},
): OpenAPIDocument {
  const paths: Record<string, Record<string, OpenAPIOperation>> = {}
  const store = new SchemaStore()
  const version = options.openapiVersion ?? "3.1.0"

  if (isApp(input)) {
    const routes =
      options.evidence === undefined
        ? reflectRoutes(input)
        : reflectedRoutesFromEvidence(options.evidence)
    for (const route of routes) {
      addOperation(
        paths,
        route.method,
        {
          path: route.path,
          body: route.schema?.body,
          query: route.schema?.query,
          headers: route.schema?.headers,
          cookies: route.schema?.cookies,
          params: route.schema?.params,
          // A route may now declare a `response` contract - emit it as the 200 body schema.
          response: route.schema?.response,
          sse: route.schema?.sse,
          validationErrorHook: route.schema?.validationErrorHook === true,
          rateLimited: route.assurance?.some(
            (evidence) =>
              evidence.id === NIFRA_ASSURANCE.RATE_LIMITED && evidence.provenance === "runtime",
          ),
          // …and an `errors` contract - emit each as a non-2xx response.
          responses: reflectedErrorsToResponses(route.schema?.errors),
          inferredResponses:
            options.inferredResponses?.[`${route.method.toUpperCase()} ${route.path}`],
          operationId: undefined,
        },
        store,
        options.operations,
        version,
      )
    }
  } else {
    for (const [name, op] of Object.entries(input)) {
      // A path ending in optional params is one operation per concrete path it serves. Operation ids
      // are unique in a document, so the contract name goes to the full path and the shorter ones
      // carry none; a shorter path declares only the parameters it has.
      const forms = expandOptionalParams(op.path)
      const responses =
        op.responses === undefined
          ? undefined
          : Object.fromEntries(
              Object.entries(op.responses).map(([status, response]) => {
                const { schema, ...metadata } = response
                return [
                  status,
                  {
                    ...metadata,
                    ...(schema === undefined ? {} : { schema: reflectSchema(schema, "output") }),
                  },
                ]
              }),
            )
      for (const path of forms) {
        addOperation(
          paths,
          op.method,
          {
            path,
            body: op.body === undefined ? undefined : reflectSchema(op.body),
            query: op.query === undefined ? undefined : reflectSchema(op.query),
            headers: op.headers === undefined ? undefined : reflectSchema(op.headers),
            cookies: op.cookies === undefined ? undefined : reflectSchema(op.cookies),
            params: op.params === undefined ? undefined : reflectSchema(op.params),
            response: op.response === undefined ? undefined : reflectSchema(op.response, "output"),
            operationId: path === forms[forms.length - 1] ? name : undefined,
            summary: op.summary,
            description: op.description,
            tags: op.tags,
            deprecated: op.deprecated,
            security: op.security,
            requestContentType: op.requestContentType,
            responseContentType: op.responseContentType,
            responses,
            inferredResponses:
              options.inferredResponses?.[`${op.method.toUpperCase()} ${path}`] ??
              options.inferredResponses?.[`${op.method.toUpperCase()} ${op.path}`],
          },
          store,
          options.operations,
          version,
        )
      }
    }
  }

  discriminateDocument(paths, store.schemas)
  const components: OpenAPIComponents = {}
  if (Object.keys(store.schemas).length > 0) components.schemas = store.schemas
  if (options.securitySchemes !== undefined) components.securitySchemes = options.securitySchemes

  return {
    openapi: version,
    info: {
      title: options.title ?? "API",
      version: options.version ?? "1.0.0",
      ...(options.description !== undefined ? { description: options.description } : {}),
    },
    paths,
    ...(options.servers !== undefined ? { servers: options.servers } : {}),
    ...(options.tags !== undefined ? { tags: options.tags } : {}),
    ...(options.security !== undefined ? { security: options.security } : {}),
    ...(Object.keys(components).length > 0 ? { components } : {}),
  }
}

/** Generate OpenAPI from an existing canonical project-evidence snapshot without loading a server. */
export function toOpenAPIFromEvidence(
  evidence: ProjectEvidenceSnapshot,
  options: Omit<ToOpenAPIOptions, "evidence"> = {},
): OpenAPIDocument {
  const app: unknown = {
    routes: () => reflectedRoutesFromEvidence(evidence),
  }
  // biome-ignore lint/plugin/noWidenThenAssert: toOpenAPI reads an app only through routes() (see isApp), which this shim supplies.
  return toOpenAPI(app as Server, { ...options, evidence })
}

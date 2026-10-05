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
  reflectRoutes,
  reflectSchema,
  type SchemaReflection,
} from "@nifrajs/core/reflection"
import type { Server } from "@nifrajs/core/server"

/**
 * OpenAPI 3.1 generation. We model a practical slice of the spec - enough to feed Swagger UI / codegen
 * and to validate structurally: paths, parameters, request bodies, responses (incl. non-200 and
 * non-JSON), tags, security, servers, and `$ref` reuse via `components.schemas`.
 *
 * Schemas carry full detail only for `t`/TypeBox inputs (they expose a JSON Schema); a BYO Standard
 * Schema validates at runtime but exposes no JSON Schema, so its route is emitted without body/response
 * detail. A **contract** is richest - its operations carry `response`, `tags`, `security`, additional
 * `responses`, etc.; an **app** emits request shapes + a generic `200` (an inline handler has no
 * response *schema* to serialize), enrichable via `options.operations`.
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
}

interface OpenAPIMediaType {
  readonly schema: JsonSchema
}

interface OpenAPIRequestBody {
  readonly required: boolean
  readonly content: Record<string, OpenAPIMediaType>
}

interface OpenAPIResponse {
  description: string
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
  readonly openapi: "3.1.0"
  readonly info: OpenAPIInfo
  readonly paths: Record<string, Record<string, OpenAPIOperation>>
  readonly servers?: readonly OpenAPIServer[]
  readonly tags?: readonly OpenAPITag[]
  readonly security?: readonly SecurityRequirement[]
  readonly components?: OpenAPIComponents
}

/**
 * Collects schemas that carry a `$id` into `components.schemas`, returning a `$ref` in their place -
 * so a schema used by N operations is emitted once. Schemas without a `$id` stay inline (the existing
 * behavior). The first sighting of an id wins; later ones just `$ref` it.
 */
class SchemaStore {
  readonly schemas: Record<string, JsonSchema> = {}
  private readonly componentNames = new Map<string, string>()
  private readonly componentIds = new Map<string, string>()

  private componentName(id: string): string {
    const known = this.componentNames.get(id)
    if (known !== undefined) return known
    const encoded = [...new TextEncoder().encode(id)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
    const base = /^[A-Za-z0-9._-]+$/.test(id) ? id : `Schema_${encoded}`
    let name = base
    let suffix = 2
    while (this.componentIds.has(name) && this.componentIds.get(name) !== id) {
      name = `${base}_${suffix}`
      suffix += 1
    }
    this.componentNames.set(id, name)
    this.componentIds.set(name, id)
    return name
  }

  /** Hoist a schema with a `$id` into components + return a `$ref`; otherwise return it inline. */
  collect(schema: JsonSchema | undefined): JsonSchema | undefined {
    if (schema === undefined) return undefined
    if (typeof schema === "boolean") return schema
    const id = typeof schema.$id === "string" ? schema.$id : undefined
    if (id === undefined) return schema
    const componentName = this.componentName(id)
    if (!Object.hasOwn(this.schemas, componentName)) {
      const hoisted = { ...schema }
      delete hoisted.$id // the component key is the name; drop the redundant base-URI hint
      Object.defineProperty(this.schemas, componentName, {
        value: hoisted,
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    return { $ref: `#/components/schemas/${componentName}` }
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

function pathParameters(path: string, paramsSchema?: SchemaReflection): OpenAPIParameter[] {
  // Build a lookup of per-field schemas from the declared params schema (if any).
  const fieldSchemas = new Map<string, JsonSchema>()
  if (paramsSchema?.fields !== undefined) {
    for (const field of paramsSchema.fields) {
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

function queryParameters(schema: SchemaReflection | undefined): OpenAPIParameter[] {
  if (schema === undefined) return []
  const fields = schema.fields
  // Only an introspectable object schema decomposes into individual query parameters.
  if (fields === undefined) return []
  return fields.map((field) => ({
    name: field.name,
    in: "query",
    required: field.required,
    schema: field.schema,
  }))
}

function headerParameters(schema: SchemaReflection | undefined): OpenAPIParameter[] {
  if (schema?.fields === undefined) return []
  return schema.fields.map((field) => ({
    name: field.name.toLowerCase(),
    in: "header" as const,
    required: field.required,
    schema: field.schema,
  }))
}

/** Cookie names are case-sensitive, so each declared field keeps its name as written. */
function cookieParameters(schema: SchemaReflection | undefined): OpenAPIParameter[] {
  if (schema?.fields === undefined) return []
  return schema.fields.map((field) => ({
    name: field.name,
    in: "cookie" as const,
    required: field.required,
    schema: field.schema,
  }))
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
  "415": "Unsupported Media Type",
  "422": "Unprocessable Entity",
  "429": "Too Many Requests",
  "500": "Internal Server Error",
  "502": "Bad Gateway",
  "503": "Service Unavailable",
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

function buildResponses(
  input: OperationInput,
  store: SchemaStore,
): Record<string, OpenAPIResponse> {
  const responses: Record<string, OpenAPIResponse> = {}
  if (input.response !== undefined) {
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

function buildOperation(input: OperationInput, store: SchemaStore): OpenAPIOperation {
  const operation: OpenAPIOperation = { responses: buildResponses(input, store) }
  if (input.operationId !== undefined) operation.operationId = input.operationId
  if (input.summary !== undefined) operation.summary = input.summary
  if (input.description !== undefined) operation.description = input.description
  if (input.tags !== undefined && input.tags.length > 0) operation.tags = input.tags
  if (input.deprecated === true) operation.deprecated = true
  if (input.security !== undefined) operation.security = input.security // `[]` ⇒ explicitly public

  const parameters = [
    ...pathParameters(input.path, input.params),
    ...queryParameters(input.query),
    ...headerParameters(input.headers),
    ...cookieParameters(input.cookies),
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
): void {
  // A path item has a field for each standard method and no place for any other, so a route
  // registered under a custom method is left out of the document.
  if (!PATH_ITEM_METHODS.has(method.toLowerCase())) return
  const templated = templatedPath(input.path).template
  const pathItem = paths[templated] ?? {}
  paths[templated] = pathItem
  let operation = buildOperation(input, store)
  // Shallow-merge an override keyed by operationId or "METHOD /path".
  const override =
    operations?.[input.operationId ?? ""] ?? operations?.[`${method.toUpperCase()} ${input.path}`]
  if (override !== undefined) operation = { ...operation, ...override } as OpenAPIOperation
  pathItem[method.toLowerCase()] = operation
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
          // …and an `errors` contract - emit each as a non-2xx response.
          responses: reflectedErrorsToResponses(route.schema?.errors),
          inferredResponses:
            options.inferredResponses?.[`${route.method.toUpperCase()} ${route.path}`],
          operationId: undefined,
        },
        store,
        options.operations,
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
                    ...(schema === undefined ? {} : { schema: reflectSchema(schema) }),
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
            response: op.response === undefined ? undefined : reflectSchema(op.response),
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
        )
      }
    }
  }

  const components: OpenAPIComponents = {}
  if (Object.keys(store.schemas).length > 0) components.schemas = store.schemas
  if (options.securitySchemes !== undefined) components.securitySchemes = options.securitySchemes

  return {
    openapi: "3.1.0",
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
  const app = {
    routes: () => reflectedRoutesFromEvidence(evidence),
  } as unknown as Server
  return toOpenAPI(app, { ...options, evidence })
}

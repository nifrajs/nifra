import type { ContractShape, Server, StandardSchemaV1 } from "@nifrajs/core"

/**
 * OpenAPI 3.1 generation. We model a practical slice of the spec — enough to feed Swagger UI / codegen
 * and to validate structurally: paths, parameters, request bodies, responses (incl. non-200 and
 * non-JSON), tags, security, servers, and `$ref` reuse via `components.schemas`.
 *
 * Schemas carry full detail only for `t`/TypeBox inputs (they expose a JSON Schema); a BYO Standard
 * Schema validates at runtime but exposes no JSON Schema, so its route is emitted without body/response
 * detail. A **contract** is richest — its operations carry `response`, `tags`, `security`, additional
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
  /** Tag definitions (OpenAPI top-level `tags`) — names referenced by an operation's `tags`. */
  readonly tags?: readonly OpenAPITag[]
  /** Reusable security schemes → `components.securitySchemes` (e.g. `{ bearer: { type: "http", scheme: "bearer" } }`). */
  readonly securitySchemes?: Readonly<Record<string, Record<string, unknown>>>
  /** Document-wide security requirement; a per-operation `security` (incl. `[]` for public) overrides it. */
  readonly security?: readonly SecurityRequirement[]
  /**
   * Per-operation overrides, shallow-merged over the generated operation. Keyed by `operationId`
   * (contract op name) or `"METHOD /path"` (e.g. `"GET /users/:id"`). The escape hatch for detail that
   * can't be introspected — richer response bodies, examples, app-route tags/security.
   */
  readonly operations?: Readonly<Record<string, Record<string, unknown>>>
}

type JsonSchema = Record<string, unknown>

interface OpenAPIParameter {
  readonly name: string
  readonly in: "path" | "query"
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

/** A Standard Schema that also carries a raw JSON Schema (i.e. a `t`/TypeBox schema). */
type WithJsonSchema = StandardSchemaV1 & { readonly jsonSchema: unknown }

function hasJsonSchema(schema: StandardSchemaV1): schema is WithJsonSchema {
  return (
    "jsonSchema" in schema &&
    (schema as { jsonSchema?: unknown }).jsonSchema !== undefined &&
    (schema as { jsonSchema?: unknown }).jsonSchema !== null
  )
}

/**
 * Extract clean JSON Schema from a schema, or `undefined` for a BYO Standard Schema with no JSON
 * Schema. The `JSON` round-trip strips TypeBox's Symbol-keyed metadata; a string `$id` survives it and
 * drives `$ref` reuse.
 */
function toJsonSchema(schema: StandardSchemaV1): JsonSchema | undefined {
  if (!hasJsonSchema(schema)) return undefined
  return JSON.parse(JSON.stringify(schema.jsonSchema)) as JsonSchema
}

/**
 * Collects schemas that carry a `$id` into `components.schemas`, returning a `$ref` in their place —
 * so a schema used by N operations is emitted once. Schemas without a `$id` stay inline (the existing
 * behavior). The first sighting of an id wins; later ones just `$ref` it.
 */
class SchemaStore {
  readonly schemas: Record<string, JsonSchema> = {}

  /** Hoist a schema with a `$id` into components + return a `$ref`; otherwise return it inline. */
  collect(schema: JsonSchema | undefined): JsonSchema | undefined {
    if (schema === undefined) return undefined
    const id = typeof schema.$id === "string" ? schema.$id : undefined
    if (id === undefined) return schema
    if (this.schemas[id] === undefined) {
      const hoisted = { ...schema }
      delete hoisted.$id // the component key is the name; drop the redundant base-URI hint
      this.schemas[id] = hoisted
    }
    return { $ref: `#/components/schemas/${id}` }
  }
}

/** Name of a path segment's parameter, or `undefined` for a static segment. */
function segmentParam(segment: string): string | undefined {
  if (segment.startsWith(":")) return segment.slice(1)
  if (segment.startsWith("*")) return segment.length > 1 ? segment.slice(1) : "wildcard"
  return undefined
}

/** `/users/:id/*rest` → `/users/{id}/{rest}` (OpenAPI path templating). */
function toTemplatedPath(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      const param = segmentParam(segment)
      return param === undefined ? segment : `{${param}}`
    })
    .join("/")
}

function pathParameters(path: string): OpenAPIParameter[] {
  const params: OpenAPIParameter[] = []
  for (const segment of path.split("/")) {
    const name = segmentParam(segment)
    // Path params are always strings (decoded from the URL).
    if (name !== undefined)
      params.push({ name, in: "path", required: true, schema: { type: "string" } })
  }
  return params
}

function queryParameters(schema: StandardSchemaV1 | undefined): OpenAPIParameter[] {
  if (schema === undefined) return []
  const json = toJsonSchema(schema)
  // Only an object schema decomposes into individual query parameters.
  if (json === undefined || json.type !== "object" || typeof json.properties !== "object") return []
  const properties = json.properties as Record<string, JsonSchema>
  const required = Array.isArray(json.required) ? (json.required as string[]) : []
  return Object.entries(properties).map(([name, propSchema]) => ({
    name,
    in: "query",
    required: required.includes(name),
    schema: propSchema,
  }))
}

interface OperationInput {
  readonly path: string
  readonly body: StandardSchemaV1 | undefined
  readonly query: StandardSchemaV1 | undefined
  readonly response: StandardSchemaV1 | undefined
  readonly operationId: string | undefined
  // `| undefined` (not just `?`) so a contract op's optional fields — `string | undefined` etc. — are
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
        Record<string, { description?: string; schema?: StandardSchemaV1; contentType?: string }>
      >
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

/** Turn a route's `errors` contract (`{ status → schema }`) into the additional-`responses` shape that
 * {@link buildResponses} emits as non-2xx OpenAPI responses. */
function errorsToResponses(
  errors: Readonly<Record<number, StandardSchemaV1>> | undefined,
): OperationInput["responses"] {
  if (errors === undefined) return undefined
  const out: Record<string, { description?: string; schema?: StandardSchemaV1 }> = {}
  for (const [status, schema] of Object.entries(errors)) {
    out[status] = { description: STATUS_TEXT[status] ?? "Error", schema }
  }
  return out
}

function buildResponses(
  input: OperationInput,
  store: SchemaStore,
): Record<string, OpenAPIResponse> {
  const responses: Record<string, OpenAPIResponse> = {}
  if (input.response !== undefined) {
    const schema = store.collect(toJsonSchema(input.response))
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
      const schema = def.schema !== undefined ? store.collect(toJsonSchema(def.schema)) : undefined
      if (schema !== undefined)
        response.content = { [def.contentType ?? "application/json"]: { schema } }
      responses[status] = response
    }
  }
  return responses
}

function buildOperation(input: OperationInput, store: SchemaStore): OpenAPIOperation {
  const operation: OpenAPIOperation = { responses: buildResponses(input, store) }
  if (input.operationId !== undefined) operation.operationId = input.operationId
  if (input.summary !== undefined) operation.summary = input.summary
  if (input.description !== undefined) operation.description = input.description
  if (input.tags !== undefined && input.tags.length > 0) operation.tags = input.tags
  if (input.deprecated === true) operation.deprecated = true
  if (input.security !== undefined) operation.security = input.security // `[]` ⇒ explicitly public

  const parameters = [...pathParameters(input.path), ...queryParameters(input.query)]
  if (parameters.length > 0) operation.parameters = parameters

  if (input.body !== undefined) {
    const schema = store.collect(toJsonSchema(input.body))
    if (schema !== undefined) {
      operation.requestBody = {
        required: true,
        content: { [input.requestContentType ?? "application/json"]: { schema } },
      }
    }
  }
  return operation
}

function addOperation(
  paths: Record<string, Record<string, OpenAPIOperation>>,
  method: string,
  input: OperationInput,
  store: SchemaStore,
  operations: ToOpenAPIOptions["operations"],
): void {
  const templated = toTemplatedPath(input.path)
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
    for (const route of input.routes()) {
      addOperation(
        paths,
        route.method,
        {
          path: route.path,
          body: route.schema?.body,
          query: route.schema?.query,
          // A route may now declare a `response` contract — emit it as the 200 body schema.
          response: route.schema?.response,
          // …and an `errors` contract — emit each as a non-2xx response.
          responses: errorsToResponses(route.schema?.errors),
          operationId: undefined,
        },
        store,
        options.operations,
      )
    }
  } else {
    for (const [name, op] of Object.entries(input)) {
      addOperation(
        paths,
        op.method,
        {
          path: op.path,
          body: op.body,
          query: op.query,
          response: op.response,
          operationId: name,
          summary: op.summary,
          description: op.description,
          tags: op.tags,
          deprecated: op.deprecated,
          security: op.security,
          requestContentType: op.requestContentType,
          responseContentType: op.responseContentType,
          responses: op.responses,
        },
        store,
        options.operations,
      )
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

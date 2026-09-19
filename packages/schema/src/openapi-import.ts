/**
 * OpenAPI 3.x inventory import - the structural half of an export/import roundtrip.
 *
 * `toOpenAPI` renders a Nifra app (or contract) as an OpenAPI 3.1 document. This module reads such
 * a document back into a canonical route inventory: method, Nifra-templated path (`{id}` back to
 * `:id`), required query names, body presence, and response statuses. `diffOpenApiInventory` then
 * compares two inventories, so `export -> import -> diff` proves the cycle survives in CI.
 *
 * Deliberate boundaries, all fail-closed or explicitly documented:
 *
 * - Offline and ref-opaque. `$ref`s are never resolved and nothing is fetched. A `$ref` parameter
 *   cannot yield a name without resolution, so it throws with the location; `$ref` bodies and
 *   response schemas only assert presence, which needs no resolution.
 * - No schema reconstruction. JSON Schema is not turned back into `t` builders here - that is a
 *   separate codegen step needing consumer evidence. The inventory proves the route table survived;
 *   field-level types ride along in the source document, not in this comparison.
 * - No auth interpretation. `security`, `securitySchemes`, and `servers` are never read. Importing
 *   an API must not silently adopt its auth model.
 * - Templated paths degrade conservatively. `/files/*path` exports as `/files/{path}`, indistinguishable
 *   from a single-segment `:path`. Import yields `:path` and records a note for every OpenAPI template;
 *   a greedy remainder needs a manual `*path` rewrite.
 * - Nifra parameter names follow `/^[A-Za-z_][A-Za-z0-9_]*$/`; `__proto__`, `constructor`, and
 *   `prototype` are rejected. Mixed templates are converted only when their boundaries are representable.
 * - Bounded. Path/operation/parameter counts are capped (`ImportOpenAPIOptions`); a document over
 *   the caps throws rather than allocating.
 */

export class OpenAPIImportError extends Error {
  constructor(message: string) {
    super(`openapi import: ${message}`)
    this.name = "OpenAPIImportError"
  }
}

export interface ImportOpenAPIOptions {
  /** Maximum entries under `paths`. Default 5000. */
  readonly maxPaths?: number
  /** Maximum operations on one path item. Default 8. */
  readonly maxOperationsPerPath?: number
  /** Maximum merged parameters per operation. Default 100. */
  readonly maxParameters?: number
}

export interface ImportedRouteQuery {
  readonly name: string
  readonly required: boolean
}

export interface ImportedRoute {
  /** Lowercase HTTP method as it appears in the document. */
  readonly method: string
  /** Nifra-templated path (`/users/:id`). */
  readonly path: string
  readonly operationId?: string
  /** Template parameter names in path order. */
  readonly pathParams: readonly string[]
  readonly query: readonly ImportedRouteQuery[]
  readonly hasBody: boolean
  readonly requestBodyRequired: boolean
  /** Response status keys (`"200"`, `"404"`, `"default"`). */
  readonly responseStatuses: readonly string[]
  /** Per-route degradations (wildcard rewrites). */
  readonly notes: readonly string[]
}

export interface ImportedApiInventory {
  readonly title: string
  readonly version: string
  readonly routes: readonly ImportedRoute[]
  readonly warnings: readonly string[]
}

export interface OpenApiInventoryDrift {
  /** `METHOD /path`, or `inventory` for route-set level drift. */
  readonly route: string
  readonly message: string
}

const SUPPORTED_METHODS: ReadonlySet<string> = new Set([
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
])
const PATH_ITEM_METADATA = new Set(["$ref", "summary", "description", "servers", "parameters"])
const RESPONSE_KEY = /^(?:[1-5][0-9]{2}|default)$/
const TEMPLATE_EXPRESSION = /\{([^{}]*)\}/g
const NIFRA_PARAM = /^[A-Za-z_][A-Za-z0-9_]*$/
const RESERVED_PARAM_NAMES = new Set(["__proto__", "constructor", "prototype"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizedLimit(value: number | undefined, fallback: number, label: string): number {
  const max = value ?? fallback
  if (!Number.isSafeInteger(max) || max < 0)
    throw new OpenAPIImportError(`${label} limit must be a finite safe integer >= 0`)
  return max
}

function assertLimit(count: number, max: number, label: string): void {
  if (count > max) throw new OpenAPIImportError(`${label} count ${count} exceeds limit ${max}`)
}

/** Collect own keys while stopping as soon as a bounded collection is over its cap. */
function ownKeysWithinLimit(
  record: Record<string, unknown>,
  max: number,
  label: string,
  include: (key: string) => boolean = () => true,
): string[] {
  const keys: string[] = []
  for (const key in record) {
    if (!Object.hasOwn(record, key) || !include(key)) continue
    if (keys.length >= max)
      throw new OpenAPIImportError(`${label} count ${keys.length + 1} exceeds limit ${max}`)
    keys.push(key)
  }
  return keys
}

function toNifraPath(openapiPath: string): {
  readonly path: string
  readonly templated: boolean
  readonly pathParams: readonly string[]
} {
  const segments = openapiPath.split("/")
  let templated = false
  const pathParams: string[] = []
  const out = segments.map((segment) => {
    if (!segment.includes("{") && !segment.includes("}")) return segment
    const matches = [...segment.matchAll(TEMPLATE_EXPRESSION)]
    if (matches.length === 0)
      throw new OpenAPIImportError(`unparseable path template ${openapiPath}`)
    let cursor = 0
    let converted = ""
    for (const match of matches) {
      if (match.index === undefined)
        throw new OpenAPIImportError(`unparseable path template ${openapiPath}`)
      const start = match.index
      const end = start + match[0].length
      const name = match[1] ?? ""
      const previous = segment[start - 1]
      const next = segment[end]
      // Nifra's mixed grammar needs a non-identifier delimiter after a parameter. A terminal
      // `foo{bar}` or adjacent `{a}{b}` cannot be represented without changing the capture.
      if (
        next === "{" ||
        (next !== undefined && /[A-Za-z0-9_]/.test(next)) ||
        (next === undefined && previous !== undefined && /[A-Za-z0-9_]/.test(previous))
      )
        throw new OpenAPIImportError(`path template ${openapiPath} is not representable in Nifra`)
      if (!NIFRA_PARAM.test(name) || RESERVED_PARAM_NAMES.has(name))
        throw new OpenAPIImportError(`invalid path parameter ${name}`)
      if (pathParams.includes(name))
        throw new OpenAPIImportError(`duplicate path parameter ${name} on ${openapiPath}`)
      pathParams.push(name)
      converted += `${segment.slice(cursor, start)}:${name}`
      cursor = end
      templated = true
    }
    const tail = segment.slice(cursor)
    if (tail.includes("{") || tail.includes("}"))
      throw new OpenAPIImportError(`unparseable path template ${openapiPath}`)
    return converted + tail
  })
  return { path: out.join("/"), templated, pathParams: Object.freeze(pathParams) }
}

interface MergedParameter {
  readonly name: string
  readonly location: string
  readonly required: boolean
}

function mergedParameters(
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>,
  max: number,
): MergedParameter[] {
  const merged = new Map<string, MergedParameter>()
  for (const source of [pathItem.parameters, operation.parameters]) {
    if (source === undefined) continue
    if (!Array.isArray(source)) throw new OpenAPIImportError("parameters must be an array")
    assertLimit(source.length, max, "parameters")
    for (const entry of source) {
      if (!isRecord(entry)) throw new OpenAPIImportError("parameter entries must be objects")
      if ("$ref" in entry)
        throw new OpenAPIImportError(
          "parameter $refs must be inlined before import - refs are never resolved",
        )
      const {
        name,
        in: location,
        required,
      } = entry as {
        name?: unknown
        in?: unknown
        required?: unknown
      }
      if (typeof name !== "string" || name === "")
        throw new OpenAPIImportError("parameters need a non-empty name")
      if (typeof location !== "string" || location === "")
        throw new OpenAPIImportError(`parameter ${name} needs an 'in' location`)
      merged.set(`${location} ${name}`, {
        name,
        location,
        required: required === true,
      })
    }
  }
  assertLimit(merged.size, max, "merged parameters")
  return [...merged.values()]
}

/** Parse an OpenAPI 3.0/3.1 document into a canonical route inventory. Throws on invalid input. */
export function importOpenAPI(
  document: unknown,
  options: ImportOpenAPIOptions = {},
): ImportedApiInventory {
  const maxPaths = normalizedLimit(options.maxPaths, 5000, "maxPaths")
  const maxOperations = normalizedLimit(options.maxOperationsPerPath, 8, "maxOperationsPerPath")
  const maxParameters = normalizedLimit(options.maxParameters, 100, "maxParameters")
  if (!isRecord(document)) throw new OpenAPIImportError("document must be an object")
  const { openapi, info, paths } = document
  if (typeof openapi !== "string" || !/^3\.(0|1)\.\d+$/.test(openapi))
    throw new OpenAPIImportError(
      `unsupported OpenAPI version ${JSON.stringify(openapi)} - 3.0.x and 3.1.x only`,
    )
  if (!isRecord(info)) throw new OpenAPIImportError("document.info must be an object")
  const title = typeof info.title === "string" ? info.title : ""
  const version = typeof info.version === "string" ? info.version : ""
  if (paths === undefined)
    return { title, version, routes: Object.freeze([]), warnings: Object.freeze([]) }
  if (!isRecord(paths)) throw new OpenAPIImportError("document.paths must be an object")
  const pathKeys = ownKeysWithinLimit(paths, maxPaths, "paths")
  const warnings: string[] = []
  const routes: ImportedRoute[] = []
  for (const openapiPath of pathKeys) {
    if (!openapiPath.startsWith("/"))
      throw new OpenAPIImportError(`path ${openapiPath} must start with /`)
    const pathItem = paths[openapiPath]
    if (!isRecord(pathItem))
      throw new OpenAPIImportError(`path item ${openapiPath} must be an object`)
    if (Object.hasOwn(pathItem, "$ref"))
      throw new OpenAPIImportError(
        `path item $refs must be inlined before import - refs are never resolved`,
      )
    const operationKeys = ownKeysWithinLimit(
      pathItem,
      maxOperations,
      `operations on ${openapiPath}`,
      (key) => key !== "parameters" && !PATH_ITEM_METADATA.has(key) && !key.startsWith("x-"),
    )
    const { path, templated, pathParams } = toNifraPath(openapiPath)
    const seenMethods = new Set<string>()
    for (const rawMethod of operationKeys) {
      const method = rawMethod.toLowerCase()
      if (!SUPPORTED_METHODS.has(method))
        throw new OpenAPIImportError(`unsupported method ${rawMethod} on ${openapiPath}`)
      if (seenMethods.has(method))
        throw new OpenAPIImportError(`duplicate method ${rawMethod} on ${openapiPath}`)
      seenMethods.add(method)
      const rawOperation = pathItem[rawMethod]
      if (!isRecord(rawOperation))
        throw new OpenAPIImportError(`operation ${rawMethod} ${openapiPath} must be an object`)
      const params = mergedParameters(pathItem, rawOperation, maxParameters)
      const query: ImportedRouteQuery[] = []
      for (const param of params) {
        if (param.location === "query") query.push({ name: param.name, required: param.required })
        else if (param.location !== "path" && param.location !== "header")
          warnings.push(
            `${method.toUpperCase()} ${path}: '${param.location}' parameter '${param.name}' skipped`,
          )
        else if (param.location === "header")
          warnings.push(`${method.toUpperCase()} ${path}: header parameters are not inventoried`)
      }
      const declaredPathParams = new Set(
        params.filter((param) => param.location === "path").map((param) => param.name),
      )
      for (const name of pathParams) {
        if (!declaredPathParams.has(name))
          throw new OpenAPIImportError(
            `path parameter ${name} is not declared on ${method.toUpperCase()} ${path}`,
          )
      }
      for (const name of declaredPathParams) {
        if (!pathParams.includes(name))
          throw new OpenAPIImportError(`declared path parameter ${name} is not in ${path}`)
      }
      const rawBody = rawOperation.requestBody
      const hasBody = rawBody !== undefined
      if (hasBody && !isRecord(rawBody))
        throw new OpenAPIImportError(
          `requestBody on ${method.toUpperCase()} ${path} must be an object`,
        )
      const rawResponses = rawOperation.responses
      if (rawResponses === undefined)
        throw new OpenAPIImportError(`responses are required on ${method.toUpperCase()} ${path}`)
      if (!isRecord(rawResponses))
        throw new OpenAPIImportError(
          `responses on ${method.toUpperCase()} ${path} must be an object`,
        )
      const responseStatuses: string[] = []
      for (const status of Object.keys(rawResponses)) {
        if (!RESPONSE_KEY.test(status))
          throw new OpenAPIImportError(
            `invalid response status ${status} on ${method.toUpperCase()} ${path}`,
          )
        if (!isRecord(rawResponses[status]))
          throw new OpenAPIImportError(
            `response ${status} on ${method.toUpperCase()} ${path} must be an object`,
          )
        responseStatuses.push(status)
      }
      const notes = templated
        ? [
            "OpenAPI path templates import as single-segment :params - greedy remainders (*rest) cannot be distinguished and need manual rewrites",
          ]
        : []
      const operationId = rawOperation.operationId
      routes.push(
        Object.freeze({
          method,
          path,
          ...(typeof operationId === "string" && operationId !== "" ? { operationId } : {}),
          pathParams,
          query: Object.freeze(query),
          hasBody,
          requestBodyRequired: hasBody && (rawBody as Record<string, unknown>).required === true,
          responseStatuses: Object.freeze(responseStatuses),
          notes: Object.freeze(notes),
        }),
      )
    }
  }
  if (routes.some((route) => route.pathParams.length > 0))
    warnings.push(
      "OpenAPI path templates import as single-segment :params - greedy remainders (*rest) cannot be distinguished and need manual rewrites; see route notes",
    )
  return {
    title,
    version,
    routes: Object.freeze(routes),
    warnings: Object.freeze(warnings),
  }
}

function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`
}

/** Compare two inventories. Empty means the export/import cycle preserved the route table. */
export function diffOpenApiInventory(
  expected: ImportedApiInventory,
  actual: ImportedApiInventory,
): readonly OpenApiInventoryDrift[] {
  const drift: OpenApiInventoryDrift[] = []
  const actualByKey = new Map(
    actual.routes.map((route) => [routeKey(route.method, route.path), route]),
  )
  const expectedKeys = new Set<string>()
  for (const want of expected.routes) {
    const key = routeKey(want.method, want.path)
    expectedKeys.add(key)
    const got = actualByKey.get(key)
    if (got === undefined) {
      drift.push({ route: key, message: "route missing after import" })
      continue
    }
    const wantQuery = new Map(want.query.map((param) => [param.name, param.required]))
    const gotQuery = new Map(got.query.map((param) => [param.name, param.required]))
    for (const [name, required] of wantQuery) {
      if (!gotQuery.has(name)) drift.push({ route: key, message: `query parameter '${name}' lost` })
      else if (gotQuery.get(name) !== required)
        drift.push({ route: key, message: `query parameter '${name}' required flag flipped` })
    }
    for (const name of gotQuery.keys()) {
      if (!wantQuery.has(name))
        drift.push({ route: key, message: `unexpected query parameter '${name}'` })
    }
    if (want.hasBody !== got.hasBody)
      drift.push({
        route: key,
        message: want.hasBody ? "request body lost" : "unexpected request body",
      })
    else if (want.hasBody && want.requestBodyRequired !== got.requestBodyRequired)
      drift.push({ route: key, message: "request body required flag flipped" })
    const wantStatuses = new Set(want.responseStatuses)
    const gotStatuses = new Set(got.responseStatuses)
    for (const status of wantStatuses) {
      if (!gotStatuses.has(status))
        drift.push({ route: key, message: `response status ${status} lost` })
    }
    for (const status of gotStatuses) {
      if (!wantStatuses.has(status))
        drift.push({ route: key, message: `unexpected response status ${status}` })
    }
  }
  for (const got of actual.routes) {
    const key = routeKey(got.method, got.path)
    if (!expectedKeys.has(key)) drift.push({ route: key, message: "unexpected route after import" })
  }
  return Object.freeze(drift)
}

/** Deterministic typed SDK generation from the backend's OpenAPI contract. */
import { existsSync } from "node:fs"
import { basename, resolve } from "node:path"
import type { JsonSchema } from "@nifrajs/core/reflection"
import { type OpenAPIDocument, toOpenAPI } from "@nifrajs/schema/openapi"

export type SdkLanguage = "python" | "go"

export interface SdkRenderOptions {
  /** Refuse operations whose request/response schema is opaque or unsupported. */
  readonly strict?: boolean
}

export interface SdkOpaqueIssue {
  readonly operation: string
  readonly location: string
  readonly reason: string
}

export class SdkGenerationError extends Error {
  readonly issues: readonly SdkOpaqueIssue[]

  constructor(issues: readonly SdkOpaqueIssue[]) {
    super(
      "[nifra] strict SDK generation found " +
        issues.length +
        " opaque contract " +
        (issues.length === 1 ? "portion" : "portions") +
        ":\n" +
        issues.map((issue) => `- ${issue.operation} ${issue.location}: ${issue.reason}`).join("\n"),
    )
    this.name = "SdkGenerationError"
    this.issues = Object.freeze([...issues])
  }
}

interface SchemaRecord {
  readonly [key: string]: unknown
}

interface ParameterLike {
  readonly name: string
  readonly in: "path" | "query" | "header"
  readonly required: boolean
  readonly schema?: JsonSchema
}

interface MediaLike {
  readonly schema?: JsonSchema
}

interface RequestBodyLike {
  readonly required?: boolean
  readonly content?: Readonly<Record<string, MediaLike>>
}

interface ResponseLike {
  readonly description?: string
  readonly content?: Readonly<Record<string, MediaLike>>
}

interface OperationLike {
  readonly operationId?: string
  readonly parameters?: readonly ParameterLike[]
  readonly requestBody?: RequestBodyLike
  readonly responses?: Readonly<Record<string, ResponseLike>>
}

interface OperationEntry {
  readonly method: string
  readonly path: string
  readonly operation: OperationLike
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const
const SUCCESS_STATUS = /^[23][0-9]{2}$/
const ERROR_STATUS = /^[45][0-9]{2}$/

const recordOf = (value: unknown): SchemaRecord | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as SchemaRecord)
    : undefined

function operations(document: OpenAPIDocument): readonly OperationEntry[] {
  const result: OperationEntry[] = []
  for (const [path, item] of Object.entries(document.paths).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    for (const method of HTTP_METHODS) {
      const operation = (item as Record<string, unknown>)[method]
      if (operation !== null && typeof operation === "object") {
        result.push({ method, path, operation: operation as OperationLike })
      }
    }
  }
  return result
}

function identifier(value: string, fallback: string): string {
  const normalized = value
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
  const safe = /^\d/.test(normalized) ? `_${normalized}` : normalized
  return safe === "" || safe === "_" ? fallback : safe
}

const PYTHON_KEYWORDS = new Set([
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "case",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "False",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "None",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "True",
  "try",
  "while",
  "with",
  "yield",
])

function pythonIdentifier(value: string, fallback: string): string {
  const result = identifier(value, fallback)
  return PYTHON_KEYWORDS.has(result) ? `${result}_` : result
}

function pascal(value: string, fallback: string): string {
  const words = identifier(value, fallback).split("_").filter(Boolean)
  const result = words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join("")
  return result === "" ? fallback : result
}

function operationName(operation: OperationLike, method: string, path: string): string {
  return identifier(operation.operationId ?? `${method}_${path}`, `${method}_request`)
}

function uniqueNames(items: readonly string[]): readonly string[] {
  const counts = new Map<string, number>()
  return items.map((item) => {
    const count = (counts.get(item) ?? 0) + 1
    counts.set(item, count)
    return count === 1 ? item : `${item}_${count}`
  })
}

function pathParameters(path: string): readonly string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!).filter(Boolean)
}

function firstSchema(
  container: { readonly content?: Readonly<Record<string, MediaLike>> } | undefined,
): JsonSchema | undefined {
  return Object.values(container?.content ?? {})[0]?.schema
}

function responseSchema(response: ResponseLike | undefined): JsonSchema | undefined {
  return firstSchema(response)
}

function schemaRef(schema: JsonSchema): string | undefined {
  const record = recordOf(schema)
  return typeof record?.$ref === "string" ? record.$ref : undefined
}

function schemaType(schema: JsonSchema): string | undefined {
  const record = recordOf(schema)
  return typeof record?.type === "string" ? record.type : undefined
}

function schemaProperties(schema: JsonSchema): Readonly<Record<string, JsonSchema>> | undefined {
  const properties = recordOf(recordOf(schema)?.properties)
  return properties as Readonly<Record<string, JsonSchema>> | undefined
}

function schemaRequired(schema: JsonSchema): ReadonlySet<string> {
  const required = recordOf(schema)?.required
  return new Set(
    Array.isArray(required)
      ? required.filter((value): value is string => typeof value === "string")
      : [],
  )
}

function schemaUnion(schema: JsonSchema): readonly JsonSchema[] | undefined {
  const record = recordOf(schema)
  for (const key of ["anyOf", "oneOf"] as const) {
    const value = record?.[key]
    if (
      Array.isArray(value) &&
      value.every((item) => typeof item === "boolean" || recordOf(item) !== undefined)
    ) {
      return value as JsonSchema[]
    }
  }
  return undefined
}

function schemaIsNullable(schema: JsonSchema): boolean {
  return schemaUnion(schema)?.some((item) => schemaType(item) === "null") ?? false
}

function isObjectModel(schema: JsonSchema): boolean {
  const record = recordOf(schema)
  const type = schemaType(schema)
  if (type !== "object" && schemaProperties(schema) === undefined) return false
  const additional = record?.additionalProperties
  return additional === undefined || additional === false
}

function operationLabel(entry: OperationEntry): string {
  return `${entry.method.toUpperCase()} ${entry.path}`
}

class SchemaCatalog {
  readonly models = new Map<string, JsonSchema>()
  readonly componentNames = new Map<string, string>()
  private readonly namesBySchema = new Map<JsonSchema, string>()
  private readonly usedNames = new Set<string>()

  constructor(components: Readonly<Record<string, JsonSchema>> = {}) {
    for (const name of Object.keys(components).sort()) {
      this.componentNames.set(name, this.uniqueName(pascal(name, "Model")))
    }
    for (const [name, schema] of Object.entries(components)) {
      const className = this.componentNames.get(name)
      if (className !== undefined) this.models.set(className, schema)
    }
  }

  private uniqueName(preferred: string): string {
    let name = preferred || "Model"
    let suffix = 2
    while (this.usedNames.has(name)) name = `${preferred}_${suffix++}`
    this.usedNames.add(name)
    return name
  }

  model(schema: JsonSchema, hint: string): string {
    const known = this.namesBySchema.get(schema)
    if (known !== undefined) return known
    const name = this.uniqueName(pascal(hint, "Model"))
    this.namesBySchema.set(schema, name)
    this.models.set(name, schema)
    return name
  }

  refName(ref: string): string | undefined {
    const prefix = "#/components/schemas/"
    return ref.startsWith(prefix) ? this.componentNames.get(ref.slice(prefix.length)) : undefined
  }
}

class OpaqueTracker {
  readonly issues: SdkOpaqueIssue[] = []

  add(operation: string, location: string, reason: string): void {
    this.issues.push({ operation, location, reason })
  }
}

function literal(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return "None"
}

function pythonType(
  schema: JsonSchema | undefined,
  hint: string,
  catalog: SchemaCatalog,
  tracker: OpaqueTracker,
  operation: string,
  location: string,
): string {
  if (schema === undefined) {
    tracker.add(operation, location, "schema is not declared")
    return "Any"
  }
  if (typeof schema === "boolean") {
    if (schema) tracker.add(operation, location, "boolean true schema has no usable static type")
    return schema ? "Any" : "Never"
  }
  const ref = schemaRef(schema)
  if (ref !== undefined) {
    const name = catalog.refName(ref)
    if (name !== undefined) return name
    tracker.add(operation, location, `unresolved schema reference ${ref}`)
    return "Any"
  }
  const union = schemaUnion(schema)
  if (union !== undefined) {
    const members = union
      .filter((item) => schemaType(item) !== "null")
      .map((item, index) =>
        pythonType(item, hint + (index + 1), catalog, tracker, operation, location),
      )
    if (members.length === 0) return "None"
    const rendered = [...new Set(members)].join(" | ")
    return schemaIsNullable(schema) && !rendered.includes("None") ? `${rendered} | None` : rendered
  }
  const properties = schemaProperties(schema)
  const type = schemaType(schema)
  if (type === "object" || properties !== undefined) {
    if (
      properties === undefined &&
      recordOf(schema)?.additionalProperties !== undefined &&
      recordOf(schema)?.additionalProperties !== false
    ) {
      const extra = recordOf(schema)?.additionalProperties
      const extraType =
        typeof extra === "boolean"
          ? "Any"
          : pythonType(extra as JsonSchema, `${hint}Value`, catalog, tracker, operation, location)
      return `dict[str, ${extraType}]`
    }
    return catalog.model(schema, hint)
  }
  if (type === "array") {
    const item = recordOf(schema)?.items as JsonSchema | undefined
    return (
      "list[" +
      pythonType(item, `${hint}Item`, catalog, tracker, operation, `${location}.items`) +
      "]"
    )
  }
  if (type === "string") {
    const enumValues = recordOf(schema)?.enum
    if (Array.isArray(enumValues) && enumValues.length > 0) {
      return `Literal[${enumValues.map(literal).join(", ")}]`
    }
    return "str"
  }
  if (type === "integer") return "int"
  if (type === "number") return "float"
  if (type === "boolean") return "bool"
  if (type === "null") return "None"
  const constant = recordOf(schema)?.const
  if (constant !== undefined) return `Literal[${literal(constant)}]`
  const allOf = recordOf(schema)?.allOf
  if (Array.isArray(allOf) && allOf.length > 0) {
    return pythonType(allOf[0] as JsonSchema, hint, catalog, tracker, operation, location)
  }
  tracker.add(operation, location, "schema shape is opaque or unsupported")
  return "Any"
}

function pythonModelFields(
  schema: JsonSchema,
  name: string,
  catalog: SchemaCatalog,
  tracker: OpaqueTracker,
): string {
  const properties = schemaProperties(schema)
  if (properties === undefined) return "    pass"
  const required = schemaRequired(schema)
  const used = new Set<string>()
  const fields: string[] = []
  for (const [jsonName, property] of Object.entries(properties)) {
    let fieldName = pythonIdentifier(jsonName, "field")
    while (used.has(fieldName)) fieldName += "_"
    used.add(fieldName)
    let type = pythonType(
      property,
      name + pascal(jsonName, "Field"),
      catalog,
      tracker,
      "schema",
      `model ${name}.${jsonName}`,
    )
    const optional = !required.has(jsonName)
    if (optional && !type.includes("None")) type += " | None"
    if (fieldName === jsonName) {
      fields.push(`    ${fieldName}: ${type}${optional ? " = None" : ""}`)
    } else {
      const metadata = `{"json_name": ${JSON.stringify(jsonName)}}`
      fields.push(
        "    " +
          fieldName +
          ": " +
          type +
          " = field(" +
          (optional ? "default=None, " : "") +
          "metadata=" +
          metadata +
          ")",
      )
    }
  }
  return fields.length === 0 ? "    pass" : fields.join("\n")
}

function renderPythonModels(catalog: SchemaCatalog, tracker: OpaqueTracker): string {
  const rendered: string[] = []
  let index = 0
  while (index < catalog.models.size) {
    const entries = [...catalog.models.entries()]
    const [name, schema] = entries[index++]!
    if (isObjectModel(schema)) {
      rendered.push(
        "@dataclass(frozen=True)\nclass " +
          name +
          ":\n" +
          pythonModelFields(schema, name, catalog, tracker),
      )
    } else {
      rendered.push(
        name +
          ": TypeAlias = " +
          pythonType(schema, name, catalog, tracker, "schema", `model ${name}`),
      )
    }
  }
  return rendered.join("\n\n")
}

function pythonErrorAliases(
  entries: readonly OperationEntry[],
  names: readonly string[],
  catalog: SchemaCatalog,
  tracker: OpaqueTracker,
): string {
  const aliases: string[] = []
  entries.forEach((entry, index) => {
    const types: string[] = []
    for (const [status, response] of Object.entries(entry.operation.responses ?? {}).sort(
      ([a], [b]) => a.localeCompare(b),
    )) {
      if (!ERROR_STATUS.test(status)) continue
      const schema = responseSchema(response)
      types.push(
        schema === undefined
          ? "None"
          : pythonType(
              schema,
              `${pascal(names[index]!, "Request")}Error${status}`,
              catalog,
              tracker,
              operationLabel(entry),
              `response ${status}`,
            ),
      )
    }
    if (types.length > 0) {
      aliases.push(
        `type ${pascal(names[index]!, "Request")}Error = ${[...new Set(types)].join(" | ")}`,
      )
    }
  })
  return aliases.join("\n")
}

function pythonSdk(document: OpenAPIDocument, options: SdkRenderOptions): string {
  const entries = operations(document)
  const names = uniqueNames(
    entries.map(({ method, path, operation }) => operationName(operation, method, path)),
  )
  const catalog = new SchemaCatalog(document.components?.schemas)
  const tracker = new OpaqueTracker()
  const methods: string[] = []

  entries.forEach((entry, index) => {
    const { method, path, operation } = entry
    const name = names[index]!
    const label = operationLabel(entry)
    const pathNames = pathParameters(path)
    const pathDefinitions = pathNames.map((value) =>
      (operation.parameters ?? []).find(
        (parameter) => parameter.in === "path" && parameter.name === value,
      ),
    )
    const queryParameters = (operation.parameters ?? []).filter(
      (parameter) => parameter.in === "query",
    )
    const used = new Set(["self", "body", "headers", ...pathNames])
    const queryNames = queryParameters.map((parameter) => {
      let value = pythonIdentifier(parameter.name, "query")
      while (used.has(value)) value += "_"
      used.add(value)
      return value
    })
    const required: string[] = []
    const optional: string[] = []
    queryParameters.forEach((parameter, queryIndex) => {
      const type = pythonType(
        parameter.schema,
        `${pascal(name, "Request")}Query${pascal(parameter.name, "Value")}`,
        catalog,
        tracker,
        label,
        `query ${parameter.name}`,
      )
      const value = `${queryNames[queryIndex]!}: ${parameter.required ? type : `${type} | None`}`
      if (parameter.required) required.push(value)
      else optional.push(`${value} = None`)
    })
    const bodySchema = firstSchema(operation.requestBody)
    if (operation.requestBody !== undefined) {
      const bodyType = pythonType(
        bodySchema,
        `${pascal(name, "Request")}Body`,
        catalog,
        tracker,
        label,
        "request body",
      )
      if (operation.requestBody.required === true) required.push(`body: ${bodyType}`)
      else optional.push(`body: ${bodyType} = None`)
    }
    optional.push("headers: Mapping[str, str] | None = None")
    const signature = [
      ...pathDefinitions.map((parameter, parameterIndex) => {
        const type = pythonType(
          parameter?.schema,
          `${pascal(name, "Request")}Path${parameterIndex + 1}`,
          catalog,
          tracker,
          label,
          `path ${pathNames[parameterIndex]}`,
        )
        return `${pythonIdentifier(pathNames[parameterIndex]!, "param")}: ${type}`
      }),
      "*",
      ...required,
      ...optional,
    ].join(", ")
    const query =
      queryNames.length === 0
        ? "None"
        : "{" +
          queryNames
            .map(
              (value, queryIndex) =>
                `${JSON.stringify(queryParameters[queryIndex]!.name)}: ${value}`,
            )
            .join(", ") +
          "}"
    const paths =
      pathNames.length === 0
        ? "None"
        : "{" +
          pathNames
            .map((value) => `${JSON.stringify(value)}: ${pythonIdentifier(value, "param")}`)
            .join(", ") +
          "}"
    const success = Object.entries(operation.responses ?? {}).find(([status]) =>
      SUCCESS_STATUS.test(status),
    )
    const responseType =
      success === undefined
        ? "None"
        : pythonType(
            responseSchema(success[1]),
            `${pascal(name, "Request")}Response`,
            catalog,
            tracker,
            label,
            `response ${success[0]}`,
          )
    const errorType = Object.keys(operation.responses ?? {}).some((status) =>
      ERROR_STATUS.test(status),
    )
      ? `${pascal(name, "Request")}Error`
      : "Any"
    methods.push(
      "    def " +
        name +
        "(self" +
        (signature ? `, ${signature}` : "") +
        ") -> " +
        responseType +
        ":\n" +
        "        return self._request(" +
        JSON.stringify(method.toUpperCase()) +
        ", " +
        JSON.stringify(path) +
        ", path_params=" +
        paths +
        ", query=" +
        query +
        ", body=" +
        (operation.requestBody === undefined ? "None" : "body") +
        ", headers=headers, response_type=" +
        responseType +
        ", error_type=" +
        errorType +
        ")",
    )
  })

  const aliases = pythonErrorAliases(entries, names, catalog, tracker)
  const models = renderPythonModels(catalog, tracker)
  if (options.strict === true && tracker.issues.length > 0)
    throw new SdkGenerationError(tracker.issues)
  return [
    "# Generated by nifra. Regenerate with: nifra sdk --lang python",
    "from __future__ import annotations",
    "",
    "import json",
    "import types",
    "import urllib.error",
    "import urllib.parse",
    "import urllib.request",
    "from dataclasses import dataclass, field, fields, is_dataclass",
    "from typing import Any, Generic, Literal, Mapping, Never, TypeAlias, TypeVar, get_args, get_origin, get_type_hints",
    "",
    'T = TypeVar("T")',
    "",
    "class NifraApiError(RuntimeError, Generic[T]):",
    "    def __init__(self, status: int, body: T):",
    '        super().__init__(f"Nifra API request failed with HTTP {status}")',
    "        self.status = status",
    "        self.body = body",
    "",
    "def _decode(value: Any, target: Any) -> Any:",
    "    if target is None or target is Any or target is object:",
    "        return value",
    "    origin = get_origin(target)",
    "    args = get_args(target)",
    "    if origin in (list, tuple, set):",
    "        item = args[0] if args else Any",
    "        values = [_decode(item_value, item) for item_value in (value or [])]",
    "        return values if origin is list else tuple(values) if origin is tuple else set(values)",
    "    if origin is dict:",
    "        key_type, value_type = args if len(args) == 2 else (str, Any)",
    "        return {_decode(key, key_type): _decode(item, value_type) for key, item in (value or {}).items()}",
    '    if origin in (types.UnionType, getattr(__import__("typing"), "Union", object)):',
    "        for option in args:",
    "            if option is type(None) and value is None:",
    "                return None",
    "            if option is type(None):",
    "                continue",
    "            try:",
    "                return _decode(value, option)",
    "            except (TypeError, ValueError, KeyError):",
    "                pass",
    "        return value",
    "    if isinstance(target, type) and is_dataclass(target) and isinstance(value, dict):",
    "        hints = get_type_hints(target)",
    "        result = {}",
    "        for item in fields(target):",
    '            json_name = item.metadata.get("json_name", item.name)',
    "            if json_name in value:",
    "                result[item.name] = _decode(value[json_name], hints.get(item.name, Any))",
    "        return target(**result)",
    "    if target in (str, int, float, bool) and value is not None:",
    "        return target(value)",
    "    return value",
    "",
    models || "# No object models were found.",
    "",
    aliases || "# No typed error bodies were declared.",
    "",
    "class Client:",
    "    def __init__(self, base_url: str, headers: Mapping[str, str] | None = None, timeout: float = 30.0):",
    '        self.base_url = base_url.rstrip("/")',
    "        self.headers = dict(headers or {})",
    "        self.timeout = timeout",
    "",
    "    def _request(self, method: str, path: str, *, path_params: Mapping[str, Any] | None, query: Mapping[str, Any] | None, body: Any, headers: Mapping[str, str] | None, response_type: Any, error_type: Any) -> Any:",
    "        route = path",
    "        for key, value in (path_params or {}).items():",
    '            route = route.replace("{" + key + "}", urllib.parse.quote(str(value), safe=""))',
    "        # A `.` or `..` segment is a step to another path, never a value: anything between this",
    "        # client and the server may resolve it, so the call is refused instead of sent elsewhere.",
    '        if any(segment in (".", "..") for segment in route.split("/")):',
    "            raise ValueError(\"a path parameter cannot make a '.' or '..' path segment\")",
    "        params = [(key, value) for key, value in (query or {}).items() if value is not None]",
    "        url = self.base_url + route",
    "        if params:",
    '            url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params, doseq=True)',
    '        payload = None if body is None else json.dumps(body).encode("utf-8")',
    "        request = urllib.request.Request(url, data=payload, method=method, headers={**self.headers, **dict(headers or {})})",
    "        if payload is not None:",
    '            request.add_header("Content-Type", "application/json")',
    "        try:",
    "            with urllib.request.urlopen(request, timeout=self.timeout) as response:",
    "                raw = response.read()",
    "                return _decode(json.loads(raw) if raw else None, response_type)",
    "        except urllib.error.HTTPError as error:",
    "            raw = error.read()",
    "            try:",
    "                value = json.loads(raw) if raw else None",
    "            except json.JSONDecodeError:",
    '                value = raw.decode("utf-8", errors="replace")',
    "            raise NifraApiError(error.code, _decode(value, error_type)) from error",
    "",
    methods.length === 0 ? "    pass" : methods.join("\n\n"),
    "",
  ].join("\n")
}

function goType(
  schema: JsonSchema | undefined,
  hint: string,
  catalog: SchemaCatalog,
  tracker: OpaqueTracker,
  operation: string,
  location: string,
): string {
  if (schema === undefined) {
    tracker.add(operation, location, "schema is not declared")
    return "any"
  }
  if (typeof schema === "boolean") {
    if (schema) tracker.add(operation, location, "boolean true schema has no usable static type")
    return schema ? "any" : "struct{}"
  }
  const ref = schemaRef(schema)
  if (ref !== undefined) {
    const name = catalog.refName(ref)
    if (name !== undefined) return name
    tracker.add(operation, location, `unresolved schema reference ${ref}`)
    return "any"
  }
  const union = schemaUnion(schema)
  if (union !== undefined) {
    const members = union.filter((item) => schemaType(item) !== "null")
    if (members.length === 1 && schemaIsNullable(schema)) {
      const type = goType(members[0], hint, catalog, tracker, operation, location)
      return type.startsWith("*") ? type : `*${type}`
    }
    tracker.add(operation, location, "non-nullable unions have no direct Go representation")
    return "any"
  }
  const properties = schemaProperties(schema)
  const type = schemaType(schema)
  if (type === "object" || properties !== undefined) {
    if (
      properties === undefined &&
      recordOf(schema)?.additionalProperties !== undefined &&
      recordOf(schema)?.additionalProperties !== false
    ) {
      const extra = recordOf(schema)?.additionalProperties
      const extraType =
        typeof extra === "boolean"
          ? "any"
          : goType(extra as JsonSchema, `${hint}Value`, catalog, tracker, operation, location)
      return `map[string]${extraType}`
    }
    return catalog.model(schema, hint)
  }
  if (type === "array") {
    return (
      "[]" +
      goType(
        recordOf(schema)?.items as JsonSchema | undefined,
        `${hint}Item`,
        catalog,
        tracker,
        operation,
        `${location}.items`,
      )
    )
  }
  if (type === "string") return "string"
  if (type === "integer") return "int64"
  if (type === "number") return "float64"
  if (type === "boolean") return "bool"
  if (type === "null") return "struct{}"
  const allOf = recordOf(schema)?.allOf
  if (Array.isArray(allOf) && allOf.length > 0)
    return goType(allOf[0] as JsonSchema, hint, catalog, tracker, operation, location)
  tracker.add(operation, location, "schema shape is opaque or unsupported")
  return "any"
}

const GO_KEYWORDS = new Set([
  "break",
  "default",
  "func",
  "interface",
  "select",
  "case",
  "defer",
  "go",
  "map",
  "struct",
  "chan",
  "else",
  "goto",
  "package",
  "switch",
  "const",
  "fallthrough",
  "if",
  "range",
  "type",
  "continue",
  "for",
  "import",
  "return",
  "var",
])

function goFieldName(value: string): string {
  const result = pascal(value, "Field")
  return GO_KEYWORDS.has(result.toLowerCase()) ? `${result}Value` : result
}

function goModelFields(
  schema: JsonSchema,
  name: string,
  catalog: SchemaCatalog,
  tracker: OpaqueTracker,
): string {
  const properties = schemaProperties(schema)
  if (properties === undefined) return ""
  const required = schemaRequired(schema)
  const used = new Set<string>()
  const tag = String.fromCharCode(96)
  const fields: string[] = []
  for (const [jsonName, property] of Object.entries(properties)) {
    let fieldName = goFieldName(jsonName)
    while (used.has(fieldName)) fieldName += "Value"
    used.add(fieldName)
    let type = goType(
      property,
      name + pascal(jsonName, "Field"),
      catalog,
      tracker,
      "schema",
      `model ${name}.${jsonName}`,
    )
    if (!required.has(jsonName) && type !== "any" && !type.startsWith("*") && type !== "struct{}")
      type = `*${type}`
    fields.push(
      "\t" +
        fieldName +
        " " +
        type +
        " " +
        tag +
        'json:"' +
        jsonName +
        (required.has(jsonName) ? "" : ",omitempty") +
        '"' +
        tag,
    )
  }
  return fields.join("\n")
}

function renderGoModels(catalog: SchemaCatalog, tracker: OpaqueTracker): string {
  const rendered: string[] = []
  let index = 0
  while (index < catalog.models.size) {
    const entries = [...catalog.models.entries()]
    const [name, schema] = entries[index++]!
    const fields = goModelFields(schema, name, catalog, tracker)
    if (isObjectModel(schema)) {
      rendered.push(`type ${name} struct {\n${fields}\n}`)
    } else {
      rendered.push(
        `type ${name} = ${goType(schema, name, catalog, tracker, "schema", `model ${name}`)}`,
      )
    }
  }
  return rendered.join("\n\n")
}

interface GoErrorInfo {
  readonly name: string
  readonly definitions: string
  readonly decoders: string
}

function goErrorInfo(
  entry: OperationEntry,
  name: string,
  catalog: SchemaCatalog,
  tracker: OpaqueTracker,
): GoErrorInfo | undefined {
  const errors = Object.entries(entry.operation.responses ?? {})
    .filter(([status]) => ERROR_STATUS.test(status))
    .sort(([a], [b]) => a.localeCompare(b))
  if (errors.length === 0) return undefined
  const operationNameValue = pascal(name, "Request")
  const interfaceName = `${operationNameValue}ErrorBody`
  const types: Array<{ status: string; type: string }> = []
  const definitions: string[] = []
  const markers: string[] = []
  for (const [status, response] of errors) {
    const schema = responseSchema(response)
    let type = "struct{}"
    if (schema !== undefined) {
      type = goType(
        schema,
        `${operationNameValue}Error${status}`,
        catalog,
        tracker,
        operationLabel(entry),
        `response ${status}`,
      )
      if (
        type === "string" ||
        type === "int64" ||
        type === "float64" ||
        type === "bool" ||
        type.startsWith("[]") ||
        type.startsWith("map[")
      ) {
        const alias = `${operationNameValue}Error${status}`
        definitions.push(`type ${alias} ${type}`)
        type = alias
      }
      if (type !== "any") markers.push(`func (v ${type}) is${interfaceName}() {}`)
    }
    types.push({ status, type })
  }
  const hasUnknown = types.some((item) => item.type === "any")
  const bodyInterface = hasUnknown ? "any" : interfaceName
  if (!hasUnknown) {
    definitions.unshift(`type ${interfaceName} interface {\n\tis${interfaceName}()\n}`)
    definitions.push(...markers)
  }
  definitions.unshift(
    "type " +
      operationNameValue +
      "Error struct {\n\tStatus int\n\tBody " +
      bodyInterface +
      "\n\tCause error\n}\n\nfunc (e *" +
      operationNameValue +
      'Error) Error() string {\n\treturn fmt.Sprintf("nifra API request failed with HTTP %d", e.Status)\n}',
  )
  const decoderLines = [
    "func decode" +
      operationNameValue +
      "Error(status int, raw []byte, cause error) *" +
      operationNameValue +
      "Error {",
    `\tout := &${operationNameValue}Error{Status: status, Cause: cause}`,
    "\tswitch status {",
  ]
  for (const item of types) {
    if (item.type === "struct{}" || item.type === "any") continue
    decoderLines.push(
      `\tcase ${item.status}:`,
      `\t\tvar body ${item.type}`,
      "\t\tif len(raw) > 0 { if err := json.Unmarshal(raw, &body); err != nil { out.Cause = err } }",
      "\t\tout.Body = body",
    )
  }
  decoderLines.push("\t}", "\treturn out", "}")
  return {
    name: `${operationNameValue}Error`,
    definitions: definitions.join("\n\n"),
    decoders: decoderLines.join("\n"),
  }
}

function goQueryDefinition(
  entry: OperationEntry,
  name: string,
  catalog: SchemaCatalog,
  tracker: OpaqueTracker,
): { readonly type: string; readonly source: string } | undefined {
  const parameters = (entry.operation.parameters ?? []).filter(
    (parameter) => parameter.in === "query",
  )
  if (parameters.length === 0) return undefined
  const type = `${pascal(name, "Request")}Query`
  const fields: string[] = []
  const values: string[] = []
  for (const parameter of parameters) {
    let fieldType = goType(
      parameter.schema,
      type + pascal(parameter.name, "Value"),
      catalog,
      tracker,
      operationLabel(entry),
      `query ${parameter.name}`,
    )
    if (
      !parameter.required &&
      fieldType !== "any" &&
      !fieldType.startsWith("*") &&
      fieldType !== "struct{}"
    )
      fieldType = `*${fieldType}`
    const field = goFieldName(parameter.name)
    fields.push(`\t${field} ${fieldType}`)
    const value = parameter.required ? `fmt.Sprint(q.${field})` : `fmt.Sprint(*q.${field})`
    values.push(
      parameter.required
        ? `\tv.Set(${JSON.stringify(parameter.name)}, ${value})`
        : "\tif q." +
            field +
            " != nil {\n\t\tv.Set(" +
            JSON.stringify(parameter.name) +
            ", " +
            value +
            ")\n\t}",
    )
  }
  return {
    type,
    source:
      "type " +
      type +
      " struct {\n" +
      fields.join("\n") +
      "\n}\n\nfunc (q " +
      type +
      ") values() url.Values {\n\tv := make(url.Values)\n" +
      values.join("\n") +
      "\n\treturn v\n}",
  }
}

function goSdk(document: OpenAPIDocument, options: SdkRenderOptions): string {
  const entries = operations(document)
  const names = uniqueNames(
    entries.map(({ method, path, operation }) => operationName(operation, method, path)),
  )
  const catalog = new SchemaCatalog(document.components?.schemas)
  const tracker = new OpaqueTracker()
  const methods: string[] = []
  const queries: string[] = []
  const errors: string[] = []
  const decoders: string[] = []
  const errorNames = new Map<number, string>()
  const queryTypes = new Map<number, string>()

  entries.forEach((entry, index) => {
    const query = goQueryDefinition(entry, names[index]!, catalog, tracker)
    if (query !== undefined) {
      queries.push(query.source)
      queryTypes.set(index, query.type)
    }
    const error = goErrorInfo(entry, names[index]!, catalog, tracker)
    if (error !== undefined) {
      errors.push(error.definitions)
      decoders.push(error.decoders)
      errorNames.set(index, error.name)
    }
  })

  entries.forEach((entry, index) => {
    const { method, path, operation } = entry
    const name = names[index]!
    const label = operationLabel(entry)
    const pathNames = pathParameters(path)
    const args: string[] = []
    for (const parameterName of pathNames) {
      const parameter = (operation.parameters ?? []).find(
        (item) => item.in === "path" && item.name === parameterName,
      )
      const type = goType(
        parameter?.schema,
        `${pascal(name, "Request")}Path${pascal(parameterName, "Value")}`,
        catalog,
        tracker,
        label,
        `path ${parameterName}`,
      )
      args.push(`${goFieldName(parameterName)} ${type}`)
    }
    const queryType = queryTypes.get(index)
    if (queryType !== undefined) args.push(`query ${queryType}`)
    const bodySchema = firstSchema(operation.requestBody)
    const bodyType =
      operation.requestBody === undefined
        ? undefined
        : goType(
            bodySchema,
            `${pascal(name, "Request")}Body`,
            catalog,
            tracker,
            label,
            "request body",
          )
    if (bodyType !== undefined) args.push(`body ${bodyType}`)
    const success = Object.entries(operation.responses ?? {}).find(([status]) =>
      SUCCESS_STATUS.test(status),
    )
    const responseType =
      success === undefined
        ? "struct{}"
        : goType(
            responseSchema(success[1]),
            `${pascal(name, "Request")}Response`,
            catalog,
            tracker,
            label,
            `response ${success[0]}`,
          )
    const errorName = errorNames.get(index)
    const errorType = errorName === undefined ? "error" : `*${errorName}`
    const pathMap =
      pathNames.length === 0
        ? "nil"
        : "map[string]string{" +
          pathNames
            .map((value) => `${JSON.stringify(value)}: fmt.Sprint(${goFieldName(value)})`)
            .join(", ") +
          "}"
    const queryValue = queryType === undefined ? "nil" : "query.values()"
    const bodyValue = bodyType === undefined ? "nil" : "body"
    const zeroError = errorName === undefined ? "err" : `&${errorName}{Status: 0, Cause: err}`
    const statusError =
      errorName === undefined
        ? "&NifraApiError{Status: status, Body: string(raw)}"
        : `decode${errorName}(status, raw, nil)`
    const unmarshalError =
      errorName === undefined ? "err" : `&${errorName}{Status: status, Cause: err}`
    methods.push(
      "func (c *Client) " +
        pascal(name, "Request") +
        "(" +
        args.join(", ") +
        ") (" +
        responseType +
        ", " +
        errorType +
        ") {\n" +
        "\tstatus, raw, err := c.request(http.Method" +
        method[0]!.toUpperCase() +
        method.slice(1) +
        ", " +
        JSON.stringify(path) +
        ", " +
        pathMap +
        ", " +
        queryValue +
        ", " +
        bodyValue +
        ")\n" +
        "\tvar value " +
        responseType +
        "\n\tif err != nil {\n\t\treturn value, " +
        zeroError +
        "\n\t}\n" +
        "\tif status < 200 || status >= 300 {\n\t\treturn value, " +
        statusError +
        "\n\t}\n" +
        "\tif len(raw) > 0 {\n\t\tif err := json.Unmarshal(raw, &value); err != nil {\n\t\t\treturn value, " +
        unmarshalError +
        "\n\t\t}\n\t}\n\treturn value, nil\n}",
    )
  })

  const models = renderGoModels(catalog, tracker)
  if (options.strict === true && tracker.issues.length > 0)
    throw new SdkGenerationError(tracker.issues)
  return [
    "// Code generated by nifra. Regenerate with: nifra sdk --lang go",
    "package nifrasdk",
    "",
    "import (",
    '\t"bytes"',
    '\t"encoding/json"',
    '\t"fmt"',
    '\t"io"',
    '\t"net/http"',
    '\t"net/url"',
    '\t"strings"',
    ")",
    "",
    "type Client struct {",
    "\tBaseURL string",
    "\tHTTP *http.Client",
    "\tHeaders http.Header",
    "}",
    "",
    "func NewClient(baseURL string) *Client {",
    '\treturn &Client{BaseURL: strings.TrimRight(baseURL, "/"), HTTP: http.DefaultClient, Headers: make(http.Header)}',
    "}",
    "",
    "type NifraApiError struct { Status int; Body string }",
    'func (e *NifraApiError) Error() string { return fmt.Sprintf("nifra API request failed with HTTP %d", e.Status) }',
    "",
    "func (c *Client) request(method, path string, pathParams map[string]string, query url.Values, body any) (int, []byte, error) {",
    "\troute := path",
    '\tfor key, value := range pathParams { route = strings.ReplaceAll(route, "{"+key+"}", url.PathEscape(value)) }',
    "\t// A `.` or `..` segment is a step to another path, never a value: anything between this client",
    "\t// and the server may resolve it, so the call is refused instead of sent elsewhere.",
    '\tfor _, segment := range strings.Split(route, "/") { if segment == "." || segment == ".." { return 0, nil, fmt.Errorf("a path parameter cannot make a %q or %q path segment", ".", "..") } }',
    "\ttarget := c.BaseURL + route",
    "\tparsed, err := url.Parse(target)",
    "\tif err != nil { return 0, nil, err }",
    "\tif query != nil { parsed.RawQuery = query.Encode() }",
    "\tvar reader io.Reader",
    "\tif body != nil { payload, err := json.Marshal(body); if err != nil { return 0, nil, err }; reader = bytes.NewReader(payload) }",
    "\trequest, err := http.NewRequest(method, parsed.String(), reader)",
    "\tif err != nil { return 0, nil, err }",
    "\tfor key, values := range c.Headers { for _, value := range values { request.Header.Add(key, value) } }",
    '\tif body != nil { request.Header.Set("Content-Type", "application/json") }',
    "\tresponse, err := c.HTTP.Do(request)",
    "\tif err != nil { return 0, nil, err }",
    "\tdefer response.Body.Close()",
    "\traw, err := io.ReadAll(response.Body)",
    "\treturn response.StatusCode, raw, err",
    "}",
    "",
    models || "// No object models were found.",
    "",
    queries.join("\n\n") || "// No typed query models were needed.",
    "",
    errors.join("\n\n") || "// No typed error bodies were declared.",
    "",
    decoders.join("\n\n"),
    "",
    methods.join("\n\n") || "// No operations were found.",
    "",
  ].join("\n")
}

/** Render a generated SDK. Strict mode refuses opaque request/response portions. */
export function renderSdk(
  document: OpenAPIDocument,
  language: SdkLanguage,
  options: SdkRenderOptions = {},
): string {
  return language === "python" ? pythonSdk(document, options) : goSdk(document, options)
}

function unsupportedTransports(backend: unknown): readonly string[] {
  const routes = (
    backend as {
      routes?: () => readonly {
        method?: unknown
        path?: unknown
        schema?: { sse?: unknown }
      }[]
    }
  ).routes
  if (typeof routes !== "function") return []
  const result: string[] = []
  for (const route of routes()) {
    const method = typeof route.method === "string" ? route.method : "?"
    const path = typeof route.path === "string" ? route.path : "?"
    if (route.schema?.sse !== undefined) {
      result.push(`${method} ${path} uses SSE; generated SDKs currently cover JSON HTTP only`)
    }
  }
  return result
}

/** Load backend.ts, generate an SDK, and write it to the project. */
export async function runSdk(
  cwd: string,
  options: { readonly language: SdkLanguage; readonly out?: string; readonly strict?: boolean },
): Promise<void> {
  const backendPath = resolve(cwd, "backend.ts")
  if (!existsSync(backendPath)) {
    throw new Error(`[nifra] no backend.ts in ${cwd} - SDK generation needs the API contract.`)
  }
  const backend = ((await import(backendPath)) as { backend?: unknown }).backend
  if (backend === undefined) throw new Error(`[nifra] ${backendPath} does not export backend.`)
  const transportIssues = unsupportedTransports(backend)
  if (options.strict === true && transportIssues.length > 0) {
    throw new SdkGenerationError(
      transportIssues.map((reason) => ({ operation: "transport", location: "SSE", reason })),
    )
  }
  for (const warning of transportIssues) console.warn(`[nifra] SDK warning: ${warning}`)
  const document = toOpenAPI(backend as Parameters<typeof toOpenAPI>[0], {
    title: `${basename(cwd)} API`,
    version: "1.0.0",
  })
  const extension = options.language === "python" ? "py" : "go"
  const out = resolve(cwd, options.out ?? `nifra_sdk.${extension}`)
  await Bun.write(out, renderSdk(document, options.language, options))
  console.log(
    "[nifra] wrote " +
      options.language +
      " SDK with " +
      Object.keys(document.paths).length +
      " path" +
      (Object.keys(document.paths).length === 1 ? "" : "s") +
      " to " +
      out,
  )
}

/**
 * `@nifrajs/mock` — contract-based mock server.
 *
 * Reads a Nifra app's registered routes and their Standard Schema / JSON Schema
 * response definitions, then generates fake responses from supported JSON Schema keywords. Use it
 * for frontend-first development, agent testing, or CI smoke tests.
 */

import { reflectRoutes, reflectSchema } from "@nifrajs/core/reflection"

// ---------------------------------------------------------------------------
// Seeded PRNG (deterministic mocks)
// ---------------------------------------------------------------------------

function seededRandom(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) & 0x7fffffff
    // Divide by 2^31 (not 2^31 - 1) so the result stays strictly below 1 and never
    // produces an out-of-range index when scaled by an array length.
    return s / 0x80000000
  }
}

/** Clamp a `rand() * length` index so an inclusive-range rng cannot index past the end. */
const randomIndex = (rand: () => number, length: number): number =>
  Math.min(Math.floor(rand() * length), length - 1)

export class UnsupportedMockSchemaError extends Error {
  constructor(
    readonly keyword: string,
    message: string,
  ) {
    super(message)
    this.name = "UnsupportedMockSchemaError"
  }
}

function numericBounds(schema: Record<string, unknown>): { min: number; max: number } {
  const minimum = typeof schema.minimum === "number" ? schema.minimum : 0
  const maximum = typeof schema.maximum === "number" ? schema.maximum : 100
  const exclusiveMinimum =
    typeof schema.exclusiveMinimum === "number" ? schema.exclusiveMinimum : undefined
  const exclusiveMaximum =
    typeof schema.exclusiveMaximum === "number" ? schema.exclusiveMaximum : undefined
  const min =
    exclusiveMinimum === undefined ? minimum : Math.max(minimum, exclusiveMinimum + Number.EPSILON)
  const max =
    exclusiveMaximum === undefined ? maximum : Math.min(maximum, exclusiveMaximum - Number.EPSILON)
  if (min > max)
    throw new UnsupportedMockSchemaError("minimum", "Numeric schema has no satisfiable range")
  return { min, max }
}

function constrainedString(
  schema: Record<string, unknown>,
  initial: string,
  fieldName: string | undefined,
): string {
  const minLength = typeof schema.minLength === "number" ? schema.minLength : 0
  const maxLength =
    typeof schema.maxLength === "number" ? schema.maxLength : Number.POSITIVE_INFINITY
  if (minLength > maxLength) {
    throw new UnsupportedMockSchemaError("minLength", "String schema has no satisfiable length")
  }
  const candidates = [
    initial,
    fieldName ?? "mock",
    "mock_value",
    "test",
    "abc",
    "123",
    "A1",
    "https://example.com",
    "test@example.com",
  ]
  const pattern = typeof schema.pattern === "string" ? new RegExp(schema.pattern) : undefined
  for (const candidate of candidates) {
    const padded = candidate.length < minLength ? candidate.padEnd(minLength, "a") : candidate
    const value = padded.slice(0, maxLength)
    if (value.length >= minLength && (pattern === undefined || pattern.test(value))) return value
  }
  throw new UnsupportedMockSchemaError(
    "pattern",
    `Cannot generate a value for pattern ${JSON.stringify(schema.pattern)}`,
  )
}

// ---------------------------------------------------------------------------
// Schema introspection → mock value generation
// ---------------------------------------------------------------------------

/**
 * Generate a mock value from a schema object. Inspects JSON Schema properties
 * (`type`, `properties`, `items`, `enum`, `format`) that TypeBox / NifraSchema
 * objects carry directly. Unsupported constraints fail closed with
 * {@link UnsupportedMockSchemaError} rather than returning a known-invalid response.
 *
 * @param schema  A JSON-Schema-shaped object (TypeBox, NifraSchema, or raw JSON Schema)
 * @param fieldName  Optional field name hint for generating contextual string values
 * @param rng  Optional seeded random function for deterministic output
 */
export function generateMockValue(
  schema: unknown,
  fieldName?: string | undefined,
  rng?: (() => number) | undefined,
): unknown {
  const rand = rng ?? Math.random

  const reflected = reflectSchema(schema).jsonSchema
  if (reflected === true || reflected === undefined) return {}
  if (reflected === false) {
    throw new UnsupportedMockSchemaError("false", "Boolean false schema has no valid value")
  }
  const raw = reflected

  if ("const" in raw) return raw.const
  if (raw.$ref !== undefined) {
    throw new UnsupportedMockSchemaError(
      "$ref",
      "Resolve JSON Schema references before generating mocks",
    )
  }
  if (raw.not !== undefined) {
    throw new UnsupportedMockSchemaError("not", "JSON Schema `not` generation is unsupported")
  }
  if (raw.oneOf !== undefined) {
    throw new UnsupportedMockSchemaError(
      "oneOf",
      "Exclusive union generation requires a schema validator",
    )
  }
  const alternatives = raw.anyOf as readonly unknown[] | undefined
  if (Array.isArray(alternatives) && alternatives.length > 0) {
    return generateMockValue(alternatives[randomIndex(rand, alternatives.length)], fieldName, rand)
  }
  const intersections = raw.allOf as readonly unknown[] | undefined
  if (Array.isArray(intersections) && intersections.length > 0) {
    const values = intersections.map((part) => generateMockValue(part, fieldName, rand))
    if (
      values.every((value) => value !== null && typeof value === "object" && !Array.isArray(value))
    ) {
      return Object.assign({}, ...values)
    }
    const first = values[0]
    if (values.every((value) => Object.is(value, first))) return first
    throw new UnsupportedMockSchemaError(
      "allOf",
      "Could not prove that a scalar satisfies every intersection branch",
    )
  }

  // Enum — pick the first value (deterministic) or random
  const enumValues = raw.enum as readonly unknown[] | undefined
  if (enumValues && Array.isArray(enumValues) && enumValues.length > 0) {
    return enumValues[randomIndex(rand, enumValues.length)]
  }

  const declaredType = raw.type as string | readonly string[] | undefined
  const type = Array.isArray(declaredType)
    ? (declaredType.find((candidate) => candidate !== "null") ?? "null")
    : declaredType

  switch (type) {
    case "string": {
      const format = raw.format as string | undefined
      switch (format) {
        case "email":
          return constrainedString(raw, `mock@${fieldName ?? "example"}.com`, fieldName)
        case "uri":
        case "url":
          return constrainedString(raw, `https://${fieldName ?? "example"}.mock.dev`, fieldName)
        case "date":
          return constrainedString(raw, "2025-01-15", fieldName)
        case "date-time":
          return constrainedString(raw, "2025-01-15T12:00:00.000Z", fieldName)
        case "uuid":
          return constrainedString(raw, "00000000-0000-4000-8000-000000000001", fieldName)
        default:
          return constrainedString(raw, `mock_${fieldName ?? "value"}`, fieldName)
      }
    }

    case "number": {
      const { min, max } = numericBounds(raw)
      const multipleOf = typeof raw.multipleOf === "number" ? raw.multipleOf : undefined
      if (multipleOf !== undefined && multipleOf <= 0) {
        throw new UnsupportedMockSchemaError("multipleOf", "multipleOf must be positive")
      }
      if (multipleOf !== undefined) {
        const first = Math.ceil(min / multipleOf) * multipleOf
        const last = Math.floor(max / multipleOf) * multipleOf
        if (first > last)
          throw new UnsupportedMockSchemaError("multipleOf", "No multiple exists in range")
        const steps = Math.floor((last - first) / multipleOf)
        return first + Math.floor(rand() * (steps + 1)) * multipleOf
      }
      return Math.round((min + rand() * (max - min)) * 100) / 100
    }

    case "integer": {
      const { min, max } = numericBounds(raw)
      const multipleOf = typeof raw.multipleOf === "number" ? raw.multipleOf : 1
      const first = Math.ceil(min / multipleOf) * multipleOf
      const last = Math.floor(max / multipleOf) * multipleOf
      if (first > last)
        throw new UnsupportedMockSchemaError("integer", "No integer exists in range")
      const steps = Math.floor((last - first) / multipleOf)
      return first + Math.floor(rand() * (steps + 1)) * multipleOf
    }

    case "boolean":
      return true

    case "null":
      return null

    case "array": {
      const items = raw.items as Record<string, unknown> | undefined
      if (!items) return []
      const minItems = typeof raw.minItems === "number" ? raw.minItems : 1
      const maxItems = typeof raw.maxItems === "number" ? raw.maxItems : Math.max(minItems, 3)
      if (minItems > maxItems) {
        throw new UnsupportedMockSchemaError("minItems", "Array schema has no satisfiable length")
      }
      const count = minItems + Math.floor(rand() * (maxItems - minItems + 1))
      const result: unknown[] = []
      for (let i = 0; i < count; i++) {
        result.push(generateMockValue(items, `${fieldName ?? "item"}_${i}`, rand))
      }
      if (
        raw.uniqueItems === true &&
        new Set(result.map((value) => JSON.stringify(value))).size !== result.length
      ) {
        throw new UnsupportedMockSchemaError(
          "uniqueItems",
          "Could not generate enough unique items",
        )
      }
      return result
    }

    default: {
      const properties = raw.properties as Record<string, Record<string, unknown>> | undefined
      if (!properties || typeof properties !== "object") return {}

      const result: Record<string, unknown> = {}
      for (const [key, propSchema] of Object.entries(properties)) {
        result[key] = generateMockValue(propSchema, key, rand)
      }
      return result
    }
  }
}

// ---------------------------------------------------------------------------
// Mock server
// ---------------------------------------------------------------------------

/** Minimal route shape returned by `app.routes()`. */
export interface MockableRoute {
  readonly method: string
  readonly path: string
  readonly schema?:
    | {
        readonly response?: unknown
      }
    | undefined
}

/** App shape — anything with a `routes()` method. */
export interface MockableApp {
  routes(): readonly MockableRoute[]
}

export interface MockServerOptions {
  /** Seed for deterministic mock generation. */
  readonly seed?: number | undefined
  /** Log mock requests to console. */
  readonly verbose?: boolean | undefined
}

export interface MockServer {
  /** Handle a request against the mock routes. */
  fetch(request: Request): Promise<Response>
  /** The generated mock routes for inspection. */
  readonly mockRoutes: ReadonlyArray<{ method: string; path: string }>
}

/**
 * Create a mock server from a Nifra app's route definitions. For each route
 * with a `schema.response`, generates a handler returning fake data that
 * matches the response schema structure. Routes without response schemas
 * return `{}`.
 */
export function createMockServer(
  app: MockableApp,
  options?: MockServerOptions | undefined,
): MockServer {
  const seed = options?.seed ?? 42
  const verbose = options?.verbose ?? false

  const routes = reflectRoutes(app)

  // Pre-generate mock responses for each route
  const mockMap = new Map<string, unknown>()
  const mockRoutes: Array<{ method: string; path: string }> = []

  for (const route of routes) {
    const key = `${route.method.toUpperCase()} ${route.path}`
    const rng = seededRandom(seed)
    const responseSchema = route.schema?.response?.jsonSchema
    const mockValue = responseSchema ? generateMockValue(responseSchema, undefined, rng) : {}
    mockMap.set(key, mockValue)
    mockRoutes.push({ method: route.method.toUpperCase(), path: route.path })
  }

  return {
    mockRoutes,

    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url)
      const method = request.method.toUpperCase()
      const pathname = url.pathname

      // Exact match first
      const exactKey = `${method} ${pathname}`
      if (mockMap.has(exactKey)) {
        if (verbose) console.log(`[mock] ${exactKey} → 200`)
        return new Response(JSON.stringify(mockMap.get(exactKey)), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-nifra-mock": "true",
          },
        })
      }

      // Try matching parameterized routes (e.g. /users/:id → /users/123)
      for (const [key, value] of mockMap) {
        const [routeMethod, routePath] = key.split(" ", 2)
        if (routeMethod !== method || !routePath) continue

        if (matchParameterizedPath(routePath, pathname)) {
          if (verbose) console.log(`[mock] ${method} ${pathname} → ${routePath} → 200`)
          return new Response(JSON.stringify(value), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-nifra-mock": "true",
            },
          })
        }
      }

      if (verbose) console.log(`[mock] ${method} ${pathname} → 404`)
      return new Response(JSON.stringify({ error: "Not Found", mock: true }), {
        status: 404,
        headers: { "content-type": "application/json", "x-nifra-mock": "true" },
      })
    },
  }
}

/**
 * Match a parameterized route pattern (e.g. `/users/:id`) against a concrete pathname.
 * Supports non-empty `:param` segments and Nifra's trailing `*wildcard` segment.
 */
function matchParameterizedPath(pattern: string, pathname: string): boolean {
  const patternParts = pattern.split("/")
  const pathParts = pathname.split("/")

  const wildcardIndex = patternParts.findIndex((part) => part.startsWith("*"))
  if (wildcardIndex === -1 && patternParts.length !== pathParts.length) return false
  if (wildcardIndex !== -1 && wildcardIndex !== patternParts.length - 1) return false
  if (wildcardIndex !== -1 && pathParts.length < wildcardIndex + 1) return false

  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i]
    const actual = pathParts[i]
    if (pp === undefined || actual === undefined) return false
    if (pp.startsWith("*")) return true
    if (pp.startsWith(":")) {
      if (actual.length === 0) return false
      continue
    }
    if (pp !== actual) return false
  }

  return true
}

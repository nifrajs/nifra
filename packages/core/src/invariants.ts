/**
 * Contract-generated invariant tests: the declared contract *is* the test suite.
 *
 * `runContractInvariants(app)` reads each route's reflected contract (schemas, classification) and
 * verifies, with deterministic seeded fuzzing, the properties the contract already promises:
 *
 *  1. **Classification consistency** (static) — a route whose response fields are tagged more
 *     sensitive than its declared route-level classification is understating what it emits.
 *  2. **Valid input never crashes** (dynamic) — schema-generated valid requests must not produce 5xx.
 *  3. **Response conformance** (dynamic) — a 2xx response body must validate against the declared
 *     response schema; an undeclared response shape is exactly where sensitive data leaks.
 *  4. **Validation fails closed** (dynamic) — schema-violating bodies must be rejected (4xx), never
 *     accepted (2xx) and never crash (5xx).
 *
 * Everything is deterministic: a seeded PRNG (no ambient randomness, no wall clock), so a failing
 * case reproduces from its seed. Routes whose inputs cannot be generated from their JSON Schema are
 * reported in `skipped` — never silently dropped.
 */

import {
  classificationAtLeast,
  type DataClassification,
  isDataClassification,
  reflectClassification,
} from "./classification.ts"
import { type ReflectedRoute, reflectRoutes, type SchemaReflection } from "./reflection.ts"
import type { StandardSchemaV1 } from "./schema/standard.ts"

export type InvariantFindingCode =
  | "classification-understated"
  | "server-error-on-valid-input"
  | "response-schema-violation"
  | "validation-bypass"
  | "server-error-on-invalid-input"

export interface InvariantFinding {
  readonly code: InvariantFindingCode
  readonly method: string
  readonly path: string
  /** The case's deterministic seed — rerun with it to reproduce the exact request. */
  readonly seed?: number
  readonly message: string
}

export interface SkippedRoute {
  readonly method: string
  readonly path: string
  readonly reason: string
}

export interface InvariantReport {
  readonly ok: boolean
  /** Routes exercised dynamically. */
  readonly tested: readonly { readonly method: string; readonly path: string }[]
  /** Routes that could not be exercised, with the reason — reported, never silently dropped. */
  readonly skipped: readonly SkippedRoute[]
  readonly findings: readonly InvariantFinding[]
}

export interface RunInvariantsOptions {
  /** Deterministic seed for the fuzzer. Default 1. */
  readonly seed?: number
  /** Valid-input cases per route. Default 8. */
  readonly casesPerRoute?: number
  /** Invalid-input (mutated) cases per route with a body schema. Default 4. */
  readonly invalidCasesPerRoute?: number
  /**
   * Explicit isolated executor for dynamic cases. It must point at a disposable test app, sandbox,
   * or transaction that is rolled back. The runner never calls `source.fetch()` implicitly: doing so
   * could charge cards, send mail, or mutate production state merely by running a verification tool.
   */
  readonly executor?: InvariantExecutor
}

export type InvariantExecutor = (request: Request) => Response | Promise<Response>

/** Opaque route-reflection source. The runner never invokes an app's live fetch method implicitly. */
type ReflectableApp = object

/**
 * The route-level classification exactly as DECLARED (`schema.classification`). Reflection merges the
 * declared value with field tags into one maximum, which erases the understatement signal — so the
 * consistency check reads the raw descriptor instead.
 */
function declaredClassifications(app: ReflectableApp): Map<string, DataClassification> {
  const declared = new Map<string, DataClassification>()
  const routes = (app as { routes?: () => unknown }).routes?.()
  if (!Array.isArray(routes)) return declared
  for (const candidate of routes) {
    const route = recordOf(candidate)
    const schema = recordOf(route?.schema)
    const value = schema?.classification
    if (
      typeof route?.method === "string" &&
      typeof route.path === "string" &&
      isDataClassification(value)
    ) {
      declared.set(`${route.method.toUpperCase()}\n${route.path}`, value)
    }
  }
  return declared
}

/** Deterministic PRNG (mulberry32). Ambient randomness would make failures unreproducible. */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type JsonRecord = Readonly<Record<string, unknown>>

const recordOf = (value: unknown): JsonRecord | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined

class UngeneratableSchemaError extends Error {}

const SAFE_TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789"

function randomToken(rng: () => number, length: number): string {
  let out = ""
  for (let index = 0; index < length; index++) {
    out += SAFE_TOKEN[Math.floor(rng() * SAFE_TOKEN.length)]
  }
  return out
}

/**
 * Generate one value satisfying a JSON Schema (the introspectable subset nifra schemas emit).
 * Throws {@link UngeneratableSchemaError} for shapes it cannot honor — the route is then skipped
 * (and reported), never fuzzed with garbage that would produce false findings.
 */
function generateFromJsonSchema(schema: unknown, rng: () => number, depth = 0): unknown {
  if (depth > 8) throw new UngeneratableSchemaError("schema nesting exceeds the generator depth")
  const node = recordOf(schema)
  if (node === undefined) throw new UngeneratableSchemaError("schema node is not an object")
  if (node.const !== undefined) return node.const
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    return node.enum[Math.floor(rng() * node.enum.length)]
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    const variants = node[key]
    if (Array.isArray(variants) && variants.length > 0) {
      return generateFromJsonSchema(variants[Math.floor(rng() * variants.length)], rng, depth + 1)
    }
  }
  const type = Array.isArray(node.type) ? node.type[0] : node.type
  switch (type) {
    case "string": {
      const minLength = node.minLength === undefined ? 0 : node.minLength
      const maxLength =
        node.maxLength === undefined ? Math.max(12, minLength as number) : node.maxLength
      if (node.pattern !== undefined || node.format !== undefined) {
        throw new UngeneratableSchemaError("string pattern/format generation is not supported")
      }
      if (
        !Number.isSafeInteger(minLength) ||
        !Number.isSafeInteger(maxLength) ||
        (minLength as number) < 0 ||
        (maxLength as number) < (minLength as number) ||
        (minLength as number) > 4_096
      ) {
        throw new UngeneratableSchemaError("string length bounds cannot be generated safely")
      }
      const upper = Math.min(maxLength as number, (minLength as number) + 12)
      const length = (minLength as number) + Math.floor(rng() * (upper - (minLength as number) + 1))
      return randomToken(rng, length)
    }
    case "number":
    case "integer": {
      if (
        node.exclusiveMinimum !== undefined ||
        node.exclusiveMaximum !== undefined ||
        node.multipleOf !== undefined
      ) {
        throw new UngeneratableSchemaError(
          "exclusive/multiple numeric constraints are not supported",
        )
      }
      const minimum = typeof node.minimum === "number" ? node.minimum : 0
      const maximum = typeof node.maximum === "number" ? node.maximum : minimum + 1000
      if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum < minimum) {
        throw new UngeneratableSchemaError("numeric bounds cannot be generated")
      }
      if (type === "integer") {
        const lower = Math.ceil(minimum)
        const upper = Math.floor(maximum)
        if (!Number.isSafeInteger(lower) || !Number.isSafeInteger(upper) || upper < lower) {
          throw new UngeneratableSchemaError("integer bounds cannot be generated safely")
        }
        return lower + Math.floor(rng() * (upper - lower + 1))
      }
      return minimum + rng() * (maximum - minimum)
    }
    case "boolean":
      return rng() < 0.5
    case "null":
      return null
    case "array": {
      if (node.uniqueItems === true || node.contains !== undefined) {
        throw new UngeneratableSchemaError("array uniqueItems/contains generation is not supported")
      }
      const minItems = node.minItems === undefined ? 0 : node.minItems
      const maxItems = node.maxItems === undefined ? (minItems as number) + 2 : node.maxItems
      if (
        !Number.isSafeInteger(minItems) ||
        !Number.isSafeInteger(maxItems) ||
        (minItems as number) < 0 ||
        (maxItems as number) < (minItems as number) ||
        (minItems as number) > 256
      ) {
        throw new UngeneratableSchemaError("array bounds cannot be generated safely")
      }
      const count =
        (minItems as number) +
        Math.floor(
          rng() *
            (Math.min(maxItems as number, (minItems as number) + 2) - (minItems as number) + 1),
        )
      if (node.items === undefined) {
        return Array.from({ length: count }, () => null)
      }
      const out: unknown[] = []
      for (let index = 0; index < count; index++) {
        out.push(generateFromJsonSchema(node.items, rng, depth + 1))
      }
      return out
    }
    case "object": {
      const properties = recordOf(node.properties) ?? {}
      const requiredValues = Array.isArray(node.required) ? node.required : []
      if (requiredValues.some((value) => typeof value !== "string" || !(value in properties))) {
        throw new UngeneratableSchemaError("required object property has no schema")
      }
      if (
        node.minProperties !== undefined ||
        node.maxProperties !== undefined ||
        node.dependentRequired !== undefined ||
        node.dependentSchemas !== undefined
      ) {
        throw new UngeneratableSchemaError(
          "advanced object cardinality/dependency generation is not supported",
        )
      }
      const required = new Set(requiredValues as string[])
      const out: Record<string, unknown> = {}
      for (const [name, child] of Object.entries(properties)) {
        // Required properties always; optional ones half the time — both branches get exercised.
        if (required.has(name) || rng() < 0.5) {
          out[name] = generateFromJsonSchema(child, rng, depth + 1)
        }
      }
      return out
    }
    default:
      throw new UngeneratableSchemaError(`unsupported schema type ${JSON.stringify(type)}`)
  }
}

/** Mutate a valid object body so it unambiguously violates its schema (remove a required property). */
function mutateInvalid(schema: unknown, valid: unknown): unknown | undefined {
  const node = recordOf(schema)
  const properties = recordOf(node?.properties)
  const required = Array.isArray(node?.required) ? (node.required as string[]) : []
  const target = required[0]
  if (
    node?.type !== "object" ||
    properties === undefined ||
    target === undefined ||
    recordOf(valid) === undefined
  ) {
    return undefined
  }
  const invalid = { ...(valid as Record<string, unknown>) }
  delete invalid[target]
  return invalid
}

function fillPathParams(pattern: string, rng: () => number): string {
  return pattern
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) return randomToken(rng, 8)
      if (segment.startsWith("*") || segment === "*") return randomToken(rng, 8)
      return segment
    })
    .join("/")
}

function querySearchOf(query: unknown): string {
  const record = recordOf(query)
  if (record === undefined) return ""
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(record)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== null && typeof item === "object") {
          throw new UngeneratableSchemaError("nested query values are not serializable")
        }
        params.append(key, String(item))
      }
    } else if (value !== undefined && value !== null && typeof value !== "object") {
      params.set(key, String(value))
    } else if (value !== undefined && value !== null) {
      throw new UngeneratableSchemaError("nested query values are not serializable")
    }
  }
  const text = params.toString()
  return text === "" ? "" : `?${text}`
}

async function validateAgainst(
  standard: StandardSchemaV1,
  value: unknown,
): Promise<readonly { readonly message: string }[] | undefined> {
  const result = standard["~standard"].validate(value)
  const settled = result instanceof Promise ? await result : result
  return settled.issues
}

interface RoutePlan {
  readonly route: ReflectedRoute
  readonly body?: SchemaReflection
  readonly query?: SchemaReflection
}

const FUZZABLE_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"])

/** Run the contract-derived invariant suite against a reflectable app. Pure; no ambient state. */
/**
 * @deprecated Use `runAdversarialContract` from `@nifrajs/testing`. The testing package is the
 * authoritative deep contract laboratory and powers CLI L4; this export remains for compatibility.
 */
export async function runContractInvariants(
  app: ReflectableApp,
  options: RunInvariantsOptions = {},
): Promise<InvariantReport> {
  const seed = options.seed ?? 1
  if (!Number.isSafeInteger(seed)) throw new TypeError("invariants: seed must be a safe integer")
  const casesPerRoute = options.casesPerRoute ?? 8
  const invalidCasesPerRoute = options.invalidCasesPerRoute ?? 4
  if (
    !Number.isSafeInteger(casesPerRoute) ||
    !Number.isSafeInteger(invalidCasesPerRoute) ||
    casesPerRoute < 1 ||
    invalidCasesPerRoute < 0
  ) {
    throw new RangeError("invariants: case counts must be safe integers and valid")
  }
  if (options.executor !== undefined && typeof options.executor !== "function") {
    throw new TypeError("invariants: executor must be a function")
  }

  const findings: InvariantFinding[] = []
  const tested: { method: string; path: string }[] = []
  const skipped: SkippedRoute[] = []
  const declared = declaredClassifications(app)

  for (const route of reflectRoutes(app)) {
    // 1. Static classification consistency — needs no requests at all.
    const declaredMax: DataClassification | undefined = declared.get(
      `${route.method}\n${route.path}`,
    )
    const fieldReflected = reflectClassification(route.schema?.response?.standard)
    if (
      declaredMax !== undefined &&
      fieldReflected !== undefined &&
      !classificationAtLeast(declaredMax, fieldReflected.max)
    ) {
      findings.push({
        code: "classification-understated",
        method: route.method,
        path: route.path,
        message: `${route.method} ${route.path} declares ${declaredMax} but its response fields are tagged ${fieldReflected.max}`,
      })
    }

    if (!FUZZABLE_METHODS.has(route.method)) {
      skipped.push({ method: route.method, path: route.path, reason: "method not fuzzable" })
      continue
    }
    if (options.executor === undefined) {
      skipped.push({
        method: route.method,
        path: route.path,
        reason: "no isolated executor configured",
      })
      continue
    }
    const body = route.schema?.body
    const query = route.schema?.query
    if (body !== undefined && body.jsonSchema === undefined) {
      skipped.push({
        method: route.method,
        path: route.path,
        reason: "body schema exposes no JSON Schema metadata",
      })
      continue
    }
    if (query !== undefined && query.jsonSchema === undefined) {
      skipped.push({
        method: route.method,
        path: route.path,
        reason: "query schema exposes no JSON Schema metadata",
      })
      continue
    }
    if (route.schema?.sse !== undefined) {
      skipped.push({ method: route.method, path: route.path, reason: "streaming route" })
      continue
    }

    const plan: RoutePlan = {
      route,
      ...(body !== undefined ? { body } : {}),
      ...(query !== undefined ? { query } : {}),
    }
    const outcome = await fuzzRoute(
      options.executor,
      plan,
      seed,
      casesPerRoute,
      invalidCasesPerRoute,
      findings,
    )
    if (outcome === "tested") tested.push({ method: route.method, path: route.path })
    else skipped.push({ method: route.method, path: route.path, reason: outcome })
  }

  return Object.freeze({
    ok: findings.length === 0,
    tested: Object.freeze(tested),
    skipped: Object.freeze(skipped),
    findings: Object.freeze(findings),
  })
}

async function fuzzRoute(
  execute: InvariantExecutor,
  plan: RoutePlan,
  baseSeed: number,
  casesPerRoute: number,
  invalidCasesPerRoute: number,
  findings: InvariantFinding[],
): Promise<"tested" | string> {
  const { route } = plan
  for (let caseIndex = 0; caseIndex < casesPerRoute; caseIndex++) {
    const caseSeed = baseSeed * 1000 + caseIndex
    const rng = createSeededRandom(caseSeed)
    let bodyValue: unknown
    let queryValue: unknown
    try {
      bodyValue =
        plan.body === undefined ? undefined : generateFromJsonSchema(plan.body.jsonSchema, rng)
      queryValue =
        plan.query?.jsonSchema === undefined
          ? undefined
          : generateFromJsonSchema(plan.query.jsonSchema, rng)
      // Query values must survive URL serialization; fail honestly instead of silently dropping
      // nested values and calling the resulting request schema-valid.
      querySearchOf(queryValue)
    } catch (err) {
      return err instanceof UngeneratableSchemaError ? err.message : String(err)
    }

    const path = `${fillPathParams(route.path, rng)}${querySearchOf(queryValue)}`
    const request = new Request(`http://invariants.local${path}`, {
      method: route.method,
      ...(bodyValue !== undefined
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(bodyValue),
          }
        : {}),
    })
    let response: Response
    try {
      response = await execute(request)
      if (!(response instanceof Response)) throw new TypeError("executor returned a non-Response")
    } catch {
      findings.push({
        code: "server-error-on-valid-input",
        method: route.method,
        path: route.path,
        seed: caseSeed,
        message: `${route.method} ${route.path} executor threw for a schema-valid input (seed ${caseSeed})`,
      })
      continue
    }

    // 2. Valid input must never crash.
    if (response.status >= 500) {
      findings.push({
        code: "server-error-on-valid-input",
        method: route.method,
        path: route.path,
        seed: caseSeed,
        message: `${route.method} ${route.path} returned ${response.status} for a schema-valid input (seed ${caseSeed})`,
      })
      continue
    }
    // 3. A 2xx JSON response must conform to the declared response contract.
    const responseStandard = plan.route.schema?.response?.standard
    if (responseStandard !== undefined && response.status < 300) {
      const contentType = response.headers.get("content-type") ?? ""
      if (!contentType.includes("application/json")) {
        findings.push({
          code: "response-schema-violation",
          method: route.method,
          path: route.path,
          seed: caseSeed,
          message: `${route.method} ${route.path} returned non-JSON content for its declared response schema (seed ${caseSeed})`,
        })
        continue
      }
      let responseValue: unknown
      try {
        responseValue = await response.clone().json()
      } catch {
        findings.push({
          code: "response-schema-violation",
          method: route.method,
          path: route.path,
          seed: caseSeed,
          message: `${route.method} ${route.path} returned malformed JSON for its declared response schema (seed ${caseSeed})`,
        })
        continue
      }
      const issues = await validateAgainst(responseStandard, responseValue)
      if (issues !== undefined) {
        findings.push({
          code: "response-schema-violation",
          method: route.method,
          path: route.path,
          seed: caseSeed,
          message: `${route.method} ${route.path} response violates its declared schema (seed ${caseSeed}): ${issues[0]?.message ?? "invalid"}`,
        })
      }
    }
  }

  // 4. Schema-violating bodies must be rejected — 4xx, never accepted, never a crash.
  if (plan.body?.jsonSchema !== undefined) {
    for (let caseIndex = 0; caseIndex < invalidCasesPerRoute; caseIndex++) {
      const caseSeed = baseSeed * 1000 + 500 + caseIndex
      const rng = createSeededRandom(caseSeed)
      let invalid: unknown
      try {
        invalid = mutateInvalid(
          plan.body.jsonSchema,
          generateFromJsonSchema(plan.body.jsonSchema, rng),
        )
      } catch {
        invalid = undefined
      }
      if (invalid === undefined) break
      let response: Response
      try {
        response = await execute(
          new Request(`http://invariants.local${fillPathParams(route.path, rng)}`, {
            method: route.method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(invalid),
          }),
        )
        if (!(response instanceof Response)) throw new TypeError("executor returned a non-Response")
      } catch {
        findings.push({
          code: "server-error-on-invalid-input",
          method: route.method,
          path: route.path,
          seed: caseSeed,
          message: `${route.method} ${route.path} executor threw on a schema-violating body (seed ${caseSeed})`,
        })
        continue
      }
      if (response.status < 300) {
        findings.push({
          code: "validation-bypass",
          method: route.method,
          path: route.path,
          seed: caseSeed,
          message: `${route.method} ${route.path} accepted a schema-violating body (seed ${caseSeed})`,
        })
      } else if (response.status >= 500) {
        findings.push({
          code: "server-error-on-invalid-input",
          method: route.method,
          path: route.path,
          seed: caseSeed,
          message: `${route.method} ${route.path} crashed (${response.status}) on a schema-violating body (seed ${caseSeed})`,
        })
      }
    }
  }
  return "tested"
}

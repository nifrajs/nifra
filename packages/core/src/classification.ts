/**
 * Response data-classification tags. A route can declare the highest sensitivity its response body
 * carries (`schema.classification`). This is a declarative, compile-time + introspection fact — never
 * read on the request hot path and never enforced at runtime here. Downstream consumers use it: a
 * partner-API surface refuses to expose a route whose response is `pii`/`secret`, privacy tooling
 * learns which routes emit regulated data, and the capability lockfile records it so a route that
 * *starts* returning PII flips the lockfile and forces a review.
 */

/** Sensitivity of the data a response carries. Ordered `public` < `pii` < `secret`. */
export type DataClassification = "public" | "pii" | "secret"

/** Field paths use JSON Pointer segments; array items use a `*` segment. */
export interface ResponseClassification {
  readonly fields: Readonly<Record<string, DataClassification>>
  readonly max: DataClassification
}

const CLASSIFICATION = Symbol.for("nifra.data-classification")
const JSON_SCHEMA_CLASSIFICATION = "x-nifra-classification"

type ClassificationCarrier = {
  readonly [CLASSIFICATION]?: DataClassification
  readonly jsonSchema?: unknown
}

export type ClassifiedSchema<S extends object> = S & {
  readonly [CLASSIFICATION]: DataClassification
}

/** Total order over classifications; higher = more sensitive. */
export const DATA_CLASSIFICATION_RANK: Readonly<Record<DataClassification, number>> = Object.freeze(
  {
    public: 0,
    pii: 1,
    secret: 2,
  },
)

const CLASSIFICATIONS = Object.keys(DATA_CLASSIFICATION_RANK) as readonly DataClassification[]

/** Whether `value` is a known classification token. */
export function isDataClassification(value: unknown): value is DataClassification {
  return typeof value === "string" && (CLASSIFICATIONS as readonly string[]).includes(value)
}

/** The most sensitive classification among the inputs; `"public"` when none are given. */
export function maxClassification(values: Iterable<DataClassification>): DataClassification {
  let max: DataClassification = "public"
  for (const value of values) {
    if (DATA_CLASSIFICATION_RANK[value] > DATA_CLASSIFICATION_RANK[max]) max = value
  }
  return max
}

/** True when `value` is at least as sensitive as `floor` (e.g. `classificationAtLeast(x, "pii")`). */
export function classificationAtLeast(
  value: DataClassification,
  floor: DataClassification,
): boolean {
  return DATA_CLASSIFICATION_RANK[value] >= DATA_CLASSIFICATION_RANK[floor]
}

function cloneObject<T extends object>(value: T): T {
  return Object.create(Object.getPrototypeOf(value), Object.getOwnPropertyDescriptors(value)) as T
}

function tagObject<T extends object>(value: T, classification: DataClassification): T {
  const clone = cloneObject(value)
  Object.defineProperty(clone, CLASSIFICATION, {
    configurable: false,
    enumerable: true,
    value: classification,
    writable: false,
  })
  Object.defineProperty(clone, JSON_SCHEMA_CLASSIFICATION, {
    configurable: true,
    enumerable: true,
    value: classification,
    writable: true,
  })
  return clone
}

/**
 * Attach data-classification metadata without changing validation or inferred input/output types.
 * For Nifra/TypeBox carriers the raw JSON Schema node is tagged too, so metadata survives composition
 * through `t.object`, `t.array`, `t.optional`, and unions.
 */
export function classified<S extends object>(
  schema: S,
  classification: DataClassification,
): ClassifiedSchema<S> {
  if (!isDataClassification(classification)) {
    throw new TypeError(`classification: invalid tag ${JSON.stringify(classification)}`)
  }
  const clone = tagObject(schema, classification) as S & ClassificationCarrier
  const raw = (schema as ClassificationCarrier).jsonSchema
  if (raw !== null && typeof raw === "object") {
    Object.defineProperty(clone, "jsonSchema", {
      configurable: true,
      enumerable: true,
      value: tagObject(raw, classification),
      writable: false,
    })
  }
  return clone as ClassifiedSchema<S>
}

const recordOf = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object"
    ? (value as Readonly<Record<string, unknown>>)
    : undefined

const classificationOf = (value: unknown): DataClassification | undefined => {
  const record = recordOf(value)
  const symbolValue = (value as ClassificationCarrier | null)?.[CLASSIFICATION]
  if (isDataClassification(symbolValue)) return symbolValue
  const extension = record?.[JSON_SCHEMA_CLASSIFICATION]
  return isDataClassification(extension) ? extension : undefined
}

const pointerSegment = (value: string): string => value.replaceAll("~", "~0").replaceAll("/", "~1")

/** Read field-level metadata from an introspectable response schema. Never invokes its validator. */
export function reflectClassification(schema: unknown): ResponseClassification | undefined {
  const carrier = recordOf(schema)
  const raw = carrier !== undefined && "jsonSchema" in carrier ? carrier.jsonSchema : schema
  const fields: Record<string, DataClassification> = {}
  const seen = new Set<object>()
  const all: DataClassification[] = []

  const record = (path: string, value: DataClassification): void => {
    const key = path === "" ? "$" : path
    const previous = fields[key]
    fields[key] = previous === undefined ? value : maxClassification([previous, value])
    all.push(value)
  }

  const visit = (value: unknown, path: string): void => {
    const object = recordOf(value)
    if (object === undefined) return
    if (seen.has(object as object)) return
    seen.add(object as object)
    const own = classificationOf(value)
    if (own !== undefined) record(path, own)

    const properties = recordOf(object.properties)
    if (properties !== undefined) {
      for (const [name, child] of Object.entries(properties)) {
        visit(child, `${path}/${pointerSegment(name)}`)
      }
    }
    if (object.items !== undefined) visit(object.items, `${path}/*`)
    if (Array.isArray(object.prefixItems)) {
      for (const [index, child] of object.prefixItems.entries()) visit(child, `${path}/${index}`)
    }
    if (object.additionalProperties !== undefined && object.additionalProperties !== false) {
      visit(object.additionalProperties, `${path}/*`)
    }
    for (const key of ["allOf", "anyOf", "oneOf"] as const) {
      const variants = object[key]
      if (Array.isArray(variants)) for (const child of variants) visit(child, path)
    }
  }

  visit(raw, "")
  // A validation-only carrier can still carry a root tag even when it has no JSON Schema metadata.
  const carrierTag = classificationOf(schema)
  if (carrierTag !== undefined && all.length === 0) record("", carrierTag)
  if (all.length === 0) return undefined
  return Object.freeze({ fields: Object.freeze(fields), max: maxClassification(all) })
}

/** Merge field metadata with an optional route-level sensitivity fallback. */
export function routeClassification(
  responseSchema: unknown,
  fallback: DataClassification | undefined,
): ResponseClassification | undefined {
  const reflected = reflectClassification(responseSchema)
  if (reflected === undefined && fallback === undefined) return undefined
  return Object.freeze({
    fields: reflected?.fields ?? Object.freeze({}),
    max:
      fallback === undefined
        ? (reflected as ResponseClassification).max
        : maxClassification([fallback, ...(reflected === undefined ? [] : [reflected.max])]),
  })
}

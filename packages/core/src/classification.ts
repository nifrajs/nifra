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

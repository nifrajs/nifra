/**
 * Canonical JSON: object keys sorted by UTF-16 code unit, no whitespace, `undefined` members left out.
 *
 * Content hashes, manifest signatures, idempotency fingerprints and stored digests are all taken over
 * these bytes, so the output for JSON data never changes. A value JSON cannot carry throws instead of
 * hashing as something else: a non-finite number, an `undefined` or missing array item, a `Date`,
 * `Map` or class instance, a function, a symbol, a bigint. A `JSON.rawJSON` value is written verbatim.
 */

// biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the member is optional, so an engine without JSON.rawJSON leaves it undefined.
const isRawJson = (JSON as JSON & { readonly isRawJSON?: (value: unknown) => boolean }).isRawJSON

/** The canonical JSON text of `value`. Throws a `TypeError` on a value JSON cannot carry. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value)
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) return JSON.stringify(value)
  } else if (Array.isArray(value)) {
    // Each level is joined into a flat string: a `+=` rope builds faster, but on Bun it costs more
    // once a caller reads it. An undefined or missing item recurses into the refusal below.
    const items = new Array<string>(value.length)
    for (let i = 0; i < value.length; i++) items[i] = canonicalJson(value[i])
    return `[${items.join(",")}]`
  } else if (typeof value === "object") {
    const proto: unknown = Object.getPrototypeOf(value)
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: isRawJSON vouched for it, and a raw JSON value keeps its text in `rawJSON`.
    if (proto === null && isRawJson?.(value) === true) return (value as { rawJSON: string }).rawJSON
    // Any prototype whose own prototype is null passes, which admits another realm's plain object.
    if (proto === null || proto === Object.prototype || Object.getPrototypeOf(proto) === null) {
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a non-array object with a plain or null prototype; only its own string keys are read.
      const record = value as Readonly<Record<string, unknown>>
      const members: string[] = []
      for (const key of Object.keys(record).sort()) {
        const field = record[key]
        if (field !== undefined) members.push(`${JSON.stringify(key)}:${canonicalJson(field)}`)
      }
      return `{${members.join(",")}}`
    }
  }
  throw new TypeError(
    `canonical JSON cannot encode ${typeof value === "object" ? "a non-plain object" : typeof value === "number" ? value : typeof value}`,
  )
}

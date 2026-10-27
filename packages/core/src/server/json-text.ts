/**
 * JSON has no `bigint`, and `JSON.stringify` throws on one, so a handler returning a database's 64-bit
 * id answered a 500. Every plain JSON writer goes through this instead: a `bigint` is written as its
 * decimal string, the encoding OpenAPI generators and protobuf's JSON mapping use for 64-bit integers.
 * Only a first attempt that threw is retried, so a value without one costs nothing more. The Node
 * adapter runs a generated copy (scripts/gen-vendored.ts), so this module imports nothing, and the
 * helpers core's other JSON walks share live here.
 */

const bigintAsText = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value

export const DATE_TO_JSON = Date.prototype.toJSON
// What `Date.prototype.toJSON` reads a `Date`'s time value through.
const DATE_TO_PRIMITIVE = Date.prototype[Symbol.toPrimitive]
const DATE_VALUE_OF = Date.prototype.valueOf

/**
 * Whether `date` reaches the `@@toPrimitive` and `valueOf` that `Date.prototype.toJSON` reads its time
 * value through as they ship, on itself, its class or `Date.prototype`. Then its steps, taken by the
 * caller, give what the call would: `null` for a time value that is not finite, else what its
 * `toISOString` answers, called through it as `toJSON` calls it.
 */
export const readsShippedTime = (date: Date): boolean =>
  date[Symbol.toPrimitive] === DATE_TO_PRIMITIVE && date.valueOf === DATE_VALUE_OF

/** Sets `key` on `out` as an own field, `__proto__` included, which an assignment takes as the prototype. */
export function define(out: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__")
    Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })
  else out[key] = value
}

// biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the member is optional, so an engine without JSON.rawJSON leaves it undefined.
export const isRawJson = (JSON as JSON & { readonly isRawJSON?: (value: unknown) => boolean })
  .isRawJSON

/**
 * Whether `proto` is a plain record's prototype: `Object.prototype`, `null`, or any prototype whose own
 * prototype is null, which admits another realm's plain object. A boxed primitive's or a class's is
 * not. A `JSON.rawJSON` value's is `null` too, so a caller tells one apart first.
 */
export const isPlainPrototype = (proto: unknown): boolean =>
  proto === null || proto === Object.prototype || Object.getPrototypeOf(proto) === null

/**
 * `JSON.stringify`, with each `bigint` written as its decimal string. Typed as the lib types
 * `JSON.stringify`: a value with no JSON form (`undefined`, a function) still gives `undefined`.
 */
export function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch (error) {
    return retried(value, error)
  }
}

/** Write `value` again, each `bigint` as text, after `JSON.stringify(value)` threw `error`; any other
 * failure rethrows `error`. */
export function retried(value: unknown, error: unknown): string {
  if (!(error instanceof TypeError)) throw error
  try {
    return JSON.stringify(value, bigintAsText)
  } catch {
    // A cycle or a throwing `toJSON` fails this pass too; the first error is the one to report.
    throw error
  }
}

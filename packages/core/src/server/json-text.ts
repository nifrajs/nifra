/**
 * JSON has no `bigint`, and `JSON.stringify` throws on one, so a handler returning a database's 64-bit
 * id answered a 500. Every plain JSON writer goes through this instead: a `bigint` is written as its
 * decimal string, the encoding OpenAPI generators and protobuf's JSON mapping use for 64-bit integers.
 * Only a first attempt that threw is retried, so a value without one costs nothing more. The Node
 * adapter runs a generated copy (scripts/gen-vendored.ts), so this module imports nothing.
 */

const bigintAsText = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value

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

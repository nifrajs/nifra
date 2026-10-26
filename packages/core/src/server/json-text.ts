/**
 * JSON has no `bigint`, and `JSON.stringify` throws on one, so a handler returning a database's 64-bit
 * id answered a 500. Every plain JSON writer goes through this instead: a `bigint` is written as its
 * decimal string, the encoding OpenAPI generators and protobuf's JSON mapping use for 64-bit integers.
 * Only a first attempt that threw is retried, so a value without one costs nothing more. The Node
 * adapter runs a generated copy (scripts/gen-vendored.ts), so this module imports nothing.
 */

const bigintAsText = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value

const DATE_TO_JSON = Date.prototype.toJSON
const DATE_TO_PRIMITIVE = Date.prototype[Symbol.toPrimitive]
const DATE_VALUE_OF = Date.prototype.valueOf
const DATE_TO_ISO_STRING = Date.prototype.toISOString

/**
 * Whether `value` is a `Date` that reaches `toJSON` and each method `toJSON` calls as they ship, so its
 * JSON can be written here, by `toJSON`'s own steps, with no code but the engine's.
 */
const isPlainDate = (value: object): value is Date =>
  value instanceof Date &&
  value.toJSON === DATE_TO_JSON &&
  value[Symbol.toPrimitive] === DATE_TO_PRIMITIVE &&
  value.valueOf === DATE_VALUE_OF &&
  value.toISOString === DATE_TO_ISO_STRING

// How far down the first row's path, and how many fields of each object, the probe looks.
const PROBE_DEPTH = 4
const PROBE_FIELDS = 64

/**
 * Whether a plain `Date` sits on `value`'s first path: an object's fields, a list's first item, a few
 * levels down. Allocates nothing, so a payload whose first row holds none costs only this look.
 */
function datesAhead(value: object, depth: number): boolean {
  if (value instanceof Date) return isPlainDate(value)
  if (depth === 0) return false
  if (Array.isArray(value)) {
    const first: unknown = value[0]
    return typeof first === "object" && first !== null && datesAhead(first, depth - 1)
  }
  let fields = 0
  for (const key in value) {
    if (++fields > PROBE_FIELDS) return false
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: `key` was enumerated from `value`; `Reflect.get` here halves the speed of this for-in.
    const field: unknown = (value as Record<string, unknown>)[key]
    if (typeof field === "object" && field !== null && datesAhead(field, depth - 1)) return true
  }
  return false
}

/**
 * `value` with each plain `Date` in it written as its JSON, copying only the containers above one.
 * What has a hook of its own, a byte view, a list of another class and a cycle are left as they are,
 * for the serializer.
 */
function datesWritten(value: object, path: object[]): unknown {
  if (isPlainDate(value)) return Number.isFinite(value.valueOf()) ? value.toISOString() : null
  if (
    typeof Reflect.get(value, "toJSON") === "function" ||
    ArrayBuffer.isView(value) ||
    path.includes(value)
  )
    return value
  path.push(value)
  let out: object | undefined
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) === Array.prototype) {
      let items: unknown[] | undefined
      for (let i = 0; i < value.length; i++) {
        const item: unknown = value[i]
        if (typeof item !== "object" || item === null) continue
        const written = datesWritten(item, path)
        if (written === item) continue
        items ??= value.slice()
        items[i] = written
      }
      out = items
    }
  } else {
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: every key read below comes from `Object.keys(value)`; `Reflect.get` costs a call per field.
    const record = value as Record<string, unknown>
    let fields: Record<string, unknown> | undefined
    for (const name of Object.keys(record)) {
      const field = record[name]
      if (typeof field !== "object" || field === null) continue
      const written = datesWritten(field, path)
      if (written === field) continue
      // A spread copies the own enumerable fields JSON writes, faster than one assignment each.
      fields ??= { ...record }
      if (name === "__proto__")
        Object.defineProperty(fields, name, {
          value: written,
          enumerable: true,
          writable: true,
          configurable: true,
        })
      else fields[name] = written
    }
    out = fields
  }
  path.pop()
  return out ?? value
}

/**
 * `value` as `JSON.stringify` takes it, with each plain `Date` already written when its first row
 * holds one: the engine's serializer leaves its fast path at a `Date`, several times slower. The probe
 * and the copy read those fields once more than the serializer does.
 */
export const withDatesWritten = (value: unknown): unknown =>
  typeof value === "object" && value !== null && datesAhead(value, PROBE_DEPTH)
    ? datesWritten(value, [])
    : value

/**
 * `JSON.stringify`, with each `bigint` written as its decimal string. Typed as the lib types
 * `JSON.stringify`: a value with no JSON form (`undefined`, a function) still gives `undefined`.
 */
export function jsonText(value: unknown): string {
  const written = withDatesWritten(value)
  try {
    return JSON.stringify(written)
  } catch (error) {
    return retried(written, error)
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

import { isRawJson } from "./json-shared.ts"
import { retried } from "./json-text.ts"

/** A JSON value would exceed the caller's UTF-8 byte budget. */
export class JsonByteLimitError extends RangeError {
  constructor() {
    super("JSON output exceeds the byte limit")
    this.name = "JsonByteLimitError"
  }
}

const OMIT_JSON_VALUE = Symbol("nifra.omitJsonValue")

interface JsonBudget {
  readonly maxBytes: number
  usedBytes: number
}

function addJsonBytes(budget: JsonBudget, bytes: number): void {
  if (bytes > budget.maxBytes - budget.usedBytes) throw new JsonByteLimitError()
  budget.usedBytes += bytes
}

/** Count a quoted JSON string without allocating its escaped representation. */
function countQuotedJsonString(value: string, budget: JsonBudget): void {
  addJsonBytes(budget, 2) // opening and closing quotes
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      addJsonBytes(budget, 2)
    } else if (code < 0x20) {
      addJsonBytes(budget, 6) // \\u00xx
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        addJsonBytes(budget, 4)
        index++
      } else {
        addJsonBytes(budget, 6) // well-formed JSON escapes a lone surrogate
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      addJsonBytes(budget, 6)
    } else {
      addJsonBytes(budget, code < 0x80 ? 1 : code < 0x800 ? 2 : 3)
    }
  }
}

/** Count the UTF-8 bytes of an already-encoded JSON fragment. */
function countRawJsonBytes(value: string, budget: JsonBudget): void {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    const next = value.charCodeAt(index + 1)
    if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      addJsonBytes(budget, 4)
      index++
    } else addJsonBytes(budget, code < 0x80 ? 1 : code < 0x800 ? 2 : 3)
  }
}

function ownJsonValue(value: object, key: string): unknown {
  const toJSON = Reflect.get(value, "toJSON")
  return typeof toJSON === "function" ? Reflect.apply(toJSON, value, [key]) : value
}

function normalizedJsonValue(
  value: unknown,
  key: string,
  budget: JsonBudget,
  ancestors: Set<object>,
): unknown | typeof OMIT_JSON_VALUE {
  if (typeof value === "object" && value !== null && isRawJson?.(value) === true) {
    const raw = Reflect.get(value, "rawJSON")
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The runtime guard below verifies this optional JSON.rawJSON extension is callable before use.
    const rawJSON = (JSON as JSON & { readonly rawJSON?: (text: string) => unknown }).rawJSON
    if (typeof raw !== "string" || typeof rawJSON !== "function")
      throw new TypeError("Could not serialize JSON.rawJSON")
    countRawJsonBytes(raw, budget)
    return rawJSON(raw)
  }
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    value = ownJsonValue(value, key)
  } else if (typeof value === "bigint") {
    const boxed = Object(value)
    const toJSON = Reflect.get(boxed, "toJSON")
    if (typeof toJSON === "function") value = Reflect.apply(toJSON, boxed, [key])
  }

  if (value === null) {
    addJsonBytes(budget, 4)
    return null
  }
  if (typeof value === "string") {
    countQuotedJsonString(value, budget)
    return value
  }
  if (typeof value === "boolean") {
    addJsonBytes(budget, value ? 4 : 5)
    return value
  }
  if (typeof value === "number") {
    const text = JSON.stringify(value)!
    addJsonBytes(budget, text.length) // JSON numbers are ASCII.
    return value
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol")
    return OMIT_JSON_VALUE
  if (typeof value === "bigint") throw new TypeError("Do not know how to serialize a BigInt")

  // JSON.stringify unwraps primitive wrapper objects before writing them.
  try {
    return normalizedJsonValue(Number.prototype.valueOf.call(value), key, budget, ancestors)
  } catch (error) {
    if (error instanceof JsonByteLimitError) throw error
  }
  try {
    return normalizedJsonValue(String.prototype.valueOf.call(value), key, budget, ancestors)
  } catch (error) {
    if (error instanceof JsonByteLimitError) throw error
  }
  try {
    return normalizedJsonValue(Boolean.prototype.valueOf.call(value), key, budget, ancestors)
  } catch (error) {
    if (error instanceof JsonByteLimitError) throw error
  }
  try {
    BigInt.prototype.valueOf.call(value)
  } catch {
    // Not a boxed BigInt; continue with ordinary object serialization.
    return normalizeJsonObject(value, budget, ancestors)
  }
  throw new TypeError("Do not know how to serialize a BigInt")
}

function normalizeJsonObject(
  object: object,
  budget: JsonBudget,
  ancestors: Set<object>,
): unknown | typeof OMIT_JSON_VALUE {
  if (ancestors.has(object)) throw new TypeError("Converting circular structure to JSON")
  ancestors.add(object)
  try {
    if (Array.isArray(object)) {
      addJsonBytes(budget, 1) // [
      const result: unknown[] = Object.setPrototypeOf([], null)
      const length = object.length
      for (let index = 0; index < length; index++) {
        if (index > 0) addJsonBytes(budget, 1)
        const key = String(index)
        const item = normalizedJsonValue(Reflect.get(object, key), key, budget, ancestors)
        if (item === OMIT_JSON_VALUE) {
          addJsonBytes(budget, 4)
          result[index] = null
        } else result[index] = item
      }
      addJsonBytes(budget, 1) // ]
      return result
    }

    addJsonBytes(budget, 1) // {
    const result: Record<string, unknown> = Object.create(null)
    let first = true
    for (const property of Object.keys(object)) {
      const item = normalizedJsonValue(Reflect.get(object, property), property, budget, ancestors)
      if (item === OMIT_JSON_VALUE) continue
      if (!first) addJsonBytes(budget, 1)
      countQuotedJsonString(property, budget)
      addJsonBytes(budget, 1) // :
      first = false
      Object.defineProperty(result, property, {
        configurable: true,
        enumerable: true,
        value: item,
        writable: true,
      })
    }
    addJsonBytes(budget, 1) // }
    return result
  } finally {
    ancestors.delete(object)
  }
}

/**
 * Serialize a JSON value only when its exact UTF-8 size fits `maxBytes`. The preflight snapshots
 * enumerable values and `toJSON` results while counting, so an oversized output is rejected before
 * constructing the escaped JSON string or its encoded byte buffer. Returns `undefined` for a root
 * value with no JSON representation, matching `JSON.stringify`.
 */
export function boundedJsonText(
  value: unknown,
  maxBytes: number,
): { readonly text: string; readonly byteLength: number } | undefined {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new RangeError("maxBytes must be a non-negative safe integer")
  const budget: JsonBudget = { maxBytes, usedBytes: 0 }
  const normalized = normalizedJsonValue(value, "", budget, new Set())
  if (normalized === OMIT_JSON_VALUE) return undefined
  const text = JSON.stringify(normalized)
  if (text === undefined) return undefined
  return { text, byteLength: budget.usedBytes }
}

/** `Response.json`, with each `bigint` written as its decimal string, as `jsonText` writes it. */
export function jsonResponse(value: unknown, init?: ResponseInit): Response {
  try {
    return Response.json(value, init)
  } catch (error) {
    const text = retried(value, error)
    // Parsed back so the runtime's own `Response.json` still picks the content-type, and still
    // throws for a value with no JSON form.
    return Response.json(typeof text === "string" ? JSON.parse(text) : value, init)
  }
}

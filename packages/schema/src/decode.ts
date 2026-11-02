/**
 * `t.date()` across a request: JSON carries an RFC 3339 string and the handler receives a `Date`.
 * The validator has already checked the value, so a decoder only turns the strings at `t.date()`
 * places into `Date`s, copying the containers above one and leaving the caller's value as it was.
 *
 * Which place is a `t.date()` comes from the schema alone, never from what a string looks like, so a
 * field declared a string stays one however much it resembles a date. In a union the first branch
 * that accepts the value decides, so the result matches that branch's type exactly.
 */
import type { TSchema } from "@sinclair/typebox"
import { dateTimeMs } from "./formats.ts"
import { isRecord } from "./internal/record.ts"

const DATE_KEY = "x-nifra-date"
// Deeper than any real schema; a decoder stops there and leaves the value as it is.
const MAX_DEPTH = 64

export type Decoder = (value: unknown) => unknown

/** A check of `value` against one union branch, built the first time that branch is asked. */
export type BranchCheck = (branch: object) => (value: unknown) => boolean

const dateSchemas = new WeakMap<object, boolean>()

/** Whether a schema node is, or holds, a `t.date()`. */
export function declaresDate(node: unknown, depth = 0): boolean {
  if (typeof node !== "object" || node === null || depth > MAX_DEPTH) return false
  const known = dateSchemas.get(node)
  if (known !== undefined) return known
  let found = Reflect.get(node, DATE_KEY) === true
  // Not `Object.values`: in JSC that costs every later check of a value shaped like a walked node ~20
  // instructions.
  if (!found)
    for (const key of Object.keys(node))
      if (declaresDate(Reflect.get(node, key), depth + 1)) {
        found = true
        break
      }
  dateSchemas.set(node, found)
  return found
}

/** The decoder for `schema`, or `undefined` when it declares no `t.date()` and has nothing to do. */
export function compileDecoder(schema: TSchema, check: BranchCheck): Decoder | undefined {
  return compile(schema, check, 0)
}

function compile(node: unknown, check: BranchCheck, depth: number): Decoder | undefined {
  if (typeof node !== "object" || node === null || depth > MAX_DEPTH || !declaresDate(node))
    return undefined
  if (Reflect.get(node, DATE_KEY) === true) return toDate
  const branches: unknown = Reflect.get(node, "anyOf") ?? Reflect.get(node, "oneOf")
  if (Array.isArray(branches)) return compileUnion(branches, check, depth)
  const parts: unknown = Reflect.get(node, "allOf")
  if (Array.isArray(parts)) {
    const decoders = parts.map((part) => compile(part, check, depth + 1)).filter(isDecoder)
    return (value) => decoders.reduce((decoded, decode) => decode(decoded), value)
  }
  const type: unknown = Reflect.get(node, "type")
  if (type === "array") return compileArray(node, check, depth)
  return type === "object" ? compileObject(node, check, depth) : undefined
}

const isDecoder = (decoder: Decoder | undefined): decoder is Decoder => decoder !== undefined

const toDate: Decoder = (value) => {
  if (typeof value !== "string") return value
  const ms = dateTimeMs(value)
  return Number.isNaN(ms) ? value : new Date(ms)
}

/** `__proto__` is a field like any other here; plain assignment would set the prototype. */
function define(out: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__")
    Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })
  else out[key] = value
}

function compileObject(node: object, check: BranchCheck, depth: number): Decoder | undefined {
  const properties: unknown = Reflect.get(node, "properties")
  const fields: Array<readonly [string, Decoder]> = []
  if (isRecord(properties))
    for (const key of Object.keys(properties)) {
      const decode = compile(properties[key], check, depth + 1)
      if (decode !== undefined) fields.push([key, decode])
    }
  const declared = new Set(isRecord(properties) ? Object.keys(properties) : [])
  const patterns: Array<readonly [RegExp, Decoder | undefined]> = []
  const patterned: unknown = Reflect.get(node, "patternProperties")
  if (isRecord(patterned))
    for (const source of Object.keys(patterned)) {
      let pattern: RegExp
      try {
        // Without flags, as TypeBox reads it, so a key matches here exactly when it was checked there.
        pattern = new RegExp(source)
      } catch {
        continue // the validator could not read it either, so no key reached it
      }
      patterns.push([pattern, compile(patterned[source], check, depth + 1)])
    }
  const extra = compile(Reflect.get(node, "additionalProperties"), check, depth + 1)
  const undeclared = extra !== undefined || patterns.some(([, decode]) => decode !== undefined)
  if (fields.length === 0 && !undeclared) return undefined
  return (value) => {
    if (!isRecord(value) || value instanceof Date) return value
    let out: Record<string, unknown> | undefined
    // Index loops: iterating would allocate per call.
    for (let i = 0; i < fields.length; i++) {
      const entry = fields[i]
      if (entry === undefined || !Object.hasOwn(value, entry[0])) continue
      const field = value[entry[0]]
      const decoded = entry[1](field)
      if (decoded === field) continue
      out ??= { ...value }
      define(out, entry[0], decoded)
    }
    if (undeclared)
      for (const key of Object.keys(value)) {
        if (declared.has(key)) continue
        let decode: Decoder | undefined
        let matched = false
        for (let i = 0; i < patterns.length; i++) {
          const entry = patterns[i]
          if (entry === undefined || !entry[0].test(key)) continue
          matched = true
          decode ??= entry[1]
        }
        if (!matched) decode = extra
        if (decode === undefined) continue
        const field = value[key]
        const decoded = decode(field)
        if (decoded === field) continue
        out ??= { ...value }
        define(out, key, decoded)
      }
    return out ?? value
  }
}

function compileArray(node: object, check: BranchCheck, depth: number): Decoder | undefined {
  const items: unknown = Reflect.get(node, "items")
  const prefix: unknown = Reflect.get(node, "prefixItems")
  const tuple = Array.isArray(prefix) ? prefix : Array.isArray(items) ? items : []
  const slots = tuple.map((slot) => compile(slot, check, depth + 1))
  const rest = compile(
    Array.isArray(items) ? Reflect.get(node, "additionalItems") : items,
    check,
    depth + 1,
  )
  if (rest === undefined && slots.every((slot) => slot === undefined)) return undefined
  return (value) => {
    if (!Array.isArray(value)) return value
    let out: unknown[] | undefined
    for (let i = 0; i < value.length; i++) {
      const decode = i < slots.length ? slots[i] : rest
      if (decode === undefined) continue
      const item: unknown = value[i]
      const decoded = decode(item)
      if (decoded === item) continue
      out ??= value.slice()
      out[i] = decoded
    }
    return out ?? value
  }
}

/** The JSON types a union branch accepts, or `undefined` when it may accept anything. */
function acceptedTypes(node: unknown): ReadonlySet<string> | undefined {
  if (typeof node !== "object" || node === null) return undefined
  if (Reflect.get(node, DATE_KEY) === true) return new Set(["string", "date"])
  const branches: unknown = Reflect.get(node, "anyOf") ?? Reflect.get(node, "oneOf")
  if (Array.isArray(branches)) {
    const all = new Set<string>()
    for (const branch of branches) {
      const types = acceptedTypes(branch)
      if (types === undefined) return undefined
      for (const type of types) all.add(type)
    }
    return all
  }
  if (Object.hasOwn(node, "const")) return new Set([jsonTypeOf(Reflect.get(node, "const"))])
  const listed: unknown = Reflect.get(node, "enum")
  if (Array.isArray(listed)) return new Set(listed.map(jsonTypeOf))
  const type: unknown = Reflect.get(node, "type")
  const types = Array.isArray(type) ? type : typeof type === "string" ? [type] : undefined
  return types === undefined
    ? undefined
    : new Set(types.map((name) => (name === "integer" ? "number" : String(name))))
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  if (value instanceof Date) return "date"
  return typeof value
}

/**
 * A union decodes by the first branch that accepts the value. When only one branch takes the value's
 * JSON type it is that one, since the validator already passed the value; otherwise each candidate
 * is checked in order, so `t.union([t.date(), t.null()])` never runs a check.
 */
function compileUnion(
  branches: readonly unknown[],
  check: BranchCheck,
  depth: number,
): Decoder | undefined {
  const decoders = branches.map((branch) => compile(branch, check, depth + 1))
  if (decoders.every((decode) => decode === undefined)) return undefined
  const types = branches.map(acceptedTypes)
  const checks: Array<((value: unknown) => boolean) | undefined> = []
  return (value) => {
    const type = jsonTypeOf(value)
    let first = -1
    let several = false
    for (let i = 0; i < branches.length; i++) {
      if (types[i]?.has(type) === false) continue
      if (first === -1) first = i
      else {
        several = true
        break
      }
    }
    if (first === -1) return value
    if (!several) return decoders[first]?.(value) ?? value
    for (let i = first; i < branches.length; i++) {
      if (types[i]?.has(type) === false) continue
      const branch = branches[i]
      if (typeof branch !== "object" || branch === null) continue
      let accepts = checks[i]
      if (accepts === undefined) {
        accepts = check(branch)
        checks[i] = accepts
      }
      if (accepts(value)) return decoders[i]?.(value) ?? value
    }
    return value
  }
}

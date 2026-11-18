/** Prototypes whose instances a structured clone rebuilds with the same prototype. */
const CLONED_PROTOTYPES: ReadonlySet<unknown> = new Set([
  Object.prototype,
  Array.prototype,
  Map.prototype,
  Set.prototype,
  Date.prototype,
  RegExp.prototype,
  ArrayBuffer.prototype,
  DataView.prototype,
  Boolean.prototype,
  Number.prototype,
  String.prototype,
  BigInt.prototype,
  ...[
    "Int8Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "Int16Array",
    "Uint16Array",
    "Int32Array",
    "Uint32Array",
    "Float16Array",
    "Float32Array",
    "Float64Array",
    "BigInt64Array",
    "BigUint64Array",
  ].flatMap((name) => {
    const view: unknown = Reflect.get(globalThis, name)
    return typeof view === "function" ? [Reflect.get(view, "prototype")] : []
  }),
])

const typedArray = Object.getPrototypeOf(Uint8Array.prototype)
const typedArrayBuffer = Reflect.getOwnPropertyDescriptor(typedArray, "buffer")?.get
const typedArrayLength = Reflect.getOwnPropertyDescriptor(typedArray, "length")?.get
const dataViewBuffer = Reflect.getOwnPropertyDescriptor(DataView.prototype, "buffer")?.get

/** Typed arrays up to this many elements are checked for fields the clone drops; a larger one would
 * list a key per element. */
const VIEW_FIELD_CHECK_LIMIT = 4096

/** A view's backing buffer through the built-in getter, so a getter the caller put on the view never runs. */
function backingBuffer(view: ArrayBufferView): unknown {
  const read = view instanceof DataView ? dataViewBuffer : typedArrayBuffer
  if (read === undefined) throw new TypeError("snapshot: this runtime hides its buffer getters")
  return Reflect.apply(read, view, [])
}

/** A typed array's element count through the built-in getter, or `undefined` for a `DataView`. */
function elementCount(view: ArrayBufferView): number | undefined {
  try {
    return typedArrayLength === undefined ? undefined : Reflect.apply(typedArrayLength, view, [])
  } catch {
    return undefined
  }
}

/** Whether `key` names one of the code units a boxed string of `length` units holds. */
function isStringIndex(key: string, length: number): boolean {
  return /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < length
}

/**
 * Refuse, before anything is cloned, a value a structured clone would change: a prototype other than
 * the built-in one, an accessor, a symbol or non-enumerable field, a field the clone would drop, an
 * `Error`, a regular expression with a position. Property descriptors are read, never values, so no
 * caller code runs between this check and the clone. The elements of a typed array are not visited,
 * and a field on one over {@link VIEW_FIELD_CHECK_LIMIT} elements is dropped without being refused.
 */
function refuseLossy(root: unknown): void {
  const pending: unknown[] = [root]
  const seen = new WeakSet<object>()
  while (pending.length > 0) {
    const source = pending.pop()
    if (source === null || typeof source !== "object" || seen.has(source)) continue
    seen.add(source)
    if (source instanceof Error) throw new TypeError("snapshot: Error instances are not data")
    if (!CLONED_PROTOTYPES.has(Object.getPrototypeOf(source))) {
      throw new TypeError("snapshot: custom prototypes cannot be preserved")
    }
    if (ArrayBuffer.isView(source)) {
      const elements = elementCount(source)
      if (elements === undefined || elements <= VIEW_FIELD_CHECK_LIMIT) {
        if (Reflect.ownKeys(source).length !== (elements ?? 0)) {
          throw new TypeError("snapshot: accessors or omitted fields cannot be preserved")
        }
      }
      continue
    }
    if (source instanceof Map) {
      for (const [key, item] of Map.prototype.entries.call(source)) pending.push(key, item)
    } else if (source instanceof Set) {
      for (const item of Set.prototype.values.call(source)) pending.push(item)
    }
    const text = source instanceof String ? String.prototype.valueOf.call(source) : undefined
    const record = Object.getPrototypeOf(source) === Object.prototype || Array.isArray(source)
    // Native cloning drops accessors, symbol fields, non-enumerable fields, and every field of a
    // collection, date, buffer or regular expression. Refuse a lossy copy instead of accepting a
    // payload whose validated behavior has changed.
    for (const key of Reflect.ownKeys(source)) {
      const field = Reflect.getOwnPropertyDescriptor(source, key)
      if (field === undefined || !("value" in field) || typeof key === "symbol") {
        throw new TypeError("snapshot: accessors or omitted fields cannot be preserved")
      }
      if (key === "length" && (text !== undefined || Array.isArray(source))) continue
      if (text !== undefined && isStringIndex(key, text.length)) continue
      if (key === "lastIndex" && source instanceof RegExp && field.value === 0) continue
      if (!record || !field.enumerable) {
        throw new TypeError("snapshot: accessors or omitted fields cannot be preserved")
      }
      if (field.value !== null && typeof field.value === "object") pending.push(field.value)
    }
  }
}

/**
 * Refuse a copy that still shares memory with its source. The copy is searched, not the source: a
 * clone rebuilds every object with its built-in prototype, so `instanceof` cannot be fooled the way
 * it can by a source whose shared buffer had its prototype swapped for a plain object's.
 */
function refuseShared(copy: unknown): void {
  if (typeof SharedArrayBuffer === "undefined") return
  const pending: unknown[] = [copy]
  const seen = new WeakSet<object>()
  while (pending.length > 0) {
    const value = pending.pop()
    if (value === null || typeof value !== "object" || seen.has(value)) continue
    seen.add(value)
    if (value instanceof SharedArrayBuffer) {
      throw new TypeError("snapshot: shared memory cannot be detached")
    }
    if (ArrayBuffer.isView(value)) pending.push(backingBuffer(value))
    else if (value instanceof Map) pending.push(...value.keys(), ...value.values())
    else if (value instanceof Set) pending.push(...value)
    else if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) pending.push(value[index])
    } else pending.push(...Object.values(value))
  }
}

/** Clone data only when the copy preserves its fields and prototypes without shared memory. */
export function cloneData<T>(value: T): T {
  refuseLossy(value)
  let copy: T
  try {
    copy = structuredClone(value)
  } catch (cause) {
    throw new TypeError("snapshot: value cannot be cloned", { cause })
  }
  refuseShared(copy)
  return copy
}

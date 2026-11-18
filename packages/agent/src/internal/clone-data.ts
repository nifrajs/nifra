/** Prototypes of the typed arrays and `DataView` this runtime has. */
const VIEW_PROTOTYPES: ReadonlySet<unknown> = new Set([
  DataView.prototype,
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

/** A built-in accessor or method of `prototype` that throws on an object without the real internal slot. */
function slotCheck(prototype: object, key: string): (() => unknown) | undefined {
  const own = Reflect.getOwnPropertyDescriptor(prototype, key)
  const check = own?.get ?? own?.value
  return typeof check === "function" ? check : undefined
}

const typedArray = Object.getPrototypeOf(Uint8Array.prototype)
const typedArrayBuffer = Reflect.getOwnPropertyDescriptor(typedArray, "buffer")?.get
const typedArrayLength = Reflect.getOwnPropertyDescriptor(typedArray, "length")?.get
const dataViewBuffer = Reflect.getOwnPropertyDescriptor(DataView.prototype, "buffer")?.get

/** Every object whose prototype is not `Object.prototype` must hold the slot that prototype names. */
const PROTOTYPE_SLOTS: ReadonlyMap<unknown, (() => unknown) | undefined> = new Map<
  unknown,
  (() => unknown) | undefined
>([
  [Map.prototype, slotCheck(Map.prototype, "size")],
  [Set.prototype, slotCheck(Set.prototype, "size")],
  [Date.prototype, slotCheck(Date.prototype, "getTime")],
  [RegExp.prototype, slotCheck(RegExp.prototype, "source")],
  [ArrayBuffer.prototype, slotCheck(ArrayBuffer.prototype, "byteLength")],
  [Boolean.prototype, slotCheck(Boolean.prototype, "valueOf")],
  [Number.prototype, slotCheck(Number.prototype, "valueOf")],
  [String.prototype, slotCheck(String.prototype, "valueOf")],
  [BigInt.prototype, slotCheck(BigInt.prototype, "valueOf")],
])

/** The slots a plain-prototyped object must not hold: a map, a set or shared memory in disguise. */
const DISGUISES: readonly (() => unknown)[] = [
  slotCheck(Map.prototype, "size"),
  slotCheck(Set.prototype, "size"),
  typeof SharedArrayBuffer === "undefined"
    ? undefined
    : slotCheck(SharedArrayBuffer.prototype, "byteLength"),
].filter((read) => read !== undefined)

const sharedPrototype =
  typeof SharedArrayBuffer === "undefined" ? undefined : SharedArrayBuffer.prototype

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

/** Whether `read` answers for `source`, which only an object holding the real internal slot allows. */
function holdsSlot(read: () => unknown, source: object): boolean {
  try {
    Reflect.apply(read, source, [])
    return true
  } catch {
    return false
  }
}

/**
 * Whether `source` matches its prototype: a view has a view prototype, and any other prototype than
 * `Object.prototype` names a slot `source` really holds. A plain-prototyped object must hold none of
 * the {@link DISGUISES}. The built-in getters throw without the slot, so a swapped prototype hides
 * nothing; a thrown error per check, only for an object that is not an array or a view.
 */
function matchesPrototype(source: object, prototype: unknown): boolean {
  if (ArrayBuffer.isView(source) !== VIEW_PROTOTYPES.has(prototype)) return false
  if (VIEW_PROTOTYPES.has(prototype)) return true
  if (prototype === Object.prototype) return !DISGUISES.some((read) => holdsSlot(read, source))
  if (prototype === Array.prototype) return Array.isArray(source)
  if (!PROTOTYPE_SLOTS.has(prototype)) return false
  const slot = PROTOTYPE_SLOTS.get(prototype)
  return slot === undefined || holdsSlot(slot, source)
}

/** Whether `key` names one of the code units a boxed string of `length` units holds. */
function isStringIndex(key: string, length: number): boolean {
  return /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < length
}

/**
 * Refuse, before anything is cloned, a value a structured clone would change or share: a prototype
 * other than the built-in one, an accessor, a symbol or non-enumerable field, a field the clone would
 * drop, an `Error`, a regular expression with a position, shared memory. Property descriptors are
 * read, never values, so no caller code runs between this check and the clone. The elements of a
 * typed array are not visited, and a field on one over {@link VIEW_FIELD_CHECK_LIMIT} elements is
 * dropped without being refused. A date, regular expression, buffer or boxed primitive wearing a plain
 * prototype is not detected.
 */
function refuseLossy(root: unknown): void {
  const pending: unknown[] = [root]
  const seen = new WeakSet<object>()
  while (pending.length > 0) {
    const source = pending.pop()
    if (source === null || typeof source !== "object" || seen.has(source)) continue
    seen.add(source)
    if (source instanceof Error) throw new TypeError("snapshot: Error instances are not data")
    const prototype = Object.getPrototypeOf(source)
    if (prototype === sharedPrototype && sharedPrototype !== undefined) {
      throw new TypeError("snapshot: shared memory cannot be detached")
    }
    if (!matchesPrototype(source, prototype)) {
      throw new TypeError("snapshot: custom prototypes cannot be preserved")
    }
    if (ArrayBuffer.isView(source)) {
      const elements = elementCount(source)
      if (elements === undefined || elements <= VIEW_FIELD_CHECK_LIMIT) {
        if (Reflect.ownKeys(source).length !== (elements ?? 0)) {
          throw new TypeError("snapshot: accessors or omitted fields cannot be preserved")
        }
      }
      pending.push(backingBuffer(source))
      continue
    }
    if (source instanceof Map) {
      for (const [key, item] of Map.prototype.entries.call(source)) pending.push(key, item)
    } else if (source instanceof Set) {
      for (const item of Set.prototype.values.call(source)) pending.push(item)
    }
    const text = source instanceof String ? String.prototype.valueOf.call(source) : undefined
    const record = prototype === Object.prototype || Array.isArray(source)
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

/** Clone data only when the copy preserves its fields and prototypes without shared memory. */
export function cloneData<T>(value: T): T {
  refuseLossy(value)
  try {
    return structuredClone(value)
  } catch (cause) {
    throw new TypeError("snapshot: value cannot be cloned", { cause })
  }
}

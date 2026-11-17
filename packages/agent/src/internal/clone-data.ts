/** Clone data only when the copy preserves its fields and prototypes without shared memory. */
export function cloneData<T>(value: T): T {
  let copy: T
  try {
    copy = structuredClone(value)
  } catch (cause) {
    throw new TypeError("snapshot: value cannot be cloned", { cause })
  }
  const pending: [unknown, unknown][] = [[value, copy]]
  const seen = new WeakSet<object>()
  while (pending.length > 0) {
    const pair = pending.pop()
    if (pair === undefined) break
    const [source, target] = pair
    if (source === null || typeof source !== "object") {
      if (!Object.is(source, target)) throw new TypeError("snapshot: cloning changed a data value")
      continue
    }
    if (seen.has(source)) continue
    seen.add(source)
    if (source instanceof Error) throw new TypeError("snapshot: Error instances are not data")
    if (
      target === null ||
      typeof target !== "object" ||
      Object.getPrototypeOf(source) !== Object.getPrototypeOf(target)
    )
      throw new TypeError("snapshot: custom prototypes cannot be preserved")
    if (typeof SharedArrayBuffer !== "undefined" && source instanceof SharedArrayBuffer)
      throw new TypeError("snapshot: shared memory cannot be detached")
    if (ArrayBuffer.isView(source) && ArrayBuffer.isView(target))
      pending.push([source.buffer, target.buffer])
    if (source instanceof Map && target instanceof Map) {
      const entries = Map.prototype.entries.call(target)
      for (const [key, item] of Map.prototype.entries.call(source)) {
        const entry = entries.next().value
        if (entry === undefined) throw new TypeError("snapshot: cloning changed a map entry")
        pending.push([key, entry[0]], [item, entry[1]])
      }
    }
    if (source instanceof Set && target instanceof Set) {
      const items = Set.prototype.values.call(target)
      for (const item of Set.prototype.values.call(source)) pending.push([item, items.next().value])
    }
    // Native cloning drops accessors, symbol fields and some non-enumerable or built-in fields.
    // Refuse a lossy copy instead of accepting a payload whose validated behavior has changed.
    for (const key of Reflect.ownKeys(source)) {
      const original = Object.getOwnPropertyDescriptor(source, key)
      const cloned = Object.getOwnPropertyDescriptor(target, key)
      if (
        original === undefined ||
        cloned === undefined ||
        !("value" in original) ||
        !("value" in cloned)
      )
        throw new TypeError("snapshot: accessors or omitted fields cannot be preserved")
      pending.push([original.value, cloned.value])
    }
  }
  return copy
}

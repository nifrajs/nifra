import { expect, test } from "bun:test"
import { cloneData } from "../src/internal/clone-data.ts"

test("data snapshots preserve cycles, collection aliases and independent native buffers", () => {
  const value = { count: 1 }
  const buffer = new ArrayBuffer(2)
  interface Data {
    value: typeof value
    array: (typeof value)[]
    map: Map<typeof value, typeof value>
    set: Set<typeof value>
    buffer: ArrayBuffer
    bytes: Uint8Array
    view: DataView
    at: Date
    expression: RegExp
    self?: Data
  }
  const data: Data = {
    value,
    array: [value],
    map: new Map([[value, value]]),
    set: new Set([value]),
    buffer,
    bytes: new Uint8Array(buffer),
    view: new DataView(buffer),
    at: new Date(0),
    expression: /data/gi,
  }
  data.self = data
  data.bytes[0] = 1
  const copy = cloneData(data)
  expect(copy.self).toBe(copy)
  expect(copy.array[0]).toBe(copy.value)
  expect(copy.map.get(copy.value)).toBe(copy.value)
  expect(copy.set.has(copy.value)).toBe(true)
  expect(copy.buffer).not.toBe(buffer)
  expect(copy.bytes.buffer).toBe(copy.buffer)
  expect(copy.view.buffer).toBe(copy.buffer)
  expect(copy.at).toEqual(new Date(0))
  expect(copy.expression).toEqual(/data/gi)
  value.count = 2
  data.bytes[0] = 2
  data.at.setTime(2)
  expect(copy.value.count).toBe(1)
  expect(copy.bytes[0]).toBe(1)
  expect(copy.at.getTime()).toBe(0)
})

test("lossy structured clones are refused before consumers receive them", () => {
  const symbolField = { [Symbol("field")]: 1 }
  const nonEnumerable = Object.defineProperty({}, "field", { value: 1 })
  const accessor = {
    get field() {
      return 1
    },
  }
  const expression = /data/g
  expression.lastIndex = 2
  const date = Object.assign(new Date(0), { nested: { count: 1 } })
  for (const value of [symbolField, nonEnumerable, accessor, expression, date])
    expect(() => cloneData(value)).toThrow(TypeError)
})

test("data snapshot primitives retain their exact values", () => {
  for (const value of [undefined, null, true, "data", 1, -0, Number.NaN, 1n])
    expect(Object.is(cloneData(value), value)).toBe(true)
})

test("native clone failures use the same TypeError contract as other rejected data", () => {
  for (const value of [() => {}, { callback: () => {} }, new WeakMap(), Promise.resolve(1)])
    expect(() => cloneData(value)).toThrow(TypeError)
})

test("errors are refused even without optional runtime source metadata", () => {
  const error = new RangeError("data")
  error.stack = "data"
  for (const key of Reflect.ownKeys(error))
    if (key !== "message" && key !== "stack") Reflect.deleteProperty(error, key)
  for (const value of [error, { error }, new Map([["error", error]])])
    expect(() => cloneData(value)).toThrow(TypeError)
})

test("an accessor is refused without running it, so it cannot hide shared memory from the check, and one on a view is never run", () => {
  const shared = new SharedArrayBuffer(4)
  let reads = 0
  const hiding = {
    get bytes() {
      reads++
      Reflect.deleteProperty(this, "bytes")
      return new Uint8Array(shared)
    },
  }
  expect(() => cloneData(hiding)).toThrow(TypeError)
  const viaView = new Uint8Array(new ArrayBuffer(1))
  Object.defineProperty(viaView, "buffer", {
    get() {
      reads++
      return new ArrayBuffer(1)
    },
  })
  // A getter on a view is never run: the clone reads the view's internal slots, and so does the check.
  expect(cloneData({ viaView }).viaView).toHaveLength(1)
  expect(reads).toBe(0)
})

test("shared memory is refused wherever a view or a collection holds it", () => {
  const shared = new SharedArrayBuffer(4)
  for (const value of [
    shared,
    new Uint8Array(shared),
    new DataView(shared),
    { nested: [new Uint16Array(shared)] },
    new Map([["k", new Float32Array(shared)]]),
    new Set([shared]),
  ])
    expect(() => cloneData(value)).toThrow(TypeError)
})

test("a large binary payload is copied without a descriptor lookup per element", () => {
  const bytes = new Uint8Array(1 << 22).fill(7)
  const original = Reflect.getOwnPropertyDescriptor
  let lookups = 0
  Reflect.getOwnPropertyDescriptor = (...args: Parameters<typeof original>) => {
    lookups++
    return original(...args)
  }
  let copy: Uint8Array
  try {
    copy = cloneData(bytes)
  } finally {
    Reflect.getOwnPropertyDescriptor = original
  }
  expect(copy).not.toBe(bytes)
  expect(copy.buffer).not.toBe(bytes.buffer)
  expect(copy[copy.length - 1]).toBe(7)
  expect(lookups).toBeLessThan(10)
})

test("prototypes a clone would replace are refused, including those of binary views", () => {
  class Mailbox {}
  class Bytes extends Uint8Array {}
  class Index extends Map<string, number> {}
  const bare = Object.assign(Object.create(null), { field: 1 })
  const map = Object.assign(new Map([["k", 1]]), { extra: 1 })
  for (const value of [new Mailbox(), new Bytes(1), new Index(), bare, map, [new Mailbox()]])
    expect(() => cloneData(value)).toThrow(TypeError)
})

test("a regular expression is accepted when its position is the start", () => {
  const expression = /data/g
  expect(cloneData(expression)).toEqual(expression)
})

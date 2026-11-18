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

test("an accessor is refused without running it, so it cannot hide shared memory from the check, and neither is one on a view", () => {
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
  expect(() => cloneData({ viaView })).toThrow(TypeError)
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

test("shared memory is found whatever prototype its buffer or view was given", () => {
  const spoofedBuffer = new SharedArrayBuffer(4)
  Object.setPrototypeOf(spoofedBuffer, Object.prototype)
  const spoofedView = new Uint8Array(new SharedArrayBuffer(4))
  Object.setPrototypeOf(spoofedView, Object.prototype)
  for (const value of [
    spoofedBuffer,
    { held: spoofedBuffer },
    spoofedView,
    new Set([spoofedBuffer]),
    new Map([[spoofedBuffer, 1]]),
  ])
    expect(() => cloneData(value)).toThrow(TypeError)
})

test("fields on a binary view or a boxed string are refused, since the clone would drop them", () => {
  const bytes = Object.assign(new Uint8Array(1), { jobId: "a" })
  const view = Object.assign(new DataView(new ArrayBuffer(1)), { jobId: "a" })
  const text = Object.assign(new String("data"), { jobId: "a" })
  for (const value of [bytes, view, text, { bytes }, new Set([text])])
    expect(() => cloneData(value)).toThrow(TypeError)
})

test("views and boxed strings without extra fields are copied", () => {
  const bytes = new Uint8Array([1, 2, 3])
  const view = new DataView(new ArrayBuffer(2))
  const text = new String("data")
  const copy = cloneData({ bytes, view, text })
  expect(copy.bytes).toEqual(bytes)
  expect(copy.bytes).not.toBe(bytes)
  expect(copy.view.byteLength).toBe(2)
  expect(String(copy.text)).toBe("data")
})

test("a view over a buffer is refused when the view or the buffer carries fields the clone would drop", () => {
  const buffer = Object.assign(new ArrayBuffer(2), { jobId: "a" })
  expect(() => cloneData(new DataView(buffer))).toThrow(TypeError)
  expect(() => cloneData({ view: new Uint8Array(buffer) })).toThrow(TypeError)
})

test("a map or set wearing a plain prototype is refused without running a getter inside it", () => {
  let reads = 0
  const entry = {
    get x() {
      reads += 1
      return 1
    },
  }
  const map = Object.setPrototypeOf(new Map([["k", entry]]), Object.prototype)
  const set = Object.setPrototypeOf(new Set([entry]), Object.prototype)
  expect(() => cloneData(map)).toThrow(TypeError)
  expect(() => cloneData(set)).toThrow(TypeError)
  expect(reads).toBe(0)
})

test("a large map and set are walked without exhausting the stack", () => {
  const map = new Map<number, number>()
  const set = new Set<number>()
  for (let index = 0; index < 150_000; index += 1) {
    map.set(index, index)
    set.add(index)
  }
  const copy = cloneData({ map, set })
  expect(copy.map.size).toBe(150_000)
  expect(copy.set.size).toBe(150_000)
})

test("shared memory behind a named field of an array or a view is refused, an ordinary buffer is not", () => {
  const shared: unknown[] = []
  Object.assign(shared, { bytes: new Uint8Array(new SharedArrayBuffer(1)) })
  const plain: unknown[] = []
  Object.assign(plain, { bytes: new Uint8Array(new ArrayBuffer(1)) })
  expect(() => cloneData(shared)).toThrow(TypeError)
  expect(cloneData(plain)).toHaveLength(0)
})

test("shared memory is refused under every prototype the allowlist accepts", () => {
  for (const prototype of [Array.prototype, ArrayBuffer.prototype, Map.prototype, Date.prototype]) {
    const shared = Object.setPrototypeOf(new SharedArrayBuffer(1), prototype)
    const holder: unknown[] = []
    Object.assign(holder, { extra: shared })
    expect(() => cloneData(holder)).toThrow(TypeError)
    expect(() => cloneData(new DataView(shared))).toThrow(TypeError)
  }
})

test("a map or set wearing another allowed prototype is refused without running a getter", () => {
  let reads = 0
  const entry = {
    get x() {
      reads += 1
      return 1
    },
  }
  for (const prototype of [Date.prototype, Array.prototype, Set.prototype, ArrayBuffer.prototype]) {
    const map = Object.setPrototypeOf(new Map([["k", entry]]), prototype)
    const set = Object.setPrototypeOf(new Set([entry]), prototype)
    if (prototype !== Set.prototype) expect(() => cloneData(map)).toThrow(TypeError)
    expect(() => cloneData(set)).toThrow(TypeError)
  }
  expect(reads).toBe(0)
})

test("a plain object wearing a built-in prototype or a view prototype is refused", () => {
  for (const prototype of [Date.prototype, Map.prototype, Array.prototype, Uint8Array.prototype]) {
    expect(() => cloneData(Object.setPrototypeOf({ a: 1 }, prototype))).toThrow(TypeError)
  }
})

test("a sparse array with a huge length is copied without visiting its holes", () => {
  const sparse = new Array<number>(50_000_000)
  const copy = cloneData(sparse)
  expect(copy).toHaveLength(50_000_000)
  expect(0 in copy).toBe(false)
})

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

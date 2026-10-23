import { describe, expect, test } from "bun:test"
import { parsePageData } from "../src/internal/revive-dates.ts"
import { shareData } from "../src/internal/share-data.ts"

type Row = { id: number; label: string; tags: string[] }
const rows = (count: number, label = (i: number) => `row ${i}`): Row[] =>
  Array.from({ length: count }, (_, i) => ({ id: i, label: label(i), tags: ["a", "b"] }))
const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value))

describe("shareData", () => {
  test("data equal throughout returns the previous object itself", () => {
    const prev = { title: "List", items: rows(5), meta: { total: 5, at: null } }
    expect(shareData(prev, fresh(prev))).toBe(prev)
  })

  test("a changed leaf gets new parents, and every unchanged part keeps its identity", () => {
    const prev = { title: "List", items: rows(5), owner: { name: "a" } }
    const next = fresh(prev)
    next.items[2] = { id: 2, label: "changed", tags: ["a", "b"] }
    const shared = shareData(prev, next)
    expect(shared).toEqual(next)
    expect(shared).not.toBe(prev)
    expect(shared.items).not.toBe(prev.items)
    expect(shared.items[2]).not.toBe(prev.items[2])
    expect(shared.items[2]?.tags).toBe(prev.items[2]?.tags)
    for (const i of [0, 1, 3, 4]) expect(shared.items[i]).toBe(prev.items[i])
    expect(shared.owner).toBe(prev.owner)
  })

  test("Dates compare by time", () => {
    const text = '{"at":{"__nifra_date":"2026-01-01T00:00:00.000Z"},"n":1}'
    const at = (data: unknown): unknown => Reflect.get(Object(data), "at")
    const prev = parsePageData(text)
    const again = parsePageData(text)
    expect(at(again)).toBeInstanceOf(Date)
    expect(at(again)).not.toBe(at(prev))
    expect(shareData(prev, again)).toBe(prev)
    const later = parsePageData(text.replace("00.000Z", "01.000Z"))
    const shared = at(shareData(prev, later))
    expect(shared).toBe(at(later))
    expect(shared).toEqual(new Date("2026-01-01T00:00:01.000Z"))
  })

  test("class instances, Maps, promises and prototype-less objects come from the new payload", () => {
    class Point {
      constructor(readonly x: number) {}
    }
    const bare = (): Record<string, unknown> => Object.assign(Object.create(null), { a: 1 })
    const make = () => ({
      point: new Point(1),
      map: new Map([["a", 1]]),
      promise: Promise.resolve(1),
      bare: bare(),
      plain: { a: 1 },
    })
    const prev = make()
    const next = make()
    const shared = shareData(prev, next)
    expect(shared).not.toBe(prev)
    expect(shared.point).toBe(next.point)
    expect(shared.map).toBe(next.map)
    expect(shared.promise).toBe(next.promise)
    expect(shared.bare).toBe(next.bare)
    expect(shared.plain).toBe(prev.plain)
  })

  test("an own __proto__ key stays an own key", () => {
    const prev = JSON.parse('{"a":{"x":1},"b":{"__proto__":{"polluted":true},"y":1}}')
    const next = JSON.parse('{"a":{"x":1},"b":{"__proto__":{"polluted":true},"y":2}}')
    const shared = shareData(prev, next)
    expect(shared.a).toBe(prev.a)
    expect(Object.hasOwn(shared.b, "__proto__")).toBe(true)
    expect(Object.getPrototypeOf(shared.b)).toBe(Object.prototype)
    expect(Reflect.get({}, "polluted")).toBeUndefined()
    expect(shared.b.y).toBe(2)
  })

  test("a key added, removed, or present as undefined is a change", () => {
    const prev: Record<string, unknown> = { a: 1, b: 2 }
    expect(shareData(prev, { a: 1, b: 2, c: 3 })).toEqual({ a: 1, b: 2, c: 3 })
    expect(shareData(prev, { a: 1 })).toEqual({ a: 1 })
    const swapped = shareData(prev, { a: 1, c: undefined })
    expect(swapped).not.toBe(prev)
    expect(Object.keys(swapped)).toEqual(["a", "c"])
    // Inherited names read the prototype's member on the old object, never an equal value.
    expect(shareData({ a: 1 }, { constructor: 1 })).toEqual({ constructor: 1 })
  })

  test("rows with an id match by id on a prepend and a reorder", () => {
    const prev = rows(50)
    const prepended = [{ id: -1, label: "new", tags: [] }, ...fresh(prev)]
    const shared = shareData(prev, prepended)
    expect(shared[0]).toBe(prepended[0])
    for (let i = 0; i < 50; i++) expect(shared[i + 1]).toBe(prev[i])

    const reordered = fresh(prev).reverse()
    const again = shareData(prev, reordered)
    expect(again).not.toBe(prev)
    for (let i = 0; i < 50; i++) expect(again[i]).toBe(prev[49 - i])
  })

  test("rows without an id match by position", () => {
    const prev = [{ label: "a" }, { label: "b" }]
    const appended = shareData(prev, [{ label: "a" }, { label: "b" }, { label: "c" }])
    expect(appended[0]).toBe(prev[0])
    expect(appended[1]).toBe(prev[1])
    const prepended = shareData(prev, [{ label: "x" }, { label: "a" }, { label: "b" }])
    expect(prepended[1]).not.toBe(prev[0])
    expect(prepended).toEqual([{ label: "x" }, { label: "a" }, { label: "b" }])
  })

  test("an array whose first 32 elements keep nothing is taken whole", () => {
    const prev = rows(100)
    const allChanged = fresh(rows(100, (i) => `row ${i} r2`))
    const shared = shareData(prev, allChanged)
    expect(shared).toBe(allChanged)
    // Nothing nested in it is shared either: the walk stopped.
    expect(shared[0]?.tags).not.toBe(prev[0]?.tags)

    // One kept element among the first 32 keeps the walk going.
    const oneKept = fresh(rows(100, (i) => (i === 31 || i > 50 ? `row ${i}` : `row ${i} r2`)))
    const walked = shareData(prev, oneKept)
    expect(walked).not.toBe(oneKept)
    expect(walked[31]).toBe(prev[31])
    expect(walked[99]).toBe(prev[99])
    expect(walked[0]?.tags).toBe(prev[0]?.tags)
  })

  test("arrays of primitives and nested arrays share by content", () => {
    const prev = { grid: [[1, 2], [3]], flags: [true, false] }
    expect(shareData(prev, fresh(prev))).toBe(prev)
    const shared = shareData(prev, { grid: [[1, 2], [4]], flags: [true, false] })
    expect(shared.grid[0]).toBe(prev.grid[0])
    expect(shared.flags).toBe(prev.flags)
  })

  test("primitives and a change of type take the new value", () => {
    expect(shareData(1, 2)).toBe(2)
    expect(shareData(Number.NaN, Number.NaN)).toBeNaN()
    expect(Object.is(shareData(0, -0), -0)).toBe(true)
    const list = [1]
    expect(shareData({ a: 1 }, list)).toBe(list)
    expect(shareData(null, list)).toBe(list)
    expect(shareData(list, undefined)).toBeUndefined()
  })
})

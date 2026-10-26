import { describe, expect, test } from "bun:test"
import { server, silentLogger, status } from "../src/index.ts"
import { jsonResponse } from "../src/server/json-response.ts"
import { jsonText } from "../src/server/json-text.ts"

/**
 * A plain `Date` in a JSON answer is written ahead of the serializer, which leaves its fast path at
 * one. Each writer must still send, byte for byte, what `JSON.stringify` writes, whatever the `Date`
 * overrides and wherever it sits, and leave the value it was handed as it was.
 */

const AT = new Date("2026-10-25T12:00:00.000Z")

/** What the writers must send: the serializer's own text, a `bigint` as its decimal string. */
const expected = (value: unknown): string =>
  JSON.stringify(value, (_key, field: unknown) =>
    typeof field === "bigint" ? field.toString() : field,
  )

class Rows extends Array<unknown> {}

/** A class that writes itself through its prototype's hook, which a plain copy would lose. */
class Wrapped {
  constructor(readonly at: Date) {}
  toJSON(): unknown {
    return { wrapped: true }
  }
}

/** A class with no hook, which JSON writes as its own fields. */
class Stamped {
  constructor(readonly at: Date) {}
}

/** Every place a `Date` can sit: on the probe's path, past it, and where the writer leaves it. */
const placements: ReadonlyArray<readonly [string, (date: Date) => unknown]> = [
  ["top", (date) => date],
  ["field", (date) => ({ id: 1, at: date })],
  [
    "first row",
    (date) => [
      { id: 1, at: date },
      { id: 2, at: date },
    ],
  ],
  [
    "later row only",
    (date) => [
      { id: 1, at: null },
      { id: 2, at: date },
    ],
  ],
  ["nested", (date) => ({ page: { items: [{ at: date }], at: date } })],
  ["null-prototype row", (date) => [Object.assign(Object.create(null), { id: 1, at: date })]],
  ["class instance row", (date) => [new Stamped(date)]],
  ["past the probe", (date) => ({ a: { b: { c: { d: { e: { at: date } } } } } })],
  ["beside a bigint", (date) => ({ id: 1n, at: date })],
  ["under a hook", (date) => ({ at: date, wrapped: { toJSON: () => ({ at: date }) } })],
  ["under a class's hook", (date) => [{ at: date, wrapped: new Wrapped(date) }]],
  ["in a list subclass", (date) => ({ at: date, rows: Rows.of({ at: date }) })],
  [
    "own __proto__ field",
    (date) =>
      Object.defineProperty({ id: 1, at: date }, "__proto__", {
        value: date,
        enumerable: true,
        writable: true,
        configurable: true,
      }),
  ],
  [
    "getter",
    (date) => Object.defineProperty({ id: 1 }, "at", { get: () => date, enumerable: true }),
  ],
  ["repeated", (date) => ({ a: date, b: date, list: [date, [date]] })],
]

/** Each method `Date.prototype.toJSON` is or calls, with answers that change what it writes. */
const overrides: ReadonlyArray<readonly [PropertyKey, () => unknown]> = [
  ["toJSON", () => "own json"],
  [Symbol.toPrimitive, () => Number.NaN],
  ["valueOf", () => Number.NaN],
  ["valueOf", () => "text"],
  ["valueOf", () => ({})],
  ["toISOString", () => "custom"],
]

async function check(label: string, date: Date): Promise<void> {
  for (const [where, place] of placements) {
    const value = place(date)
    const want = expected(value)
    const response = await jsonResponse(value).text()
    expect({ label, where, text: jsonText(value), response }).toEqual({
      label,
      where,
      text: want,
      response: want,
    })
    // The value handed in keeps its `Date`s.
    expect(expected(value)).toBe(want)
  }
}

describe("a Date in a JSON answer", () => {
  test("is written as JSON.stringify writes it, a plain one, an invalid one and the extreme years", async () => {
    for (const date of [AT, new Date(Number.NaN), new Date(8.64e15), new Date(-8.64e15)])
      await check(String(date.valueOf()), date)
  })

  test("is written as its toJSON writes it, whichever method it overrides and where", async () => {
    for (const [method, answer] of overrides) {
      for (const where of ["own", "class", "global"] as const) {
        const override = { value: answer, configurable: true, writable: true }
        const shipped = Object.getOwnPropertyDescriptor(Date.prototype, method)
        let date = new Date(AT)
        if (where === "own") Object.defineProperty(date, method, override)
        if (where === "class") {
          class Stamp extends Date {}
          Object.defineProperty(Stamp.prototype, method, override)
          date = new Stamp(AT.getTime())
        }
        if (where === "global") Object.defineProperty(Date.prototype, method, override)
        try {
          await check(`${String(method)} ${String(answer())} ${where}`, date)
        } finally {
          if (where === "global" && shipped !== undefined)
            Object.defineProperty(Date.prototype, method, shipped)
        }
      }
    }
  })

  test("a Date's own toISOString runs after the hooks the serializer runs before it", async () => {
    let written = "early"
    const date = new Date(AT)
    Object.defineProperty(date, "toISOString", { value: () => written, configurable: true })
    const first = {
      toJSON: () => {
        written = "late"
        return 1
      },
    }
    const value = [{ first, at: date }]
    const want = '[{"first":1,"at":"late"}]'
    expect(jsonText(value)).toBe(want)
    written = "early"
    expect(await jsonResponse(value).text()).toBe(want)
  })

  test("leaves the value it was handed as it was", () => {
    const row = { id: 1, at: AT }
    const rows = [row]
    jsonText(rows)
    expect(rows[0]).toBe(row)
    expect(row.at).toBe(AT)
  })

  test("a cycle beside a Date is still the TypeError the serializer throws", () => {
    const cyclic: Record<string, unknown> = { at: AT }
    cyclic.self = cyclic
    expect(() => jsonText(cyclic)).toThrow(TypeError)
    expect(() => jsonResponse(cyclic)).toThrow(TypeError)
  })

  test("is the ISO string on every lane", async () => {
    const rows = [{ id: 1, at: AT }]
    const app = server({ logger: silentLogger })
      .get("/bare", () => rows)
      .get("/status", () => status(201, rows))
      .get("/json", (c) => c.json(rows, { status: 202 }))
      .derive(() => ({ who: "a" }))
      .get("/derived", async (c) => ({ who: c.who, rows }))
    const sent = `[{"id":1,"at":"${AT.toISOString()}"}]`
    for (const [path, code, text] of [
      ["/bare", 200, sent],
      ["/status", 201, sent],
      ["/json", 202, sent],
      ["/derived", 200, `{"who":"a","rows":${sent}}`],
    ] as const) {
      const response = await app.fetch(new Request(`http://t${path}`))
      expect({ path, status: response.status, text: await response.text() }).toEqual({
        path,
        status: code,
        text,
      })
    }
  })
})

/**
 * Values the serializer may write by rules of their own rather than as their own fields: each kind of
 * primitive boxed, a raw JSON text of each kind, and an instance of every global class that builds
 * with no arguments.
 */
function ownRuleValues(): ReadonlyArray<readonly [string, () => object]> {
  const values: Array<readonly [string, () => object]> = []
  for (const primitive of [1.5, "ab", false, 12n, Symbol("s")])
    values.push([`boxed ${typeof primitive}`, () => Object(primitive)])
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the member is optional, so an engine without JSON.rawJSON leaves it undefined.
  const rawJson = (JSON as JSON & { readonly rawJSON?: (text: string) => object }).rawJSON
  if (rawJson !== undefined)
    for (const text of ["1.10", "12345678901234567890", '"ab"', "true", "null"])
      values.push([`raw ${text}`, () => rawJson(text)])
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    const make: unknown = Reflect.get(globalThis, name)
    if (typeof make !== "function" || !/^[A-Z]/.test(name)) continue
    try {
      if (typeof Reflect.construct(make, []) !== "object") continue
    } catch {
      continue
    }
    values.push([name, () => Reflect.construct(make, [])])
  }
  return values
}

/** Every place such a value can sit beside a plain `Date` on the probe's path, or holding one. */
const ownRulePlacements: ReadonlyArray<readonly [string, (value: object, date: Date) => unknown]> =
  [
    ["beside", (value, date) => [{ at: date, value }]],
    ["nested beside", (value, date) => ({ at: date, page: { value } })],
    ["listed beside", (value, date) => ({ at: date, list: [value] })],
    ["in a later row", (value, date) => [{ at: date }, { at: date, value }]],
    ["holding it", (value, date) => [{ at: date, value: Object.assign(value, { at: date }) }]],
    ["holding it at the top", (value, date) => Object.assign(value, { at: date })],
  ]

/** The text `write` gives, or the class of what it throws. */
async function outcome(write: () => string | Promise<string>): Promise<string> {
  try {
    return await write()
  } catch (error) {
    return `throws ${error instanceof Error ? error.name : typeof error}`
  }
}

describe("a value JSON writes by its own rules beside a Date", () => {
  test("is written as JSON.stringify writes it, wherever it sits", async () => {
    const values = ownRuleValues()
    expect(values.length).toBeGreaterThan(30)
    for (const [kind, make] of values) {
      for (const [where, place] of ownRulePlacements) {
        let value: unknown
        try {
          value = place(make(), AT)
        } catch {
          // A frozen value, such as a raw JSON text, cannot hold a field.
          continue
        }
        const want = await outcome(() => expected(value))
        expect({
          kind,
          where,
          text: await outcome(() => jsonText(value)),
          response: await outcome(() => jsonResponse(value).text()),
        }).toEqual({ kind, where, text: want, response: want })
      }
    }
  })
})

describe("an accessor in a JSON answer", () => {
  /** A record whose `name` field is an accessor, counting its reads; `first` is what the first read gets. */
  const counted = (first: unknown, later: unknown) => {
    let reads = 0
    const record = Object.defineProperty({ id: 1, at: AT }, "late", {
      get: () => (reads++ === 0 ? first : later),
      enumerable: true,
    })
    return { record, reads: () => reads }
  }
  const placements: ReadonlyArray<readonly [string, (record: object) => unknown]> = [
    ["the first row", (record) => [record]],
    ["a later row", (record) => [{ id: 0, at: AT }, record]],
    ["nested", (record) => ({ page: { items: [record] } })],
    ["the top", (record) => record],
  ]

  test("has its getter run once, by the serializer, on every writer", async () => {
    for (const [where, place] of placements) {
      for (const write of [
        (value: unknown) => jsonText(value),
        (value: unknown) => jsonResponse(value).text(),
      ]) {
        const { record, reads } = counted(AT, "later")
        const value = place(record)
        const text = await write(value)
        expect({ where, reads: reads(), text }).toEqual({
          where,
          reads: 1,
          text: expected(place(counted(AT, "later").record)),
        })
      }
    }
  })

  test("an accessor list item has its getter run once", () => {
    let reads = 0
    const rows = Object.defineProperty([{ at: AT }, null], 1, {
      get: () => {
        reads++
        return { at: AT }
      },
      enumerable: true,
    })
    expect(jsonText(rows)).toBe(expected([{ at: AT }, { at: AT }]))
    expect(reads).toBe(1)
  })
})

import { afterEach, expect, test } from "bun:test"
import { server, status } from "@nifrajs/core"
import { jsonText } from "../src/generated/json-text.ts"
import { type NodeServer, serve } from "../src/index.ts"

/**
 * The adapter writes a handler's JSON with its generated copy of core's writer, so a `Date` is written
 * here exactly as `JSON.stringify` writes it, whatever it overrides and wherever it sits.
 */

const AT = new Date("2026-10-25T12:00:00.000Z")

const expected = (value: unknown): string =>
  JSON.stringify(value, (_key, field: unknown) =>
    typeof field === "bigint" ? field.toString() : field,
  )

class Rows extends Array<unknown> {}
class Stamp extends Date {
  override toISOString(): string {
    return "stamp"
  }
}

let running: NodeServer | undefined
afterEach(async () => {
  await running?.stop({ drainMs: 0 })
  running = undefined
})

test("a Date is its ISO string on every lane the adapter writes", async () => {
  const rows = [{ id: 1, at: AT }]
  const app = server()
    .get("/bare", () => rows)
    .get("/status", () => status(201, rows))
    .get("/json", (c) => c.json(rows, { status: 202 }))
  running = await serve(app, { hostname: "127.0.0.1", port: 0 })
  const sent = `[{"id":1,"at":"${AT.toISOString()}"}]`
  for (const [path, code] of [
    ["/bare", 200],
    ["/status", 201],
    ["/json", 202],
  ] as const) {
    const response = await fetch(`http://127.0.0.1:${running.port}${path}`)
    expect({ path, status: response.status, text: await response.text() }).toEqual({
      path,
      status: code,
      text: sent,
    })
  }
})

test("the generated writer matches JSON.stringify wherever a Date sits", () => {
  const getter = Object.defineProperty({ id: 1 }, "at", { get: () => AT, enumerable: true })
  const values: unknown[] = [
    AT,
    new Date(Number.NaN),
    { id: 1n, at: AT },
    [{ at: AT }, { at: new Stamp(AT.getTime()) }],
    [{ at: null }, { at: AT }],
    { page: { items: [{ at: AT }, 1, "x"], at: AT } },
    { at: AT, rows: Rows.of({ at: AT }), bytes: new Uint8Array([1]) },
    { at: AT, wrapped: { toJSON: () => ({ at: AT }) } },
    Object.defineProperty({ at: AT }, "__proto__", {
      value: AT,
      enumerable: true,
      writable: true,
      configurable: true,
    }),
    [getter],
    [{ at: AT }, getter],
  ]
  for (const value of values) expect(jsonText(value)).toBe(expected(value))
})

test("a getter runs once, and a cycle is still the serializer's TypeError", () => {
  let reads = 0
  const counted = Object.defineProperty({ at: AT }, "late", {
    get: () => ++reads,
    enumerable: true,
  })
  expect(jsonText([{ at: AT }, counted])).toBe(expected([{ at: AT }, { at: AT, late: 1 }]))
  expect(reads).toBe(1)
  const cyclic: Record<string, unknown> = { at: AT }
  cyclic.self = cyclic
  expect(() => jsonText(cyclic)).toThrow(TypeError)
})

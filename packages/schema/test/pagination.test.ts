import { describe, expect, test } from "bun:test"
import { validateStandard } from "@nifrajs/core/schema"
import { decodeCursor, encodeCursor, paginate, t } from "../src/index.ts"

describe("cursor codec", () => {
  test("encode → decode round-trips JSON values", () => {
    for (const value of [
      { id: 7, k: "x" },
      "plain",
      42,
      [1, 2, 3],
      { nested: { a: [true, null] } },
    ]) {
      expect(decodeCursor(encodeCursor(value)) as unknown).toEqual(value)
    }
  })

  test("cursors are URL-safe (no +, /, or = padding)", () => {
    const c = encodeCursor({ s: "a/b+c==", emoji: "🚀" })
    expect(c).not.toMatch(/[+/=]/)
    expect(decodeCursor(c) as unknown).toEqual({ s: "a/b+c==", emoji: "🚀" })
  })

  test("decode of null/empty/garbage → undefined (treat as 'from the start')", () => {
    expect(decodeCursor(null)).toBeUndefined()
    expect(decodeCursor(undefined)).toBeUndefined()
    expect(decodeCursor("")).toBeUndefined()
    expect(decodeCursor("!!!not base64!!!")).toBeUndefined()
  })
})

describe("paginate", () => {
  const rows = [{ id: 1 }, { id: 2 }, { id: 3 }]

  test("more rows than the limit → sliced items + a nextCursor from the last KEPT row", () => {
    const page = paginate(rows, 2, (r) => r.id) // fetched limit+1 (3) for limit 2
    expect(page.items).toEqual([{ id: 1 }, { id: 2 }])
    expect(page.nextCursor).not.toBeNull()
    expect(decodeCursor(page.nextCursor) as unknown).toBe(2) // cursor of the last kept row
  })

  test("rows at or under the limit → all items, null cursor (last page)", () => {
    expect(paginate(rows, 3, (r) => r.id)).toEqual({ items: rows, nextCursor: null })
    expect(paginate(rows, 5, (r) => r.id).nextCursor).toBeNull()
  })

  test("empty rows → empty page, null cursor", () => {
    expect(paginate([], 10, (r: { id: number }) => r.id)).toEqual({ items: [], nextCursor: null })
  })
})

describe("t.paginated", () => {
  const schema = t.paginated(t.object({ id: t.integer() }))

  test("accepts a well-formed envelope (string or null cursor)", async () => {
    expect((await validateStandard(schema, { items: [{ id: 1 }], nextCursor: "abc" })).ok).toBe(
      true,
    )
    expect((await validateStandard(schema, { items: [], nextCursor: null })).ok).toBe(true)
  })

  test("rejects a missing cursor, wrong item shape, or extra fields", async () => {
    expect((await validateStandard(schema, { items: [{ id: 1 }] })).ok).toBe(false) // no nextCursor
    expect((await validateStandard(schema, { items: "nope", nextCursor: null })).ok).toBe(false)
    expect(
      (await validateStandard(schema, { items: [{ id: 1 }], nextCursor: null, extra: 1 })).ok,
    ).toBe(false)
  })
})

describe("t.pageQuery", () => {
  const query = t.pageQuery({ maxLimit: 50 })

  test("accepts an empty query and a cursor+limit within bounds", async () => {
    expect((await validateStandard(query, {})).ok).toBe(true)
    expect((await validateStandard(query, { cursor: "c", limit: 20 })).ok).toBe(true)
  })

  test("clamps limit: rejects over maxLimit and under 1; rejects unknown fields", async () => {
    expect((await validateStandard(query, { limit: 51 })).ok).toBe(false)
    expect((await validateStandard(query, { limit: 0 })).ok).toBe(false)
    expect((await validateStandard(query, { page: 2 })).ok).toBe(false)
  })

  test("default maxLimit is 100", async () => {
    expect((await validateStandard(t.pageQuery(), { limit: 100 })).ok).toBe(true)
    expect((await validateStandard(t.pageQuery(), { limit: 101 })).ok).toBe(false)
  })

  // Query values arrive as STRINGS over HTTP (`?limit=20` → `"20"`). pageQuery coerces so the handler
  // sees a real number — the case the numeric-literal tests above never exercised.
  test("coerces a string limit from the query, then bounds it", async () => {
    const ok = await validateStandard(query, { limit: "20" })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.value.limit).toBe(20) // coerced string → number

    const withCursor = await validateStandard(query, { cursor: "abc", limit: "50" })
    expect(withCursor.ok).toBe(true)
    if (withCursor.ok) expect(withCursor.value).toEqual({ cursor: "abc", limit: 50 })

    expect((await validateStandard(query, { limit: "51" })).ok).toBe(false) // over cap, after coercion
    expect((await validateStandard(query, { limit: "abc" })).ok).toBe(false) // not numeric → stays string → fails
    expect((await validateStandard(query, {})).ok).toBe(true) // limit optional

    // Convert rounds a fractional limit to an integer (lenient — a query "limit=1.5" is nonsense but harmless).
    const frac = await validateStandard(query, { limit: "1.5" })
    expect(frac.ok).toBe(true)
    if (frac.ok) expect(frac.value.limit).toBe(1)
  })
})

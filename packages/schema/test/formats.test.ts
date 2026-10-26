import { describe, expect, test } from "bun:test"
import { validateStandard } from "@nifrajs/core/schema"
import type { NifraSchema } from "../src/index.ts"
import { registerFormat, t } from "../src/index.ts"

async function accepts(schema: NifraSchema, value: unknown): Promise<boolean> {
  return (await validateStandard(schema, value)).ok
}

describe("standard string formats validate (not just annotate)", () => {
  test("email", async () => {
    expect(await accepts(t.string({ format: "email" }), "ada@example.com")).toBe(true)
    expect(await accepts(t.string({ format: "email" }), "not-an-email")).toBe(false)
    expect(await accepts(t.string({ format: "email" }), "ada@mail.example.co.uk")).toBe(true)
    expect(await accepts(t.string({ format: "email" }), "ada@example")).toBe(false)
    expect(await accepts(t.string({ format: "email" }), "ada@example..com")).toBe(false)
  })

  test("email validates a hostile 200 KB value in linear time", async () => {
    const hostile = `a@${".".repeat(200_000)}@`
    const started = performance.now()
    expect(await accepts(t.string({ format: "email" }), hostile)).toBe(false)
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  test("uuid", async () => {
    expect(
      await accepts(t.string({ format: "uuid" }), "123e4567-e89b-12d3-a456-426614174000"),
    ).toBe(true)
    expect(await accepts(t.string({ format: "uuid" }), "nope")).toBe(false)
  })

  test("date-time, date, time", async () => {
    expect(await accepts(t.string({ format: "date-time" }), "2026-05-30T12:00:00Z")).toBe(true)
    expect(await accepts(t.string({ format: "date-time" }), "2026-05-30")).toBe(false)
    expect(await accepts(t.string({ format: "date" }), "2026-05-30")).toBe(true)
    expect(await accepts(t.string({ format: "time" }), "12:00:00")).toBe(true)
    expect(await accepts(t.string({ format: "time" }), "noon")).toBe(false)
  })

  test("date-time, date and time check the calendar and the clock, as RFC 3339 does", async () => {
    const dateTime = t.string({ format: "date-time" })
    for (const value of [
      "2024-02-29T00:00:00Z",
      "0000-01-01T00:00:00z",
      "2026-05-30t23:59:59.123456789-23:59",
      "2016-12-31T23:59:60Z",
      "2017-01-01T00:59:60+01:00",
    ])
      expect(await accepts(dateTime, value)).toBe(true)
    for (const value of [
      "2026-02-29T00:00:00Z",
      "1900-02-29T00:00:00Z",
      "2026-04-31T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-00-10T00:00:00Z",
      "2026-05-30T24:00:00Z",
      "2026-05-30T12:60:00Z",
      "2026-05-30T12:00:61Z",
      "2026-05-30T12:00:60Z",
      "2026-05-30T12:00:00.Z",
      "2026-05-30T12:00:00+24:00",
      "2026-05-30T12:00:00+0100",
      "2026-05-30 12:00:00Z",
      "2026-05-30T12:00:00Z ",
      "\u0662026-05-30T12:00:00Z",
    ])
      expect(await accepts(dateTime, value)).toBe(false)
    expect(await accepts(t.string({ format: "date" }), "2024-02-29")).toBe(true)
    for (const value of ["2026-02-29", "2026-5-30", "2026-05-30T00:00:00Z", "2026/05/30"])
      expect(await accepts(t.string({ format: "date" }), value)).toBe(false)
    for (const value of ["23:59:60Z", "00:00:00.5+05:30", "12:00:00z"])
      expect(await accepts(t.string({ format: "time" }), value)).toBe(true)
    for (const value of ["24:00:00", "12:00", "12:00:00+5:30", "12:00:00Zz"])
      expect(await accepts(t.string({ format: "time" }), value)).toBe(false)
  })

  test("uri, ipv4", async () => {
    expect(await accepts(t.string({ format: "uri" }), "https://example.com/x")).toBe(true)
    expect(await accepts(t.string({ format: "uri" }), "no-scheme")).toBe(false)
    expect(await accepts(t.string({ format: "ipv4" }), "192.168.0.1")).toBe(true)
    expect(await accepts(t.string({ format: "ipv4" }), "999.1.1.1")).toBe(false)
  })

  test("the format also annotates the JSON Schema (for OpenAPI)", () => {
    const json = JSON.parse(JSON.stringify(t.string({ format: "email" }).jsonSchema))
    expect(json).toEqual({ type: "string", format: "email" })
  })

  test("registerFormat adds a custom format", async () => {
    registerFormat("slug", (value) => /^[a-z0-9-]+$/.test(value))
    expect(await accepts(t.string({ format: "slug" }), "my-slug")).toBe(true)
    expect(await accepts(t.string({ format: "slug" }), "Not A Slug")).toBe(false)
  })
})

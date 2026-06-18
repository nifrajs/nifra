import { describe, expect, test } from "bun:test"
import { validateStandard } from "@nifrajs/core"
import type { NifraSchema } from "../src/index.ts"
import { registerFormat, t } from "../src/index.ts"

async function accepts(schema: NifraSchema, value: unknown): Promise<boolean> {
  return (await validateStandard(schema, value)).ok
}

describe("standard string formats validate (not just annotate)", () => {
  test("email", async () => {
    expect(await accepts(t.string({ format: "email" }), "ada@example.com")).toBe(true)
    expect(await accepts(t.string({ format: "email" }), "not-an-email")).toBe(false)
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

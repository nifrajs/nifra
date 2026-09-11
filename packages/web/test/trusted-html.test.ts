import { describe, expect, test } from "bun:test"
import { sanitizedHtml, sanitizeHtml, trustHtml } from "../src/trusted-html.ts"

describe("trusted HTML boundaries", () => {
  test("trustHtml remains an explicit build-time/application-owned escape hatch", () => {
    expect(String(trustHtml("<em>owned</em>"))).toBe("<em>owned</em>")
  })

  test("sanitizedHtml requires and applies a sanitizer", () => {
    const calls: string[] = []
    const sanitizer = (value: string): string => {
      calls.push(value)
      return value
        .replaceAll("<script>", "&lt;script&gt;")
        .replaceAll("</script>", "&lt;/script&gt;")
    }
    const result = sanitizedHtml("<script>alert(1)</script>", sanitizer)
    expect(calls).toEqual(["<script>alert(1)</script>"])
    expect(String(result)).toBe("&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(String(sanitizeHtml("<b>ok</b>", (value) => value))).toBe("<b>ok</b>")
  })

  test("rejects a missing or non-string sanitizer result", () => {
    expect(() => sanitizedHtml("<b>x</b>", undefined as never)).toThrow(/sanitizer is required/)
    expect(() => sanitizedHtml("<b>x</b>", (() => 1) as never)).toThrow(
      /sanitizer must return a string/,
    )
  })
})

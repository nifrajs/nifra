import { describe, expect, test } from "bun:test"
import { negotiateContentType, parseAcceptHeader } from "../src/index.ts"

describe("negotiateContentType()", () => {
  test("selects the highest-quality offered representation", () => {
    expect(
      negotiateContentType("text/*;q=0.8, application/json;q=1", ["text/html", "application/json"]),
    ).toBe("application/json")
  })

  test("uses the most-specific media range and honors q=0", () => {
    expect(negotiateContentType("text/*;q=0.9, text/html;q=0.2", ["text/html", "text/plain"])).toBe(
      "text/plain",
    )
    expect(
      negotiateContentType("*/*;q=1, application/json;q=0", ["application/json"]),
    ).toBeUndefined()
    expect(negotiateContentType("text/*;q=0.8, text/html;q=0.8", ["text/plain", "text/html"])).toBe(
      "text/html",
    )
  })

  test("accepts Request and Headers inputs and preserves offered parameters", () => {
    const request = new Request("http://x", { headers: { accept: "application/json" } })
    expect(negotiateContentType(request, ["text/html", "application/json;profile=v1"])).toBe(
      "application/json;profile=v1",
    )
    expect(negotiateContentType(new Headers(), ["text/plain"])).toBe("text/plain")
    expect(negotiateContentType("image/avif", ["text/html"])).toBeUndefined()
  })

  test("ignores accept extensions after q", () => {
    expect(negotiateContentType("text/html;q=0.9;profile=client-extension", ["text/html"])).toBe(
      "text/html",
    )
    expect(negotiateContentType("text/html;profile=v1;q=0.9", ["text/html"])).toBeUndefined()
  })

  test("rejects oversized or excessively fragmented Accept headers", () => {
    expect(parseAcceptHeader("text/plain,".repeat(129))).toEqual([])
    expect(negotiateContentType("text/plain,".repeat(129), ["text/plain"])).toBeUndefined()
  })
})

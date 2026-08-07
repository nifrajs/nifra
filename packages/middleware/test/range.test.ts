import { describe, expect, test } from "bun:test"
import { parseByteRange, rangeResponse } from "../src/index.ts"

describe("rangeResponse()", () => {
  test("serves a satisfiable byte range", async () => {
    const response = rangeResponse(
      new Request("http://x/file.txt", { headers: { range: "bytes=2-5" } }),
      new TextEncoder().encode("0123456789"),
      { contentType: "text/plain", etag: '"file-v1"' },
    )

    expect(response.status).toBe(206)
    expect(response.headers.get("accept-ranges")).toBe("bytes")
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10")
    expect(response.headers.get("content-length")).toBe("4")
    expect(response.headers.get("etag")).toBe('"file-v1"')
    expect(await response.text()).toBe("2345")
  })

  test("parses open and suffix ranges", () => {
    expect(parseByteRange("bytes=4-", 10)).toEqual({
      kind: "satisfiable",
      ranges: [{ start: 4, end: 9 }],
    })
    expect(parseByteRange("bytes=-3", 10)).toEqual({
      kind: "satisfiable",
      ranges: [{ start: 7, end: 9 }],
    })
    expect(parseByteRange("bytes=not-a-range", 10)).toEqual({ kind: "none" })
  })

  test("ignores oversized range sets before sorting or materializing them", () => {
    const abusive = `bytes=${Array.from({ length: 17 }, (_, index) => `${index}-${index}`).join(",")}`
    expect(parseByteRange(abusive, 100)).toEqual({ kind: "none" })
  })

  test("returns 416 for an unsatisfiable range and 304 for a matching validator", async () => {
    const body = new TextEncoder().encode("0123456789")
    const unsatisfiable = rangeResponse(
      new Request("http://x/file.txt", { headers: { range: "bytes=99-" } }),
      body,
    )
    expect(unsatisfiable.status).toBe(416)
    expect(unsatisfiable.headers.get("content-range")).toBe("bytes */10")
    expect(await unsatisfiable.text()).toBe("")

    const notModified = rangeResponse(
      new Request("http://x/file.txt", { headers: { "if-none-match": '"file-v1"' } }),
      body,
      { etag: '"file-v1"' },
    )
    expect(notModified.status).toBe(304)
    expect(notModified.headers.get("etag")).toBe('"file-v1"')
    expect(await notModified.text()).toBe("")
  })

  test("gives If-None-Match precedence over Last-Modified and falls back to date validation", async () => {
    const modified = new Date("2026-01-01T00:00:00.000Z")
    const staleTag = rangeResponse(
      new Request("http://x/file.txt", {
        headers: { "if-none-match": '"stale"' },
      }),
      "0123",
      { etag: '"fresh"', lastModified: modified },
    )
    expect(staleTag.status).toBe(200)

    const dateMatch = rangeResponse(
      new Request("http://x/file.txt", {
        headers: { "if-modified-since": modified.toUTCString() },
      }),
      "0123",
      { etag: '"fresh"', lastModified: modified },
    )
    expect(dateMatch.status).toBe(304)
    expect(await dateMatch.text()).toBe("")
  })

  test("supports multiple ranges and ignores a stale If-Range", async () => {
    const body = new TextEncoder().encode("0123456789")
    const multiple = rangeResponse(
      new Request("http://x/file.txt", { headers: { range: "bytes=0-1,8-9" } }),
      body,
      { contentType: "text/plain", etag: '"new"' },
    )
    expect(multiple.status).toBe(206)
    expect(multiple.headers.get("content-type")).toMatch(/^multipart\/byteranges; boundary=/)
    const multipart = await multiple.text()
    expect(multipart).toContain("Content-Range: bytes 0-1/10")
    expect(multipart).toContain("Content-Range: bytes 8-9/10")
    expect(multipart).toContain("01")
    expect(multipart).toContain("89")

    const stale = rangeResponse(
      new Request("http://x/file.txt", {
        headers: { range: "bytes=2-5", "if-range": '"old"' },
      }),
      body,
      { etag: '"new"' },
    )
    expect(stale.status).toBe(200)
    expect(await stale.text()).toBe("0123456789")
  })

  test("keeps HEAD bodyless while preserving representation length", async () => {
    const response = rangeResponse(
      new Request("http://x/file.txt", { method: "HEAD", headers: { range: "bytes=2-5" } }),
      "0123456789",
      { contentType: "text/plain" },
    )

    expect(response.status).toBe(206)
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10")
    expect(response.headers.get("content-length")).toBe("4")
    expect(await response.text()).toBe("")
  })
})

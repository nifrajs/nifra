import { describe, expect, test } from "bun:test"
import { conditionalResponse } from "../src/index.ts"

describe("conditionalResponse()", () => {
  test("turns a matching validator into a bodyless 304", async () => {
    const response = conditionalResponse(
      new Request("http://x/resource", { headers: { "if-none-match": 'W/"v1"' } }),
      new Response("payload", { headers: { "content-type": "text/plain" } }),
      { etag: '"v1"' },
    )

    expect(response.status).toBe(304)
    expect(response.headers.get("etag")).toBe('"v1"')
    expect(response.headers.get("content-type")).toBeNull()
    expect(await response.text()).toBe("")
  })

  test("attaches validators on a stale request and honors date fallback", async () => {
    const modified = new Date("2026-01-01T00:00:00.000Z")
    const stale = conditionalResponse(
      new Request("http://x/resource", { headers: { "if-none-match": '"old"' } }),
      new Response("payload"),
      { etag: '"new"', lastModified: modified },
    )
    expect(stale.status).toBe(200)
    expect(stale.headers.get("etag")).toBe('"new"')
    expect(stale.headers.get("last-modified")).toBe(modified.toUTCString())
    expect(await stale.text()).toBe("payload")

    const byDate = conditionalResponse(
      new Request("http://x/resource", {
        headers: { "if-modified-since": modified.toUTCString() },
      }),
      new Response("payload", { headers: { "content-type": "text/plain" } }),
      { lastModified: modified },
    )
    expect(byDate.status).toBe(304)
    expect(await byDate.text()).toBe("")
  })

  test("rejects invalid dates and leaves non-success responses unchanged", () => {
    expect(() =>
      conditionalResponse(new Request("http://x"), new Response("bad", { status: 400 }), {
        lastModified: new Date("invalid"),
      }),
    ).toThrow(/valid Date/)

    const response = new Response("bad", { status: 400 })
    expect(conditionalResponse(new Request("http://x"), response, { etag: '"v1"' })).toBe(response)
  })

  test("cancels a streaming body when returning 304", async () => {
    let cancelled = false
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]))
        },
        cancel() {
          cancelled = true
        },
      }),
    )

    const notModified = conditionalResponse(
      new Request("http://x/resource", { headers: { "if-none-match": '"v1"' } }),
      response,
      { etag: '"v1"' },
    )

    expect(notModified.status).toBe(304)
    await Promise.resolve()
    expect(cancelled).toBe(true)
  })
})

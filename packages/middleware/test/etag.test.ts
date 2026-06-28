import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { etag } from "@nifrajs/middleware"

const app = server()
  .use(etag())
  .get("/", () => ({ hello: "world" }))
  .post("/", () => ({ ok: true }))

describe("etag", () => {
  test("adds a weak ETag to GET 200 responses", async () => {
    const res = await app.fetch(new Request("http://x/"))
    expect(res.status).toBe(200)
    expect(res.headers.get("etag")).toMatch(/^W\/"[0-9a-f]+"$/)
    expect(await res.json()).toEqual({ hello: "world" })
  })

  test("returns 304 when If-None-Match matches", async () => {
    const tag = (await app.fetch(new Request("http://x/"))).headers.get("etag")!
    const res = await app.fetch(new Request("http://x/", { headers: { "if-none-match": tag } }))
    expect(res.status).toBe(304)
    expect(await res.text()).toBe("")
    expect(res.headers.get("etag")).toBe(tag)
  })

  test("matches If-None-Match lists, wildcard, and weak validators", async () => {
    const tag = (await app.fetch(new Request("http://x/"))).headers.get("etag")!
    const listed = await app.fetch(
      new Request("http://x/", {
        headers: { "if-none-match": `"other", ${tag}, "later"` },
      }),
    )
    expect(listed.status).toBe(304)

    const wildcard = await app.fetch(
      new Request("http://x/", { headers: { "if-none-match": "*" } }),
    )
    expect(wildcard.status).toBe(304)

    const strong = server()
      .use(etag({ weak: false }))
      .get("/", () => ({ hello: "world" }))
    const strongTag = (await strong.fetch(new Request("http://x/"))).headers.get("etag")!
    const weakMatch = await strong.fetch(
      new Request("http://x/", { headers: { "if-none-match": `W/${strongTag}` } }),
    )
    expect(weakMatch.status).toBe(304)
  })

  test("a stale If-None-Match still gets 200 + body", async () => {
    const res = await app.fetch(
      new Request("http://x/", { headers: { "if-none-match": 'W/"deadbeef"' } }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ hello: "world" })
  })

  test("non-GET responses are untouched (no ETag)", async () => {
    const res = await app.fetch(new Request("http://x/", { method: "POST" }))
    expect(res.headers.get("etag")).toBeNull()
  })

  test("skips over-maxBytes responses without consuming the outgoing body", async () => {
    const large = server()
      .use(etag({ maxBytes: 4 }))
      .get("/", () => new Response("12345", { headers: { "content-length": "5" } }))

    const res = await large.fetch(new Request("http://x/"))
    expect(res.headers.get("etag")).toBeNull()
    expect(await res.text()).toBe("12345")
  })

  test("streams through a length-less body that exceeds maxBytes (no ETag, body intact)", async () => {
    // No Content-Length ⇒ the cap can only be enforced mid-stream: readBytesCapped reads the clone,
    // cancels once the running total passes maxBytes, and bails so the ORIGINAL body is returned
    // untouched. The declared-length test above hits the early return, so this is the only path that
    // exercises the streaming cancel + pass-through (and it fails on the old unconditional hash).
    const large = server()
      .use(etag({ maxBytes: 4 }))
      .get(
        "/",
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("12345678")) // 8 bytes > 4
                controller.close()
              },
            }),
          ),
      )

    const res = await large.fetch(new Request("http://x/"))
    expect(res.headers.get("etag")).toBeNull()
    expect(await res.text()).toBe("12345678")
  })

  test("a 304 carries no Content-Length / Content-Type (no body-describing headers)", async () => {
    const first = await app.fetch(new Request("http://x/"))
    const tag = first.headers.get("etag")
    expect(tag).not.toBeNull()
    const res = await app.fetch(
      new Request("http://x/", { headers: { "if-none-match": tag as string } }),
    )
    expect(res.status).toBe(304)
    expect(res.headers.get("content-length")).toBeNull()
    expect(res.headers.get("content-type")).toBeNull()
  })

  test("validates construction", () => {
    expect(() => etag({ maxBytes: -1 })).toThrow(/maxBytes/)
  })
})

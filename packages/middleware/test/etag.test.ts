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

  test("adds an ETag to a raw streamed response and revalidates it", async () => {
    const raw = server()
      .use(etag())
      .get(
        "/",
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"raw":true}'))
                controller.close()
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
      )
    const first = await raw.fetch(new Request("http://x/"))
    const tag = first.headers.get("etag")
    expect(tag).not.toBeNull()
    expect(await first.text()).toBe('{"raw":true}')
    const second = await raw.fetch(new Request("http://x/", { headers: { "if-none-match": tag! } }))
    expect(second.status).toBe(304)
    expect(await second.text()).toBe("")
  })

  test("strong ETags use a collision-resistant digest", async () => {
    const app = server()
      .use(etag({ weak: false }))
      .get("/", () => ({ stable: true }))
    const res = await app.fetch(new Request("http://x/"))
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/)
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
    // No Content-Length ⇒ the cap can only be enforced mid-stream: readBytesCapped reads a prefix,
    // replays it through the same reader, and bails so the body remains intact. The declared-length
    // test above hits the early return, so this is the only path that exercises streaming replay.
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

  // Hashing a raw body means reading it, and a read cannot be undone. When the upstream fails
  // partway there is no digest to send, so the prefix already taken has to be replayed to the
  // client instead of dropped.
  test("replays a raw body whose upstream fails mid-read, without an ETag", async () => {
    let sent = false
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) throw new Error("upstream failed")
        sent = true
        controller.enqueue(new TextEncoder().encode("head"))
      },
    })
    const failing = server()
      .use(etag())
      .get("/", () => new Response(upstream, { headers: { "content-type": "text/plain" } }))
    const res = await failing.fetch(new Request("http://x/"))

    // No digest exists for a body that was never fully read - sending one would be a lie.
    expect(res.headers.get("etag")).toBeNull()

    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("head")
    await expect(reader.read()).rejects.toThrow("upstream failed")
  })

  test("replays a raw body that exceeds maxBytes instead of buffering it", async () => {
    const capped = server()
      .use(etag({ maxBytes: 8 }))
      .get(
        "/",
        () =>
          new Response("far longer than the cap allows", {
            headers: { "content-type": "text/plain" },
          }),
      )
    const res = await capped.fetch(new Request("http://x/"))
    expect(res.headers.get("etag")).toBeNull()
    expect(await res.text()).toBe("far longer than the cap allows")
  })

  test("propagates a client disconnect on the replayed body to the upstream reader", async () => {
    let cancelled: unknown
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("far longer than the cap allows"))
      },
      cancel(reason) {
        cancelled = reason
      },
    })
    const capped = server()
      .use(etag({ maxBytes: 8 }))
      .get("/", () => new Response(upstream, { headers: { "content-type": "text/plain" } }))
    const res = await capped.fetch(new Request("http://x/"))

    // The cap put this body on the replay path with the upstream still healthy, so a disconnect
    // has to reach it - otherwise the producer keeps running for a client that has gone.
    await res.body?.cancel("client went away")
    expect(cancelled).toBe("client went away")
  })
})
